export type PatchRiskSeverity = "warning" | "critical";

export interface PatchRisk {
  readonly severity: PatchRiskSeverity;
  readonly code:
    | "dependency_manifest"
    | "install_lifecycle"
    | "likely_secret"
    | "dangerous_workflow";
  readonly file: string | null;
  readonly message: string;
}

interface AddedPatchLine {
  readonly file: string | null;
  readonly text: string;
}

const DEPENDENCY_MANIFEST =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|uv\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|Gemfile(?:\.lock)?|composer\.json|composer\.lock)$/i;
const WORKFLOW_FILE = /(?:^|\/)\.github\/workflows\/[^/]+\.(?:ya?ml)$/i;
const OBVIOUS_PLACEHOLDER =
  /(?:example|placeholder|replace[_ -]?me|your[_ -]?(?:api[_ -]?)?key|dummy|fake|test[_ -]?(?:key|token)|not[_ -]?a[_ -]?real|xxx+|<[^>]+>)/i;

function addedLines(patch: string): AddedPatchLine[] {
  const lines: AddedPatchLine[] = [];
  let file: string | null = null;
  for (const raw of patch.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header !== null) {
      file = header[2] ?? null;
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    lines.push({ file, text: raw.slice(1) });
  }
  return lines;
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
  return /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(
    line,
  );
}

/**
 * Scan only added patch lines. Findings are deterministic warnings, not proof
 * that a patch is malicious or safe.
 */
export function scanPatchRisks(patch: string): PatchRisk[] {
  const found: PatchRisk[] = [];
  const added = addedLines(patch);
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

  for (const line of added) {
    const text = line.text.trim();
    if (containsLikelySecret(text)) {
      pushUnique(found, {
        severity: "critical",
        code: "likely_secret",
        file: line.file,
        message: "added line resembles a credential or private key",
      });
    }
    if (
      line.file !== null &&
      /(?:^|\/)package\.json$/i.test(line.file) &&
      /["'](?:preinstall|install|postinstall)["']\s*:/.test(text)
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
      left.code.localeCompare(right.code),
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
