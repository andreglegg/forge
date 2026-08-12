/**
 * MCP client: stdio transport only, behind the existing action protocol.
 *
 * An external MCP tool call crosses exactly the same path as a built-in tool
 * -- CallProposal, approval, bounding, journal events -- and nothing widens
 * outside it. This module owns the narrow part underneath: server processes
 * spawned only from an explicit token-array config with `shell: false` and the
 * credential-free environment allowlist, a hand-rolled newline-delimited
 * JSON-RPC 2.0 client speaking exactly the load-bearing subset (initialize,
 * notifications/initialized, tools/list, tools/call), and hard bounds on every
 * byte that crosses: 1 MiB per protocol line, 32 tools per server over at most
 * 4 list pages, one outstanding call per server, a per-call timeout, and a
 * head+tail output clip. Server output is untrusted text; it is returned as a
 * string and never parsed as actions or allowed to alter the tool set after
 * startup. A declared-but-broken server fails loudly at startup, never
 * silently.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { commandEnvironment } from "./exec.js";
import type { McpToolSummary } from "./protocol.js";
import { FORGE_VERSION } from "./version.js";

/** The one revision this client speaks. Anything else is refused at startup. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MAX_LINE_CHARS = 1_048_576;
const MAX_TOOLS_PER_SERVER = 32;
const MAX_TOOL_PAGES = 4;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_SECONDS = 60;
const MAX_CALL_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 16_000;

export const McpServerSchema = z.strictObject({
  /** A token array, never a shell string: same invariant as every command. */
  command: z.array(z.string().min(1)).min(1),
  env: z.record(z.string().min(1), z.string()).optional(),
  timeoutSeconds: z.number().int().positive().max(MAX_CALL_TIMEOUT_SECONDS).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export const McpConfigSchema = z.strictObject({
  servers: z.record(
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,31}$/,
        "server names are lowercase letters, digits and hyphens, 32 characters or fewer",
      ),
    McpServerSchema,
  ),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

const ResponseEnvelope = z
  .looseObject({
    jsonrpc: z.literal("2.0"),
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
  })
  .refine((value) => (value.error === undefined) !== (value.result === undefined), {
    message: "a response carries exactly one of result and error",
  });

const InitializeResult = z.looseObject({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
});

const ToolsListResult = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string().min(1), description: z.string().optional() })),
  nextCursor: z.string().optional(),
});

const CallToolResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
});

function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? `${value}s` : `${value.toFixed(1)}s`;
}

function diagnostic(line: string): string {
  return line.length <= 160 ? line : `${line.slice(0, 160)}…`;
}

/** Head+tail clip, same policy as bounded command output. */
function clipOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head - 40;
  return `${text.slice(0, head)}\n… ${text.length - head - tail} chars omitted …\n${text.slice(-tail)}`;
}

interface Pending {
  readonly id: number;
  readonly settle: (outcome: { ok: true; result: unknown } | { ok: false; error: Error }) => void;
}

class McpConnection {
  readonly child: ChildProcess;
  alive = true;
  tools: McpToolSummary[] = [];
  notice: string | null = null;
  private buffer = "";
  private nextId = 0;
  private pending: Pending | null = null;

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    options: { readonly cwd?: string; readonly envSource?: Record<string, string | undefined> },
  ) {
    const [executable, ...args] = this.config.command;
    this.child = spawn(executable as string, args, {
      cwd: options.cwd ?? process.cwd(),
      // The allowlist is the security property: provider credentials are never
      // present, and only the explicit per-server env is added on top.
      env: { ...commandEnvironment(options.envSource ?? process.env), ...(config.env ?? {}) },
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.on("error", (error) =>
      this.destroy(new Error(`mcp server ${this.name} failed to start: ${error.message}`)),
    );
    this.child.on("exit", () => this.destroy(new Error(`mcp server ${this.name} exited`)));
    this.child.stdin?.on("error", () => {
      // A dying pipe surfaces through the exit handler; crashing here would not.
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  /** initialize → notifications/initialized → bounded tools/list pages. */
  async handshake(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    let initialized: unknown;
    try {
      initialized = await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "forge", version: FORGE_VERSION },
        },
        remaining(),
      );
    } catch (error) {
      throw new Error(
        `mcp server ${this.name} failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = InitializeResult.safeParse(initialized);
    if (!parsed.success) {
      throw new Error(`mcp server ${this.name} returned an invalid initialize result`);
    }
    if (parsed.data.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error(
        `mcp server ${this.name} negotiated protocol version ${parsed.data.protocolVersion}; this build requires ${MCP_PROTOCOL_VERSION}`,
      );
    }
    this.notify("notifications/initialized", {});

    const collected: McpToolSummary[] = [];
    let cursor: string | undefined;
    let morePages = false;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const raw = await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        remaining(),
      );
      const listed = ToolsListResult.safeParse(raw);
      if (!listed.success) {
        throw new Error(`mcp server ${this.name} returned an invalid tools/list result`);
      }
      for (const tool of listed.data.tools) {
        collected.push({
          server: this.name,
          tool: tool.name,
          description: (tool.description ?? "").slice(0, 200),
        });
      }
      cursor = listed.data.nextCursor;
      if (cursor === undefined) break;
      if (page === MAX_TOOL_PAGES - 1) morePages = true;
    }
    this.tools = collected.slice(0, MAX_TOOLS_PER_SERVER);
    if (collected.length > this.tools.length || morePages) {
      this.notice = `mcp server ${this.name} advertises more than ${this.tools.length} tools; only the first ${this.tools.length} are available`;
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(new Error(`mcp server ${this.name} is not running`));
    }
    if (this.pending !== null) {
      return Promise.reject(new Error(`mcp server ${this.name} already has a call in flight`));
    }
    this.nextId += 1;
    const id = this.nextId;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending !== null && this.pending.id === id) {
          this.pending = null;
          // Best effort: tell the server the request is abandoned. Its late
          // reply, if any, is dropped by the id check in onLine.
          this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
          reject(new Error(`mcp server ${this.name} call timed out after ${seconds(timeoutMs)}`));
        }
      }, timeoutMs);
      this.pending = {
        id,
        settle: (outcome) => {
          clearTimeout(timer);
          if (outcome.ok) resolve(outcome.result);
          else reject(outcome.error);
        },
      };
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  destroy(reason: Error): void {
    if (!this.alive) return;
    this.alive = false;
    const pid = this.child.pid;
    if (pid !== undefined) {
      // The group, not the child: a grandchild holding the pipe open must not
      // outlive the server it belongs to. Same policy as bounded execution.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    const pending = this.pending;
    this.pending = null;
    pending?.settle({ ok: false, error: reason });
  }

  private write(message: unknown): void {
    if (!this.alive) return;
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A dead pipe is reported by the exit handler.
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > MAX_LINE_CHARS) {
        this.destroy(
          new Error(
            `mcp server ${this.name} sent a protocol line over ${MAX_LINE_CHARS} characters`,
          ),
        );
        return;
      }
      if (line.trim() !== "") this.onLine(line);
      if (!this.alive) return;
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.destroy(
        new Error(`mcp server ${this.name} sent a protocol line over ${MAX_LINE_CHARS} characters`),
      );
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.destroy(
        new Error(`mcp server ${this.name} sent a non-JSON protocol line: ${diagnostic(line)}`),
      );
      return;
    }
    if (parsed !== null && typeof parsed === "object" && "method" in parsed) {
      return; // Server-initiated traffic is outside the subset and ignored.
    }
    const envelope = ResponseEnvelope.safeParse(parsed);
    if (!envelope.success) {
      this.destroy(
        new Error(`mcp server ${this.name} sent an invalid response envelope: ${diagnostic(line)}`),
      );
      return;
    }
    const pending = this.pending;
    if (pending === null || envelope.data.id !== pending.id) {
      return; // A late reply to an abandoned id is dropped, never delivered.
    }
    this.pending = null;
    if (envelope.data.error !== undefined) {
      pending.settle({
        ok: false,
        error: new Error(`mcp server ${this.name}: ${envelope.data.error.message}`),
      });
      return;
    }
    pending.settle({ ok: true, result: envelope.data.result });
  }
}

export interface McpCallResult {
  readonly ok: boolean;
  readonly output: string;
}

export interface McpManagerOptions {
  readonly handshakeTimeoutMs?: number;
  readonly cwd?: string;
  readonly envSource?: Record<string, string | undefined>;
}

/**
 * Owns the configured server processes for one run. Servers start only when
 * the user passed the explicit flag, every startup failure is a hard error,
 * and the discovered tool set is frozen until shutdown.
 */
export class McpManager {
  private readonly connections = new Map<string, McpConnection>();

  constructor(
    private readonly servers: Readonly<Record<string, McpServerConfig>>,
    private readonly options: McpManagerOptions = {},
  ) {}

  async start(): Promise<void> {
    const names = Object.keys(this.servers).sort();
    if (names.length === 0) {
      throw new Error(
        "no MCP servers are configured; declare them under mcp.servers in forge.json",
      );
    }
    try {
      for (const name of names) {
        const config = this.servers[name];
        if (config === undefined) continue;
        const connection = new McpConnection(name, config, this.options);
        this.connections.set(name, connection);
        await connection.handshake(this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
      }
    } catch (error) {
      // A partial capability set is a silent drop; kill whatever started.
      this.shutdown();
      throw error;
    }
  }

  /** Discovered tools, frozen at startup; the model never changes this set. */
  tools(): readonly McpToolSummary[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  notices(): readonly string[] {
    return [...this.connections.values()].flatMap((connection) =>
      connection.notice === null ? [] : [connection.notice],
    );
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const connection = this.connections.get(server);
    if (connection === undefined || !connection.alive) {
      return { ok: false, output: `mcp server ${server} is not running` };
    }
    if (!connection.tools.some((entry) => entry.tool === tool)) {
      return {
        ok: false,
        output: `mcp server ${server} has no tool named ${tool}; the tool set is fixed at startup`,
      };
    }
    const timeoutSeconds = Math.min(
      connection.config.timeoutSeconds ?? DEFAULT_CALL_TIMEOUT_SECONDS,
      MAX_CALL_TIMEOUT_SECONDS,
    );
    let raw: unknown;
    try {
      raw = await connection.request(
        "tools/call",
        { name: tool, arguments: args },
        timeoutSeconds * 1000,
      );
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
    const parsed = CallToolResult.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, output: `mcp server ${server} returned an invalid tools/call result` };
    }
    const output = clipOutput(
      parsed.data.content
        .map((item) =>
          item.type === "text" && item.text !== undefined
            ? item.text
            : `[${item.type} content omitted]`,
        )
        .join("\n"),
    );
    return { ok: parsed.data.isError !== true, output };
  }

  shutdown(): void {
    for (const connection of this.connections.values()) {
      connection.destroy(new Error(`mcp server ${connection.name} was shut down`));
    }
  }
}
