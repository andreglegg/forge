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
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
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
import { compactTranscript } from "./compaction.js";
import {
  comparePolyglotReports,
  comparePolyglotWithLittleCoder,
  formatCrossAgentComparison,
  formatPolyglotComparison,
  loadPolyglotReport,
} from "./compare.js";
import { type ContextItem, type ContextReceipt, compile, scoreFiles } from "./context.js";
import { execBounded, resolveCommandInvocation } from "./exec.js";
import { formatHookFailure, type HookReport, runProjectHooks } from "./hooks.js";
import { projectInstructionItems } from "./instructions.js";
import {
  captureIsolatedPatch,
  createIsolatedWorktree,
  type IsolatedWorktree,
  promoteIsolatedPatch,
  readCapturedPatch,
  removeIsolatedWorktree,
  transferIsolatedArtifacts,
} from "./isolation.js";
import { streamNative } from "./native.js";
import {
  load as loadObject,
  loadBytes as loadObjectBytes,
  store as storeObject,
  storeBytes as storeObjectBytes,
} from "./objects.js";
import { runPolyglot } from "./polyglot.js";
import {
  initializeProject,
  modeRefusal,
  type PermissionMode,
  type ProjectConfig,
  readProjectConfig,
  resolvePermissionMode,
  selectModelProfile,
} from "./product.js";
import {
  type ActionProposal,
  boundTurnIntent,
  mutates,
  renderTurn,
  type TurnIntent,
  textProtocolPrompt,
} from "./protocol.js";
import {
  DEFAULT_PROVIDER,
  discoverModel,
  type Message,
  type ProviderConfig,
  probeProvider,
  streamCompletion,
} from "./provider.js";
import { relatedRepository, resolveRelativeModuleDependencies } from "./relationships.js";
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
  globRepository,
  indexRepository,
  listRepository,
  projectMap,
  readRepositoryText,
  repositoryFiles,
  searchRepository,
} from "./repository.js";
import { decidePromotionRisk, type PatchRisk, scanPatchRisks } from "./risk.js";
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
import {
  type EntryType,
  resolveInside,
  revisionOf,
  revisionOfBytes,
  Workspace,
} from "./workspace.js";

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
  "  forge plan <task>        inspect and produce a plan without effects",
  "  forge continue [id]      reopen interactive chat with retained history",
  "  forge resume [id]        alias for continue",
  "  forge doctor             validate project, provider, model, and verifier",
  "  forge init               create an idempotent forge.json",
  "  forge config             print resolved configuration",
  "  forge profiles           list named model profiles",
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
  "  --profile <name>         named model profile from forge.json",
  "  --model <name>           model id            (FORGE_MODEL)",
  "  --url <base>             OpenAI-compatible base url  (FORGE_URL)",
  "  --context <tokens>       declared context window, sizes the reply budget",
  "  --max-tokens <n>         explicit reply-token budget (0 = derive)",
  "  --temperature <n>        sampling temperature (default 0.1)",
  "  --max-turns <n>          headless action-turn limit (default 12)",
  "  --task-packet            include bounded exercise docs in initial context",
  "  --batch-actions          invite bounded independent actions in one reply",
  "  --yes                    approve every action (headless, CI)",
  "  --isolate                run in a detached temporary Git worktree",
  "  --promote                apply a verified isolated patch to the original",
  "  --allow-risk             override critical patch-risk promotion blocks",
  "  --hooks                  enable repository hooks for headless runs",
  "  --mode <mode>            workspace, read-only, or plan",
  "  --read-only              deny edits and command execution",
  "  --plan                   plan mode alias",
  "  --no-verify              skip the verification gate on completion",
  "  --native                 use the provider's tool-calling instead of the text protocol",
  "  --json                   one final machine-readable document",
  "  --stream-json            JSONL durable events plus one final result",
  "  --version                print the installed Forge version",
].join("\n");

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

/** Keep setup, newest turns, and high-value omitted evidence under budget. */
export function boundTranscript(messages: readonly Message[], budgetChars: number): Message[] {
  return compactTranscript(messages, budgetChars);
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
 * The stable half of the prompt: the protocol and the rules, and nothing that
 * depends on the task.
 *
 * The repository used to be pasted in here, which was wrong twice over. It made
 * the system prompt change with the directory, defeating any prompt cache the
 * endpoint keeps; and it was the *same* listing whatever the task was, so the
 * one part of the prompt that should respond to what was asked never did.
 */
export function systemPrompt(
  native = false,
  batchActions = false,
  mode: PermissionMode = "workspace",
): string {
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
    ...(mode === "plan"
      ? [
          "- PLAN MODE: do not edit files or run commands. Inspect with reads and searches only.",
          "- Finish with a concrete ordered implementation plan naming files, tests, risks, and assumptions.",
        ]
      : mode === "read-only"
        ? [
            "- READ-ONLY MODE: do not edit files or run commands.",
            "- Answer from repository inspection and state uncertainty explicitly.",
          ]
        : []),
  ].join("\n");
}

/** Like POSIX lexists: true for files, directories, and broken symlinks. */
function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function currentEntryMatches(
  target: string,
  entryType: EntryType,
  expectedRevision: string | null,
  expectedMode: number | null | undefined,
): boolean {
  try {
    const stat = lstatSync(target);
    const currentRevision =
      entryType === "directory"
        ? stat.isDirectory() && !stat.isSymbolicLink()
          ? null
          : "mismatch"
        : entryType === "symlink"
          ? stat.isSymbolicLink()
            ? revisionOfBytes(Buffer.from(readlinkSync(target), "utf8"))
            : "mismatch"
          : stat.isFile() && !stat.isSymbolicLink()
            ? revisionOf(target)
            : "mismatch";
    return (
      currentRevision === expectedRevision &&
      (expectedMode === null || expectedMode === undefined || (stat.mode & 0o7777) === expectedMode)
    );
  } catch {
    return false;
  }
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
  const index = indexRepository(workspace.root);
  const paths = repositoryFiles(index);
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
  const smallRepositoryFallback = nothingMatched && paths.length <= 80;

  const items = ranked.map((item) => {
    const relative = item.path ?? item.text;
    // Only files the query matched are worth their contents -- unless nothing
    // matched at all, in which case withholding them helps no one.
    if ((item.score <= 0 && !smallRepositoryFallback) || inlined >= inlineBudget) {
      return item;
    }
    let contents: string;
    try {
      const read = readRepositoryText(workspace.root, relative, {
        maxChars: INLINE_FILE_MAX_CHARS + 1,
      });
      if (read.truncated || read.content.length > INLINE_FILE_MAX_CHARS) return item;
      contents = read.content;
    } catch {
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
    for (const candidate of resolveRelativeModuleDependencies(index, item.path, item.text)) {
      if (alreadyInlined.has(candidate)) continue;
      let contents: string;
      try {
        const read = readRepositoryText(workspace.root, candidate, {
          maxChars: INLINE_FILE_MAX_CHARS + 1,
        });
        if (read.truncated || read.content.length > INLINE_FILE_MAX_CHARS) continue;
        contents = read.content;
      } catch {
        continue;
      }
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
    id: "project-map",
    kind: "listing" as const,
    text: projectMap(index, Math.min(8_000, Math.max(2_000, Math.floor(budgetChars * 0.25)))),
    mandatory: true,
    score: 0,
    reason: "bounded complete repository map",
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
    retain: (content: string | Buffer) =>
      typeof content === "string"
        ? storeObject(workspace.root, content)
        : storeObjectBytes(workspace.root, content),
    runTool: async (proposal: {
      kind: string;
      tool?: string;
      arguments?: Record<string, unknown>;
    }) => {
      const args = proposal.arguments ?? {};
      try {
        if (proposal.tool === "read") {
          const target = String(args["path"] ?? "");
          const start = typeof args["start"] === "number" ? args["start"] : undefined;
          const end = typeof args["end"] === "number" ? args["end"] : undefined;
          const read = readRepositoryText(workspace.root, target, {
            ...(start === undefined ? {} : { start }),
            ...(end === undefined ? {} : { end }),
          });
          const range = `${read.startLine}-${read.endLine} of ${read.totalLines}`;
          const continuation =
            read.truncated && read.endLine < read.totalLines
              ? `\n[read truncated; continue with READ ${read.path}:${read.endLine + 1}-${Math.min(read.totalLines, read.endLine + 200)}]`
              : "";
          return {
            ok: true,
            output: `${read.path} — exact lines ${range}, quote from this and nothing else:\n${read.content}${continuation}`,
          };
        }
        if (proposal.tool === "list") {
          const listed = listRepository(workspace.root, String(args["path"] ?? "."));
          return { ok: true, output: listed.output };
        }
        if (proposal.tool === "glob") {
          const result = globRepository(
            workspace.root,
            String(args["pattern"] ?? ""),
            String(args["path"] ?? "."),
          );
          return {
            ok: true,
            output: `${result.output}${result.truncated ? "\n[glob results truncated]" : ""}`,
          };
        }
        if (proposal.tool === "grep") {
          const result = searchRepository(workspace.root, String(args["pattern"] ?? ""), {
            path: String(args["path"] ?? "."),
            ...(typeof args["glob"] === "string" ? { glob: args["glob"] } : {}),
            ignoreCase: args["ignoreCase"] === true,
            literal: args["literal"] === true,
            context: typeof args["context"] === "number" ? args["context"] : 0,
          });
          return {
            ok: true,
            output: `${result.output}\n[${result.hits} matches in ${result.filesScanned} files${result.truncated ? "; truncated" : ""}]`,
          };
        }
        if (proposal.tool === "search") {
          const result = searchRepository(workspace.root, String(args["query"] ?? ""), {
            path: String(args["path"] ?? "."),
            literal: true,
            maxHits: 100,
          });
          return {
            ok: true,
            output: `${result.output}\n[${result.hits} matches in ${result.filesScanned} files${result.truncated ? "; truncated" : ""}]`,
          };
        }
        if (proposal.tool === "related") {
          return {
            ok: true,
            output: relatedRepository(workspace.root, String(args["path"] ?? "")).output,
          };
        }
        if (
          proposal.tool === "symbol" ||
          proposal.tool === "references" ||
          proposal.tool === "callers"
        ) {
          // Load the parser only for project intelligence. Ordinary runs should
          // not pay the compiler API's startup and memory cost.
          const { findRepositoryCallers, findRepositoryReferences, findRepositorySymbols } =
            await import("./symbols.js");
          const query = String(args["query"] ?? "");
          const symbolOptions = { path: String(args["path"] ?? ".") };
          return {
            ok: true,
            output:
              proposal.tool === "symbol"
                ? findRepositorySymbols(workspace.root, query, symbolOptions).output
                : proposal.tool === "references"
                  ? findRepositoryReferences(workspace.root, query, symbolOptions).output
                  : findRepositoryCallers(workspace.root, query, symbolOptions).output,
          };
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

function makeRunEffects(workspace: Workspace, signal: AbortSignal, mode: PermissionMode) {
  const tools = makeTools(workspace, signal);
  if (mode === "workspace") return { workspace, ...tools };
  const refusal = modeRefusal(mode);
  return {
    workspace,
    ...tools,
    authorize: (proposal: ActionProposal): string | null => (mutates(proposal) ? refusal : null),
  };
}

async function restoredSession(
  root: string,
  requestedId: string | undefined,
): Promise<{ id: string; messages: Message[]; turns: number } | { error: string }> {
  const store = new SessionStore(root);
  const id = requestedId || store.list()[0]?.id;
  if (id === undefined) return { error: "nothing recorded here to resume" };
  const journal = store.load(id);
  if (journal === null) return { error: `no such session: ${id}` };
  const turns = [];
  for await (const record of loadTraces(path.join(root, TRACES_SUBDIRECTORY, `${id}.jsonl`))) {
    turns.push(record);
  }
  const observations = journal
    .all()
    .filter((event) => event.type === "action.finished")
    .map((event) => (event.type === "action.finished" ? event.output : ""));
  return { id, messages: resumeTranscript(turns, observations), turns: turns.length };
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
      ? { proposals: 12, runs: 3, mutations: 2, filesystem: 8 }
      : { proposals: 8, runs: 2, mutations: 1, filesystem: 4 },
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
      (result) =>
        result.ok &&
        ["applied ", "deleted ", "created directory ", "moved ", "copied "].some((prefix) =>
          result.output.startsWith(prefix),
        ),
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

  if (options["json"] === true && options["stream-json"] === true) {
    io.err("Choose either --json or --stream-json, not both.");
    return 2;
  }
  const root = path.resolve(typeof options["repo"] === "string" ? options["repo"] : ".");
  const workspace = new Workspace(root);
  let mode: PermissionMode;
  try {
    mode = resolvePermissionMode(options, command ?? "");
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const isolate = options["isolate"] === true;
  const promote = options["promote"] === true;
  const allowRisk = options["allow-risk"] === true;
  const hooksEnabled = options["hooks"] === true;
  if (promote && !isolate) {
    io.err("--promote requires --isolate.");
    return 2;
  }
  if (promote && options["no-verify"] === true) {
    io.err("--promote requires verification; remove --no-verify.");
    return 2;
  }
  if (allowRisk && (!isolate || !promote)) {
    io.err("--allow-risk requires --isolate --promote.");
    return 2;
  }
  if (isolate && (command !== "run" || mode !== "workspace")) {
    io.err("--isolate is currently supported only by `forge run` in workspace mode.");
    return 2;
  }
  if (hooksEnabled && command !== "run" && command !== "plan") {
    io.err("--hooks is currently supported only by headless `forge run` and `forge plan`.");
    return 2;
  }
  const offline =
    command === "replay" ||
    command === "compare" ||
    command === "compare-little-coder" ||
    command === "sessions" ||
    command === "show" ||
    command === "undo" ||
    command === "init" ||
    command === "config" ||
    command === "profiles" ||
    command === "doctor";
  const projectResult = readProjectConfig(root);
  for (const warning of projectResult.warnings) io.err(warning);
  for (const error of projectResult.errors) io.err(error);
  if (projectResult.errors.length > 0) return 2;
  const project = projectResult.config;
  let selectedProfile: ReturnType<typeof selectModelProfile>;
  try {
    selectedProfile = selectModelProfile(
      project,
      typeof options["profile"] === "string" ? options["profile"] : undefined,
    );
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const profile = selectedProfile.profile;
  let config = providerFrom(options);
  // Precedence: explicit CLI/environment values beat the selected profile,
  // which beats project-level compatibility keys, which beat defaults.
  const explicitUrl = typeof options["url"] === "string" || Boolean(process.env["FORGE_URL"]);
  const explicitModel = typeof options["model"] === "string" || Boolean(process.env["FORGE_MODEL"]);
  if (!explicitUrl) config = { ...config, baseUrl: profile.url ?? project.url ?? config.baseUrl };
  if (!explicitModel) config = { ...config, model: profile.model ?? project.model ?? config.model };
  if (typeof options["context"] !== "string" && profile.contextWindow !== undefined) {
    config = { ...config, contextWindow: profile.contextWindow };
  }
  if (typeof options["max-tokens"] !== "string" && profile.maxTokens !== undefined) {
    config = { ...config, maxTokens: profile.maxTokens };
  }
  if (typeof options["temperature"] !== "string" && profile.temperature !== undefined) {
    config = { ...config, temperature: profile.temperature };
  }
  if (typeof options["max-turns"] !== "string" && profile.maxTurns !== undefined) {
    options["max-turns"] = String(profile.maxTurns);
  }

  if (command === "init") {
    try {
      const initialized = initializeProject(root);
      const result = {
        created: initialized.created,
        file: path.relative(root, initialized.file) || "forge.json",
        config: initialized.config,
      };
      if (options["json"] === true) io.out(JSON.stringify(result, null, 2));
      else {
        io.out(
          initialized.created
            ? `Created ${result.file}. Review and commit it with your project.`
            : `${result.file} already exists and was left unchanged.`,
        );
        const commands = initialized.config.verify ?? [];
        if (commands.length > 0)
          io.out(`verify: ${commands.map((item) => item.join(" ")).join(", ")}`);
      }
      return 0;
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === "profiles") {
    const profiles = Object.entries(project.profiles ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, selected: name === selectedProfile.name, ...value }));
    const result = { selected: selectedProfile.name, profiles };
    if (options["json"] === true) io.out(JSON.stringify(result, null, 2));
    else if (profiles.length === 0) io.out("No model profiles defined in forge.json.");
    else {
      for (const item of profiles) {
        io.out(
          `${item.selected ? "*" : " "} ${item.name} · ${item.model ?? "auto-model"} · ${item.url ?? "default endpoint"}${item.contextWindow === undefined ? "" : ` · ${item.contextWindow} ctx`}`,
        );
      }
    }
    return 0;
  }

  if (command === "config") {
    const result = {
      version: FORGE_VERSION,
      repository: root,
      source: projectResult.source,
      mode,
      profile: selectedProfile.name,
      provider: {
        url: config.baseUrl,
        model: config.model || null,
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        native:
          options["native"] === true ||
          (options["native"] === undefined && profile.native === true),
        maxTurns: positiveIntegerOption(options["max-turns"], 12),
      },
      verify: project.verify ?? detectCommands(root),
      hooks: project.hooks ?? {},
      hooksEnabled,
    };
    if (options["json"] === true) io.out(JSON.stringify(result, null, 2));
    else {
      io.out(`Forge ${result.version}`);
      io.out(`repository: ${result.repository}`);
      io.out(`config: ${result.source ?? "detected defaults"}`);
      io.out(`mode: ${result.mode}`);
      io.out(`profile: ${result.profile ?? "none"}`);
      io.out(`provider: ${result.provider.url}`);
      io.out(`model: ${result.provider.model ?? "auto-discover"}`);
      io.out(
        result.verify.length === 0
          ? "verify: none detected"
          : `verify: ${result.verify.map((item) => item.join(" ")).join(", ")}`,
      );
    }
    return 0;
  }

  if (command === "doctor") {
    const verification = project.verify ?? detectCommands(root);
    const provider = await probeProvider(config, { completion: true });
    const result = {
      ok: provider.ok,
      version: FORGE_VERSION,
      node: process.version,
      repository: root,
      config: projectResult.source,
      mode,
      profile: selectedProfile.name,
      verify: verification,
      provider,
    };
    if (options["json"] === true) io.out(JSON.stringify(result, null, 2));
    else {
      io.out(`✓ Forge ${FORGE_VERSION} on ${process.version}`);
      io.out(`✓ repository ${root}`);
      io.out(
        verification.length === 0
          ? "! no verification command detected; run `forge init` or edit forge.json"
          : `✓ verifier ${verification.map((item) => item.join(" ")).join(", ")}`,
      );
      if (provider.ok) {
        io.out(`✓ provider ${config.baseUrl} · ${provider.selectedModel}`);
      } else {
        io.err(`✗ provider ${config.baseUrl}: ${provider.error ?? "unhealthy"}`);
      }
    }
    return result.ok ? 0 : 2;
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
  const native =
    options["native"] === true || (options["native"] === undefined && profile.native === true);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  const codingCommand =
    command === null ||
    command === "run" ||
    command === "plan" ||
    command === "continue" ||
    command === "resume";
  if (codingCommand) {
    const provider = await probeProvider(config, { completion: true });
    if (!provider.ok) {
      const message = `Provider preflight failed at ${config.baseUrl}: ${provider.error ?? "unhealthy endpoint"}`;
      if (options["json"] === true) {
        io.out(
          JSON.stringify({ ok: false, error: "provider_preflight", message, provider }, null, 2),
        );
      } else if (options["stream-json"] === true) {
        io.out(JSON.stringify({ type: "error", error: "provider_preflight", message, provider }));
      } else io.err(message);
      return 2;
    }
  }

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
      `${state.committed.length} path(s) changed · ${state.turn} turns · ${state.done ? (state.ok ? "ok" : "failed") : "unfinished"}`,
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
    // Reverse order. Rich filesystem events are deliberately journalled in an
    // order whose reverse removes created leaves before directories, then
    // recreates deleted directories before their leaves.
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

      // Journals written before first-class filesystem operations had no entry
      // type or operation. Preserve their exact revision-guarded semantics.
      if (event.operation === undefined) {
        if (
          event.afterRevision === null
            ? entryExists(target)
            : revisionOf(target) !== event.afterRevision
        ) {
          io.err(`  ✗ ${event.path} changed since this session; left untouched`);
          skipped += 1;
          continue;
        }
        if (event.beforeRevision === null) {
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
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
        io.out(`  ✓ restored ${event.path}`);
        restored += 1;
        continue;
      }

      if (event.entryType === undefined) {
        io.err(`  ✗ ${event.path} — session has incomplete filesystem undo metadata`);
        skipped += 1;
        continue;
      }

      if (event.operation === "create") {
        const unchanged =
          entryExists(target) &&
          currentEntryMatches(target, event.entryType, event.afterRevision, event.afterMode);
        if (!unchanged) {
          io.err(`  ✗ ${event.path} changed since this session; left untouched`);
          skipped += 1;
          continue;
        }
        try {
          // Non-recursive by design. A directory that gained user files after
          // the session is not empty, so this fails rather than deleting them.
          if (event.entryType === "directory") rmdirSync(target);
          else rmSync(target);
          io.out(`  ✓ removed ${event.path}`);
          restored += 1;
        } catch {
          io.err(`  ✗ ${event.path} is no longer empty or could not be removed`);
          skipped += 1;
        }
        continue;
      }

      if (event.operation === "delete") {
        if (entryExists(target)) {
          io.err(`  ✗ ${event.path} changed since this session; left untouched`);
          skipped += 1;
          continue;
        }
        try {
          if (event.entryType === "directory") {
            mkdirSync(target, { mode: event.beforeMode ?? 0o755 });
            if (event.beforeMode !== null && event.beforeMode !== undefined) {
              chmodSync(target, event.beforeMode);
            }
          } else {
            const content =
              event.beforeRevision === null
                ? null
                : loadObjectBytes(workspace.root, event.beforeRevision);
            if (content === null) {
              io.err(`  ✗ ${event.path} — the deleted content was not recorded`);
              skipped += 1;
              continue;
            }
            mkdirSync(path.dirname(target), { recursive: true });
            if (event.entryType === "symlink") {
              symlinkSync(content.toString("utf8"), target);
            } else {
              writeFileSync(target, content);
              if (event.beforeMode !== null && event.beforeMode !== undefined) {
                chmodSync(target, event.beforeMode);
              }
            }
          }
          io.out(`  ✓ restored ${event.path}`);
          restored += 1;
        } catch {
          io.err(`  ✗ ${event.path} could not be restored`);
          skipped += 1;
        }
        continue;
      }

      // A write restores the exact prior file bytes only if the current entry
      // still matches what the session committed.
      const unchanged =
        entryExists(target) &&
        currentEntryMatches(target, event.entryType, event.afterRevision, event.afterMode);
      if (!unchanged || event.beforeRevision === null) {
        io.err(`  ✗ ${event.path} changed since this session; left untouched`);
        skipped += 1;
        continue;
      }
      const content = loadObjectBytes(workspace.root, event.beforeRevision);
      if (content === null) {
        io.err(`  ✗ ${event.path} — the replaced content was not recorded`);
        skipped += 1;
        continue;
      }
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
        if (event.beforeMode !== null && event.beforeMode !== undefined) {
          chmodSync(target, event.beforeMode);
        }
        io.out(`  ✓ restored ${event.path}`);
        restored += 1;
      } catch {
        io.err(`  ✗ ${event.path} could not be restored`);
        skipped += 1;
      }
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
  if (command === "run" || command === "plan") {
    const task = rest.join(" ").trim();
    if (!isolate) {
      return await headless(
        task,
        workspace,
        config,
        controller,
        options,
        io,
        native,
        project,
        mode,
      );
    }
    let isolated: IsolatedWorktree;
    try {
      isolated = await createIsolatedWorktree(root, newSessionId());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options["json"] === true) {
        io.out(JSON.stringify({ ok: false, error: "isolation_setup", message }, null, 2));
      } else if (options["stream-json"] === true) {
        io.out(JSON.stringify({ type: "error", error: "isolation_setup", message }));
      } else io.err(`Isolation setup failed: ${message}`);
      return 2;
    }
    try {
      return await headless(
        task,
        new Workspace(isolated.root),
        config,
        controller,
        options,
        io,
        native,
        project,
        mode,
        isolatedFinalizer(isolated, promote, allowRisk, options, io),
      );
    } catch (error) {
      try {
        await removeIsolatedWorktree(isolated);
      } catch {
        // The original exception is the causal failure. The worktree remains
        // discoverable through Git if cleanup also failed.
      }
      throw error;
    }
  }
  if (command === "continue" || command === "resume") {
    return await interactive(
      workspace,
      config,
      controller,
      io,
      native,
      project,
      options["task-packet"] === true,
      options["batch-actions"] === true,
      mode,
      rest[0] === undefined ? {} : { id: rest[0] },
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
    mode,
    null,
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
  hookReports: HookReport[] = [],
  hooksEnabled = false,
  project: ProjectConfig = {},
  sessionId = "",
): Promise<string | null> {
  if (hooksEnabled) {
    const before = await runProjectHooks(project.hooks, {
      repository: workspace.root,
      sessionId,
      event: "beforeVerify",
      signal,
    });
    hookReports.push(before);
    if (!before.ok) return formatHookFailure(before);
  }
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
    const objection = await reviewChanges(run, workspace, config, task, signal, native);
    if (hooksEnabled) {
      const after = await runProjectHooks(project.hooks, {
        repository: workspace.root,
        sessionId,
        event: "afterVerify",
        verified: objection === null,
        signal,
      });
      hookReports.push(after);
      if (!after.ok) return formatHookFailure(after);
    }
    return objection;
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
  if (hooksEnabled) {
    const after = await runProjectHooks(project.hooks, {
      repository: workspace.root,
      sessionId,
      event: "afterVerify",
      verified: report.passed,
      signal,
    });
    hookReports.push(after);
    if (!after.ok) return formatHookFailure(after);
  }
  return report.passed ? null : formatForModel(report);
}

interface HeadlessResultDocument {
  readonly ok: boolean;
  readonly session: string;
  readonly mode: PermissionMode;
  readonly usage: Readonly<Record<string, number>>;
  readonly state: ReturnType<Run["snapshot"]>;
  readonly [key: string]: unknown;
}

interface HeadlessFinalization {
  readonly code?: number | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

type HeadlessFinalizer = (result: HeadlessResultDocument) => Promise<HeadlessFinalization>;

function isolatedFinalizer(
  worktree: IsolatedWorktree,
  promotionRequested: boolean,
  allowRisk: boolean,
  options: Readonly<Record<string, string | boolean>>,
  io: IO,
): HeadlessFinalizer {
  return async (result) => {
    const errors: string[] = [];
    let patch: Awaited<ReturnType<typeof captureIsolatedPatch>> | null = null;
    let risks: PatchRisk[] = [];
    let promoted = false;
    let promotionBlocked: string | null = null;
    try {
      patch = await captureIsolatedPatch(worktree);
    } catch (error) {
      errors.push(
        `could not capture isolated patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (patch?.changed === true) {
      try {
        risks = scanPatchRisks(readCapturedPatch(patch));
      } catch (error) {
        errors.push(
          `could not scan isolated patch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const riskDecision = decidePromotionRisk(risks, allowRisk);
    try {
      transferIsolatedArtifacts(worktree, result.session);
    } catch (error) {
      errors.push(
        `could not transfer session evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (promotionRequested && result.ok && patch?.changed === true) {
      if (!riskDecision.allowed) {
        promotionBlocked = riskDecision.reason;
      } else {
        try {
          await promoteIsolatedPatch(worktree, patch);
          promoted = true;
        } catch (error) {
          errors.push(
            `could not promote isolated patch: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    try {
      await removeIsolatedWorktree(worktree);
    } catch (error) {
      errors.push(
        `could not remove isolated worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const patchPath = patch === null ? null : path.relative(worktree.repository, patch.file);
    if (options["json"] !== true && options["stream-json"] !== true) {
      if (patch?.changed === true) {
        io.out(
          promoted
            ? `isolated patch promoted · ${patchPath}`
            : `isolated patch retained; original repository unchanged · ${patchPath}`,
        );
      } else if (patch !== null) {
        io.out("isolated run produced no repository changes");
      }
      for (const risk of risks) {
        io.err(`${risk.severity}: ${risk.file ?? "patch"} · ${risk.message}`);
      }
      if (promotionBlocked !== null) io.err(promotionBlocked);
      for (const error of errors) io.err(error);
    }
    return {
      ...(errors.length > 0 || promotionBlocked !== null ? { code: 2 } : {}),
      metadata: {
        isolation: {
          id: worktree.id,
          baseCommit: worktree.baseCommit,
          patch: patchPath,
          changed: patch?.changed ?? null,
          bytes: patch?.bytes ?? null,
          promotionRequested,
          promoted,
          risks,
          riskOverride: riskDecision.overridden,
          promotionBlocked,
          errors,
        },
      },
    };
  };
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
  mode: PermissionMode,
  finalize?: HeadlessFinalizer,
): Promise<number> {
  if (!task) {
    io.err("forge run needs a task description.");
    return 2;
  }
  const run = new Run(makeRunEffects(workspace, controller.signal, mode), options["yes"] === true);
  const asJson = options["json"] === true;
  const streamJson = options["stream-json"] === true;
  const sessions = new SessionStore(workspace.root);
  const sessionId = newSessionId();
  const tracePath = traceFileFor(workspace.root, sessionId);
  const hooksEnabled = options["hooks"] === true;
  const hookReports: HookReport[] = [];
  const collected: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of run.events()) {
      collected.push(event);
      // Appended as it happens, not only saved at the end. The end is exactly
      // what a crash, a kill or a pulled terminal never reaches, and a session
      // that only exists once the run succeeds is no use for diagnosing the
      // runs that did not. The final save repairs any torn tail.
      sessions.appendTo(sessionId, event);
      if (streamJson) io.out(JSON.stringify({ type: "event", event }));
      else if (!asJson) {
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
      content: systemPrompt(native, options["batch-actions"] === true, mode),
    },
    { role: "user", content: `${context.text}\n\n${task}` },
  ];
  let code = 1;
  if (hooksEnabled) {
    const started = await runProjectHooks(project.hooks, {
      repository: workspace.root,
      sessionId,
      event: "sessionStart",
      signal: controller.signal,
    });
    hookReports.push(started);
    if (!started.ok) {
      run.fail(formatHookFailure(started));
      code = 2;
    }
  }
  const progress = new ProgressWatch();
  const commands =
    options["no-verify"] === true ? [] : (project.verify ?? detectCommands(workspace.root));
  const usages: TurnUsage[] = [];
  const maxTurns = positiveIntegerOption(options["max-turns"], 12);
  const verificationCadence = new VerificationCadence();
  try {
    for (let turn = 0; code !== 2 && turn < maxTurns; turn += 1) {
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
        const objection =
          mode === "workspace"
            ? await gate(
                run,
                workspace,
                config,
                task,
                commands,
                controller.signal,
                io,
                asJson || streamJson,
                native,
                hookReports,
                hooksEnabled,
                project,
                sessionId,
              )
            : null;
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
  if (hooksEnabled) {
    const ended = await runProjectHooks(project.hooks, {
      repository: workspace.root,
      sessionId,
      event: "sessionEnd",
      verified: code === 0,
      signal: controller.signal,
    });
    hookReports.push(ended);
    if (!ended.ok) code = 2;
  }
  run.close();
  await drained;
  sessions.save(sessionId, run.journal);
  const usage = summarize(usages);
  const actions = collected.filter((event) => event.type === "action.proposed").length;
  const resultDocument: HeadlessResultDocument = {
    ok: code === 0,
    session: sessionId,
    mode,
    usage: { ...usage, actions },
    state: run.snapshot(),
    hooks: {
      enabled: hooksEnabled,
      ok: hookReports.every((report) => report.ok),
      reports: hookReports,
    },
  };
  let finalCode = code;
  let metadata: Readonly<Record<string, unknown>> = {};
  if (finalize !== undefined) {
    try {
      const finalized = await finalize(resultDocument);
      finalCode = finalized.code ?? finalCode;
      metadata = finalized.metadata ?? {};
    } catch (error) {
      finalCode = 2;
      metadata = {
        finalization: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  const finalDocument: HeadlessResultDocument = {
    ...resultDocument,
    ...metadata,
    ok: finalCode === 0,
  };
  if (!asJson && !streamJson) {
    for (const report of hookReports.filter((candidate) => !candidate.ok)) {
      io.err(formatHookFailure(report));
    }
  }
  if (streamJson) io.out(JSON.stringify({ type: "result", result: finalDocument }));
  else if (asJson) {
    io.out(JSON.stringify(finalDocument, null, 2));
  } else {
    io.out(
      `${usage.turns} ${usage.turns === 1 ? "turn" : "turns"} · ${usage.chars} chars · ${usage.seconds.toFixed(1)}s · ${usage.charsPerSecond.toFixed(0)} ch/s · session ${sessionId}`,
    );
  }
  return finalCode;
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
  mode: PermissionMode,
  initialResume: { readonly id?: string } | null,
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
  const transcript: Message[] = [
    { role: "system", content: systemPrompt(native, batchActions, mode) },
  ];
  const tty = process.stdout.isTTY === true;
  const sessions = new SessionStore(workspace.root);
  const sessionId = newSessionId();
  const tracePath = traceFileFor(workspace.root, sessionId);
  // A configured verify list beats detection: the user knows which command
  // means "this project is working" and the guess does not.
  let commands = project.verify ?? detectCommands(workspace.root);
  let lastReceipt: ContextReceipt | null = null;
  const contextBudget = 24_000;
  let resumeNotice: string | null = null;
  if (initialResume !== null) {
    const restored = await restoredSession(workspace.root, initialResume.id);
    if ("error" in restored) {
      rl.close();
      io.err(restored.error);
      return 2;
    }
    transcript.push(...restored.messages);
    resumeNotice = `resumed ${restored.id}: ${restored.turns} turns of history`;
  }

  io.out("");
  io.out(
    banner({
      color: useColor(tty, process.env),
      width: process.stdout.columns ?? 80,
      truecolor: useTruecolor(process.env),
    }),
  );
  io.out("");
  io.out(`  ${path.basename(workspace.root)} · ${config.model} · ${mode}`);
  if (resumeNotice !== null) io.out(`  ${resumeNotice}`);
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
        const wanted = input.slice("/resume".length).trim() || undefined;
        const restored = await restoredSession(workspace.root, wanted);
        if ("error" in restored) {
          io.out(`  ${restored.error}`);
          continue;
        }
        // Appended to the live transcript rather than replacing it, so a
        // resume adds history instead of discarding whatever was said first.
        transcript.push(...restored.messages);
        io.out(`  resumed ${restored.id}: ${restored.turns} turns of history`);
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
      const run = new Run(makeRunEffects(workspace, controller.signal, mode), false, policy);
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
            const objection =
              mode === "workspace"
                ? await gate(
                    run,
                    workspace,
                    config,
                    input,
                    commands,
                    controller.signal,
                    io,
                    false,
                    native,
                  )
                : null;
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
  const mutationEvents = run.journal.all().filter((event) => event.type === "mutation.committed");
  const changed = [
    ...new Set(
      mutationEvents.flatMap((event) =>
        event.type === "mutation.committed"
          ? [event.rootPath, event.destinationPath, event.path].filter(
              (candidate): candidate is string => candidate !== undefined,
            )
          : [],
      ),
    ),
  ];
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
        "The request below was reported as complete, but NO repository paths were changed.",
        "",
        "Reply DONE <one line> only if the request genuinely required no change",
        "to any repository path — a question, or something already true of the code.",
        "Reply PROBLEM <what is missing> if it asked for work that was not done.",
      ].join("\n"),
      `The request was:\n${task}`,
    );
  }
  const reviewLimit = 200;
  const shown = [
    ...changed.slice(0, reviewLimit).map((file) => {
      const target = resolveInside(workspace.root, file);
      if (target === null) {
        return `${file} \u2014 the path can no longer be resolved safely; the result is not confirmed`;
      }
      if (!entryExists(target)) {
        return `${file} \u2014 deleted or moved away; the path no longer exists`;
      }
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) {
          return `${file} \u2014 symbolic link exists and points to ${JSON.stringify(readlinkSync(target))}`;
        }
        if (stat.isDirectory()) {
          return `${file} \u2014 directory exists`;
        }
        return `${file} \u2014 as it now stands on disk:\n${workspace.read(file)}`;
      } catch {
        return `${file} \u2014 file exists but is binary or could not be read back as text`;
      }
    }),
    ...(changed.length > reviewLimit
      ? [
          `${changed.length - reviewLimit} additional changed path(s) omitted from this bounded review.`,
        ]
      : []),
  ].join("\n\n");

  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are checking work that has already been applied. Be strict.",
        "",
        "Reply with exactly one of:",
        "  DONE <one line> if the paths below fully satisfy the request and",
        "  nothing that worked before is now broken.",
        "  PROBLEM <what is wrong> otherwise.",
        "",
        "Do not propose edits. Do not restate the paths. Judge only.",
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
