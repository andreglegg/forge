import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpConfigSchema } from "./mcp.js";
import { detectCommands } from "./verify.js";

export type PermissionMode = "workspace" | "read-only" | "plan";

const ModelProfileSchema = z
  .object({
    url: z.string().url().optional(),
    model: z.string().min(1).optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    native: z.boolean().optional(),
    maxTurns: z.number().int().positive().max(100).optional(),
  })
  .strict();

const HookCommandsSchema = z.array(z.array(z.string()).min(1)).max(20);

const HooksSchema = z
  .object({
    sessionStart: HookCommandsSchema.optional(),
    beforeVerify: HookCommandsSchema.optional(),
    afterVerify: HookCommandsSchema.optional(),
    sessionEnd: HookCommandsSchema.optional(),
  })
  .strict();

/**
 * The extension manifest: name -> subscribed executable. Strict and versioned.
 * `api` is the extension API the entry was written against, enforced at startup
 * against EXTENSION_API_VERSION; `command` is a token array crossing the same
 * shell-free subprocess boundary as every other command Forge runs.
 */
const ExtensionSchema = z
  .object({
    api: z.string().regex(/^\d+\.\d+$/, "api must be major.minor, for example 1.0"),
    command: z.array(z.string().min(1)).min(1),
    events: z.array(z.enum(["beforeCompletion"])).min(1),
    timeoutSeconds: z.number().int().positive().max(600).optional(),
    maxOutputChars: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

const ExtensionsSchema = z.record(z.string().min(1), ExtensionSchema);

/**
 * Where commands run. Absent means the host, which is the historical behaviour
 * and stays the default: a container backend that turned itself on would break
 * every project whose toolchain is installed locally rather than in an image.
 */
const ExecutionSchema = z
  .object({
    runtime: z.enum(["host", "docker", "podman"]).optional(),
    image: z.string().min(1).optional(),
    network: z.boolean().optional(),
    // Sizes are MiB integers, validated here, never runtime strings like "2g":
    // the runtime's own parser would give worse diagnostics, later.
    memoryMiB: z.number().int().positive().optional(),
    cpus: z.number().positive().optional(),
    pids: z.number().int().positive().optional(),
    tmpfsMiB: z.number().int().positive().optional(),
    readOnlyRoot: z.boolean().optional(),
    limits: z.boolean().optional(),
  })
  .strict();

/**
 * Bounded and compiled at load: an invalid or oversize pattern is a hard
 * config error before any provider preflight, never a silent skip. The cap is
 * the ReDoS mitigation that pairs with verify.ts matching line-by-line.
 */
const ADAPTER_PATTERN_MAX_CHARS = 500;

function compilesAsRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

const AdapterPatternSchema = z
  .string()
  .min(1)
  .max(ADAPTER_PATTERN_MAX_CHARS)
  .refine(compilesAsRegExp, { message: "must be a valid regular expression" });

/**
 * A declarative verdict-strictener for one verify command: `failWhen` fails an
 * exit-0 run, `evidence` reshapes the failure body. There is no field that can
 * turn a failure into a pass.
 */
const VerifyAdapterSchema = z
  .object({
    command: z.array(z.string()).min(1),
    failWhen: AdapterPatternSchema.optional(),
    evidence: AdapterPatternSchema.optional(),
  })
  .strict()
  .refine((adapter) => adapter.failWhen !== undefined || adapter.evidence !== undefined, {
    message: "an adapter must declare failWhen, evidence, or both",
  });

const ProjectConfigSchema = z
  .object({
    execution: ExecutionSchema.optional(),
    url: z.string().url().optional(),
    model: z.string().min(1).optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    verify: z.array(z.array(z.string()).min(1)).optional(),
    verifyAdapters: z.array(VerifyAdapterSchema).optional(),
    profile: z.string().min(1).optional(),
    profiles: z.record(z.string().min(1), ModelProfileSchema).optional(),
    hooks: HooksSchema.optional(),
    extensions: ExtensionsSchema.optional(),
    // Declared servers never start automatically: forge.json is a file the
    // model can edit, so starting them stays behind the explicit --mcp flag.
    mcp: McpConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    // Matching is exact token-array equality, so an adapter naming a command
    // absent from `verify` could never apply. Refusing to load is the honest
    // failure: an orphaned adapter that loaded would silently stop guarding
    // the very output it was written to distrust.
    const verify = config.verify ?? [];
    for (const [index, adapter] of (config.verifyAdapters ?? []).entries()) {
      const matched = verify.some(
        (command) =>
          command.length === adapter.command.length &&
          command.every((token, position) => token === adapter.command[position]),
      );
      if (!matched) {
        ctx.addIssue({
          code: "custom",
          path: ["verifyAdapters", index, "command"],
          message: `does not match any verify command exactly: ${adapter.command.join(" ")}`,
        });
      }
    }
  });

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ProjectHooks = z.infer<typeof HooksSchema>;
export type ProjectExtensions = z.infer<typeof ExtensionsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface SelectedModelProfile {
  readonly name: string | null;
  readonly profile: ModelProfile;
}

export function selectModelProfile(
  config: ProjectConfig,
  requested?: string,
): SelectedModelProfile {
  const name = requested ?? config.profile ?? null;
  if (name === null) return { name: null, profile: {} };
  const profile = config.profiles?.[name];
  if (profile === undefined) {
    const available = Object.keys(config.profiles ?? {}).sort();
    throw new Error(
      available.length === 0
        ? `unknown model profile: ${name}; forge.json defines no profiles`
        : `unknown model profile: ${name}; available: ${available.join(", ")}`,
    );
  }
  return { name, profile };
}

/** What the active endpoint's preflight probe advertised; plain data, no transport. */
export interface AdvertisedEndpoint {
  readonly url: string;
  readonly models: readonly string[];
  /**
   * The probe reads `context_length` from the selected model's `/models` entry
   * alone, so the window is a claim about one model, not the endpoint. It is
   * only verifiable against a profile targeting that model.
   */
  readonly contextWindow: number | null;
  readonly contextWindowModel: string | null;
}

export interface ProfileMismatch {
  readonly name: string;
  readonly reason: string;
}

export interface ProfileRecommendation {
  readonly recommended: string | null;
  readonly reason: string | null;
  readonly selectedFits: boolean;
  readonly mismatches: readonly ProfileMismatch[];
}

function normalizedUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Cross-checks configured profiles against what the endpoint advertises.
 * Advisory only: nothing here writes configuration, and adopting the result
 * stays an explicit user action (--profile or editing forge.json).
 *
 * Deterministic by construction: names are evaluated in sorted order so object
 * key order cannot change the outcome, and the ranking is a fixed total order
 * (exact model match, then larger declared context window, then name).
 */
export function recommendProfile(
  endpoint: AdvertisedEndpoint,
  profiles: Readonly<Record<string, ModelProfile>> | undefined,
  selectedName: string | null,
): ProfileRecommendation {
  const entries = profiles ?? {};
  const mismatches: ProfileMismatch[] = [];
  const fits: Array<{ name: string; profile: ModelProfile }> = [];
  for (const name of Object.keys(entries).sort()) {
    const profile = entries[name];
    if (profile === undefined) continue;
    if (profile.url !== undefined && normalizedUrl(profile.url) !== normalizedUrl(endpoint.url)) {
      mismatches.push({ name, reason: `targets a different endpoint (${profile.url})` });
      continue;
    }
    if (profile.model !== undefined && !endpoint.models.includes(profile.model)) {
      mismatches.push({ name, reason: `${profile.model} is not advertised by the endpoint` });
      continue;
    }
    // A context claim is disqualifying only when the endpoint advertised a
    // window for the model this profile would actually run: the probed window
    // belongs to one model, a model-unset profile inherits that model, and any
    // other model's window is unknown -- unverifiable, so never disqualifying.
    if (
      profile.contextWindow !== undefined &&
      endpoint.contextWindow !== null &&
      endpoint.contextWindowModel !== null &&
      (profile.model === undefined || profile.model === endpoint.contextWindowModel) &&
      profile.contextWindow > endpoint.contextWindow
    ) {
      mismatches.push({
        name,
        reason: `declares a ${profile.contextWindow}-token context window but the endpoint advertises ${endpoint.contextWindow} for ${endpoint.contextWindowModel}`,
      });
      continue;
    }
    fits.push({ name, profile });
  }
  const best = [...fits].sort((left, right) => {
    const exact =
      Number(right.profile.model !== undefined) - Number(left.profile.model !== undefined);
    if (exact !== 0) return exact;
    const window = (right.profile.contextWindow ?? 0) - (left.profile.contextWindow ?? 0);
    if (window !== 0) return window;
    return left.name < right.name ? -1 : 1;
  })[0];
  const selectedFits = selectedName === null || fits.some((fit) => fit.name === selectedName);
  if (best === undefined || best.name === selectedName) {
    return { recommended: null, reason: null, selectedFits, mismatches };
  }
  return {
    recommended: best.name,
    reason:
      best.profile.model === undefined
        ? `profile ${best.name} fits every model the endpoint advertises`
        : `profile ${best.name} matches advertised model ${best.profile.model}`,
    selectedFits,
    mismatches,
  };
}

export interface ProjectConfigResult {
  readonly config: ProjectConfig;
  readonly source: string | null;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export function readProjectConfig(root: string): ProjectConfigResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const name of ["forge.yaml", "forge.yml"]) {
    if (existsSync(path.join(root, name))) {
      warnings.push(`${name} is not read; migrate it to forge.json`);
    }
  }
  const source = path.join(root, "forge.json");
  if (!existsSync(source)) return { config: {}, source: null, warnings, errors };
  try {
    const parsed = ProjectConfigSchema.safeParse(JSON.parse(readFileSync(source, "utf8")));
    if (!parsed.success) {
      errors.push(`invalid forge.json: ${z.prettifyError(parsed.error)}`);
      return { config: {}, source, warnings, errors };
    }
    return { config: parsed.data, source, warnings, errors };
  } catch (error) {
    errors.push(`invalid forge.json: ${error instanceof Error ? error.message : String(error)}`);
    return { config: {}, source, warnings, errors };
  }
}

export interface ProjectInitialization {
  readonly created: boolean;
  readonly file: string;
  readonly config: ProjectConfig;
}

export function initializeProject(root: string): ProjectInitialization {
  const file = path.join(root, "forge.json");
  if (existsSync(file)) {
    const existing = readProjectConfig(root);
    if (existing.errors.length > 0) throw new Error(existing.errors.join("\n"));
    return { created: false, file, config: existing.config };
  }
  const verify = detectCommands(root);
  const config: ProjectConfig = verify.length === 0 ? {} : { verify };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { created: true, file, config };
}

export function resolvePermissionMode(
  options: Readonly<Record<string, string | boolean>>,
  command = "",
): PermissionMode {
  const aliases = [
    options["plan"] === true || command === "plan" ? "plan" : null,
    options["read-only"] === true ? "read-only" : null,
    typeof options["mode"] === "string" ? options["mode"] : null,
  ].filter((value): value is string => value !== null);
  const unique = [...new Set(aliases)];
  if (unique.length > 1) throw new Error(`conflicting permission modes: ${unique.join(", ")}`);
  const mode = unique[0] ?? "workspace";
  if (mode !== "workspace" && mode !== "read-only" && mode !== "plan") {
    throw new Error(`unknown permission mode: ${mode}`);
  }
  return mode;
}

export function modeRefusal(mode: PermissionMode): string {
  if (mode === "plan") {
    return "plan mode is read-only: inspect the repository and return a concrete implementation plan without editing files or running commands";
  }
  if (mode === "read-only") {
    return "read-only mode forbids edits and command execution";
  }
  return "";
}
