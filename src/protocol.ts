/**
 * One semantic protocol, several codecs.
 *
 * The central design claim of this package: *what the model wants to do* and
 * *how it said so* are different things, and only the first should ever reach
 * the rest of the system. Provider bytes differ wildly -- OpenAI tool calls,
 * Anthropic tool blocks, an 8B model emitting plain text -- and pretending they
 * are one wire format produces a provider abstraction that leaks everywhere.
 *
 *     provider bytes
 *        -> provider-normalized deltas
 *        -> text codec | native codec
 *        -> ActionProposal            <-- the boundary. Everything above is one path.
 *        -> validation -> loop guard -> policy -> approval -> commit
 *
 * Drift between codecs is prevented structurally rather than by discipline:
 * non-edit tools are generated from the single `TOOLS` registry below, while
 * the native edit schema is derived from the canonical `EditProposal`. A tool
 * cannot exist in one codec and not the other, and its mutation classification
 * cannot disagree between them.
 *
 * Measured basis for the text codec (24,206 recorded real responses from local
 * models, replayed offline): 100% of unrecoverable failures were truncation,
 * 96.8% of those were turns writing code, and JSON escaping accounted for 8.62%
 * of every character emitted on an edit turn (p90 15.9%). A SEARCH/REPLACE
 * surface removes that entire failure class for weak models. It is *not*
 * claimed to dominate native tool-calling universally -- it duplicates the old
 * content, it can collide with delimiters that appear in the file, and a
 * frontier model with a good tokenizer may do better natively. Which codec an
 * endpoint gets is a measured decision, not a belief.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// The canonical proposal
// ---------------------------------------------------------------------------

/**
 * One edit, expressed so it can be validated, previewed and re-checked later.
 *
 * `baseRevision` is the point. An approval is a decision about a *specific*
 * version of a file, and between proposing and committing the file can change
 * -- another edit in the same turn, a verification command that rewrites it, a
 * human saving in their editor. Carrying the hash lets the commit refuse a
 * stale proposal instead of silently applying it to something the user never
 * saw.
 */
export const EditOperation = z.strictObject({
  /** Text to find. Empty only when `create` is true. */
  search: z.string(),
  replace: z.string(),
  /**
   * How many matches the model expects. Anything else is a failed proposal
   * rather than a guess: editing the first of three identical anchors is how a
   * plausible patch lands in the wrong function.
   */
  expectedMatches: z.number().int().min(1).default(1),
});
export type EditOperation = z.infer<typeof EditOperation>;

export const EditProposal = z.strictObject({
  kind: z.literal("edit"),
  path: z.string().min(1),
  create: z.boolean().default(false),
  /**
   * Replace the file's entire contents with the single operation's `replace`.
   *
   * Set by the runtime, never by the model: it is what a CREATE over a file the
   * model has already read is converted into. Keeping it out of the protocol
   * prompt is deliberate -- see the note below on prompt dilution.
   */
  rewrite: z.boolean().default(false),
  operations: z.array(EditOperation).min(1),
  /**
   * sha256 of the file as the model was shown it, or null for a creation.
   * Re-checked at commit time; a mismatch is a stale proposal.
   */
  baseRevision: z.string().nullable().default(null),
});
export type EditProposal = z.infer<typeof EditProposal>;

/** The provider-facing arguments for the native `edit` tool. */
const NativeEditArguments = EditProposal.omit({ kind: true });

export const CallProposal = z.strictObject({
  kind: z.literal("call"),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default(() => ({})),
});
export type CallProposal = z.infer<typeof CallProposal>;

export const ActionProposal = z.discriminatedUnion("kind", [EditProposal, CallProposal]);
export type ActionProposal = z.infer<typeof ActionProposal>;

/**
 * One decoded model turn.
 *
 * `text` is prose the model wrote around its actions -- shown to the user,
 * never executed. `final` set means the model believes the task is done.
 */
export interface TurnIntent {
  readonly text: string;
  readonly proposals: ActionProposal[];
  readonly final: string | null;
  /** Repairs the codec had to apply, for the reliability ledger. */
  readonly repairs: string[];
}

export interface BoundedTurn {
  readonly turn: TurnIntent;
  readonly dropped: number;
  readonly duplicates: number;
  readonly notice: string | null;
}

/**
 * Bound a decoded reply before it can execute or enter the transcript.
 *
 * A malformed local-model reply once decoded into 1,300 distinct `RUN`
 * directives. Executing them consumed minutes, and rendering them back into
 * the conversation pushed the next request beyond a 65k-token context. The
 * codec should remain permissive about syntax; this boundary limits effects.
 */
export function boundTurnIntent(
  turn: TurnIntent,
  limits: {
    readonly proposals: number;
    readonly runs: number;
    readonly mutations: number;
    /** Bounded first-class filesystem calls: delete, mkdir, move, copy, rename. */
    readonly filesystem?: number;
    /** Backward-compatible alias used by older callers. */
    readonly deletes?: number;
  },
): BoundedTurn {
  const accepted: ActionProposal[] = [];
  const seen = new Set<string>();
  let runs = 0;
  let mutations = 0;
  let filesystemMutations = 0;
  let duplicates = 0;
  let dropped = 0;
  for (const proposal of turn.proposals) {
    const key = JSON.stringify(proposal);
    if (seen.has(key)) {
      duplicates += 1;
      dropped += 1;
      continue;
    }
    seen.add(key);
    const isRun = proposal.kind === "call" && proposal.tool === "run";
    const isMutation = proposal.kind === "edit";
    const isFilesystemMutation =
      proposal.kind === "call" &&
      ["delete", "mkdir", "move", "copy", "rename"].includes(proposal.tool);
    if (
      accepted.length >= limits.proposals ||
      (isRun && runs >= limits.runs) ||
      (isMutation && mutations >= limits.mutations) ||
      (isFilesystemMutation &&
        filesystemMutations >= (limits.filesystem ?? limits.deletes ?? limits.mutations))
    ) {
      dropped += 1;
      continue;
    }
    accepted.push(proposal);
    if (isRun) runs += 1;
    if (isMutation) mutations += 1;
    if (isFilesystemMutation) filesystemMutations += 1;
  }
  if (dropped === 0) return { turn, dropped: 0, duplicates: 0, notice: null };

  const repairs = new Set(turn.repairs);
  if (duplicates > 0) repairs.add("duplicate_proposal");
  if (dropped > duplicates) repairs.add("proposal_limit");
  const excess = dropped - duplicates;
  const reasons = [
    duplicates > 0 ? `${duplicates} duplicate` : "",
    excess > 0 ? `${excess} over-budget` : "",
  ].filter(Boolean);
  return {
    turn: {
      ...turn,
      proposals: accepted,
      // Completion cannot be trusted while requested actions were ignored.
      final: null,
      repairs: [...repairs].sort(),
    },
    dropped,
    duplicates,
    notice: `Action guard ignored ${reasons.join(" and ")} proposal(s). Review the results of the bounded actions before continuing.`,
  };
}

// ---------------------------------------------------------------------------
// The tool registry: one source for every codec surface
// ---------------------------------------------------------------------------

export interface ToolSpec {
  readonly name: string;
  /** Whether running this can change the repository. Drives approval. */
  readonly mutates: boolean;
  readonly schema: z.ZodType<Record<string, unknown>>;
  /** One line, shown in the approval prompt. */
  readonly describe: (args: Record<string, unknown>) => string;
  /** How the text codec teaches it. Omitted tools are native-only. */
  readonly textForm?: string;
}

const path_ = z.string().min(1);

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "read",
    mutates: false,
    schema: z.strictObject({
      path: path_,
      start: z.number().int().min(1).optional(),
      end: z.number().int().min(1).optional(),
    }),
    describe: (a) => `read ${String(a["path"])}`,
    textForm: "READ <path>[:<start>-<end>]",
  },
  {
    name: "list",
    mutates: false,
    schema: z.strictObject({ path: z.string().default(".") }),
    describe: (a) => `list ${String(a["path"] ?? ".")}`,
    textForm: "LIST <path>",
  },
  {
    name: "glob",
    mutates: false,
    schema: z.strictObject({
      pattern: z.string().min(1),
      path: z.string().default("."),
    }),
    describe: (a) => `find paths matching ${JSON.stringify(a["pattern"])}`,
    textForm: "GLOB <pattern>",
  },
  {
    // A real grep, not a substring scan. The competitor ships one and forge
    // did not, and that single gap accounted for the worst task in the
    // benchmark: a bug in a file the task never names took forge 250 seconds
    // per run and three failures out of three, against 17 seconds for an agent
    // that could `grep RATE .` and land on it immediately.
    //
    // Regex by default, with `literal` to opt out, because the model asking for
    // a regex and getting a substring match is a silent wrong answer while the
    // reverse is a loud one.
    name: "grep",
    mutates: false,
    schema: z.strictObject({
      pattern: z.string().min(1),
      path: z.string().default("."),
      glob: z.string().optional(),
      ignoreCase: z.boolean().default(false),
      literal: z.boolean().default(false),
      context: z.number().int().min(0).max(10).default(0),
    }),
    describe: (a) => `grep for ${JSON.stringify(a["pattern"])}`,
    textForm: "GREP <pattern>",
  },
  {
    name: "search",
    mutates: false,
    schema: z.strictObject({ query: z.string().min(1), path: z.string().default(".") }),
    describe: (a) => `search for ${JSON.stringify(a["query"])}`,
    textForm: "SEARCH <query>",
  },
  {
    name: "related",
    mutates: false,
    schema: z.strictObject({ path: path_ }),
    describe: (a) => `inspect relationships for ${String(a["path"])}`,
    textForm: "RELATED <path>",
  },
  {
    name: "symbol",
    mutates: false,
    schema: z.strictObject({
      query: z.string().min(1),
      path: z.string().default("."),
    }),
    describe: (a) => `find declarations named ${JSON.stringify(a["query"])}`,
    textForm: "SYMBOL <name>",
  },
  {
    name: "references",
    mutates: false,
    schema: z.strictObject({
      query: z.string().min(1),
      path: z.string().default("."),
    }),
    describe: (a) => `find syntax references to ${JSON.stringify(a["query"])}`,
    textForm: "REFERENCES <name>",
  },
  {
    name: "delete",
    mutates: true,
    schema: z.strictObject({ path: path_ }),
    describe: (a) => `delete ${String(a["path"])}`,
    textForm: "DELETE <path>",
  },
  {
    name: "mkdir",
    mutates: true,
    schema: z.strictObject({ path: path_ }),
    describe: (a) => `create directory ${String(a["path"])}`,
    textForm: "MKDIR <path>",
  },
  {
    name: "move",
    mutates: true,
    schema: z.strictObject({ source: path_, destination: path_ }),
    describe: (a) => `move ${String(a["source"])} to ${String(a["destination"])}`,
    textForm: "MOVE <source> -> <destination>",
  },
  {
    name: "copy",
    mutates: true,
    schema: z.strictObject({ source: path_, destination: path_ }),
    describe: (a) => `copy ${String(a["source"])} to ${String(a["destination"])}`,
    textForm: "COPY <source> -> <destination>",
  },
  {
    name: "rename",
    mutates: true,
    schema: z.strictObject({ source: path_, destination: path_ }),
    describe: (a) => `rename ${String(a["source"])} to ${String(a["destination"])}`,
    textForm: "RENAME <source> -> <destination>",
  },
  {
    name: "run",
    mutates: true,
    // A token array, never a shell string: nothing model-written reaches a
    // shell, so there is no quoting to get wrong and no injection to defend.
    schema: z.strictObject({ command: z.array(z.string()).min(1) }),
    describe: (a) => `run ${(a["command"] as string[]).join(" ")}`,
    textForm: "RUN <argv...>",
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function toolNamed(name: string): ToolSpec | undefined {
  return BY_NAME.get(name);
}

/** Whether a proposal can change the repository, and so needs approval. */
export function mutates(proposal: ActionProposal): boolean {
  return proposal.kind === "edit" || (toolNamed(proposal.tool)?.mutates ?? true);
}

/** The line shown in an approval prompt. */
export function describeProposal(proposal: ActionProposal): string {
  if (proposal.kind === "edit") {
    return proposal.create
      ? `create ${proposal.path}`
      : `edit ${proposal.path} (${proposal.operations.length} change${proposal.operations.length === 1 ? "" : "s"})`;
  }
  return toolNamed(proposal.tool)?.describe(proposal.arguments) ?? `run ${proposal.tool}`;
}

// ---------------------------------------------------------------------------
// Prompt surface, generated from the registry
// ---------------------------------------------------------------------------

/**
 * The text protocol, written out for the model.
 *
 * Generated rather than hand-written so a tool added to `TOOLS` is taught
 * automatically. A tool that exists in the executor but not in the prompt is
 * invisible; a tool in the prompt but not the executor is a guaranteed failed
 * turn. Generating both from one list makes either impossible.
 */
export function textProtocolPrompt(): string {
  const lines = [
    "Reply in plain text. Use these directives, one per line:",
    ...TOOLS.filter((tool) => tool.textForm !== undefined).map((tool) => `  ${tool.textForm}`),
    "To change a file, write an edit block:",
    "",
    "  EDIT path/to/file.ts",
    "  <<<<<<< SEARCH",
    "  the exact existing text",
    "  =======",
    "  the replacement text",
    "  >>>>>>> REPLACE",
    "CREATE uses an empty SEARCH; READ path:start-end returns an exact bounded excerpt.",
    "LIST/GLOB/GREP navigate; RELATED shows modules/tests; SYMBOL/REFERENCES inspect identifiers.",
    "DELETE never targets the root; MOVE/COPY/RENAME require an absent destination.",
    // Reverted from a longer version. Adding eight lines about marker
    // collisions and anchor sizing made things measurably WORSE: the task it
    // targeted went from 2/3 to 0/3 and false successes rose from 1 to 6
    // across the suite. The most plausible reading is dilution -- the protocol
    // itself is the load-bearing part of this prompt, and burying it in
    // caveats costs more than the edge case the caveats addressed.
    "The SEARCH text must appear exactly once. Quote the smallest text that",
    "does; add surrounding lines only if a shorter anchor would be ambiguous.",
    "When the task is done, write:  DONE <one line summary>",
  ];
  return lines.join("\n");
}

/**
 * A proposal rendered back into the text protocol.
 *
 * Used for the assistant turn written into the transcript. Feeding the model's
 * *raw* reply back is actively harmful: a malformed marker teaches it that the
 * malformation is acceptable, and -- observed live against qwen3-coder-30b --
 * an invented SEARCH body written before the file was read stays in the
 * conversation and anchors every later attempt to the invention rather than to
 * the tool result. Re-rendering from the decoded proposal keeps the transcript
 * canonical and self-reinforcing: the model only ever sees the protocol spelled
 * correctly, including its own turns.
 *
 * `decode(render(p))` must equal `p`; a test pins it.
 */
export function renderProposal(proposal: ActionProposal): string {
  if (proposal.kind === "call") {
    const args = proposal.arguments;
    if (proposal.tool === "run") {
      return `RUN ${((args["command"] as string[]) ?? []).join(" ")}`;
    }
    if (proposal.tool === "read") {
      const start = args["start"];
      const end = args["end"];
      const range =
        typeof start === "number" ? `:${start}-${typeof end === "number" ? end : start}` : "";
      return `READ ${String(args["path"] ?? "")}${range}`;
    }
    if (proposal.tool === "search") {
      return `SEARCH ${String(args["query"] ?? "")}`;
    }
    if (proposal.tool === "symbol") {
      return `SYMBOL ${String(args["query"] ?? "")}`;
    }
    if (proposal.tool === "references") {
      return `REFERENCES ${String(args["query"] ?? "")}`;
    }
    if (proposal.tool === "grep") {
      return `GREP ${String(args["pattern"] ?? "")}`;
    }
    if (proposal.tool === "glob") {
      return `GLOB ${String(args["pattern"] ?? "")}`;
    }
    if (["move", "copy", "rename"].includes(proposal.tool)) {
      return `${proposal.tool.toUpperCase()} ${String(args["source"] ?? "")} -> ${String(args["destination"] ?? "")}`;
    }
    return `${proposal.tool.toUpperCase()} ${String(args["path"] ?? ".")}`;
  }
  const head = `${proposal.create ? "CREATE" : "EDIT"} ${proposal.path}`;
  const blocks = proposal.operations.map((operation) =>
    ["<<<<<<< SEARCH", operation.search, "=======", operation.replace, ">>>>>>> REPLACE"].join(
      "\n",
    ),
  );
  return [head, ...blocks].join("\n");
}

/** A whole decoded turn, rendered back into the protocol. */
export function renderTurn(turn: TurnIntent): string {
  const parts: string[] = [];
  if (turn.text) parts.push(turn.text);
  for (const proposal of turn.proposals) parts.push(renderProposal(proposal));
  if (turn.final !== null) parts.push(`DONE ${turn.final}`);
  return parts.join("\n");
}

/** The registry plus canonical edit schema, rendered for native providers. */
export function nativeToolSchemas(): Array<Record<string, unknown>> {
  const tools: Array<{ name: string; schema: z.ZodType }> = [
    { name: "edit", schema: NativeEditArguments },
    ...TOOLS.map((tool) => ({ name: tool.name, schema: tool.schema })),
  ];
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      parameters: z.toJSONSchema(tool.schema, { io: "input" }),
    },
  }));
}
