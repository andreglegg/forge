import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { detectCommands } from "./verify.js";

export type PermissionMode = "workspace" | "read-only" | "plan";

const ModelProfileSchema = z
  .object({
    url: z.string().url().optional(),
    model: z.string().min(1).optional(),
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
 * Where commands run. Absent means the host, which is the historical behaviour
 * and stays the default: a container backend that turned itself on would break
 * every project whose toolchain is installed locally rather than in an image.
 */
const ExecutionSchema = z
  .object({
    runtime: z.enum(["host", "docker", "podman"]).optional(),
    image: z.string().min(1).optional(),
    network: z.boolean().optional(),
  })
  .strict();

const ProjectConfigSchema = z
  .object({
    execution: ExecutionSchema.optional(),
    url: z.string().url().optional(),
    model: z.string().min(1).optional(),
    verify: z.array(z.array(z.string()).min(1)).optional(),
    profile: z.string().min(1).optional(),
    profiles: z.record(z.string().min(1), ModelProfileSchema).optional(),
    hooks: HooksSchema.optional(),
  })
  .strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ProjectHooks = z.infer<typeof HooksSchema>;
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
