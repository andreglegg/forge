import path from "node:path";
import * as ts from "typescript-compiler";
import { canonicalFilesystemPath, filesystemPathKey } from "./path-utils.js";
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
const AUTOMATIC_CONTEXT_MAX_FILES = 200;

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

export interface RepositorySymbolReference {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly revision: string;
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

export interface RepositoryReferenceResult {
  readonly query: string;
  readonly matches: readonly RepositorySymbolReference[];
  readonly output: string;
  readonly truncated: boolean;
}

export interface RepositoryCaller {
  readonly target: string;
  readonly caller: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly revision: string;
}

export interface RepositoryCallerResult {
  readonly query: string;
  readonly matches: readonly RepositoryCaller[];
  readonly output: string;
  readonly truncated: boolean;
}

export interface SemanticContextPath {
  readonly path: string;
  readonly score: number;
  readonly reason: string;
}

const TASK_SYMBOL_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\b/g;

/** Extract identifiers that look deliberately code-shaped rather than ordinary prose. */
export function taskSymbolQueries(task: string): readonly string[] {
  const found = new Set<string>();
  for (const candidate of task.match(TASK_SYMBOL_PATTERN) ?? []) {
    const leaf = candidate.split(".").at(-1) ?? candidate;
    const codeShaped =
      candidate.includes(".") ||
      /[a-z][A-Z]/.test(leaf) ||
      /^[A-Z][A-Za-z0-9_$]*[a-z][A-Za-z0-9_$]*$/.test(leaf) ||
      (/^[A-Z][A-Z0-9_$]+$/.test(leaf) && leaf.length >= 3);
    if (codeShaped) found.add(candidate);
  }
  return [...found].slice(0, 4);
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

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node)
  );
}

export function extractSourceReferences(
  relative: string,
  source: string,
  queryInput: string,
): readonly RepositorySymbolReference[] {
  const query = queryInput.trim().split(".").at(-1) ?? "";
  if (!query) return [];
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(relative),
  );
  const revision = revisionOfContent(source);
  const matches: RepositorySymbolReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === query && !isDeclarationIdentifier(node)) {
      matches.push({
        name: query,
        path: relative,
        ...declarationLocation(sourceFile, node),
        revision,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

export function findRepositoryReferences(
  root: string,
  queryInput: string,
  options: SymbolLookupOptions = {},
): RepositoryReferenceResult {
  const query = queryInput.trim();
  if (!query) throw new Error("reference query cannot be empty");
  const scope = normalizedScope(options.path ?? ".");
  if (scope === null) throw new Error(`${options.path ?? "."} is outside the repository`);
  const index = options.index ?? indexRepository(root);
  const maxFiles = DEFAULT_MAX_FILES;
  const candidates = index.entries.filter(
    (entry) =>
      entry.type === "file" && isSupportedSource(entry.path) && insideScope(entry.path, scope),
  );
  const selected = candidates.slice(0, maxFiles);
  const allMatches: RepositorySymbolReference[] = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;
  for (const entry of selected) {
    if ((entry.bytes ?? 0) > DEFAULT_MAX_FILE_BYTES) {
      skippedLargeFiles += 1;
      continue;
    }
    try {
      const source = readRepositoryText(root, entry.path, {
        maxChars: DEFAULT_MAX_FILE_BYTES,
      }).content;
      allMatches.push(...extractSourceReferences(entry.path, source, query));
      scannedFiles += 1;
    } catch {}
  }
  allMatches.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column,
  );
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const matches = allMatches.slice(0, maxResults);
  const truncated =
    index.truncated || candidates.length > selected.length || allMatches.length > matches.length;
  const output = [
    `Syntax references for ${query} (${allMatches.length}):`,
    ...(matches.length === 0
      ? ["  (none)"]
      : matches.map(
          (match) =>
            `  ${match.path}:${match.line}:${match.column}-${match.endLine}:${match.endColumn} [rev ${match.revision.slice(0, 12)}]`,
        )),
    ...(allMatches.length > matches.length
      ? [`  … ${allMatches.length - matches.length} more`]
      : []),
    "Analysis: exact TypeScript/JavaScript identifier occurrences outside declaration sites; syntax-only, without alias, type, scope, or runtime resolution.",
    `Scan: ${scannedFiles}/${candidates.length} supported files${skippedLargeFiles > 0 ? `; ${skippedLargeFiles} oversized files skipped` : ""}.`,
    ...(truncated ? ["[reference scan truncated at the configured safety limit]"] : []),
  ].join("\n");
  return { query, matches, output, truncated };
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | null {
  if (symbol === undefined) return null;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function isTopLevelDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === node
  ) {
    return ts.isSourceFile(parent.parent);
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    const list = parent.parent;
    return (
      ts.isVariableDeclarationList(list) &&
      ts.isVariableStatement(list.parent) &&
      ts.isSourceFile(list.parent.parent)
    );
  }
  return false;
}

function qualifiedDeclarationName(node: ts.Identifier): string {
  const parent = node.parent;
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  ) {
    const container = parent.parent;
    if (
      (ts.isClassDeclaration(container) || ts.isInterfaceDeclaration(container)) &&
      container.name
    ) {
      return `${container.name.text}.${node.text}`;
    }
  }
  return node.text;
}

function enclosingCaller(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) {
      const name = propertyName(current.name, current.getSourceFile()) ?? "<method>";
      const container = current.parent;
      return ts.isClassDeclaration(container) && container.name
        ? `${container.name.text}.${name}`
        : name;
    }
    if (ts.isConstructorDeclaration(current)) {
      const container = current.parent;
      return ts.isClassDeclaration(container) && container.name
        ? `${container.name.text}.constructor`
        : "constructor";
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      return "<anonymous>";
    }
    current = current.parent;
  }
  return "<module>";
}

export function findRepositoryCallers(
  root: string,
  queryInput: string,
  options: SymbolLookupOptions = {},
): RepositoryCallerResult {
  const query = queryInput.trim();
  if (!query) throw new Error("caller query cannot be empty");
  const scope = normalizedScope(options.path ?? ".");
  if (scope === null) throw new Error(`${options.path ?? "."} is outside the repository`);
  const index = options.index ?? indexRepository(root);
  const candidates = index.entries.filter(
    (entry) =>
      entry.type === "file" && isSupportedSource(entry.path) && insideScope(entry.path, scope),
  );
  const selected = candidates
    .slice(0, DEFAULT_MAX_FILES)
    .filter((entry) => (entry.bytes ?? 0) <= DEFAULT_MAX_FILE_BYTES);
  const canonicalRoot = canonicalFilesystemPath(root);
  const rootNames = selected.map((entry) => path.join(canonicalRoot, ...entry.path.split("/")));
  const rootNameKeys = new Set(rootNames.map(filesystemPathKey));
  const program = ts.createProgram({
    rootNames,
    options: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      noLib: true,
      skipLibCheck: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.Latest,
    },
  });
  const checker = program.getTypeChecker();
  const targets = new Set<ts.Symbol>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!rootNameKeys.has(filesystemPathKey(sourceFile.fileName))) continue;
    const visitDeclaration = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && isDeclarationIdentifier(node)) {
        const name = qualifiedDeclarationName(node);
        const selectedDeclaration = query.includes(".")
          ? name === query
          : isTopLevelDeclarationIdentifier(node) && node.text === query;
        if (selectedDeclaration) {
          const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node));
          if (symbol !== null) targets.add(symbol);
        }
      }
      ts.forEachChild(node, visitDeclaration);
    };
    visitDeclaration(sourceFile);
  }

  const matches: RepositoryCaller[] = [];
  if (targets.size > 0) {
    for (const sourceFile of program.getSourceFiles()) {
      const relative = path
        .relative(canonicalRoot, canonicalFilesystemPath(sourceFile.fileName))
        .replaceAll("\\", "/");
      if (!insideScope(relative, scope) || !isSupportedSource(relative)) continue;
      const revision = revisionOfContent(sourceFile.text);
      const visitCall = (node: ts.Node): void => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = node.expression;
          const lookup = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
          const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(lookup));
          if (symbol !== null && targets.has(symbol)) {
            matches.push({
              target: query,
              caller: enclosingCaller(node),
              path: relative,
              ...declarationLocation(sourceFile, expression),
              revision,
            });
          }
        }
        ts.forEachChild(node, visitCall);
      };
      visitCall(sourceFile);
    }
  }

  matches.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column,
  );
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const shown = matches.slice(0, maxResults);
  const truncated =
    index.truncated || candidates.length > selected.length || matches.length > shown.length;
  const output = [
    `Semantic callers for ${query} (${matches.length}):`,
    ...(shown.length === 0
      ? ["  (none)"]
      : shown.map(
          (match) =>
            `  ${match.caller} — ${match.path}:${match.line}:${match.column}-${match.endLine}:${match.endColumn} [rev ${match.revision.slice(0, 12)}]`,
        )),
    ...(matches.length > shown.length ? [`  … ${matches.length - shown.length} more`] : []),
    "Analysis: TypeScript checker-resolved direct calls and constructor calls, including relative-import aliases and lexical scope. Dynamic dispatch, reflection, package aliases, and untyped runtime calls are not inferred.",
    `Scan: ${selected.length}/${candidates.length} supported files.`,
    ...(truncated ? ["[caller scan truncated at the configured safety limit]"] : []),
  ].join("\n");
  return { query, matches: shown, output, truncated };
}

export function semanticContextPaths(
  root: string,
  task: string,
  index: RepositoryIndex = indexRepository(root),
): readonly SemanticContextPath[] {
  const queries = taskSymbolQueries(task);
  if (queries.length === 0) return [];
  const supportedFiles = index.entries.filter(
    (entry) => entry.type === "file" && isSupportedSource(entry.path),
  ).length;
  // Automatic context runs before the first model turn, so it has a stricter
  // latency budget than an explicitly requested SYMBOL/REFERENCES/CALLERS tool.
  if (supportedFiles > AUTOMATIC_CONTEXT_MAX_FILES) return [];

  const symbols = buildRepositorySymbols(root, index);
  const evidence = new Map<string, SemanticContextPath>();
  const add = (candidatePath: string, score: number, reason: string): void => {
    const current = evidence.get(candidatePath);
    if (current === undefined) {
      evidence.set(candidatePath, { path: candidatePath, score, reason });
      return;
    }
    evidence.set(candidatePath, {
      path: candidatePath,
      score: Math.max(current.score, score),
      reason: current.reason.includes(reason) ? current.reason : `${current.reason}; ${reason}`,
    });
  };

  for (const query of queries) {
    const declarations = findRepositorySymbols(root, query, {
      index,
      symbols,
      maxResults: 20,
    }).matches;
    for (const declaration of declarations) {
      add(declaration.path, 40, `declares task symbol ${query}`);
    }
    if (declarations.length === 0) continue;
    for (const caller of findRepositoryCallers(root, query, { index, maxResults: 30 }).matches) {
      add(caller.path, 30, `calls task symbol ${query} from ${caller.caller}`);
    }
    for (const reference of findRepositoryReferences(root, query, { index, maxResults: 30 })
      .matches) {
      add(reference.path, 20, `references task symbol ${query}`);
    }
  }

  return [...evidence.values()].sort(
    (left, right) => right.score - left.score || left.path.localeCompare(right.path),
  );
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
