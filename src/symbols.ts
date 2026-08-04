import path from "node:path";
import * as ts from "typescript-compiler";
import type { RepositoryIndex } from "./repository.js";
import { indexRepository, readRepositoryText } from "./repository.js";
import { revisionOfContent } from "./workspace.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULTS = 100;

export type RepositorySymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable"
  | "method"
  | "property"
  | "getter"
  | "setter"
  | "enum-member";

export interface RepositorySymbolDeclaration {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: RepositorySymbolKind;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly exported: boolean;
  readonly revision: string;
}

export interface SourceSymbolExtraction {
  readonly declarations: readonly RepositorySymbolDeclaration[];
  readonly parseDiagnostics: number;
}

export interface RepositorySymbolIndex {
  readonly declarations: readonly RepositorySymbolDeclaration[];
  readonly scannedFiles: number;
  readonly candidateFiles: number;
  readonly skippedLargeFiles: number;
  readonly parseErrorFiles: number;
  readonly truncated: boolean;
}

export interface SymbolBuildOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

export interface SymbolLookupOptions {
  readonly index?: RepositoryIndex;
  readonly symbols?: RepositorySymbolIndex;
  readonly path?: string;
  readonly maxResults?: number;
}

export interface RepositorySymbolResult {
  readonly query: string;
  readonly matches: readonly RepositorySymbolDeclaration[];
  readonly output: string;
  readonly truncated: boolean;
}

function normalizedScope(candidate: string): string | null {
  if (!candidate || candidate.includes("\0")) return null;
  if (/^[A-Za-z]:/.test(candidate) || /^[\\/]{2}[^\\/]+[\\/]/.test(candidate)) return null;
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (normalized === ".") return ".";
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isSupportedSource(relative: string): boolean {
  const lower = relative.toLowerCase();
  if (lower.endsWith(".d.ts")) return true;
  return SUPPORTED_EXTENSIONS.has(path.posix.extname(lower));
}

function scriptKind(relative: string): ts.ScriptKind {
  const lower = relative.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (
    ts
      .getModifiers(node)
      ?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword,
      ) ?? false
  );
}

function propertyName(
  node: ts.PropertyName | ts.BindingName,
  sourceFile: ts.SourceFile,
): string | null {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return node.getText(sourceFile);
  return null;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const found: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    found.push(...bindingIdentifiers(element.name));
  }
  return found;
}

function declarationLocation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): Pick<RepositorySymbolDeclaration, "line" | "column" | "endLine" | "endColumn"> {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

export function extractSourceSymbols(relative: string, source: string): SourceSymbolExtraction {
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(relative),
  );
  const revision = revisionOfContent(source);
  const declarations: RepositorySymbolDeclaration[] = [];

  const add = (
    name: string,
    qualifiedName: string,
    kind: RepositorySymbolKind,
    node: ts.Node,
    exported: boolean,
  ): void => {
    declarations.push({
      name,
      qualifiedName,
      kind,
      path: relative,
      ...declarationLocation(sourceFile, node),
      exported,
      revision,
    });
  };

  const addMembers = (
    containerName: string,
    containerExported: boolean,
    members: ts.NodeArray<ts.TypeElement | ts.ClassElement> | ts.NodeArray<ts.EnumMember>,
  ): void => {
    for (const member of members) {
      if (ts.isEnumMember(member)) {
        const name = propertyName(member.name, sourceFile);
        if (name !== null)
          add(name, `${containerName}.${name}`, "enum-member", member.name, containerExported);
        continue;
      }
      if (ts.isConstructorDeclaration(member)) continue;
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        if (member.name === undefined) continue;
        const name = propertyName(member.name, sourceFile);
        if (name !== null)
          add(name, `${containerName}.${name}`, "method", member.name, containerExported);
        continue;
      }
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const name = propertyName(member.name, sourceFile);
        const kind = ts.isGetAccessorDeclaration(member) ? "getter" : "setter";
        if (name !== null)
          add(name, `${containerName}.${name}`, kind, member.name, containerExported);
        continue;
      }
      if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        const name = propertyName(member.name, sourceFile);
        if (name !== null)
          add(name, `${containerName}.${name}`, "property", member.name, containerExported);
      }
    }
  };

  for (const statement of sourceFile.statements) {
    const exported = hasExportModifier(statement);
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      add(statement.name.text, statement.name.text, "function", statement.name, exported);
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      const name = statement.name.text;
      add(name, name, "class", statement.name, exported);
      addMembers(name, exported, statement.members);
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      const name = statement.name.text;
      add(name, name, "interface", statement.name, exported);
      addMembers(name, exported, statement.members);
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      add(statement.name.text, statement.name.text, "type", statement.name, exported);
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      const name = statement.name.text;
      add(name, name, "enum", statement.name, exported);
      addMembers(name, exported, statement.members);
      continue;
    }
    if (ts.isModuleDeclaration(statement)) {
      const name = propertyName(statement.name, sourceFile);
      if (name !== null) add(name, name, "namespace", statement.name, exported);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          add(identifier.text, identifier.text, "variable", identifier, exported);
        }
      }
    }
  }

  declarations.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.qualifiedName.localeCompare(right.qualifiedName),
  );
  const diagnostics = (
    sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  return { declarations, parseDiagnostics: diagnostics?.length ?? 0 };
}

export function buildRepositorySymbols(
  root: string,
  index: RepositoryIndex = indexRepository(root),
  options: SymbolBuildOptions = {},
): RepositorySymbolIndex {
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const candidates = index.entries.filter(
    (entry) => entry.type === "file" && isSupportedSource(entry.path),
  );
  const selected = candidates.slice(0, maxFiles);
  const declarations: RepositorySymbolDeclaration[] = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;
  let parseErrorFiles = 0;

  for (const entry of selected) {
    if ((entry.bytes ?? 0) > maxFileBytes) {
      skippedLargeFiles += 1;
      continue;
    }
    let source: string;
    try {
      source = readRepositoryText(root, entry.path, { maxChars: maxFileBytes }).content;
    } catch {
      continue;
    }
    const extracted = extractSourceSymbols(entry.path, source);
    declarations.push(...extracted.declarations);
    scannedFiles += 1;
    if (extracted.parseDiagnostics > 0) parseErrorFiles += 1;
  }

  declarations.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column,
  );
  return {
    declarations,
    scannedFiles,
    candidateFiles: candidates.length,
    skippedLargeFiles,
    parseErrorFiles,
    truncated: index.truncated || candidates.length > selected.length,
  };
}

function insideScope(relative: string, scope: string): boolean {
  return scope === "." || relative === scope || relative.startsWith(`${scope}/`);
}

export function findRepositorySymbols(
  root: string,
  queryInput: string,
  options: SymbolLookupOptions = {},
): RepositorySymbolResult {
  const query = queryInput.trim();
  if (!query) throw new Error("symbol query cannot be empty");
  const scope = normalizedScope(options.path ?? ".");
  if (scope === null) throw new Error(`${options.path ?? "."} is outside the repository`);
  const index = options.index ?? indexRepository(root);
  const symbols = options.symbols ?? buildRepositorySymbols(root, index);
  const allMatches = symbols.declarations
    .filter(
      (declaration) =>
        insideScope(declaration.path, scope) &&
        (declaration.name === query || declaration.qualifiedName === query),
    )
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.kind.localeCompare(right.kind),
    );
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const matches = allMatches.slice(0, maxResults);
  const truncated = symbols.truncated || allMatches.length > matches.length;
  const output = [
    `Symbol declarations for ${query} (${allMatches.length}):`,
    ...(matches.length === 0
      ? ["  (none)"]
      : matches.map(
          (match) =>
            `  ${match.kind} ${match.qualifiedName} — ${match.path}:${match.line}:${match.column}-${match.endLine}:${match.endColumn}${match.exported ? " [exported]" : ""} [rev ${match.revision.slice(0, 12)}]`,
        )),
    ...(allMatches.length > matches.length
      ? [`  … ${allMatches.length - matches.length} more`]
      : []),
    `Analysis: TypeScript compiler syntax tree; exact declarations and named members only, without type checking, aliases, locals, or semantic references.`,
    `Scan: ${symbols.scannedFiles}/${symbols.candidateFiles} supported files${symbols.skippedLargeFiles > 0 ? `; ${symbols.skippedLargeFiles} oversized files skipped` : ""}${symbols.parseErrorFiles > 0 ? `; ${symbols.parseErrorFiles} files had parse diagnostics` : ""}.`,
    ...(symbols.truncated ? ["[symbol scan truncated at the configured safety limit]"] : []),
  ].join("\n");
  return { query, matches, output, truncated };
}
