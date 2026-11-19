import { readFileSync, statSync } from 'node:fs';
import ts from 'typescript';

export type DefinitionLocation = {
  path: string;
  line: number;
  column: number;
  endColumn: number;
};

/** What an identifier is bound to when it comes from another module. `importedName` is the name the
 * target module exports: `'default'` for a default import, `'*'` for a namespace import. */
export type ImportBinding = {
  specifier: string;
  importedName: string;
};

export type ResolveSpecifier = (fromFile: string, specifier: string) => string | null;

const MAX_EXPORT_DEPTH = 8;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;

function identifierAt(sourceFile: ts.SourceFile, offset: number): ts.Identifier | null {
  let found: ts.Identifier | null = null;
  const visit = (node: ts.Node): void => {
    if (offset < node.getStart(sourceFile) || offset >= node.getEnd()) return;
    if (ts.isIdentifier(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function moduleSpecifierText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

type BindingDeclaration =
  | ts.ImportSpecifier
  | ts.ImportClause
  | ts.NamespaceImport
  | ts.ExportSpecifier;

function isBindingDeclaration(node: ts.Node): node is BindingDeclaration {
  return (
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isExportSpecifier(node)
  );
}

function moduleOf(declaration: BindingDeclaration): ts.Expression | undefined {
  if (ts.isImportClause(declaration)) return declaration.parent.moduleSpecifier;
  if (ts.isImportSpecifier(declaration)) return declaration.parent.parent.parent.moduleSpecifier;
  return declaration.parent.parent.moduleSpecifier;
}

function importedNameOf(declaration: BindingDeclaration): string {
  if (ts.isImportClause(declaration)) return 'default';
  if (ts.isNamespaceImport(declaration)) return '*';
  return (declaration.propertyName ?? declaration.name).text;
}

function bindingFromDeclaration(declaration: ts.Node): ImportBinding | null {
  if (!isBindingDeclaration(declaration)) return null;
  const specifier = moduleSpecifierText(moduleOf(declaration));
  return specifier ? { specifier, importedName: importedNameOf(declaration) } : null;
}

function singleFileChecker(sourceFile: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === sourceFile.fileName ? sourceFile : undefined);
  host.fileExists = (name) => name === sourceFile.fileName;
  host.readFile = () => undefined;
  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
}

/**
 * The import the identifier at `offset` is bound to, by scope rather than by name: a local that
 * shadows an import returns null so the editor's own definition wins.
 */
export function findImportBindingAt(
  fileContent: string,
  fileName: string,
  offset: number,
): ImportBinding | null {
  const sourceFile = ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest, true);
  const identifier = identifierAt(sourceFile, offset) ?? identifierAt(sourceFile, offset - 1);
  if (!identifier) return null;

  const parent = identifier.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
    return bindingFromDeclaration(parent);
  }
  const declaration =
    singleFileChecker(sourceFile).getSymbolAtLocation(identifier)?.declarations?.[0];
  return declaration ? bindingFromDeclaration(declaration) : null;
}

function readSource(path: string): ts.SourceFile | null {
  if (!SOURCE_FILE_PATTERN.test(path)) return null;
  try {
    if (statSync(path).size > MAX_SOURCE_BYTES) return null;
    return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  } catch {
    return null;
  }
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): DefinitionLocation {
  const start = node.getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  const column = character + 1;
  return {
    path: sourceFile.fileName,
    line: line + 1,
    column,
    endColumn: endLine === line ? column + node.getEnd() - start : column,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === kind));
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

type NamedDeclarationStatement =
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ModuleDeclaration;

const NAMED_DECLARATION_GUARDS: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isModuleDeclaration,
];

function isNamedDeclaration(statement: ts.Statement): statement is NamedDeclarationStatement {
  return NAMED_DECLARATION_GUARDS.some((isKind) => isKind(statement));
}

/** Names a top-level statement declares, whether or not it is exported. */
function declaredNames(statement: ts.Statement): ts.Identifier[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  }
  const name = isNamedDeclaration(statement) ? statement.name : undefined;
  return name && ts.isIdentifier(name) ? [name] : [];
}

type ImportDeclarationPart = ts.ImportClause | ts.ImportSpecifier | ts.NamespaceImport;

function importedNames(statement: ts.Statement): ImportDeclarationPart[] {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) return [];
  const clause = statement.importClause;
  const bindings = clause.namedBindings;
  const named = bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
  const namespace = bindings && ts.isNamespaceImport(bindings) ? [bindings] : [];
  return [...(clause.name ? [clause] : []), ...named, ...namespace];
}

type Walk = {
  resolve: ResolveSpecifier;
  visited: Set<string>;
  depth: number;
};

function follow(fromFile: string, binding: ImportBinding, walk: Walk): DefinitionLocation | null {
  const target = walk.resolve(fromFile, binding.specifier);
  if (!target || binding.importedName === '*') return null;
  return locateIn(target, binding.importedName, { ...walk, depth: walk.depth + 1 });
}

/** A top-level declaration named `localName`, following it when it is itself imported. */
function locateLocal(
  sourceFile: ts.SourceFile,
  localName: string,
  walk: Walk,
): DefinitionLocation | null {
  for (const statement of sourceFile.statements) {
    const declared = declaredNames(statement).find((name) => name.text === localName);
    if (declared) return locationOf(sourceFile, declared);
    for (const declaration of importedNames(statement)) {
      const name = declaration.name;
      if (name?.text !== localName) continue;
      const binding = bindingFromDeclaration(declaration);
      return (
        (binding && follow(sourceFile.fileName, binding, walk)) ?? locationOf(sourceFile, name)
      );
    }
  }
  return null;
}

function locateDefault(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  walk: Walk,
): DefinitionLocation | null {
  if (ts.isExportAssignment(statement)) {
    const expression = statement.expression;
    const local = ts.isIdentifier(expression)
      ? locateLocal(sourceFile, expression.text, walk)
      : null;
    return local ?? locationOf(sourceFile, expression);
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
    hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
  ) {
    return locationOf(sourceFile, statement.name ?? statement);
  }
  return null;
}

function locateInExportDeclaration(
  sourceFile: ts.SourceFile,
  statement: ts.ExportDeclaration,
  name: string,
  walk: Walk,
): DefinitionLocation | null {
  const clause = statement.exportClause;
  if (clause && ts.isNamespaceExport(clause)) {
    return clause.name.text === name ? locationOf(sourceFile, clause.name) : null;
  }
  if (!clause) return null;
  const element = clause.elements.find((el) => el.name.text === name);
  if (!element) return null;
  const sourceName = (element.propertyName ?? element.name).text;
  const specifier = moduleSpecifierText(statement.moduleSpecifier);
  const found = specifier
    ? follow(sourceFile.fileName, { specifier, importedName: sourceName }, walk)
    : locateLocal(sourceFile, sourceName, walk);
  return found ?? locationOf(sourceFile, element.name);
}

function firstFound<T>(
  items: readonly T[],
  find: (item: T) => DefinitionLocation | null,
): DefinitionLocation | null {
  for (const item of items) {
    const found = find(item);
    if (found) return found;
  }
  return null;
}

function locateDefaultExport(sourceFile: ts.SourceFile, walk: Walk): DefinitionLocation | null {
  return firstFound(sourceFile.statements, (statement) =>
    ts.isExportDeclaration(statement)
      ? locateInExportDeclaration(sourceFile, statement, 'default', walk)
      : locateDefault(sourceFile, statement, walk),
  );
}

function locateNamedInStatement(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  name: string,
  walk: Walk,
): DefinitionLocation | null {
  if (ts.isExportDeclaration(statement)) {
    return locateInExportDeclaration(sourceFile, statement, name, walk);
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return null;
  const declared = declaredNames(statement).find((id) => id.text === name);
  return declared ? locationOf(sourceFile, declared) : null;
}

function starSpecifier(statement: ts.Statement): string | null {
  if (!ts.isExportDeclaration(statement) || statement.exportClause) return null;
  return moduleSpecifierText(statement.moduleSpecifier);
}

/** Local declarations and named re-exports win over `export *`, as in the module system. */
function locateNamedExport(
  sourceFile: ts.SourceFile,
  name: string,
  walk: Walk,
): DefinitionLocation | null {
  const statements = sourceFile.statements;
  const stars = statements.flatMap((statement) => starSpecifier(statement) ?? []);
  return (
    firstFound(statements, (statement) =>
      locateNamedInStatement(sourceFile, statement, name, walk),
    ) ??
    firstFound(stars, (specifier) =>
      follow(sourceFile.fileName, { specifier, importedName: name }, walk),
    )
  );
}

function locateIn(path: string, name: string, walk: Walk): DefinitionLocation | null {
  const key = `${path}#${name}`;
  if (walk.depth > MAX_EXPORT_DEPTH || walk.visited.has(key)) return null;
  walk.visited.add(key);
  const sourceFile = readSource(path);
  if (!sourceFile) return null;
  return name === 'default'
    ? locateDefaultExport(sourceFile, walk)
    : locateNamedExport(sourceFile, name, walk);
}

/** Where `exportName` is declared, following re-exports and barrels from `path`. */
export function locateExport(
  path: string,
  exportName: string,
  resolve: ResolveSpecifier,
): DefinitionLocation | null {
  return locateIn(path, exportName, { resolve, visited: new Set(), depth: 0 });
}
