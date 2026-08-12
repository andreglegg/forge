export type PatchRiskSeverity = "warning" | "critical";

export interface PatchRisk {
  readonly severity: PatchRiskSeverity;
  readonly code:
    | "dependency_manifest"
    | "dependency_confusion"
    | "dependency_source"
    | "install_lifecycle"
    | "likely_secret"
    | "high_entropy_secret"
    | "dangerous_workflow";
  readonly file: string | null;
  readonly message: string;
}

interface PatchLine {
  readonly file: string | null;
  readonly text: string;
}

const DEPENDENCY_MANIFEST =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|uv\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|Gemfile(?:\.lock)?|composer\.json|composer\.lock)$/i;
const WORKFLOW_FILE = /(?:^|\/)\.github\/workflows\/[^/]+\.(?:ya?ml)$/i;
const OBVIOUS_PLACEHOLDER =
  /(?:example|placeholder|replace[_ -]?me|your[_ -]?(?:api[_ -]?)?key|dummy|fake|test[_ -]?(?:key|token)|not[_ -]?a[_ -]?real|xxx+|<[^>]+>)/i;
const PACKAGE_JSON_FILE = /(?:^|\/)package\.json$/i;
const REQUIREMENTS_FILE = /(?:^|\/)requirements[^/]*\.txt$/i;
const LOCKFILE_PATH = /(?:(?:^|\/)(?:package-lock\.json|go\.sum)|\.lock|-lock\.ya?ml)$/i;
const MINIFIED_PATH = /\.(?:min\.js|map)$/i;
const GITHUB_SHORTHAND = /^(?:github:)?[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(?:#\S*)?$/;
// Common non-dependency package.json keys that also appear as `"name": "value"`.
const PACKAGE_JSON_METADATA_KEYS = new Set([
  "name",
  "version",
  "description",
  "homepage",
  "license",
  "main",
  "module",
  "browser",
  "types",
  "typings",
  "type",
  "author",
  "url",
  "email",
  "directory",
  "registry",
  "access",
  "tag",
  "node",
  "packageManager",
]);
// Bounds keeping the scan O(patch bytes) even on adversarial manifests/lines.
const MANIFEST_ENTRY_LIMIT = 400;
const ENTROPY_CANDIDATES_PER_LINE = 8;
const ENTROPY_THRESHOLD_BITS = 3.8;
const NAME_LENGTH_LIMIT = 214;

interface ParsedPatch {
  readonly added: PatchLine[];
  readonly removed: PatchLine[];
}

function parsePatchLines(patch: string): ParsedPatch {
  const added: PatchLine[] = [];
  const removed: PatchLine[] = [];
  let file: string | null = null;
  for (const raw of patch.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header !== null) {
      file = header[2] ?? null;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      added.push({ file, text: raw.slice(1) });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      removed.push({ file, text: raw.slice(1) });
    }
  }
  return { added, removed };
}

function pushUnique(found: PatchRisk[], risk: PatchRisk): void {
  if (
    found.some(
      (item) => item.code === risk.code && item.file === risk.file && item.message === risk.message,
    )
  ) {
    return;
  }
  found.push(risk);
}

function containsLikelySecret(line: string): boolean {
  if (OBVIOUS_PLACEHOLDER.test(line)) return false;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) return true;
  if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) return true;
  if (/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/.test(line)) return true;
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(line)) return true;
  if (/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/.test(line)) return true;
  if (/\b[sr]k_live_[A-Za-z0-9]{16,}\b/.test(line)) return true;
  if (/\bAIza[0-9A-Za-z_-]{30,}\b/.test(line)) return true;
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/.test(line)) return true;
  return /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(
    line,
  );
}

function shannonEntropyBits(token: string): number {
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function entropyCandidates(line: string): string[] {
  const results: string[] = [];
  const contexts = [
    /["']([A-Za-z0-9+/=_-]{24,})["']/g,
    /[:=]\s*([A-Za-z0-9+/=_-]{24,})(?=[\s,;]|$)/g,
  ];
  for (const regex of contexts) {
    let match = regex.exec(line);
    while (match !== null && results.length < ENTROPY_CANDIDATES_PER_LINE) {
      if (match[1] !== undefined) results.push(match[1]);
      match = regex.exec(line);
    }
  }
  return results;
}

function containsHighEntropySecret(file: string | null, line: string): boolean {
  if (file !== null && (LOCKFILE_PATH.test(file) || MINIFIED_PATH.test(file))) return false;
  if (OBVIOUS_PLACEHOLDER.test(line)) return false;
  if (/\bsha(?:256|512)-|\bintegrity\b/i.test(line)) return false;
  // Lowercase-only or hex-shaped tokens (module paths, slugs, commit SHAs,
  // digests) clear the entropy threshold while being indistinguishable from
  // ordinary source text; require the mixed upper/lower/digit shape of
  // machine-generated credentials before measuring entropy.
  return entropyCandidates(line).some(
    (token) =>
      /[a-z]/.test(token) &&
      /[A-Z]/.test(token) &&
      /[0-9]/.test(token) &&
      shannonEntropyBits(token) >= ENTROPY_THRESHOLD_BITS,
  );
}

interface ManifestEntry {
  readonly name: string;
  readonly spec: string;
  /** Whether the entry is precise enough for the critical confusion path. */
  readonly confusable: boolean;
}

/**
 * Line-level package.json parsing cannot see block boundaries, so a
 * `"name": "value"` pair may be a script or other non-dependency key. Restrict
 * the critical confusion path to values shaped like dependency specifiers
 * (version ranges, wildcards, protocols, github shorthand); shell-ish script
 * values such as "vitest run" or "tsc --noEmit" do not qualify.
 */
function looksLikeDependencySpec(spec: string): boolean {
  const value = spec.trim();
  if (value === "" || value === "*") return true;
  if (
    /^(?:git\+|git:|github:|file:|link:|npm:|workspace:|catalog:|portal:|patch:|https?:)/i.test(
      value,
    )
  ) {
    return true;
  }
  if (GITHUB_SHORTHAND.test(value)) return true;
  // A semver range: every whitespace-separated part is an operator, a range
  // hyphen, an "||" join, or a version-ish token starting with a digit/x/*.
  return value
    .split(/\s+/)
    .every((part) => /^(?:\|\||-|[~^><=]{1,2}|[~^><=]{0,2}v?[0-9xX*][0-9A-Za-z.*+-]*)$/.test(part));
}

function manifestEntry(file: string, text: string): ManifestEntry | null {
  const line = text.trim();
  if (PACKAGE_JSON_FILE.test(file)) {
    const pair = /^"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"([^"]*)"\s*,?$/.exec(line);
    if (pair === null) return null;
    const name = pair[1] ?? "";
    if (PACKAGE_JSON_METADATA_KEYS.has(name)) return null;
    const spec = pair[2] ?? "";
    return { name, spec, confusable: looksLikeDependencySpec(spec) };
  }
  if (REQUIREMENTS_FILE.test(file)) {
    if (line === "" || line.startsWith("#") || line.startsWith("-")) return null;
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(
      line,
    );
    if (match === null) return null;
    const rest = (match[2] ?? "").trim();
    return {
      name: match[1] ?? "",
      spec: rest.startsWith("@") ? rest.slice(1).trim() : rest,
      confusable: true,
    };
  }
  return null;
}

function manifestEntriesByFile(lines: readonly PatchLine[]): Map<string, ManifestEntry[]> {
  const byFile = new Map<string, ManifestEntry[]>();
  for (const line of lines) {
    if (line.file === null) continue;
    if (!PACKAGE_JSON_FILE.test(line.file) && !REQUIREMENTS_FILE.test(line.file)) continue;
    const entry = manifestEntry(line.file, line.text);
    if (entry === null || entry.name === "") continue;
    const entries = byFile.get(line.file) ?? [];
    if (entries.length >= MANIFEST_ENTRY_LIMIT) continue;
    entries.push(entry);
    byFile.set(line.file, entries);
  }
  return byFile;
}

function normalizedName(name: string): string {
  return name
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[-_.]/g, "");
}

/** Optimal-string-alignment Damerau-Levenshtein distance; inputs are length-bounded by the caller. */
function editDistance(left: string, right: string): number {
  const width = right.length + 1;
  const cells = new Array<number>((left.length + 1) * width).fill(0);
  for (let i = 0; i <= left.length; i += 1) cells[i * width] = i;
  for (let j = 0; j <= right.length; j += 1) cells[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let best = Math.min(
        (cells[(i - 1) * width + j] ?? 0) + 1,
        (cells[i * width + (j - 1)] ?? 0) + 1,
        (cells[(i - 1) * width + (j - 1)] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, (cells[(i - 2) * width + (j - 2)] ?? 0) + 1);
      }
      cells[i * width + j] = best;
    }
  }
  return cells[left.length * width + right.length] ?? 0;
}

function namesCollide(added: string, removed: string): boolean {
  if (added === removed) return false;
  if (added.length < 4 || removed.length < 4) return false;
  if (added.length > NAME_LENGTH_LIMIT || removed.length > NAME_LENGTH_LIMIT) return false;
  if (normalizedName(added) === normalizedName(removed)) return true;
  if (Math.abs(added.length - removed.length) > 1) return false;
  return editDistance(added.toLowerCase(), removed.toLowerCase()) === 1;
}

function dependencySourceRisk(
  entry: ManifestEntry,
): Pick<PatchRisk, "severity" | "message"> | null {
  const spec = entry.spec.trim();
  if (spec === "") return null;
  const snippet = spec.length > 120 ? `${spec.slice(0, 120)}…` : spec;
  if (/^git\+/i.test(spec) || /^git:\/\//i.test(spec) || GITHUB_SHORTHAND.test(spec)) {
    return {
      severity: "warning",
      message: `added dependency "${entry.name}" resolves from a git source instead of a registry: ${snippet}`,
    };
  }
  if (/^(?:file|link):/i.test(spec)) {
    return {
      severity: "warning",
      message: `added dependency "${entry.name}" resolves from a local path instead of a registry: ${snippet}`,
    };
  }
  if (/^http:\/\//i.test(spec)) {
    return {
      severity: "critical",
      message: `added dependency "${entry.name}" resolves from an insecure http URL instead of a registry: ${snippet}`,
    };
  }
  if (/^https:\/\//i.test(spec)) {
    return {
      severity: "warning",
      message: `added dependency "${entry.name}" resolves from a tarball URL instead of a registry: ${snippet}`,
    };
  }
  if (spec === "*" || /^latest$/i.test(spec)) {
    return {
      severity: "warning",
      message: `added dependency "${entry.name}" uses the unpinned specifier "${spec}"`,
    };
  }
  return null;
}

/**
 * Scan added and removed patch lines. Findings are deterministic warnings, not
 * proof that a patch is malicious or safe.
 */
export function scanPatchRisks(patch: string): PatchRisk[] {
  const found: PatchRisk[] = [];
  const { added, removed } = parsePatchLines(patch);
  const touchedFiles = new Set(added.flatMap((line) => (line.file === null ? [] : [line.file])));

  for (const file of [...touchedFiles].sort()) {
    if (DEPENDENCY_MANIFEST.test(file)) {
      pushUnique(found, {
        severity: "warning",
        code: "dependency_manifest",
        file,
        message:
          "dependency or package-manager metadata changed; review new packages and lockfile movement",
      });
    }
  }

  const addedEntries = manifestEntriesByFile(added);
  const removedEntries = manifestEntriesByFile(removed);
  for (const [file, entries] of addedEntries) {
    const removedInFile = removedEntries.get(file) ?? [];
    for (const entry of entries) {
      for (const removedEntry of removedInFile) {
        if (!entry.confusable || !removedEntry.confusable) continue;
        if (!namesCollide(entry.name, removedEntry.name)) continue;
        pushUnique(found, {
          severity: "critical",
          code: "dependency_confusion",
          file,
          message: `added dependency "${entry.name}" closely resembles removed dependency "${removedEntry.name}"; possible lookalike substitution`,
        });
      }
      const source = dependencySourceRisk(entry);
      if (source !== null) {
        pushUnique(found, { ...source, code: "dependency_source", file });
      }
    }
  }

  for (const line of added) {
    const text = line.text.trim();
    if (containsLikelySecret(text)) {
      pushUnique(found, {
        severity: "critical",
        code: "likely_secret",
        file: line.file,
        message: "added line resembles a credential or private key",
      });
    } else if (containsHighEntropySecret(line.file, text)) {
      // At most one secret finding per line; the prefix match above wins.
      pushUnique(found, {
        severity: "critical",
        code: "high_entropy_secret",
        file: line.file,
        message: "added line assigns a high-entropy token that resembles a credential",
      });
    }
    if (
      line.file !== null &&
      PACKAGE_JSON_FILE.test(line.file) &&
      /["'](?:preinstall|install|postinstall|prepare|prepublish|prepublishOnly)["']\s*:/.test(text)
    ) {
      pushUnique(found, {
        severity: "critical",
        code: "install_lifecycle",
        file: line.file,
        message: "package installation lifecycle script was added or changed",
      });
    }
    if (
      line.file !== null &&
      WORKFLOW_FILE.test(line.file) &&
      (/\bpull_request_target\b/.test(text) || /(?:curl|wget)[^|\n]*\|\s*(?:sh|bash)\b/i.test(text))
    ) {
      pushUnique(found, {
        severity: "critical",
        code: "dangerous_workflow",
        file: line.file,
        message: "workflow adds a privileged trigger or downloads code directly into a shell",
      });
    }
  }

  return found.sort(
    (left, right) =>
      (left.severity === right.severity ? 0 : left.severity === "critical" ? -1 : 1) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

export interface PromotionRiskDecision {
  readonly allowed: boolean;
  readonly criticalCount: number;
  readonly overridden: boolean;
  readonly reason: string | null;
}

export function decidePromotionRisk(
  risks: readonly PatchRisk[],
  allowCritical: boolean,
): PromotionRiskDecision {
  const criticalCount = risks.filter((risk) => risk.severity === "critical").length;
  if (criticalCount === 0) {
    return { allowed: true, criticalCount: 0, overridden: false, reason: null };
  }
  if (allowCritical) {
    return { allowed: true, criticalCount, overridden: true, reason: null };
  }
  return {
    allowed: false,
    criticalCount,
    overridden: false,
    reason: `${criticalCount} critical patch risk${criticalCount === 1 ? "" : "s"} require review; patch retained. Re-run with --allow-risk only after inspecting it.`,
  };
}
