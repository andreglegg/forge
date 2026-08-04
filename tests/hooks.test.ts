import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { formatHookFailure, runProjectHooks } from "../src/hooks.js";

describe("project lifecycle hooks", () => {
  test("runs shell-free token arrays with bounded Forge metadata", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-hooks-")));
    try {
      const marker = path.join(root, "hook.txt");
      const report = await runProjectHooks(
        {
          beforeVerify: [
            [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.FORGE_HOOK_EVENT + ':' + process.env.FORGE_SESSION_ID)`,
            ],
          ],
        },
        {
          repository: root,
          sessionId: "session-1",
          event: "beforeVerify",
        },
      );

      expect(report.ok).toBe(true);
      expect(report.invocations).toHaveLength(1);
      expect(readFileSync(marker, "utf8")).toBe("beforeVerify:session-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails fast and formats authoritative diagnostics", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-hooks-fail-")));
    try {
      const later = path.join(root, "later.txt");
      const report = await runProjectHooks(
        {
          sessionStart: [
            [process.execPath, "-e", "process.stderr.write('blocked'); process.exit(7)"],
            [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(later)}, 'ran')`,
            ],
          ],
        },
        { repository: root, sessionId: "session-2", event: "sessionStart" },
      );

      expect(report.ok).toBe(false);
      expect(report.invocations).toHaveLength(1);
      expect(report.output).toContain("exit 7");
      expect(report.output).toContain("blocked");
      expect(formatHookFailure(report)).toMatch(/sessionStart hook failed/i);
      expect(existsSync(later)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes the verification verdict only to post-verification hooks", async () => {
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "forge-hooks-verified-")));
    try {
      const report = await runProjectHooks(
        {
          afterVerify: [
            [
              process.execPath,
              "-e",
              "process.stdout.write(process.env.FORGE_VERIFIED || 'missing')",
            ],
          ],
        },
        {
          repository: root,
          sessionId: "session-3",
          event: "afterVerify",
          verified: true,
        },
      );

      expect(report.ok).toBe(true);
      expect(report.output).toContain("true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
