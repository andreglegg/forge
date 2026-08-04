/**
 * Context assembly: deciding what the model is allowed to see, and leaving
 * behind a receipt that makes the decision falsifiable.
 *
 * Prompt construction is the largest lever on a small model's behaviour and
 * usually the least examined part of a harness, because it has no natural
 * failure signal: a bad selection does not throw, it just produces a worse
 * answer. A flat unranked file listing and a carefully retrieved excerpt look
 * identical from the outside. So this module treats selection as a measurable
 * operation rather than a matter of taste:
 *
 *   - every candidate is an item with a `score` and a human-readable `reason`;
 *   - `compile` returns a `ContextReceipt` recording, for each item, what it
 *     cost, how it ranked, why, and whether it made the cut;
 *   - the same inputs always produce the same output, byte for byte, so two
 *     runs can be diffed.
 *
 * Without the receipt, "retrieval got worse" is an unfalsifiable claim. With
 * it, a regression is a diff between two receipts.
 *
 * ## Why the budget is in characters
 *
 * A token count is a property of the *endpoint's* tokenizer. This harness
 * targets arbitrary OpenAI-compatible servers and local models, and offline it
 * does not have that tokenizer. Characters are an honest proxy: available with
 * no dependency, exact with respect to what is actually emitted, and visibly a
 * proxy. Dividing characters by four and labelling the result `tokens` would
 * be a fabricated measurement, and every eviction decision made from it would
 * inherit the fabrication while looking authoritative. A caller that *does*
 * have a tokenizer converts its token budget to characters once, at the edge,
 * where the conversion factor is a stated assumption rather than a hidden one.
 *
 * This module reads no files and calls no model. Ranking must stay cheap and
 * side-effect free so it can be run over thousands of candidates, and so a
 * test can assert on it without a repository.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextKind = "instruction" | "file" | "excerpt" | "listing";

export interface ContextItem {
  /** Stable identity. Also the tie-break key, so it must be unique per call. */
  readonly id: string;
  readonly kind: ContextKind;
  /** Repository-relative path, when the item came from one. */
  readonly path?: string;
  /** Exactly the characters this item contributes to the prompt. */
  readonly text: string;
  /** Included regardless of budget. See `compile`. */
  readonly mandatory: boolean;
  /** Higher wins. Meaningful only relative to the other items in one call. */
  readonly score: number;
  /** Why this score. Shown to humans reading the receipt; never sent to the model. */
  readonly reason: string;
}

export interface ContextReceiptEntry {
  readonly id: string;
  readonly kind: ContextKind;
  readonly path?: string;
  /** The item's own size. Independent of where it landed, so it is comparable across runs. */
  readonly chars: number;
  readonly score: number;
  readonly reason: string;
  readonly included: boolean;
}

export interface ContextReceipt {
  /**
   * Every candidate, exactly once, in selection order: mandatory items as
   * given, then optional items by rank. Ranked order is the useful order --
   * the first excluded entry is the item that just missed the cut, which is
   * the one worth arguing about.
   */
  readonly items: readonly ContextReceiptEntry[];
  /** Length of the emitted text, separators included. Not the sum of `chars`. */
  readonly includedChars: number;
  /** Sum of `chars` over evicted items: what the budget cost you. */
  readonly droppedChars: number;
  readonly budgetChars: number;
}

/**
 * The only text `compile` invents. Items are emitted verbatim and joined by a
 * blank line; there are no synthesised headers or fences, because any framing
 * the model sees should be attributable to an item in the receipt. Compiler-
 * invented text is budget nobody authorised and nobody can diff.
 */
export const SEPARATOR = "\n\n";

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Select items under a character budget and explain the selection.
 *
 * Mandatory items are always included, in the order given, even when they
 * alone exceed the budget. This is deliberate and is the one place the budget
 * is allowed to be violated: a truncated instruction is worse than an
 * over-budget prompt. Half a system prompt does not degrade gracefully -- it
 * changes the rules the model is following, silently, in a way that looks like
 * the model misbehaving rather than like the harness lying to it. If the
 * mandatory set does not fit, that is a configuration error the caller must
 * see (`includedChars > budgetChars` in the receipt), not something to paper
 * over by cutting a sentence in half.
 *
 * Optional items are then taken by descending score while they fit.
 */
export function compile(
  items: readonly ContextItem[],
  budgetChars: number,
): { text: string; receipt: ContextReceipt } {
  const mandatory = items.filter((item) => item.mandatory);
  // Copy before sorting: `sort` mutates, and a caller's array is not ours.
  const optional = items.filter((item) => !item.mandatory).sort(byRank);

  const chosen: ContextItem[] = [];
  const entries: ContextReceiptEntry[] = [];
  let used = 0;

  for (const item of mandatory) {
    used += costOf(item, chosen.length === 0);
    chosen.push(item);
    entries.push(entryFor(item, true));
  }

  let droppedChars = 0;
  for (const item of optional) {
    const next = used + costOf(item, chosen.length === 0);
    // Skip and keep scanning rather than stopping at the first item that does
    // not fit: one oversized candidate would otherwise evict the entire tail
    // of the ranking and leave most of the budget unspent. A later item can
    // only ever use room a higher-ranked item declined, since higher-ranked
    // items were offered it first -- so filling the remainder never costs a
    // better item its place.
    const fits = next <= budgetChars;
    if (fits) {
      used = next;
      chosen.push(item);
    } else {
      droppedChars += item.text.length;
    }
    entries.push(entryFor(item, fits));
  }

  const text = chosen.map((item) => item.text).join(SEPARATOR);
  return {
    text,
    receipt: { items: entries, includedChars: text.length, droppedChars, budgetChars },
  };
}

/**
 * Exactly what `join(SEPARATOR)` will charge for this item, so the running
 * total tracks the emitted length instead of approximating it. Keyed on
 * "nothing chosen yet" rather than "total is still zero", because an item with
 * empty text would otherwise leave the total at zero while `join` had already
 * committed to a separator.
 */
function costOf(item: ContextItem, isFirst: boolean): number {
  return item.text.length + (isFirst ? 0 : SEPARATOR.length);
}

function byRank(a: ContextItem, b: ContextItem): number {
  if (a.score !== b.score) return b.score - a.score;
  // Code-unit order, never `localeCompare`: collation depends on the locale and
  // the ICU build, so equal-scoring items would order differently on two
  // machines and receipts would stop being comparable across them.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function entryFor(item: ContextItem, included: boolean): ContextReceiptEntry {
  return {
    id: item.id,
    kind: item.kind,
    // Conditional spread, not `path: item.path`: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent key, and a serialized receipt should not grow `"path": null`
    // fields for items that never had one.
    ...(item.path === undefined ? {} : { path: item.path }),
    chars: item.text.length,
    score: item.score,
    reason: item.reason,
    included,
  };
}

// ---------------------------------------------------------------------------
// Lexical ranking
// ---------------------------------------------------------------------------

/**
 * Weights for the three ways a query token can touch a path. The ordering is
 * the claim -- a file *named* for the token beats one that merely mentions it,
 * which beats one that only shares a directory. The absolute values are
 * arbitrary and carry no meaning beyond that ordering.
 */
export const EXACT_BASENAME_WEIGHT = 3;
export const PARTIAL_BASENAME_WEIGHT = 2;
export const PATH_WEIGHT = 1;

/**
 * Query -> distinct lowercase word tokens.
 *
 * Single characters are dropped: they match a substring of nearly every path,
 * so they add score without adding evidence, which is exactly the failure this
 * module exists to prevent.
 */
export function tokenize(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length > 1) tokens.add(token);
  }
  return [...tokens];
}

/**
 * Rank candidate paths against a query by lexical overlap.
 *
 * This is substring matching on file names. It is not semantic retrieval, it
 * has no model behind it, and it will miss a file that solves the query
 * without naming it. That is a known limit, stated rather than hidden: an
 * explainable score whose weaknesses are obvious is a better foundation for
 * measurement than an opaque one whose weaknesses are not, and every item's
 * `reason` names the tokens that earned it its place so a bad ranking can be
 * read off the receipt instead of guessed at.
 *
 * Paths are not read. `text` is the path itself, which is what a flat file
 * listing would have contained anyway; a caller that decides a candidate is
 * worth its contents replaces `text` with them. Non-matching paths are
 * returned with score 0 rather than filtered out, so the receipt records that
 * they were considered -- "was it even a candidate?" is the first question
 * asked about a retrieval miss.
 */
/**
 * Whether a token matches part of a basename in a way that means anything.
 *
 * A bare substring test is too generous, and visibly so: the token `js` is a
 * substring of `json`, so every task mentioning a `.js` file scored
 * `package.json` as a partial basename match. Harmless among four files;
 * on a large repository it promotes noise into a budget that has to evict
 * something real to make room.
 *
 * The rule is that a match must start at a boundary -- the beginning of the
 * name, or just after a separator that names use: `.`, `-`, `_`. So `js`
 * matches `app.js` (after the dot) and not `package.json` (`json` starts at a
 * boundary, `js` within it does not end at one). A one-character token matches
 * nothing partial; there is no signal in it.
 */
function isComponentMatch(base: string, token: string): boolean {
  if (token.length < 2) return false;
  for (const part of base.split(/[./\\\-_]/)) {
    if (part === token) return true;
    // A prefix still counts -- `conf` should find `config` -- but a suffix or a
    // fragment from the middle does not, because those are usually accidents.
    if (part.startsWith(token) && token.length >= 3) return true;
  }
  return false;
}

export function scoreFiles(paths: readonly string[], query: string): ContextItem[] {
  const tokens = tokenize(query);
  const items = paths.map((candidate) => {
    const lower = candidate.toLowerCase();
    // Split on both separators by hand instead of `path.basename`: on POSIX
    // that function does not treat "\" as a separator, and these strings are
    // repository-relative paths that may have been produced on Windows.
    const cut = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"));
    const base = lower.slice(cut + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;

    let score = 0;
    const matched: string[] = [];
    for (const token of tokens) {
      // Each token is counted once, at its strongest tier, so a token that
      // appears in both the directory and the file name is one piece of
      // evidence rather than two.
      if (base === token || stem === token) {
        score += EXACT_BASENAME_WEIGHT;
        matched.push(`${token} (exact basename)`);
      } else if (isComponentMatch(base, token)) {
        score += PARTIAL_BASENAME_WEIGHT;
        matched.push(`${token} (partial basename)`);
      } else if (isComponentMatch(lower, token)) {
        // Same boundary rule as the basename tier, and for the same reason: a
        // bare substring test over the whole path matched `js` inside
        // `package.json` and called it evidence.
        score += PATH_WEIGHT;
        matched.push(`${token} (in path)`);
      }
    }

    const item: ContextItem = {
      id: candidate,
      kind: "file",
      path: candidate,
      text: candidate,
      mandatory: false,
      score,
      reason: matched.length === 0 ? "no query token matched" : `matched ${matched.join(", ")}`,
    };
    return item;
  });
  // Returned pre-ranked even though `compile` sorts again: callers routinely
  // want the top N before they know their budget, and they should not have to
  // re-derive the ordering (and risk deriving a different one).
  return items.sort(byRank);
}
