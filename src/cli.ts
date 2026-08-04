/**
 * The chat loop and both front ends.
 *
 * `main(argv, io)` returns an exit code and writes through an injected `io`.
 * `bin/forge` is the only place `process.exit` appears, which is what lets the
 * whole CLI be tested without a pty or a capture harness.
 *
 * Two front ends over one core:
 *   - interactive: a REPL, streaming, with inline diffs and approval prompts
 *   - headless: `forge run "task"`, one shot, stable lines, an exit code
 * Both are subscribers to the same event stream. Neither can see anything the
 * other cannot, and neither can influence the run.
 */

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  fingerprintExecutable,
  fingerprintSuite,
  formatBench,
  formatTrials,
  loadSuite,
  runSuite,
  runTrials,
} from "./bench.js";
import { NativeCodec, TextCodec } from "./codecs.js";
import {
  comparePolyglotReports,
  comparePolyglotWithLittleCoder,
  formatCrossAgentComparison,
  formatPolyglotComparison,
  loadPolyglotReport,
} from "./compare.js";
import { type ContextItem, type ContextReceipt, compile, scoreFiles } from "./context.js";
import { execBounded, resolveCommandInvocation } from "./exec.js";
import { projectInstructionItems } from "./instructions.js";
import { streamNative } from "./native.js";
import { load as loadObject, store as storeObject } from "./objects.js";
import { runPolyglot } from "./polyglot.js";
import { boundTurnIntent, renderTurn, type TurnIntent, textProtocolPrompt } from "./protocol.js";
import {
  DEFAULT_PROVIDER,
  discoverModel,
  type Message,
  type ProviderConfig,
  streamCompletion,
} from "./provider.js";
import { banner, renderHeadless, renderInteractive, useColor, useTruecolor } from "./render.js";
import {
  formatReport,
  loadTraces,
  resumeTranscript,
  score,
  TRACES_SUBDIRECTORY,
  traceFileFor,
} from "./replay.js";
import {
  type ActionResult,
  ApprovalPolicy,
  type Decision,
  Run,
  type RunEvent,
  replay,
} from "./runtime.js";
import { newSessionId, SessionStore } from "./session.js";
import { summarize, TurnMeter, type TurnUsage } from "./usage.js";
import { detectCommands, formatForModel, verify } from "./verify.js";
import { FORGE_VERSION } from "./version.js";
import { resolveInside, revisionOf, Workspace } from "./workspace.js";

export interface IO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const consoleIO: IO = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

const USAGE = [
  "forge — a coding agent for local and small models",
  "",
  "  forge                    interactive chat in the current directory",
  "  forge run <task>         one shot, exits 0 on success",
  "  forge replay [path]      score the decoder on recorded turns — offline, free",
  "  forge sessions           what has been run here",
  "  forge show <id>          replay a recorded session",
  "  forge undo [id]          put back what a session changed (default: the last)",
  "  forge bench [suite]      run a task suite and judge it independently",
  "  forge polyglot <dataset> run/resume the full Aider Polyglot benchmark",
  "  forge compare <a> <b>    paired comparison of two Polyglot report.json files",
  "  forge compare-little-coder <forge> <little-coder> <cases>",
  '      --agent "<cmd {task}>"  bench another agent on the same tasks',
  "      --trials <n>         repeat the suite n times and report the spread",
  "      --name <label>       stable subject label written into the report",
  "      --model-digest <id>  exact weights/build digest for reproducibility",
  "      --per-language <n>   deterministic evenly spaced cases per language",
  "      --discover           fast idea screen: 2/language, 1 try, 8 turns",
  "      --jobs <n>            run independent Polyglot cases concurrently",
  "",
  "  --model <name>           model id            (FORGE_MODEL)",
  "  --url <base>             OpenAI-compatible base url  (FORGE_URL)",
  "  --context <tokens>       declared context window, sizes the reply budget",
  "  --max-tokens <n>         explicit reply-token budget (0 = derive)",
  "  --temperature <n>        sampling temperature (default 0.1)",
  "  --max-turns <n>          headless action-turn limit (default 12)",
  "  --task-packet            include bounded exercise docs in initial context",
  "  --batch-actions          invite bounded independent actions in one reply",
  "  --yes                    approve every action (headless, CI)",
  "  --no-verify              skip the verification gate on completion",
  "  --native                 use the provider's tool-calling instead of the text protocol",
  "  --json                   machine-readable output",
  "  --version                print the installed Forge version",
].join("\n");

/**
 * Project configuration, and a loud complaint about the file people expect.
 *
 * `forge.json` is read for `url`, `model` and `verify`. `forge.yaml` is *not*
 * -- reading YAML would mean a parser dependency for four keys -- but a user
 * who writes one is not wrong to expect it to work, and silently ignoring it
 * is the worst outcome available: their settings appear to be in effect and
 * are not. Observed: the first person handed this CLI wrote a `forge.yaml` in
 * every project before doing anything else.
 */
interface ProjectConfig {
  readonly url?: string;
  readonly model?: string;
  readonly verify?: string[][];
}

function projectConfig(root: string, io: IO): ProjectConfig {
  if (existsSync(path.join(root, "forge.yaml")) || existsSync(path.join(root, "forge.yml"))) {
    io.err('forge.yaml is not read. Use forge.json: { "url", "model", "verify" }.');
  }
  const file = path.join(root, "forge.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ProjectConfig;
    return parsed;
  } catch (error) {
    // Named, not swallowed. A configuration file that fails to parse is a
    // question the user asked and got no answer to.
    io.err(`forge.json could not be read: ${error instanceof Error ? error.message : "invalid"}`);
    return {};
  }
}

function providerFrom(options: Record<string, string | boolean>): ProviderConfig {
  const integer = (key: string, fallback: number): number => {
    const raw = options[key];
    const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const number = (key: string, fallback: number): number => {
    const raw = options[key];
    const parsed = typeof raw === "string" ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    ...DEFAULT_PROVIDER,
    baseUrl:
      (typeof options["url"] === "string" ? options["url"] : undefined) ??
      process.env["FORGE_URL"] ??
      DEFAULT_PROVIDER.baseUrl,
    model:
      (typeof options["model"] === "string" ? options["model"] : undefined) ??
      process.env["FORGE_MODEL"] ??
      DEFAULT_PROVIDER.model,
    temperature: number("temperature", DEFAULT_PROVIDER.temperature),
    maxTokens: integer("max-tokens", DEFAULT_PROVIDER.maxTokens),
    contextWindow: integer("context", DEFAULT_PROVIDER.contextWindow),
  };
}

export function positiveIntegerOption(
  value: string | boolean | undefined,
  fallback: number,
): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function transcriptBudgetChars(
  config: Pick<ProviderConfig, "contextWindow" | "maxTokens">,
): number {
  const window = config.contextWindow > 0 ? config.contextWindow : 48_000;
  const replyReserve = config.maxTokens > 0 ? config.maxTokens : 4_096;
  return Math.max(32_000, Math.floor(Math.max(8_000, window - replyReserve) * 2.5));
}

/** Keep stable setup plus the newest turns under a conservative token estimate. */
export function boundTranscript(messages: readonly Message[], budgetChars: number): Message[] {
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= budgetChars) return [...messages];

  const fixed = messages.slice(0, Math.min(2, messages.length));
  const fixedCost = fixed.reduce((sum, message) => sum + message.content.length, 0);
  const notice =
    "Earlier turns were omitted by the context guard. Trust the current files and recent tool results.";
  let remaining = Math.max(0, budgetChars - fixedCost - notice.length);
  const recent: Message[] = [];
  for (let index = messages.length - 1; index >= fixed.length; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.content.length > remaining) break;
    recent.unshift(message);
    remaining -= message.content.length;
  }
  return [...fixed, { role: "user", content: notice }, ...recent];
}

function parseArgs(argv: readonly string[]): {
  command: string | null;
  rest: string[];
  options: Record<string, string | boolean>;
} {
  const options: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let command: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[name] = next;
        index += 1;
      } else {
        options[name] = true;
      }
      continue;
    }
    if (command === null) command = token;
    else rest.push(token);
  }
  return { command, rest, options };
}

/**
 * A shallow listing, as the model's first sight of the repository.
 *
 * Placeholder for the context compiler: it is a flat list, unranked, bounded by
 * count rather than by tokens. Named as a gap rather than left to be discovered
 * -- retrieval quality is the largest single lever on small-model performance
 * and this is the crudest possible version of it.
 */
function listing(root: string, limit = 200): string {
  const skip = new Set([".git", "node_modules", "dist", ".venv", "__pycache__", ".forge"]);
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= limit || depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (skip.has(name) || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
        else if (found.length < limit) found.push(path.relative(root, full));
      } catch {
        // Unreadable entries are simply not listed.
      }
    }
  };
  walk(root, 0);
  return found.join("\n");
}

/**
 * The stable half of the prompt: the protocol and the rules, and nothing that
 * depends on the task.
 *
 * The repository used to be pasted in here, which was wrong twice over. It made
 * the system prompt change with the directory, defeating any prompt cache the
 * endpoint keeps; and it was the *same* listing whatever the task was, so the
 * one part of the prompt that should respond to what was asked never did.
 */
export function systemPrompt(native = false, batchActions = false): string {
  return [
    "You are a careful coding agent working inside a single repository.",
    "",
    // A model given native tools does not need the text protocol described, and
    // describing both invites it to mix them: half a tool call and half a
    // SEARCH block decodes to neither.
    ...(native ? [] : [textProtocolPrompt(), ""]),
    "Rules:",
    "- Read a file before you edit it.",
    ...(batchActions
      ? [
          "- Batch independent reads and searches when that saves a turn.",
          "- You may send several small edits only for files whose exact current",
          "  contents you have already seen. Never mix a new read with a blind edit.",
        ]
      : ["- One small edit per reply. Large replies get truncated and are wasted."]),
    "- Never invent file contents. If you have not read it, read it.",
    "- Before editing a non-stub implementation, run the narrowest relevant test",
    "  once. If it already passes, preserve the working code.",
    "- A missing test runner or dependency is setup failure, not a failing test.",
    "  Set up the repository and rerun the test before editing implementation code.",
    // Underspecified requests are where a small model does the most damage,
    // and it does it confidently. Asked to "make it better", the 30B added two
    // functions nobody mentioned, a default export, and edits to package.json.
    // None of it was wrong; none of it was asked for, and all of it has to be
    // read and undone by someone.
    "- Do the smallest thing that satisfies the request. Do not add functions,",
    "  exports, files or configuration that were not asked for.",
    "- If the request is ambiguous, make the narrowest reasonable change and say",
    "  in your DONE line what you assumed, rather than doing several things.",
  ].join("\n");
}

// Star globs only -- enough for "*.ts" and a recursive directory prefix, which
// is what actually gets asked for. A line comment, not a block one: a glob
// example containing a star followed by a slash closes a block comment early,
// which has now cost me three separate debugging sessions in one night.
function globMatches(pattern: string, candidate: string): boolean {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  try {
    return new RegExp(`^${source}$`).test(candidate);
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Files small enough that showing one is cheaper than a round trip to read it. */
const INLINE_FILE_MAX_CHARS = 6_000;
/**
 * Times a passing suite must pass before the completion gate believes it.
 *
 * Two, not more: one contradiction is enough to prove a pass does not
 * reproduce, and every extra round is paid on the success path of every run.
 */
const VERIFY_CONFIRMATIONS = 2;

/**
 * Local files that an inlined file imports.
 *
 * A bug is frequently not in the file the task names. Asked to fix a failing
 * price calculation, the model was shown `price.js` -- which computes correctly
 * -- while the wrong constant sat in the `config.js` it imports, unnamed by the
 * task and therefore unranked by a lexical scorer. forge spent 250 seconds per
 * run failing that, against 17 for a competitor that can grep.
 *
 * Following one level of local imports is the cheap general form of what that
 * grep does: if a file is worth showing, what it depends on usually is too.
 * One level, not transitive -- depth two on a real project pulls in the world.
 *
 * Relative specifiers only. A package import leads to node_modules, which is
 * never the answer and is always enormous.
 */
function localImports(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) found.add(specifier);
  }
  return [...found];
}

/**
 * The task-dependent half: which files matter for *this* request.
 *
 * Ranked rather than dumped, and the top few are inlined whole. Inlining is the
 * point. A small model that is handed the file it needs can edit on turn one;
 * one handed a list of names has to spend a turn on READ, and every extra turn
 * is another chance to truncate, to guess an anchor, or to forget what it was
 * doing. The budget stops that from becoming "paste the whole repository".
 *
 * Returns the receipt too, so `/context` can show what was chosen and what just
 * missed the cut. A retrieval change nobody can inspect is a retrieval change
 * nobody can defend.
 */
export function taskContext(
  workspace: Workspace,
  task: string,
  budgetChars: number,
  taskPacket = false,
): { text: string; receipt: ContextReceipt } {
  const paths = listing(workspace.root).split("\n").filter(Boolean);
  const ranked = scoreFiles(paths, task);
  const inlineBudget = Math.floor(budgetChars * 0.7);
  let inlined = 0;
  const inlinedPaths = new Set<string>();

  // "the tests fail — find and fix the bug" names no file, so a lexical scorer
  // gives every candidate zero and nothing is inlined — the model is handed a
  // list of names and must spend turns reading. That was 250 seconds per run on
  // exactly such a task, against 17 for a competitor that can grep.
  //
  // So when nothing matched, everything is a candidate: the budget decides
  // rather than the score. On a repository too large for that the budget bites
  // immediately and this costs nothing; on a small one it hands over the whole
  // problem at once, which is the case where a small model does best.
  const nothingMatched = ranked.every((item) => item.score <= 0);

  const items = ranked.map((item) => {
    const relative = item.path ?? item.text;
    // Only files the query matched are worth their contents -- unless nothing
    // matched at all, in which case withholding them helps no one.
    if ((item.score <= 0 && !nothingMatched) || inlined >= inlineBudget) {
      return item;
    }
    let contents: string;
    try {
      contents = workspace.read(relative);
    } catch {
      return item;
    }
    if (contents.length > INLINE_FILE_MAX_CHARS) {
      return item;
    }
    inlined += contents.length;
    inlinedPaths.add(relative);
    return {
      ...item,
      kind: "file" as const,
      text: `${relative} — exact contents, quote from this and nothing else:\n${contents}`,
      reason: `${item.reason}; inlined ${contents.length} chars`,
    };
  });

  // Pull in what the inlined files import, before the listing, so a dependency
  // competes for budget on its own merit rather than as an afterthought.
  const alreadyInlined = new Set(inlinedPaths);
  const followed: ContextItem[] = [];
  for (const item of items) {
    if (item.kind !== "file" || item.path === undefined || !inlinedPaths.has(item.path)) continue;
    for (const specifier of localImports(item.text)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(item.path), specifier));
      const candidate = paths.find(
        (known) => known === base || known === `${base}.js` || known === `${base}.ts`,
      );
      if (candidate === undefined || alreadyInlined.has(candidate)) continue;
      let contents: string;
      try {
        contents = workspace.read(candidate);
      } catch {
        continue;
      }
      if (contents.length > INLINE_FILE_MAX_CHARS) continue;
      alreadyInlined.add(candidate);
      followed.push({
        id: `import:${candidate}`,
        kind: "file",
        path: candidate,
        text: `${candidate} — exact contents, quote from this and nothing else:\n${contents}`,
        mandatory: false,
        // Just below its importer: included when the importer is, dropped
        // first when the budget is tight.
        score: Math.max(1, item.score - 1),
        reason: `imported by ${item.path}`,
      });
    }
  }
  items.push(...followed);

  const instructions = projectInstructionItems(workspace.root, task);
  const packet = taskPacket ? taskPacketItems(workspace, task) : [];

  const listingItem = {
    id: "listing",
    kind: "listing" as const,
    text: `Files in ${path.basename(workspace.root)}:\n${paths.join("\n")}`,
    mandatory: true,
    score: 0,
    reason: "the repository is always visible",
  };
  return compile([listingItem, ...instructions, ...packet, ...items], budgetChars);
}

/** Known student-facing specification files hidden behind dot-directory listing rules. */
function taskPacketItems(workspace: Workspace, task: string): ContextItem[] {
  if (!/\b(exercise|implement|specification|requirements?|tests?)\b/i.test(task)) return [];
  return [".docs/introduction.md", ".docs/instructions.md", ".docs/instructions.append.md"].flatMap(
    (relative, index) => {
      try {
        const contents = workspace.read(relative);
        if (!contents.trim()) return [];
        return [
          {
            id: `packet:${relative}`,
            kind: "instruction" as const,
            path: relative,
            text: `${relative} — task specification:\n${contents}`,
            mandatory: false,
            score: 800 - index,
            reason: "known student-facing exercise specification",
          },
        ];
      } catch {
        return [];
      }
    },
  );
}

/** Executes the non-edit tools. Reads are unrestricted inside the workspace. */
function makeTools(workspace: Workspace, signal?: AbortSignal) {
  return {
    // Keeps the bytes every edit replaced, so `forge undo` has something to
    // restore from. Content-addressed, so an unchanged file body costs nothing
    // however many times it is edited around.
    retain: (content: string) => storeObject(workspace.root, content),
    runTool: async (proposal: {
      kind: string;
      tool?: string;
      arguments?: Record<string, unknown>;
    }) => {
      const args = proposal.arguments ?? {};
      try {
        if (proposal.tool === "read") {
          // Verbatim, with no line-number gutter. The model has to quote an
          // exact anchor back in a SEARCH block, and every character it must
          // strip first is a chance to get it wrong.
          const target = String(args["path"]);
          // Framed as authoritative. A small model that has already guessed at
          // a file's contents will otherwise keep trusting its guess.
          return {
            ok: true,
            output: `${target} — exact contents, quote from this and nothing else:\n${workspace.read(target)}`,
          };
        }
        if (proposal.tool === "list") {
          return { ok: true, output: listing(workspace.root) };
        }
        if (proposal.tool === "grep") {
          const pattern = String(args["pattern"] ?? "");
          const literal = args["literal"] === true;
          const flags = args["ignoreCase"] === true ? "i" : "";
          const context = typeof args["context"] === "number" ? args["context"] : 0;
          const globPattern = typeof args["glob"] === "string" ? args["glob"] : undefined;
          let matcher: RegExp;
          try {
            // An invalid regex is the model's mistake to hear about, not an
            // exception to crash on -- and falling back to a literal search
            // silently would answer a different question than the one asked.
            matcher = new RegExp(literal ? escapeRegExp(pattern) : pattern, flags);
          } catch (error) {
            return {
              ok: false,
              output: `not a valid regular expression: ${error instanceof Error ? error.message : "invalid"}. Set literal true to search for it as plain text.`,
            };
          }
          const hits: string[] = [];
          for (const relative of listing(workspace.root).split("\n")) {
            if (!relative) continue;
            if (globPattern !== undefined && !globMatches(globPattern, relative)) continue;
            const target = resolveInside(workspace.root, relative);
            if (target === null || !existsSync(target)) continue;
            let lines: string[];
            try {
              lines = readFileSync(target, "utf8").split("\n");
            } catch {
              continue;
            }
            lines.forEach((line, index) => {
              if (!matcher.test(line)) return;
              const from = Math.max(0, index - context);
              const to = Math.min(lines.length - 1, index + context);
              for (let n = from; n <= to; n += 1) {
                hits.push(`${relative}:${n + 1}${n === index ? ":" : "-"} ${lines[n] ?? ""}`);
              }
            });
            if (hits.length > 200) break;
          }
          return {
            ok: true,
            output: hits.slice(0, 200).join("\n") || `no match for ${pattern}`,
          };
        }
        if (proposal.tool === "search") {
          const needle = String(args["query"]);
          const hits: string[] = [];
          for (const relative of listing(workspace.root).split("\n")) {
            if (!relative) continue;
            const target = resolveInside(workspace.root, relative);
            if (target === null || !existsSync(target)) continue;
            readFileSync(target, "utf8")
              .split("\n")
              .forEach((line, index) => {
                if (line.includes(needle)) hits.push(`${relative}:${index + 1}: ${line.trim()}`);
              });
            if (hits.length > 100) break;
          }
          return { ok: true, output: hits.join("\n") || `no match for ${needle}` };
        }
        if (proposal.tool === "run") {
          // The command reaches here only after the approval gate: for `run`
          // the human is the allowlist. How it executes is still bounded --
          // token array, no shell, group-killed on timeout, output capped.
          const command = args["command"];
          if (!Array.isArray(command) || command.some((t) => typeof t !== "string")) {
            return { ok: false, output: "run needs a token array, e.g. RUN npm test" };
          }
          const invocation = resolveCommandInvocation(command as string[], workspace.root);
          if (!invocation.ok) return { ok: false, output: invocation.output };
          const result = await execBounded(invocation.command, {
            cwd: invocation.cwd,
            signal,
          });
          const prefix = invocation.notice === null ? "" : `${invocation.notice}\n`;
          if (result.timedOut) {
            return {
              ok: false,
              output: `${prefix}timed out after ${result.seconds.toFixed(0)}s\n${result.output}`,
            };
          }
          const status = result.code === 0 ? "exit 0" : `exit ${result.code}`;
          return { ok: result.code === 0, output: `${prefix}${status}\n${result.output}` };
        }
        return {
          ok: false,
          output: `the ${String(proposal.tool)} tool is not available in this build`,
        };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * Drive one turn: stream, decode incrementally, hand the turn to the run.
 *
 * Decoding as the bytes arrive is what lets a proposal be shown while the model
 * is still talking. Nothing is *applied* until the turn completes and the user
 * approves, so an incremental view never becomes an incremental effect.
 */
async function oneTurn(
  run: Run,
  config: ProviderConfig,
  messages: Message[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  tracePath: string | null,
  native: boolean,
  batchActions: boolean,
): Promise<{
  text: string;
  final: string | null;
  results: ActionResult[];
  finished: boolean;
  /** The run produced no action for several turns and should stop. */
  stalled: boolean;
  guardNotice: string | null;
  committedMutation: boolean;
  ranCommand: boolean;
}> {
  // Which codec is a per-endpoint decision, not a belief about which is better.
  // Text wins for weak models -- it removes the JSON escaping that dominates
  // their truncation failures -- and native wins where the provider constrains
  // generation to the schema. Both decode to the same ActionProposal, so
  // nothing below this line can tell which ran.
  let raw = "";
  let turn: TurnIntent;
  const requestMessages = boundTranscript(messages, transcriptBudgetChars(config));
  if (native) {
    const codec = new NativeCodec();
    for await (const delta of streamNative(config, requestMessages, { signal })) {
      if (delta.text) {
        raw += delta.text;
        onDelta(delta.text);
      }
      codec.feed(delta);
    }
    turn = codec.finish();
  } else {
    const codec = new TextCodec();
    for await (const delta of streamCompletion(config, requestMessages, { signal })) {
      raw += delta;
      codec.feed(delta);
      onDelta(delta);
    }
    turn = codec.finish();
  }
  const decodedProposalCount = turn.proposals.length;
  const bounded = boundTurnIntent(
    turn,
    batchActions
      ? { proposals: 12, runs: 3, mutations: 2 }
      : { proposals: 8, runs: 2, mutations: 1 },
  );
  turn = bounded.turn;

  // FORGE_TRACE writes the exact bytes the model produced, per turn. This is
  // the first piece of the reliability laboratory: when a run misbehaves, the
  // question "what did the model actually say" must never be answered by
  // reconstruction.
  // Recorded unconditionally, not behind a flag. A corpus you have to remember
  // to switch on is empty exactly when you need it -- after the run that went
  // wrong. One line per turn is cheap, and `.forge/` is gitignored.
  for (const target of [tracePath, process.env["FORGE_TRACE"]]) {
    if (!target) continue;
    try {
      appendFileSync(
        target,
        `${JSON.stringify({ raw, proposals: turn.proposals, decodedProposalCount, droppedProposalCount: bounded.dropped, repairs: turn.repairs, final: turn.final })}\n`,
        "utf8",
      );
    } catch {
      // Recording is diagnostics. A full disk or a read-only checkout must not
      // take the run down with it.
    }
  }
  const outcome = await run.submit({ ...turn, repairs: turn.repairs });
  // The transcript gets the *canonical* rendering, not `raw`. See renderTurn.
  return {
    text: renderTurn(turn),
    final: turn.final,
    results: outcome.results,
    finished: outcome.finished,
    stalled: outcome.stalled === true,
    guardNotice: bounded.notice,
    committedMutation: outcome.results.some(
      (result) => result.ok && result.output.startsWith("applied "),
    ),
    ranCommand: turn.proposals.some(
      (proposal) => proposal.kind === "call" && proposal.tool === "run",
    ),
  };
}

export async function main(argv: readonly string[], io: IO = consoleIO): Promise<number> {
  const { command, rest, options } = parseArgs(argv);
  if (options["version"] === true || command === "version") {
    io.out(FORGE_VERSION);
    return 0;
  }
  if (options["help"] === true || command === "help") {
    io.out(USAGE);
    return 0;
  }

  const root = path.resolve(typeof options["repo"] === "string" ? options["repo"] : ".");
  const workspace = new Workspace(root);
  const offline =
    command === "replay" ||
    command === "compare" ||
    command === "compare-little-coder" ||
    command === "sessions" ||
    command === "show" ||
    command === "undo";
  const project = projectConfig(root, io);
  let config = providerFrom(options);
  // Precedence: an explicit flag or environment variable beats the project
  // file, which beats the default. The flag has to win, or `--url` could not
  // override a config that someone checked in.
  if (project.url && typeof options["url"] !== "string" && !process.env["FORGE_URL"]) {
    config = { ...config, baseUrl: project.url };
  }
  if (project.model && typeof options["model"] !== "string" && !process.env["FORGE_MODEL"]) {
    config = { ...config, model: project.model };
  }
  if (!config.model && !offline) {
    // Nothing configured: ask the endpoint what it serves. A local server
    // nearly always serves exactly one model, and naming it in config goes
    // stale the day the server flag changes.
    const discovered = await discoverModel(config);
    if (discovered === null) {
      io.err(
        `No model reachable at ${config.baseUrl}. Is the server running? (--url or FORGE_URL to change)`,
      );
      return 2;
    }
    config = { ...config, model: discovered };
  }
  // `auto` means text, and says why: the text surface is what removes the JSON
  // escaping that dominates a small model's truncation failures, and this
  // package's measured evidence is all on that path. `--native` opts into the
  // provider's own tool-calling for endpoints that constrain generation to the
  // schema. Neither is claimed to be better in general.
  const native = options["native"] === true;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  if (command === "compare") {
    const [baselineFile, candidateFile] = rest;
    if (baselineFile === undefined || candidateFile === undefined) {
      io.err("forge compare needs baseline and candidate report.json paths.");
      return 2;
    }
    try {
      const comparison = comparePolyglotReports(
        loadPolyglotReport(path.resolve(baselineFile)),
        loadPolyglotReport(path.resolve(candidateFile)),
      );
      io.out(
        options["json"] === true
          ? JSON.stringify(comparison, null, 2)
          : formatPolyglotComparison(comparison),
      );
      return 0;
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === "compare-little-coder") {
    const [forgeFile, littleCoderFile, manifestFile] = rest;
    if (forgeFile === undefined || littleCoderFile === undefined || manifestFile === undefined) {
      io.err(
        "forge compare-little-coder needs Forge report, Little Coder report, and case manifest paths.",
      );
      return 2;
    }
    try {
      const comparison = comparePolyglotWithLittleCoder(
        loadPolyglotReport(path.resolve(forgeFile)),
        path.resolve(littleCoderFile),
        path.resolve(manifestFile),
      );
      io.out(
        options["json"] === true
          ? JSON.stringify(comparison, null, 2)
          : formatCrossAgentComparison(comparison),
      );
      return 0;
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === "sessions") {
    const store = new SessionStore(root);
    const found = store.list();
    if (found.length === 0) {
      io.out("No sessions recorded here.");
      return 0;
    }
    for (const entry of found.slice(0, 20)) {
      const state = entry.finished ? (entry.ok ? "ok" : "failed") : "unfinished";
      io.out(
        `${entry.id}  ${String(entry.committed).padStart(2)} committed  ${state.padEnd(10)} ${entry.task.slice(0, 60)}`,
      );
    }
    return 0;
  }
  if (command === "show") {
    const id = rest[0];
    if (id === undefined) {
      io.err("forge show needs a session id. `forge sessions` lists them.");
      return 2;
    }
    const journal = new SessionStore(root).load(id);
    if (journal === null) {
      io.err(`No such session: ${id}`);
      return 2;
    }
    // Replayed through the same renderer the live run used, so what you read
    // afterwards is what you would have read at the time. A separate "history
    // formatter" would be a second thing to keep in step, and the one that
    // drifts is always the one nobody watches.
    for (const event of journal.all()) {
      const line = renderHeadless(event);
      if (line !== null) io.out(line);
    }
    const state = replay(journal);
    io.out("");
    io.out(
      `${state.committed.length} file(s) changed · ${state.turn} turns · ${state.done ? (state.ok ? "ok" : "failed") : "unfinished"}`,
    );
    return state.ok ? 0 : 1;
  }
  if (command === "bench") {
    const suite = path.resolve(rest[0] ?? path.join(root, "bench"));
    const tasks = loadSuite(suite);
    if (tasks.length === 0) {
      io.err(`No tasks in ${suite}. A task is a directory with task.json and repo/.`);
      return 2;
    }
    // With --json, stdout must be exactly one parseable document. Progress is
    // still worth seeing during a run that takes minutes, so it goes to stderr
    // rather than being suppressed: `forge bench --json > out.json` then shows
    // live progress on the terminal AND leaves a file a script can read.
    const asJson = options["json"] === true;
    const progress = asJson ? io.err : io.out;
    progress(`${tasks.length} tasks · ${suite}`);
    const trials = Number.parseInt(
      typeof options["trials"] === "string" ? options["trials"] : "1",
      10,
    );
    const binary = process.argv[1] ?? "forge";
    const agentCommand =
      typeof options["agent"] === "string"
        ? options["agent"].split(" ").filter(Boolean)
        : undefined;
    const flags = [
      ...(options["no-verify"] === true ? ["--no-verify"] : []),
      ...(native ? ["--native"] : []),
      ...(options["batch-actions"] === true ? ["--batch-actions"] : []),
      ...(config.contextWindow > 0 ? ["--context", String(config.contextWindow)] : []),
      ...(config.maxTokens > 0 ? ["--max-tokens", String(config.maxTokens)] : []),
      ...["--temperature", String(config.temperature)],
      ...(typeof options["max-turns"] === "string"
        ? ["--max-turns", String(positiveIntegerOption(options["max-turns"], 12))]
        : []),
    ];
    const commandTemplate = agentCommand ?? [
      "node",
      binary,
      "run",
      "{task}",
      "--yes",
      "--json",
      ...flags,
    ];
    const identity = {
      subject:
        typeof options["name"] === "string"
          ? options["name"]
          : agentCommand === undefined
            ? "forge"
            : "external-agent",
      suiteFingerprint: fingerprintSuite(tasks),
      executableFingerprint:
        agentCommand === undefined
          ? fingerprintExecutable(binary)
          : fingerprintExecutable(agentCommand[0] ?? ""),
      command: commandTemplate,
      model: config.model || null,
      modelDigest: typeof options["model-digest"] === "string" ? options["model-digest"] : null,
      endpoint: config.baseUrl,
      nativeProtocol: native,
      batchActions: options["batch-actions"] === true,
    };
    const runOptions = {
      binary,
      url: config.baseUrl,
      model: config.model,
      // Passed straight through, so `--no-verify` measures what the gate
      // contributes by comparing two runs of the same suite.
      flags,
      // `--agent "cmd arg {task} arg"` benches something other than forge on
      // exactly these tasks, judged by exactly these checks.
      ...(agentCommand === undefined ? {} : { agentCommand }),
      identity,
      onProgress: (line: string) => progress(line),
      // Failures keep their whole working copy — traces, session journal and
      // the files as the agent left them. `FAIL` on its own is not a lead.
      keepFailures: path.join(root, ".forge", "bench-failures"),
    };
    if (trials > 1) {
      const summary = await runTrials(tasks, runOptions, trials);
      io.out(asJson ? JSON.stringify(summary, null, 2) : formatTrials(summary));
      // Any task that ever failed is a failure. A suite that passes on average
      // is not a suite that passes.
      return summary.minPassed === summary.total ? 0 : 1;
    }
    const report = await runSuite(tasks, runOptions);
    io.out(asJson ? JSON.stringify(report, null, 2) : formatBench(report));
    // Exit 1 on any failure, so a bench is usable as a gate and not only as a
    // report. The false-success count does not change the exit code: it is
    // already a failure by the only verdict that counts.
    return report.passed === report.total ? 0 : 1;
  }
  if (command === "polyglot") {
    const dataset = rest[0];
    const name = typeof options["name"] === "string" ? options["name"] : "";
    if (dataset === undefined || !name) {
      io.err("forge polyglot needs a dataset path and --name <stable-run-name>.");
      return 2;
    }
    const commaList = (key: string): string[] =>
      typeof options[key] === "string"
        ? options[key]
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    try {
      const output = path.join(root, ".forge", "benchmarks", "polyglot", name);
      const discovery = options["discover"] === true;
      const report = await runPolyglot({
        dataset: path.resolve(dataset),
        output,
        binary: process.argv[1] ?? "forge",
        model: config.model,
        ...(typeof options["model-digest"] === "string"
          ? { modelDigest: options["model-digest"] }
          : {}),
        endpoint: config.baseUrl,
        temperature: config.temperature,
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        nativeProtocol: native,
        taskPacket: options["task-packet"] === true,
        batchActions: options["batch-actions"] === true,
        discovery,
        languages: commaList("language"),
        cases: commaList("case"),
        smoke: options["smoke"] === true,
        limit: positiveIntegerOption(options["limit"], 0),
        ...(typeof options["per-language"] === "string"
          ? { perLanguage: positiveIntegerOption(options["per-language"], discovery ? 2 : 0) }
          : {}),
        batchSize: positiveIntegerOption(options["batch-size"], 0),
        jobs: positiveIntegerOption(options["jobs"], 1),
        tries: positiveIntegerOption(options["tries"], discovery ? 1 : 2),
        firstTurns: positiveIntegerOption(options["first-turns"], discovery ? 8 : 12),
        retryTurns: positiveIntegerOption(options["retry-turns"], 8),
        ...(typeof options["timeout"] === "string"
          ? { timeoutSeconds: positiveIntegerOption(options["timeout"], 900) }
          : {}),
        onProgress: io.err,
      });
      if (options["json"] === true) io.out(JSON.stringify(report, null, 2));
      else {
        io.out(
          `${report.passedCaseCount}/${report.completedCaseCount} passed · first attempt ${report.firstAttemptPassCount} · ${report.incomplete ? "incomplete" : "complete"}`,
        );
        io.out(`report: ${path.join(output, "report.json")}`);
      }
      return report.infrastructureErrorCount > 0 ? 2 : 0;
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (command === "undo") {
    const store = new SessionStore(root);
    const id = rest[0] ?? store.list()[0]?.id;
    if (id === undefined) {
      io.err("Nothing to undo — no sessions recorded here.");
      return 2;
    }
    const journal = store.load(id);
    if (journal === null) {
      io.err(`No such session: ${id}`);
      return 2;
    }
    const mutations = journal.all().filter((event) => event.type === "mutation.committed");
    if (mutations.length === 0) {
      io.out(`Session ${id} changed nothing.`);
      return 0;
    }
    const workspace = new Workspace(root);
    let restored = 0;
    let skipped = 0;
    // Reverse order, because two edits to one file must be unwound newest
    // first: replaying them oldest-first would leave the file at its
    // intermediate state rather than at its original one.
    for (const event of [...mutations].reverse()) {
      if (event.type !== "mutation.committed") continue;
      const target = resolveInside(workspace.root, event.path);
      if (target === null) {
        io.err(`  ✗ ${event.path} is outside the workspace`);
        skipped += 1;
        continue;
      }
      if (event.afterRevision === undefined) {
        io.err(`  ✗ ${event.path} — session predates safe undo metadata`);
        skipped += 1;
        continue;
      }
      if (revisionOf(target) !== event.afterRevision) {
        io.err(`  ✗ ${event.path} changed since this session; left untouched`);
        skipped += 1;
        continue;
      }
      if (event.beforeRevision === null) {
        // A creation. Undoing it means removing the file -- but only if it is
        // still the file that was created. Anything else and the user has
        // worked on it since, and deleting their work is not an undo.
        try {
          rmSync(target);
          io.out(`  ✓ removed ${event.path}`);
          restored += 1;
        } catch {
          io.err(`  ✗ ${event.path} could not be removed`);
          skipped += 1;
        }
        continue;
      }
      const content = loadObject(workspace.root, event.beforeRevision);
      if (content === null) {
        io.err(`  ✗ ${event.path} — the replaced content was not recorded`);
        skipped += 1;
        continue;
      }
      writeFileSync(target, content, "utf8");
      io.out(`  ✓ restored ${event.path}`);
      restored += 1;
    }
    io.out(`${restored} restored, ${skipped} skipped — session ${id}`);
    return skipped === 0 ? 0 : 1;
  }
  if (command === "replay") {
    const source = rest[0] ?? path.join(root, TRACES_SUBDIRECTORY);
    const records = [];
    for await (const record of loadTraces(source)) records.push(record);
    const report = score(records);
    io.out(options["json"] === true ? JSON.stringify(report, null, 2) : formatReport(report));
    // An empty corpus is not a pass. Exit 2 so a pre-commit hook running this
    // cannot silently succeed on a directory with nothing in it.
    return records.length === 0 ? 2 : 0;
  }
  if (command === "run") {
    return await headless(
      rest.join(" ").trim(),
      workspace,
      config,
      controller,
      options,
      io,
      native,
      project,
    );
  }
  if (command !== null) {
    io.err(`Unknown command: ${command}`);
    io.err(USAGE);
    return 2;
  }
  return await interactive(
    workspace,
    config,
    controller,
    io,
    native,
    project,
    options["task-packet"] === true,
    options["batch-actions"] === true,
  );
}

/**
 * The verification gate.
 *
 * Runs the project's own checks when the model says it is done, and treats the
 * result as authoritative over the model's claim. A model that has just failed
 * to make a change will still report success -- that is not a hypothetical, it
 * is the single most dangerous behaviour this package has observed -- so the
 * only trustworthy completion is one something else agreed with.
 *
 * Returns null when the run may finish, or the text to feed back when it may
 * not. An unconfigured project cannot be gated, and says so rather than
 * printing "verified" for the absence of evidence.
 */
async function gate(
  run: Run,
  workspace: Workspace,
  config: ProviderConfig,
  task: string,
  commands: string[][],
  signal: AbortSignal,
  io: IO,
  quiet: boolean,
  native: boolean,
): Promise<string | null> {
  if (commands.length === 0) {
    // No test command exists, so there is nothing to outrank the claim with --
    // and a claim is not evidence. Benched against a task whose project had no
    // `scripts.test`, forge accepted "done", printed "unchecked", and was
    // wrong; a competing agent on the same model and the same task got it
    // right. Trusting the model was the wrong default, and "I told you it was
    // unchecked" is not a defence when the exit code still said success.
    //
    // The substitute is weaker than tests and much better than nothing: read
    // back what was actually written and judge it against the original
    // request, with the file in front of you rather than from memory of having
    // written it.
    if (!quiet) io.out("  ⋮ no test command found — re-reading the changes instead");
    return await reviewChanges(run, workspace, config, task, signal, native);
  }
  // Announced through the run's own event stream rather than printed here.
  // Printing directly raced the event subscriber and put this line above the
  // approval and commit it came after.
  run.verifying(commands.map((command) => command.join(" ")));
  // Confirm a pass before believing it. A suite that shares state between
  // parallel tests can pass by winning a race, and this gate also guards
  // candidate promotion -- so an unconfirmed pass can launder a bad change
  // into an accepted one. Only the success path repeats, so the cost is one
  // extra suite run on the finish that was about to be accepted anyway.
  const report = await verify(
    { commands, confirmations: VERIFY_CONFIRMATIONS },
    { cwd: workspace.root, signal },
  );
  run.verified(report.passed);
  return report.passed ? null : formatForModel(report);
}

async function headless(
  task: string,
  workspace: Workspace,
  config: ProviderConfig,
  controller: AbortController,
  options: Record<string, string | boolean>,
  io: IO,
  native: boolean,
  project: ProjectConfig,
): Promise<number> {
  if (!task) {
    io.err("forge run needs a task description.");
    return 2;
  }
  const run = new Run(
    { workspace, ...makeTools(workspace, controller.signal) },
    options["yes"] === true,
  );
  const asJson = options["json"] === true;
  const sessions = new SessionStore(workspace.root);
  const sessionId = newSessionId();
  const tracePath = traceFileFor(workspace.root, sessionId);
  const collected: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of run.events()) {
      collected.push(event);
      // Appended as it happens, not only saved at the end. The end is exactly
      // what a crash, a kill or a pulled terminal never reaches, and a session
      // that only exists once the run succeeds is no use for diagnosing the
      // runs that did not. The final save repairs any torn tail.
      sessions.appendTo(sessionId, event);
      if (!asJson) {
        const line = renderHeadless(event);
        if (line !== null) io.out(line);
      }
      // Without --yes there is nobody to ask, so an approval request is a
      // refusal rather than a hang.
      if (event.type === "approval.requested" && options["yes"] !== true) {
        run.send({ type: "approve", id: event.id, decision: "deny" });
      }
    }
  })();

  run.start(task);
  const context = taskContext(workspace, task, 24_000, options["task-packet"] === true);
  const messages: Message[] = [
    {
      role: "system",
      content: systemPrompt(native, options["batch-actions"] === true),
    },
    { role: "user", content: `${context.text}\n\n${task}` },
  ];
  let code = 1;
  const progress = new ProgressWatch();
  const commands =
    options["no-verify"] === true ? [] : (project.verify ?? detectCommands(workspace.root));
  const usages: TurnUsage[] = [];
  const maxTurns = positiveIntegerOption(options["max-turns"], 12);
  const verificationCadence = new VerificationCadence();
  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const meter = new TurnMeter(() => Date.now());
      meter.start();
      const result = await oneTurn(
        run,
        config,
        messages,
        controller.signal,
        (delta) => meter.delta(delta),
        tracePath,
        native,
        options["batch-actions"] === true,
      );
      usages.push(meter.finish());
      // Nothing is happening. Continuing would only spend the remaining turns
      // rediscovering that; the reason is already in the results above.
      if (result.stalled) break;
      if (result.finished) {
        const objection = await gate(
          run,
          workspace,
          config,
          task,
          commands,
          controller.signal,
          io,
          asJson,
          native,
        );
        if (objection === null) {
          code = 0;
          break;
        }
        // The model said done and the project disagreed. Its claim is
        // withdrawn and the failure goes back as the next observation.
        run.reopen();
        messages.push({ role: "assistant", content: result.text });
        messages.push({ role: "user", content: objection });
        continue;
      }
      progress.observe(result.results);
      verificationCadence.observe(result);
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: `${observationsFrom(result.results, result.guardNotice)}${progress.steer() ?? ""}${verificationCadence.steer() ?? ""}`,
      });
    }
  } catch (error) {
    run.fail(error instanceof Error ? error.message : String(error));
    code = 1;
  }
  run.close();
  await drained;
  sessions.save(sessionId, run.journal);
  const usage = summarize(usages);
  if (asJson) {
    const actions = collected.filter((event) => event.type === "action.proposed").length;
    io.out(
      JSON.stringify(
        { ok: code === 0, session: sessionId, usage: { ...usage, actions }, state: run.snapshot() },
        null,
        2,
      ),
    );
  } else {
    io.out(
      `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"} · ${usage.chars} chars · ${usage.seconds.toFixed(1)}s · ${usage.charsPerSecond.toFixed(0)} ch/s · session ${sessionId}`,
    );
  }
  return code;
}

/**
 * The chat loop.
 *
 * Three properties that make it a conversation rather than a sequence of
 * unrelated one-shots, each of which was absent in the first version:
 *
 * - **The transcript persists across messages.** "now add tests for that" has
 *   no referent otherwise, and rebuilding from a fresh system prompt each time
 *   makes every follow-up a non sequitur.
 * - **Standing approvals persist too.** "always allow edits" means for as long
 *   as the user is sitting there, not until their next message, so the policy
 *   is owned by the session and passed into each run.
 * - **Generation is visible.** A 30B at 130 tok/s spends five to twenty seconds
 *   per turn, and silence for that long reads as a hang.
 */
async function interactive(
  workspace: Workspace,
  config: ProviderConfig,
  controller: AbortController,
  io: IO,
  native: boolean,
  project: ProjectConfig,
  taskPacket: boolean,
  batchActions: boolean,
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin can end at any moment -- Ctrl-D, a pipe running dry, a closed
  // terminal -- including while an approval is pending. `rl.question` throws
  // ERR_USE_AFTER_CLOSE in that state, which crashed the process mid-run and
  // left the approval unanswered. An ended input is a refusal, not an error.
  // Deliberately *not* driven by readline's `close` event. On a non-TTY --
  // a pipe, a heredoc, a test -- readline reaches EOF and emits `close` while
  // buffered lines are still perfectly readable, so a flag set there refuses
  // input that exists and silently denied every approval in a piped session.
  // Asking and catching is the honest test of whether input is available.
  const ask = async (prompt: string): Promise<string | null> => {
    // Raced against `close`, not merely try/caught. A pending `rl.question`
    // when readline closes neither resolves nor rejects, so the await never
    // settles: Node drains the event loop and reports an unsettled top-level
    // await instead of exiting. Ctrl-D at the prompt did exactly that.
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        rl.off("close", onClose);
        resolve(value);
      };
      const onClose = (): void => finish(null);
      rl.once("close", onClose);
      rl.question(prompt).then(finish, () => finish(null));
    });
  };
  const policy = new ApprovalPolicy();
  const transcript: Message[] = [{ role: "system", content: systemPrompt(native, batchActions) }];
  const tty = process.stdout.isTTY === true;
  const sessions = new SessionStore(workspace.root);
  const sessionId = newSessionId();
  const tracePath = traceFileFor(workspace.root, sessionId);
  // A configured verify list beats detection: the user knows which command
  // means "this project is working" and the guess does not.
  let commands = project.verify ?? detectCommands(workspace.root);
  let lastReceipt: ContextReceipt | null = null;
  const contextBudget = 24_000;

  io.out("");
  io.out(
    banner({
      color: useColor(tty, process.env),
      width: process.stdout.columns ?? 80,
      truecolor: useTruecolor(process.env),
    }),
  );
  io.out("");
  io.out(`  ${path.basename(workspace.root)} · ${config.model}`);
  io.out("  /help for commands, /exit to leave");
  io.out("");

  try {
    for (;;) {
      const answer = await ask("› ");
      if (answer === null) break;
      const input = answer.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input === "/help") {
        io.out(SLASH_HELP);
        continue;
      }
      if (input === "/clear") {
        // Keep the system prompt; drop the history. The equivalent of starting
        // a fresh conversation without losing the repository context.
        transcript.length = 1;
        io.out("  conversation cleared");
        continue;
      }
      if (input === "/verify") {
        commands = detectCommands(workspace.root);
        io.out(
          commands.length === 0
            ? "  no verification command detected for this project"
            : `  ${commands.map((c: string[]) => c.join(" ")).join(", ")}`,
        );
        continue;
      }
      if (input === "/sessions") {
        const found = sessions.list().slice(0, 10);
        if (found.length === 0) io.out("  none recorded");
        for (const entry of found) {
          io.out(`  ${entry.id}  ${entry.committed} committed  ${entry.task.slice(0, 48)}`);
        }
        continue;
      }
      if (input.startsWith("/resume")) {
        const wanted = input.slice("/resume".length).trim();
        const store = new SessionStore(workspace.root);
        const id = wanted || store.list()[0]?.id;
        if (id === undefined) {
          io.out("  nothing recorded here to resume");
          continue;
        }
        const journal = store.load(id);
        if (journal === null) {
          io.out(`  no such session: ${id}`);
          continue;
        }
        const turns = [];
        for await (const record of loadTraces(
          path.join(workspace.root, TRACES_SUBDIRECTORY, `${id}.jsonl`),
        )) {
          turns.push(record);
        }
        const observations = journal
          .all()
          .filter((event) => event.type === "action.finished")
          .map((event) => (event.type === "action.finished" ? event.output : ""));
        const restored = resumeTranscript(turns, observations);
        // Appended to the live transcript rather than replacing it, so a
        // resume adds history instead of discarding whatever was said first.
        transcript.push(...restored);
        io.out(`  resumed ${id}: ${turns.length} turns of history`);
        continue;
      }
      if (input === "/replay") {
        const records = [];
        for await (const record of loadTraces(path.join(workspace.root, TRACES_SUBDIRECTORY))) {
          records.push(record);
        }
        io.out(formatReport(score(records)));
        continue;
      }
      if (input === "/context") {
        if (lastReceipt === null) {
          io.out("  nothing compiled yet — ask something first");
          continue;
        }
        io.out(
          `  ${lastReceipt.includedChars} of ${lastReceipt.budgetChars} chars used, ${lastReceipt.droppedChars} dropped`,
        );
        for (const entry of lastReceipt.items.slice(0, 12)) {
          io.out(
            `  ${entry.included ? "✓" : "·"} ${String(entry.score).padStart(2)} ${entry.path ?? entry.id}  ${entry.reason}`,
          );
        }
        continue;
      }
      if (input === "/approvals") {
        const granted = policy.granted();
        io.out(granted.length === 0 ? "  nothing standing" : `  always: ${granted.join(", ")}`);
        continue;
      }
      if (input.startsWith("/")) {
        io.out(`  unknown command ${input}. /help for the list.`);
        continue;
      }

      const context = taskContext(workspace, input, contextBudget, taskPacket);
      lastReceipt = context.receipt;
      transcript.push({ role: "user", content: `${context.text}\n\n${input}` });
      const run = new Run({ workspace, ...makeTools(workspace, controller.signal) }, false, policy);
      const drained = (async () => {
        for await (const event of run.events()) {
          sessions.appendTo(sessionId, event);
          const frame = renderInteractive(event);
          if (frame !== null) {
            clearStatus(tty);
            io.out(frame);
          }
          if (event.type === "approval.requested") {
            const reply = await ask("    > ");
            if (reply === null) {
              // Nobody left to ask. Deny and let the run unwind, rather than
              // waiting forever on an answer that cannot arrive.
              run.send({ type: "approve", id: event.id, decision: "deny" });
              run.send({ type: "cancel" });
              continue;
            }
            const choice = reply.trim().toLowerCase();
            const decision: Decision =
              choice === "" || choice === "a" || choice === "y"
                ? "once"
                : choice === "always"
                  ? "always"
                  : "deny";
            run.send({ type: "approve", id: event.id, decision });
          }
        }
      })();

      run.start(input);
      const usages: TurnUsage[] = [];
      const progress = new ProgressWatch();
      const verificationCadence = new VerificationCadence();
      try {
        for (let turn = 0; turn < 12; turn += 1) {
          const meter = new TurnMeter(() => Date.now());
          meter.start();
          let generated = 0;
          const result = await oneTurn(
            run,
            config,
            transcript,
            controller.signal,
            (delta) => {
              meter.delta(delta);
              generated += delta.length;
              writeStatus(tty, `  ⋮ generating… ${generated} chars`);
            },
            tracePath,
            native,
            batchActions,
          );
          clearStatus(tty);
          usages.push(meter.finish());
          transcript.push({ role: "assistant", content: result.text });
          if (result.stalled) break;
          if (result.finished) {
            const objection = await gate(
              run,
              workspace,
              config,
              input,
              commands,
              controller.signal,
              io,
              false,
              native,
            );
            if (objection === null) break;
            run.reopen();
            transcript.push({ role: "user", content: objection });
            continue;
          }
          progress.observe(result.results);
          verificationCadence.observe(result);
          transcript.push({
            role: "user",
            content: `${observationsFrom(result.results, result.guardNotice)}${progress.steer() ?? ""}${verificationCadence.steer() ?? ""}`,
          });
        }
      } catch (error) {
        clearStatus(tty);
        run.fail(error instanceof Error ? error.message : String(error));
      }
      run.close();
      await drained;
      sessions.save(sessionId, run.journal);
      const usage = summarize(usages);
      if (usage.turns > 0) {
        io.out(
          `  ${usage.turns} ${usage.turns === 1 ? "turn" : "turns"} · ${usage.seconds.toFixed(1)}s · ${usage.charsPerSecond.toFixed(0)} ch/s`,
        );
      }
      io.out("");
    }
  } finally {
    rl.close();
  }
  return 0;
}

const SLASH_HELP = [
  "  /help        this list",
  "  /clear       forget the conversation, keep the repository context",
  "  /approvals   what you have standing-approved this session",
  "  /context     what went into the last prompt, and what just missed",
  "  /replay      re-score the decoder on every turn recorded here",
  "  /resume [id] load a recorded session's history into this conversation",
  "  /verify      the verification command detected for this project",
  "  /sessions    recent recorded sessions",
  "  /exit        leave",
  "",
  "  At an approval prompt: enter or `a` to apply, `always` for this kind,",
  "  anything else to skip.",
].join("\n");

/**
 * A transient one-line status, only on a terminal.
 *
 * Written with a carriage return and erased before any real output, so a piped
 * or redirected session -- CI, a test, `forge | tee` -- gets clean lines with
 * no escape sequences in them.
 */
function writeStatus(tty: boolean, text: string): void {
  if (tty) process.stdout.write(`\r\u001b[2K${text}`);
}

function clearStatus(tty: boolean): void {
  if (tty) process.stdout.write("\r\u001b[2K");
}

/**
 * The fallback check: look at what was written, against what was asked.
 *
 * A fresh read from disk rather than the model's own account of its edits --
 * the failure being guarded against is a model that believes it did something
 * it did not, and asking it to recall its own work consults exactly the belief
 * in question.
 */
async function reviewChanges(
  run: Run,
  workspace: Workspace,
  config: ProviderConfig,
  task: string,
  signal: AbortSignal,
  native: boolean,
): Promise<string | null> {
  void native;
  const changed = [...new Set(run.snapshot().committed.map((entry) => entry.path))];
  if (changed.length === 0) {
    // A completion claim having changed NOTHING. The first version returned
    // early here, reasoning that a "done" with no edits is either a question
    // answered or a task not started, and so none of this function's business.
    // That was wrong, and it cost a benchmark task: asked to thread a field
    // through three files, the model claimed success in three seconds having
    // touched none of them, and the review skipped itself.
    //
    // Noticing that a change was asked for and none was made is precisely this
    // function's business. It cannot be decided from the file list alone --
    // "what does parse() do?" legitimately changes nothing -- so it is asked.
    return await judge(
      config,
      signal,
      [
        "The request below was reported as complete, but NO files were changed.",
        "",
        "Reply DONE <one line> only if the request genuinely required no change",
        "to any file — a question, or something already true of the code.",
        "Reply PROBLEM <what is missing> if it asked for work that was not done.",
      ].join("\n"),
      `The request was:\n${task}`,
    );
  }
  const shown = changed
    .map((file) => {
      try {
        return `${file} \u2014 as it now stands on disk:\n${workspace.read(file)}`;
      } catch {
        return `${file} \u2014 could not be read back`;
      }
    })
    .join("\n\n");

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are checking work that has already been applied. Be strict.",
        "",
        "Reply with exactly one of:",
        "  DONE <one line> if the files below fully satisfy the request and",
        "  nothing that worked before is now broken.",
        "  PROBLEM <what is wrong> otherwise.",
        "",
        "Do not propose edits. Do not restate the files. Judge only.",
      ].join("\n"),
    },
    { role: "user", content: `The request was:\n${task}\n\n${shown}` },
  ];

  return await judge(config, signal, messages[0]?.content ?? "", messages[1]?.content ?? "");
}

/**
 * Ask the model to judge, and treat anything but an explicit DONE as an
 * objection.
 *
 * Fails closed on both sides: a reviewer that cannot be reached is not
 * approval, and a reply that is neither DONE nor PROBLEM is not approval
 * either. This path exists precisely because there is no test to fall back on,
 * so an ambiguous verdict has to cost a turn rather than end the run.
 */
async function judge(
  config: ProviderConfig,
  signal: AbortSignal,
  system: string,
  user: string,
): Promise<string | null> {
  let raw = "";
  try {
    for await (const delta of streamCompletion(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { signal },
    )) {
      raw += delta;
    }
  } catch {
    return "The work could not be reviewed and no test command exists, so it is unverified.";
  }
  const verdict = raw.trim();
  if (/^\s*DONE\b/im.test(verdict)) return null;
  const problem = /PROBLEM\s*:?\s*([\s\S]*)/i.exec(verdict)?.[1]?.trim();
  return [
    "A review of the work as it now stands found a problem:",
    problem || verdict || "the request does not appear to have been carried out",
  ].join("\n");
}

export function observationsFrom(
  results: readonly ActionResult[],
  guardNotice: string | null = null,
  limit = 12_000,
): string {
  if (results.length === 0 && guardNotice === null) {
    return "No action was taken. Reply using one of the directives, exactly as shown.";
  }
  const blocks = guardNotice === null ? [] : [guardNotice];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const result of results) {
    const key = `${result.ok ? "ok" : "failed"}\0${result.output}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    blocks.push(`${result.ok ? "ok" : "failed"}: ${clipObservation(result.output)}`);
  }
  if (duplicates > 0) blocks.push(`${duplicates} duplicate result(s) omitted.`);

  const included: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const block of blocks) {
    const cost = block.length + (included.length > 0 ? 2 : 0);
    if (used + cost > limit) {
      omitted += 1;
      continue;
    }
    included.push(block);
    used += cost;
  }
  if (omitted > 0) included.push(`${omitted} additional result block(s) omitted by context guard.`);
  return included.join("\n\n").slice(0, limit);
}

function clipObservation(output: string, limit = 4_000): string {
  if (output.length <= limit) return output;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head - 50;
  return `${output.slice(0, head)}\n… ${output.length - head - tail} chars omitted …\n${output.slice(-tail)}`;
}

/** Ask for executable feedback before a sequence of speculative edits consumes the run. */
export class VerificationCadence {
  private consecutiveMutationTurns = 0;
  private lastSteeredAt = 0;

  observe(turn: { readonly committedMutation: boolean; readonly ranCommand: boolean }): void {
    if (turn.ranCommand) {
      this.consecutiveMutationTurns = 0;
      this.lastSteeredAt = 0;
      return;
    }
    if (turn.committedMutation) this.consecutiveMutationTurns += 1;
  }

  steer(): string | null {
    if (this.consecutiveMutationTurns < 2 || this.consecutiveMutationTurns === this.lastSteeredAt) {
      return null;
    }
    this.lastSteeredAt = this.consecutiveMutationTurns;
    return [
      "",
      `You have changed code for ${this.consecutiveMutationTurns} turns without running it.`,
      "Run the narrowest relevant compile or test command now, before making another edit.",
    ].join("\n");
  }
}

/**
 * Notices when the same thing keeps failing, and says so.
 *
 * The first version of this counted turns in which nothing succeeded, and it
 * never fired on the case it was written for: a model stuck on a failing test
 * commits a *successful* edit every turn, so by that measure it is making
 * progress the whole time it is going nowhere. Twelve turns, every edit
 * applied, the same test red at the end.
 *
 * The signal that actually distinguishes stuck from slow is a failure that
 * recurs. Keyed by the first line of the failure, because a test runner's
 * output varies in timings and paths while the assertion that failed does not.
 *
 * The steer names the possibility the model was not considering. In the case
 * this was built from, the test was correct and the module under test held
 * mutable state at module scope; the model spent eight turns rewriting the
 * test because nothing had suggested the code could be the thing that was
 * wrong.
 */
class ProgressWatch {
  private readonly failures = new Map<string, number>();

  observe(results: readonly ActionResult[]): void {
    for (const result of results) {
      if (result.ok) continue;
      const key = (result.output.split("\n").find((line) => line.trim()) ?? "").slice(0, 120);
      if (!key) continue;
      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    }
  }

  /** The steer to append, or null while nothing is repeating. */
  steer(): string | null {
    const stuck = [...this.failures.entries()].find(([, count]) => count >= 3);
    if (stuck === undefined) return null;
    return [
      "",
      `This has now failed ${stuck[1]} times the same way.`,
      "Repeating the approach will not change it. Consider that the code being",
      "tested may be what is wrong, not the test — read it again and say in one",
      "line what it actually does. If you cannot make progress, say DONE and",
      "explain what is blocking you.",
    ].join("\n");
  }
}
