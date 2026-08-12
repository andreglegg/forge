import type { Message } from "./provider.js";

const COMPACTION_NOTICE =
  "Earlier turns were compacted by the context guard. Trust current files and recent tool results.";

interface RecentSelection {
  readonly messages: Message[];
  readonly start: number;
  readonly chars: number;
}

interface EvidenceLine {
  readonly priority: 2 | 3 | 4 | 5;
  readonly order: number;
  readonly text: string;
}

export interface CompactionEvidenceReport {
  readonly candidateLines: number;
  readonly keptLines: number;
  readonly keptByPriority: Readonly<Record<2 | 3 | 4 | 5, number>>;
  readonly dedupSkipped: number;
  readonly truncatedLines: number;
}

/**
 * What a compaction did, in counters. Deliberately carries no evicted content:
 * the report is observable evidence about the transcript, never a second copy
 * of it, which also keeps the refuted "inject what was evicted" door closed.
 */
export interface CompactionReport {
  readonly budgetChars: number;
  readonly inputMessages: number;
  readonly inputChars: number;
  /** Input-derived messages that survived, counted post-clip; the notice is separate. */
  readonly keptMessages: number;
  readonly keptChars: number;
  readonly omittedMessages: number;
  readonly omittedChars: number;
  readonly recentKeptMessages: number;
  readonly setupClipped: boolean;
  readonly evidence: CompactionEvidenceReport;
  readonly noticeChars: number;
  readonly finalOverflowClipped: boolean;
}

export interface CompactionOutcome {
  readonly messages: Message[];
  /** Null exactly when the input was returned unchanged. */
  readonly report: CompactionReport | null;
}

const EMPTY_EVIDENCE: CompactionEvidenceReport = {
  candidateLines: 0,
  keptLines: 0,
  keptByPriority: { 2: 0, 3: 0, 4: 0, 5: 0 },
  dedupSkipped: 0,
  truncatedLines: 0,
};

function clipText(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit < 40) return text.slice(0, limit);
  const marker = "\n… compacted …\n";
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function setupMessages(
  messages: readonly Message[],
  budget: number,
): { messages: Message[]; clipped: boolean } {
  const setup = messages.slice(0, Math.min(2, messages.length));
  const cost = setup.reduce((sum, message) => sum + message.content.length, 0);
  const dynamicReserve = Math.max(
    Math.min(COMPACTION_NOTICE.length, budget),
    Math.min(4_000, Math.floor(budget * 0.35)),
  );
  const limit = Math.max(0, budget - dynamicReserve);
  if (cost <= limit) return { messages: [...setup], clipped: false };
  const first = setup[0];
  if (first === undefined) return { messages: [], clipped: false };
  const second = setup[1];
  if (second === undefined) {
    return { messages: [{ ...first, content: clipText(first.content, limit) }], clipped: true };
  }
  const systemLimit = Math.floor(limit * 0.6);
  return {
    messages: [
      { ...first, content: clipText(first.content, systemLimit) },
      { ...second, content: clipText(second.content, limit - systemLimit) },
    ].filter((message) => message.content.length > 0),
    clipped: true,
  };
}

function selectRecent(messages: readonly Message[], budget: number): RecentSelection {
  const selected: Message[] = [];
  let chars = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const remaining = budget - chars;
    if (remaining <= 0) break;
    if (message.content.length <= remaining) {
      selected.unshift(message);
      chars += message.content.length;
      start = index;
      continue;
    }
    if (selected.length === 0) {
      const clipped = clipText(message.content, remaining);
      if (clipped.length > 0) {
        selected.unshift({ ...message, content: clipped });
        chars += clipped.length;
        start = index;
      }
    }
    break;
  }
  return { messages: selected, start, chars };
}

function evidencePriority(role: Message["role"], line: string): 0 | 2 | 3 | 4 | 5 {
  if (
    /\b(?:failed|failure|error|exception|assert|expected|timeout|timed out|verification|flaky|conflict|cannot|could not)\b/i.test(
      line,
    )
  ) {
    return 5;
  }
  if (
    role === "user" &&
    /\b(?:must|do not|don't|never|only|without|preserve|avoid|required|requirement|constraint)\b/i.test(
      line,
    )
  ) {
    return 4;
  }
  if (
    /(?:^|\s)(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cpp|h|json|yaml|yml)(?::\d+)?\b/.test(
      line,
    )
  ) {
    return 3;
  }
  if (/^(?:EDIT|RUN|READ|GREP|SEARCH|ok:\s*applied|failed:)/i.test(line)) return 2;
  return 0;
}

function compactEvidence(
  messages: readonly Message[],
  limit: number,
): { text: string; report: CompactionEvidenceReport } {
  if (limit < 48) return { text: "", report: EMPTY_EVIDENCE };
  const candidates: EvidenceLine[] = [];
  let order = 0;
  for (const message of messages) {
    for (const raw of message.content.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) continue;
      const priority = evidencePriority(message.role, line);
      if (priority === 0) continue;
      candidates.push({
        priority,
        order,
        text: `${message.role}: ${clipText(line, 260).replace(/\n/g, " ")}`,
      });
      order += 1;
    }
  }
  candidates.sort((left, right) => right.priority - left.priority || left.order - right.order);
  const unique = new Set<string>();
  const selected: string[] = [];
  const keptByPriority: Record<2 | 3 | 4 | 5, number> = { 2: 0, 3: 0, 4: 0, 5: 0 };
  let dedupSkipped = 0;
  let truncatedLines = 0;
  let used = 0;
  const heading = "Retained earlier evidence:";
  for (const candidate of candidates) {
    const normalized = candidate.text.toLowerCase();
    if (unique.has(normalized)) {
      dedupSkipped += 1;
      continue;
    }
    unique.add(normalized);
    const available = limit - heading.length - 1 - used;
    if (available < 16) break;
    const fullLine = `- ${candidate.text}`;
    const line =
      fullLine.length + 1 <= available
        ? fullLine
        : clipText(fullLine, available - 1).replace(/\n/g, " ");
    if (line.length === 0) continue;
    selected.push(line);
    keptByPriority[candidate.priority] += 1;
    if (line !== fullLine) truncatedLines += 1;
    used += line.length + 1;
    if (selected.length >= 8) break;
  }
  return {
    text: selected.length === 0 ? "" : `${heading}\n${selected.join("\n")}`,
    report: {
      candidateLines: candidates.length,
      keptLines: selected.length,
      keptByPriority,
      dedupSkipped,
      truncatedLines,
    },
  };
}

/**
 * Bound a transcript while retaining deterministic high-value evidence from
 * omitted turns. The summary never claims stale file contents are current.
 */
export function compactTranscript(messages: readonly Message[], budgetChars: number): Message[] {
  return compactTranscriptReported(messages, budgetChars).messages;
}

/**
 * `compactTranscript` plus a report of what the compaction did.
 *
 * The report is null exactly when the input came back unchanged, so a caller
 * can treat "a report exists" as "the transcript was altered" and record it.
 * The messages are the same bytes `compactTranscript` returns for every input;
 * this function only observes the decisions it was already making.
 */
export function compactTranscriptReported(
  messages: readonly Message[],
  budgetChars: number,
): CompactionOutcome {
  if (messages.length === 0) return { messages: [], report: null };
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (budgetChars <= 0) {
    // Nothing fits, so everything is evicted. Counters still hold: kept is
    // zero and omitted is the whole input.
    return {
      messages: [],
      report: {
        budgetChars,
        inputMessages: messages.length,
        inputChars: total,
        keptMessages: 0,
        keptChars: 0,
        omittedMessages: messages.length,
        omittedChars: total,
        recentKeptMessages: 0,
        setupClipped: false,
        evidence: EMPTY_EVIDENCE,
        noticeChars: 0,
        finalOverflowClipped: false,
      },
    };
  }
  if (total <= budgetChars) return { messages: [...messages], report: null };

  const setup = setupMessages(messages, budgetChars);
  const setupChars = setup.messages.reduce((sum, message) => sum + message.content.length, 0);
  const dynamicBudget = Math.max(0, budgetChars - setupChars - COMPACTION_NOTICE.length);
  const tail = messages.slice(Math.min(2, messages.length));
  const recent = selectRecent(tail, Math.floor(dynamicBudget * 0.65));
  const evidence = compactEvidence(tail.slice(0, recent.start), dynamicBudget - recent.chars);
  const notice = evidence.text ? `${COMPACTION_NOTICE}\n${evidence.text}` : COMPACTION_NOTICE;
  const result = [
    ...setup.messages,
    { role: "user" as const, content: notice },
    ...recent.messages,
  ];
  const noticeIndex = setup.messages.length;

  // Defensive final bound in case a future notice or role wrapper grows.
  let overflow = result.reduce((sum, message) => sum + message.content.length, 0) - budgetChars;
  const finalOverflowClipped = overflow > 0;
  if (overflow > 0) {
    const message = result[noticeIndex];
    if (message !== undefined) {
      const target = Math.max(0, message.content.length - overflow);
      result[noticeIndex] = { ...message, content: clipText(message.content, target) };
      overflow = result.reduce((sum, item) => sum + item.content.length, 0) - budgetChars;
    }
  }
  if (overflow > 0) {
    const last = result.at(-1);
    if (last !== undefined && result.length > noticeIndex + 1) {
      result[result.length - 1] = {
        ...last,
        content: clipText(last.content, Math.max(0, last.content.length - overflow)),
      };
    }
  }

  // Counters read off the final array, so clipping and the empty-content
  // filter below cannot make the report disagree with what was actually sent.
  let keptMessages = 0;
  let keptChars = 0;
  let recentKeptMessages = 0;
  result.forEach((message, index) => {
    if (index === noticeIndex || message.content.length === 0) return;
    keptMessages += 1;
    keptChars += message.content.length;
    if (index > noticeIndex) recentKeptMessages += 1;
  });
  return {
    messages: result.filter((message) => message.content.length > 0),
    report: {
      budgetChars,
      inputMessages: messages.length,
      inputChars: total,
      keptMessages,
      keptChars,
      omittedMessages: messages.length - keptMessages,
      omittedChars: total - keptChars,
      recentKeptMessages,
      setupClipped: setup.clipped,
      evidence: evidence.report,
      noticeChars: result[noticeIndex]?.content.length ?? 0,
      finalOverflowClipped,
    },
  };
}
