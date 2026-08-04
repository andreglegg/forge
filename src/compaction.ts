import type { Message } from "./provider.js";

const COMPACTION_NOTICE =
  "Earlier turns were compacted by the context guard. Trust current files and recent tool results.";

interface RecentSelection {
  readonly messages: Message[];
  readonly start: number;
  readonly chars: number;
}

interface EvidenceLine {
  readonly priority: number;
  readonly order: number;
  readonly text: string;
}

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

function setupMessages(messages: readonly Message[], budget: number): Message[] {
  const setup = messages.slice(0, Math.min(2, messages.length));
  const cost = setup.reduce((sum, message) => sum + message.content.length, 0);
  const dynamicReserve = Math.max(
    Math.min(COMPACTION_NOTICE.length, budget),
    Math.min(4_000, Math.floor(budget * 0.35)),
  );
  const limit = Math.max(0, budget - dynamicReserve);
  if (cost <= limit) return [...setup];
  const first = setup[0];
  if (first === undefined) return [];
  const second = setup[1];
  if (second === undefined) {
    return [{ ...first, content: clipText(first.content, limit) }];
  }
  const systemLimit = Math.floor(limit * 0.6);
  return [
    { ...first, content: clipText(first.content, systemLimit) },
    { ...second, content: clipText(second.content, limit - systemLimit) },
  ].filter((message) => message.content.length > 0);
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

function evidencePriority(role: Message["role"], line: string): number {
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

function compactEvidence(messages: readonly Message[], limit: number): string {
  if (limit < 48) return "";
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
  let used = 0;
  const heading = "Retained earlier evidence:";
  for (const candidate of candidates) {
    const normalized = candidate.text.toLowerCase();
    if (unique.has(normalized)) continue;
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
    used += line.length + 1;
    if (selected.length >= 8) break;
  }
  return selected.length === 0 ? "" : `${heading}\n${selected.join("\n")}`;
}

/**
 * Bound a transcript while retaining deterministic high-value evidence from
 * omitted turns. The summary never claims stale file contents are current.
 */
export function compactTranscript(messages: readonly Message[], budgetChars: number): Message[] {
  if (budgetChars <= 0 || messages.length === 0) return [];
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= budgetChars) return [...messages];

  const setup = setupMessages(messages, budgetChars);
  const setupChars = setup.reduce((sum, message) => sum + message.content.length, 0);
  const dynamicBudget = Math.max(0, budgetChars - setupChars - COMPACTION_NOTICE.length);
  const tail = messages.slice(Math.min(2, messages.length));
  const recent = selectRecent(tail, Math.floor(dynamicBudget * 0.65));
  const evidence = compactEvidence(tail.slice(0, recent.start), dynamicBudget - recent.chars);
  const notice = evidence ? `${COMPACTION_NOTICE}\n${evidence}` : COMPACTION_NOTICE;
  const result = [...setup, { role: "user" as const, content: notice }, ...recent.messages];

  // Defensive final bound in case a future notice or role wrapper grows.
  let overflow = result.reduce((sum, message) => sum + message.content.length, 0) - budgetChars;
  if (overflow > 0) {
    const noticeIndex = setup.length;
    const message = result[noticeIndex];
    if (message !== undefined) {
      const target = Math.max(0, message.content.length - overflow);
      result[noticeIndex] = { ...message, content: clipText(message.content, target) };
      overflow = result.reduce((sum, item) => sum + item.content.length, 0) - budgetChars;
    }
  }
  if (overflow > 0) {
    const last = result.at(-1);
    if (last !== undefined && result.length > setup.length + 1) {
      result[result.length - 1] = {
        ...last,
        content: clipText(last.content, Math.max(0, last.content.length - overflow)),
      };
    }
  }
  return result.filter((message) => message.content.length > 0);
}
