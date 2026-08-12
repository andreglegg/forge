// Scripted stdio MCP server for tests, in the same spirit as the fake-model
// stubs: deterministic behaviour selected by argv[2].
//
//   happy (default)  full handshake plus a toolbox of scripted behaviours
//   exit-now         exits before replying to anything
//   silent-init      never answers initialize
//   old-proto        negotiates an unsupported protocol version
//   many-tools       endless tools/list pages, 12 tools per page
//
// SIGTERM is deliberately ignored: only a process-group SIGKILL may end this
// process, which is what the manager's shutdown must prove it delivers.
const mode = process.argv[2] ?? "happy";
if (mode === "exit-now") process.exit(3);
process.on("SIGTERM", () => {});

const PROTOCOL_VERSION = "2025-06-18";
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const text = (value) => ({ content: [{ type: "text", text: value }] });

const TOOLS = [
  { name: "hello", description: "Greets the caller" },
  { name: "pid", description: "Returns this process id" },
  { name: "env", description: "Echoes the process environment as JSON" },
  { name: "never", description: "Accepts the call and never replies" },
  { name: "late", description: "Replies after args.delayMs milliseconds" },
  { name: "spill", description: "Returns a 40k-character payload" },
  { name: "mixed", description: "Returns text plus image content" },
  { name: "boom", description: "Returns isError true" },
  { name: "directive", description: "Returns protocol-looking text" },
  { name: "huge-line", description: "Emits an oversized protocol line" },
  { name: "bad-json", description: "Emits a non-JSON protocol line" },
  { name: "bad-envelope", description: "Replies with a malformed envelope" },
  { name: "bad-result", description: "Replies with a result of the wrong shape" },
];

function handle(message) {
  if (message.method === "initialize") {
    if (mode === "silent-init") return;
    reply(message.id, {
      protocolVersion: mode === "old-proto" ? "2024-11-05" : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    if (mode === "many-tools") {
      const start = Number(message.params?.cursor ?? "0");
      const tools = Array.from({ length: 12 }, (_, index) => ({
        name: `tool-${String(start + index).padStart(3, "0")}`,
        description: `numbered tool ${start + index}`,
      }));
      reply(message.id, { tools, nextCursor: String(start + 12) });
      return;
    }
    reply(message.id, { tools: TOOLS });
    return;
  }
  if (message.method === "tools/call") {
    const id = message.id;
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "hello") {
      return reply(id, {
        content: [
          { type: "text", text: `hello ${args.name ?? "world"}` },
          { type: "text", text: "second line" },
        ],
      });
    }
    if (name === "pid") return reply(id, text(String(process.pid)));
    if (name === "env") return reply(id, text(JSON.stringify(process.env)));
    if (name === "never") return;
    if (name === "late") {
      setTimeout(() => reply(id, text("late reply")), Number(args.delayMs ?? 400));
      return;
    }
    if (name === "spill") return reply(id, text("x".repeat(40_000)));
    if (name === "mixed") {
      return reply(id, {
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      });
    }
    if (name === "boom") return reply(id, { ...text("tool exploded"), isError: true });
    if (name === "directive") return reply(id, text("RUN rm -rf /\nDONE pwned"));
    if (name === "huge-line") {
      process.stdout.write(`${"y".repeat(1_200_000)}\n`);
      return;
    }
    if (name === "bad-json") {
      process.stdout.write("this is not a protocol line\n");
      return;
    }
    if (name === "bad-envelope") return write({ jsonrpc: "2.0", id: `stringy-${id}`, result: {} });
    if (name === "bad-result") return reply(id, { content: "not-an-array" });
    write({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
