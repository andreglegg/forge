/**
 * The approval prompt, driven through a real terminal.
 *
 * Everything else about approval is covered by unit tests through the `Run`
 * actor, and by `--yes` end to end. What none of those reach is the path a
 * human actually takes: a TTY, a prompt written to it, a keystroke read back.
 * That path has already broken twice in ways no unit test could see -- a
 * pending `rl.question` that neither resolved nor rejected when readline
 * closed, and a `close` handler that fired at EOF while buffered input
 * remained. Both were found by running it, so this runs it.
 *
 * A pty rather than a pipe, because a pipe is exactly what does *not*
 * reproduce the conditions: stdin ends immediately, `isTTY` is false, and the
 * prompt is answered by a stream that has already closed. `script(1)` is used
 * to allocate one; it ships with macOS and with util-linux, and needing it is
 * why this file skips rather than fails where it is absent.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "forge");

/**
 * Whether a pty can actually be allocated *here*, not merely whether `script`
 * is installed.
 *
 * BSD `script` needs a controlling terminal of its own to fork from, so it
 * exits 1 and writes nothing when the test runner itself was started without
 * one -- a sandboxed shell, some CI containers. Probing by running it is the
 * only honest check: reporting "verified" from a `which` that succeeded while
 * the pty never existed is exactly the kind of empty green this package
 * refuses elsewhere.
 */
function canAllocatePty(): boolean {
  const probe = path.join(tmpdir(), `forge-pty-probe-${process.pid}.log`);
  try {
    const result = spawnSync("script", ["-q", probe, "/bin/sh", "-c", "printf ok"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) return false;
    return readFileSync(probe, "utf8").includes("ok");
  } catch {
    return false;
  }
}

/**
 * Run `forge` under a pty, feeding it `input`, and return everything it wrote.
 *
 * The BSD and util-linux spellings of `script` take their arguments in
 * different orders and neither accepts the other's; both are tried rather than
 * branching on platform, because the platform is not what decides which is
 * installed.
 */
function underPty(cwd: string, input: string, env: Record<string, string>): string {
  const log = path.join(cwd, "pty.log");
  const shellCommand = `printf %s ${JSON.stringify(input)} | ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)}`;
  const attempts: string[][] = [
    ["-q", log, "/bin/sh", "-c", shellCommand], // BSD / macOS
    ["-qec", shellCommand, log], // util-linux
  ];
  for (const args of attempts) {
    const result = spawnSync("script", args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error === undefined && result.status !== null) {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return result.stdout ?? "";
      }
    }
  }
  return "";
}

// Skipped, loudly, where no pty is available. The path is then genuinely
// unverified on that machine, and saying so is the point.
const describeIfPty = canAllocatePty() ? describe : describe.skip;

describeIfPty("the approval prompt on a real terminal", () => {
  test("pressing enter applies the edit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "forge-pty-"));
    const root = realpathSync(dir);
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "math.js"), "export const value = 1;\n");

      // A scripted endpoint, so the test asserts the approval path and not the
      // model. Started on a port of its own so a real local server on 8790 is
      // never consulted and never blamed for a failure here.
      const server = path.join(root, "model.mjs");
      writeFileSync(
        server,
        `import { createServer } from "node:http";
const reply = ["EDIT src/math.js\\n","<<<<<<< SEARCH\\n","export const value = 1;\\n",
  "=======\\n","export const value = 2;\\n",">>>>>>> REPLACE\\n","DONE bumped\\n"];
createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({ data: [{ id: "scripted" }] }));
      return;
    }
    res.writeHead(200, {"content-type":"text/event-stream"});
    for (const chunk of reply) {
      res.write("data: " + JSON.stringify({choices:[{delta:{content:chunk}}]}) + "\\n\\n");
    }
    res.write("data: [DONE]\\n\\n"); res.end();
  });
}).listen(8799, "127.0.0.1");
`,
        "utf8",
      );
      // Start the endpoint in the background for the duration of the run.
      const { spawn } = await import("node:child_process");
      const child = spawn("node", [server], { stdio: "ignore", detached: true });
      await new Promise((resolve) => setTimeout(resolve, 700));

      try {
        // Enter at the approval prompt, then /exit. Blank line = apply.
        const output = underPty(root, "bump the value\n\n/exit\n", {
          FORGE_URL: "http://127.0.0.1:8799/v1",
          FORGE_MODEL: "scripted",
        });

        // The prompt reached a terminal...
        expect(output).toContain("[a]pply");
        // ...and the keystroke applied the edit.
        expect(readFileSync(path.join(root, "src", "math.js"), "utf8")).toBe(
          "export const value = 2;\n",
        );
      } finally {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
