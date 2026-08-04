import { execBounded } from "./exec.js";
import type { ProjectHooks } from "./product.js";

export type HookEvent = "sessionStart" | "beforeVerify" | "afterVerify" | "sessionEnd";

export interface HookContext {
  readonly repository: string;
  readonly sessionId: string;
  readonly event: HookEvent;
  readonly verified?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface HookInvocation {
  readonly command: readonly string[];
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly seconds: number;
}

export interface HookReport {
  readonly event: HookEvent;
  readonly ok: boolean;
  readonly invocations: readonly HookInvocation[];
  readonly output: string;
}

/**
 * Execute explicitly enabled project hooks as shell-free token arrays.
 *
 * Commands run sequentially and fail fast. Provider credentials remain excluded
 * by execBounded's environment allowlist; only bounded Forge metadata is added.
 */
export async function runProjectHooks(
  hooks: ProjectHooks | undefined,
  context: HookContext,
): Promise<HookReport> {
  const commands = hooks?.[context.event] ?? [];
  const invocations: HookInvocation[] = [];
  for (const command of commands) {
    const result = await execBounded(command, {
      cwd: context.repository,
      timeoutSeconds: 60,
      maxOutputChars: 8_000,
      signal: context.signal,
      extraEnv: {
        FORGE_HOOK_EVENT: context.event,
        FORGE_SESSION_ID: context.sessionId,
        ...(context.verified === undefined
          ? {}
          : { FORGE_VERIFIED: context.verified ? "true" : "false" }),
      },
    });
    const invocation: HookInvocation = {
      command,
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
      seconds: result.seconds,
    };
    invocations.push(invocation);
    if (result.code !== 0 || result.timedOut) break;
  }
  const ok = invocations.every((invocation) => invocation.code === 0 && !invocation.timedOut);
  const output = invocations
    .map((invocation) => {
      const status = invocation.timedOut
        ? "timed out"
        : invocation.code === 0
          ? "exit 0"
          : `exit ${String(invocation.code)}`;
      return `$ ${invocation.command.join(" ")}\n${status}${invocation.output ? `\n${invocation.output}` : ""}`;
    })
    .join("\n\n");
  return { event: context.event, ok, invocations, output };
}

export function formatHookFailure(report: HookReport): string {
  return `Forge ${report.event} hook failed. Project hooks are authoritative and the run cannot continue:\n${report.output}`;
}
