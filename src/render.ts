/**
 * Projections. Pure functions of an event; no I/O, no state, no terminal.
 *
 * Both renderers consume the same stream the journal does, so neither is bolted
 * on and neither can see something the other cannot. That is the whole reason
 * the core emits events rather than printing: a renderer is a *view*, and a
 * view that can influence the run is not a view.
 *
 * Being pure also means the interactive output can be asserted in a test with
 * no pty, no capture harness and no snapshot of terminal escape codes.
 */

import { LOGO_COLUMNS, LOGO_TRUECOLOR } from "./logo.js";
import type { Decision, RunEvent } from "./runtime.js";
import type { Hunk } from "./workspace.js";

/**
 * The mark, as the terminal can render it.
 *
 * A transcription of `docs/assets/forge-mono.png`: two hexagonal brackets
 * facing each other, a blade rising above them, a starburst at the base, and
 * the circuit ticks on the inner traces.
 *
 * Box-drawing rather than a block mosaic. The mark has to survive a font
 * without block glyphs and a paste into a bug report, and a banner that
 * reflows into rubble is worse than no banner — which is also why there is a
 * one-line fallback for a window too narrow to hold it. Measuring by code
 * point rather than by `.length`, because the drawing characters are outside
 * the BMP-safe assumption `.length` makes and a mis-measured width would
 * trigger the fallback on a terminal that could have shown the real thing.
 */
const MARK = [
  "                  ▲",
  "                  ┃",
  "    ╱▔▔▔▔▔╲       ┃       ╱▔▔▔▔▔╲",
  "   ╱ ╱▔▔▔╲ ╲      ┃      ╱ ╱▔▔▔╲ ╲",
  "  ╱ ╱  ∘   ╲ ╲    ┃    ╱ ╱   ▁   ╲ ╲",
  " ▕ ▕   ▪    ▏ ▏   ┃   ▕ ▏   ▔     ▏ ▏",
  "  ╲ ╲      ╱ ╱    ┃    ╲ ╲   ∘   ╱ ╱",
  "   ╲ ╲▁▁▁╱ ╱   ╲  ┃  ╱   ╲ ╲▁▁▁╱ ╱",
  "    ╲▁▁▁▁▁╱  ╲╲ ╲ ┃ ╱ ╱╱  ╲▁▁▁▁▁╱",
  "              ╲╲╲╲┃╱╱╱╱",
];

const MARK_WIDTH = Math.max(...MARK.map((line) => [...line].length));

/**
 * The options offered at an approval prompt, spelled once.
 *
 * Case is meaningful: `[a]pply` and `[A]lways` are different keys, and the
 * prompt is the only place they are written. `approvalChoice` sits directly
 * below because the two must agree -- they did not, once.
 */
export const APPROVAL_PROMPT = "    [a]pply  [s]kip  [A]lways";

/**
 * Turn a typed reply into a decision.
 *
 * The reply used to be lowercased before comparison, which folded `A` onto `a`
 * and made the prompt's own "always" key approve exactly once. Case is checked
 * before folding now, and the spelled-out word is accepted in any case because
 * it was the only thing that used to work and someone will still be typing it.
 *
 * Anything unrecognised denies. A typo must never approve a mutation.
 */
export function approvalChoice(reply: string): Decision {
  const raw = reply.trim();
  if (raw === "A" || raw.toLowerCase() === "always") return "always";
  const folded = raw.toLowerCase();
  // The spelled-out words are accepted too. The prompt writes "apply" and
  // "skip" on screen, and typing what is written must not mean the opposite of
  // what it says -- which, for "apply", it did: it fell through to deny.
  if (["", "a", "y", "apply", "yes"].includes(folded)) return "once";
  return "deny";
}

export function banner(
  options: {
    readonly color?: boolean;
    readonly width?: number;
    /** Whether the terminal accepts 24-bit colour. See `useTruecolor`. */
    readonly truecolor?: boolean;
  } = {},
): string {
  const color = options.color ?? false;
  const width = options.width ?? 80;
  // The real mark, rendered from the PNG at build time, when the terminal can
  // actually show it. A 256-colour terminal fed 24-bit escapes renders
  // something between wrong and unreadable, so this is gated on the terminal
  // SAYING it supports truecolor rather than on hoping.
  if (options.truecolor === true && color && width >= LOGO_COLUMNS + 2) {
    return LOGO_TRUECOLOR.map((line) => `  ${line}`).join("\n");
  }
  // 112 is the green the mark is drawn in; the 256-colour form is understood
  // by every terminal that would render the box-drawing correctly anyway.
  const paint = (line: string): string => (color ? `\u001b[38;5;112m${line}\u001b[0m` : line);
  if (width < MARK_WIDTH + 2) {
    return paint("  ▲ forge");
  }
  return MARK.map((line) => `  ${paint(line)}`).join("\n");
}

/**
 * Whether the terminal has told us it can do 24-bit colour.
 *
 * Only ever from an explicit declaration. Guessing wrong is not a graceful
 * degradation -- a 256-colour terminal handed truecolor escapes prints the
 * escape text or a mess of approximate blocks, and the box-drawing mark it
 * would otherwise have shown is strictly better than either.
 */
export function useTruecolor(env: Record<string, string | undefined>): boolean {
  const declared = `${env["COLORTERM"] ?? ""}`.toLowerCase();
  return declared === "truecolor" || declared === "24bit";
}

/** Whether colour should be used at all. NO_COLOR wins over everything. */
export function useColor(isTty: boolean, env: Record<string, string | undefined>): boolean {
  if (env["NO_COLOR"]) return false;
  if (env["FORCE_COLOR"]) return true;
  return isTty;
}

function showCommittedMutation(event: Extract<RunEvent, { type: "mutation.committed" }>): boolean {
  if (event.action === undefined || event.action === "edit") return true;
  return event.path === event.rootPath || event.path === event.destinationPath;
}

export interface RenderOptions {
  /** Columns available. Used only for rules, never for wrapping content. */
  readonly width?: number;
  /** Maximum diff lines shown inline before the rest is summarised. */
  readonly diffLimit?: number;
}

/**
 * The interactive view: one frame per event, or null to stay silent.
 *
 * Silence is a real answer. `action.proposed` is interesting to the journal and
 * uninteresting to a human who is about to be shown the diff anyway, and
 * printing both would double every action.
 */
export function renderInteractive(event: RunEvent, options: RenderOptions = {}): string | null {
  const width = options.width ?? 72;
  const diffLimit = options.diffLimit ?? 24;
  switch (event.type) {
    case "run.started":
      return `› ${event.task}`;
    case "model.text":
      return event.text ? `\n${event.text}\n` : null;
    case "approval.requested": {
      const lines = [`  ⋮ ${event.summary}`];
      if (event.preview !== null) {
        lines.push(...diffFrame(event.preview.path, event.preview.hunks, width, diffLimit));
      }
      lines.push(APPROVAL_PROMPT);
      return lines.join("\n");
    }
    case "action.started":
      return `  ⋮ ${event.summary}`;
    case "action.finished":
      return event.ok ? null : `    ✗ ${firstLine(event.output)}`;
    case "mutation.committed":
      return showCommittedMutation(event)
        ? `    ✓ ${event.path}  +${event.added} -${event.removed}`
        : null;
    case "approval.resolved":
      return event.decision === "deny" ? "    ✗ skipped" : null;
    case "run.finished":
      return `\n● ${event.summary}`;
    case "verification.started":
      return `  ⋮ verifying: ${event.commands.join(", ")}`;
    case "verification.finished":
      return event.passed ? "    ✓ verification passed" : "    ✗ verification failed";
    case "run.reopened":
      return `  ✗ ${event.reason}`;
    case "run.failed":
      return `\n✗ ${event.reason}`;
    case "run.cancelled":
      return "\n✗ cancelled";
    default:
      // model.delta is handled by the streaming writer, not here; turn.started
      // and action.proposed are journal facts with no user-facing frame.
      return null;
  }
}

/**
 * The headless view: one stable line per durable fact.
 *
 * Deliberately not the interactive renderer with the colours removed. A log
 * that is read by a person scrolling back and a log that is grepped by CI want
 * different things, and pretending otherwise produces something bad at both.
 */
export function renderHeadless(event: RunEvent): string | null {
  switch (event.type) {
    case "run.started":
      return `task: ${event.task}`;
    case "turn.started":
      return `turn ${event.turn}`;
    case "action.proposed":
      return `proposed ${event.id} ${event.summary}`;
    case "approval.requested":
      return `approval-required ${event.id}`;
    case "approval.resolved":
      return `approval ${event.id} ${event.decision}`;
    case "action.finished":
      return `${event.ok ? "ok" : "failed"} ${event.id}${event.ok ? "" : `: ${firstLine(event.output)}`}`;
    case "mutation.committed":
      return showCommittedMutation(event)
        ? `committed ${event.path} +${event.added} -${event.removed}`
        : null;
    case "run.finished":
      return `finished ${event.ok ? "ok" : "failed"}: ${event.summary}`;
    case "verification.started":
      return `verifying ${event.commands.join(", ")}`;
    case "verification.finished":
      return `verification ${event.passed ? "passed" : "failed"}`;
    case "run.reopened":
      return `reopened: ${event.reason}`;
    case "run.failed":
      return `failed: ${event.reason}`;
    case "run.cancelled":
      return "cancelled";
    case "extension.invoked":
      return `extension ${event.name} ${event.event}`;
    case "extension.resolved":
      return `extension ${event.name} ${event.decision}${event.reason === "" ? "" : `: ${firstLine(event.reason)}`}`;
    default:
      return null;
  }
}

/**
 * A framed diff.
 *
 * Context lines are shown around changes rather than the whole file: an
 * approval prompt that requires scrolling is one that gets approved unread,
 * which defeats the point of asking.
 */
export function diffFrame(
  file: string,
  hunks: readonly Hunk[],
  width: number,
  limit: number,
): string[] {
  const interesting = new Set<number>();
  hunks.forEach((hunk, index) => {
    if (hunk.kind !== "context") {
      for (let near = index - 2; near <= index + 2; near += 1) {
        if (near >= 0 && near < hunks.length) {
          interesting.add(near);
        }
      }
    }
  });
  const header = `    ┌─ ${file} `;
  const lines = [header + "─".repeat(Math.max(0, width - header.length))];
  let shown = 0;
  let previous = -2;
  for (const index of [...interesting].sort((a, b) => a - b)) {
    if (shown >= limit) {
      lines.push(`    │ … ${interesting.size - shown} more lines`);
      break;
    }
    if (index > previous + 1) {
      lines.push("    │ ⋯");
    }
    const hunk = hunks[index];
    if (hunk !== undefined) {
      const mark = hunk.kind === "add" ? "+" : hunk.kind === "remove" ? "-" : " ";
      lines.push(`    │ ${mark} ${hunk.text}`);
      shown += 1;
    }
    previous = index;
  }
  lines.push(`    └${"─".repeat(Math.max(0, width - 5))}`);
  return lines;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
