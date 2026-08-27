#!/usr/bin/env node

/** Claude Code hook that rejects a small set of destructive Bash commands. */

const denied = [
  /(^|\s)rm\s+-rf\s+\/(?:\s|$)/,
  /(^|\s)git\s+reset\s+--hard(?:\s|$)/,
  /(^|\s)git\s+clean\s+-[a-zA-Z]*f/,
  /(^|\s)git\s+push\s+[^\n]*--force/,
  /(^|\s)sudo(?:\s|$)/,
  /(^|\s)chmod\s+-R\s+777(?:\s|$)/,
];

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
  payload = JSON.parse(input);
} catch {
  console.error("Blocked because the hook input was not valid JSON.");
  process.exit(2);
}

const rawCommand = payload?.tool_input?.command;
const command = typeof rawCommand === "string" ? rawCommand : String(rawCommand ?? "");
for (const pattern of denied) {
  if (pattern.test(command)) {
    console.error(`Blocked destructive command pattern: ${pattern.source}`);
    process.exit(2);
  }
}
