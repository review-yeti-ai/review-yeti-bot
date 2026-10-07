import { posix } from 'node:path';
import ts from 'typescript';
import { groundedSourceTextLineRangeDigest } from './groundedSourceWindows';

export interface GroundedRelativeImportDeclaration {
  specifier: string;
  symbols: string[];
  startLine: number;
  endLine: number;
  statementDigest: string;
}

export type GroundedRelativeImportParseResult =
  | { complete: true; declarations: GroundedRelativeImportDeclaration[] }
  | { complete: false; reason: string; declarations: GroundedRelativeImportDeclaration[] };

export type GroundedExportDefinitionResult =
  | { complete: true; symbols: string[]; startLine: number; endLine: number; digest: string; source: string }
  | { complete: false; reason: string };

export type GroundedExportAtLineResult =
  | { complete: true; symbol: string; definition: GroundedExportDefinitionResult & { complete: true } }
  | { complete: false; reason: string };

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/iu.test(path)) return ts.ScriptKind.TSX;
  if (/\.(?:jsx)$/iu.test(path)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/iu.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseSource(path: string, source: string): ts.SourceFile | null {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return diagnostics && diagnostics.length === 0 ? file : null;
}

function relativeSpecifier(value: string): boolean {
  return value.startsWith('./') || value.startsWith('../');
}

/** Ordered, bounded path candidates for the resolver subset accepted by grounded evidence. */
export function groundedRelativeImportCandidates(fromPath: string, specifier: string): string[] {
  if (!relativeSpecifier(specifier)) return [];
  const stem = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (stem === '..' || stem.startsWith('../') || stem.startsWith('/')) return [];
  if (/\.[a-z0-9]+$/iu.test(stem)) return [stem];
  return [stem, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map((ext) => `${stem}${ext}`),
    ...['index.ts', 'index.tsx', 'index.js'].map((leaf) => posix.join(stem, leaf))];
}

function nodeLineRange(file: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = node.getStart(file);
  const end = Math.max(start, node.getEnd() - 1);
  return { startLine: file.getLineAndCharacterOfPosition(start).line + 1,
    endLine: file.getLineAndCharacterOfPosition(end).line + 1 };
}

function lineSlice(file: ts.SourceFile, source: string, startLine: number, endLine: number): string {
  const starts = file.getLineStarts();
  const start = starts[startLine - 1];
  const end = endLine < starts.length ? starts[endLine] : source.length;
  return source.slice(start, end);
}

export function parseGroundedRelativeImports(source: string, path: string): GroundedRelativeImportParseResult {
  const file = parseSource(path, source);
  if (!file) return { complete: false, reason: 'importer_source_parse_failed', declarations: [] };
  const declarations: GroundedRelativeImportDeclaration[] = [];
  let unsupportedReason: string | undefined;
  const visit = (node: ts.Node): void => {
    if (unsupportedReason) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && relativeSpecifier(node.moduleSpecifier.text)) {
      unsupportedReason = 'relative_reexport_unsupported';
      return;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && relativeSpecifier(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (!clause) { unsupportedReason = 'side_effect_relative_import_unresolved'; return; }
      const symbols: string[] = [];
      if (clause.name) symbols.push('default');
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        unsupportedReason = 'namespace_relative_import_unsupported';
        return;
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) symbols.push(item.propertyName?.text ?? item.name.text);
      }
      if (symbols.length === 0) { unsupportedReason = 'relative_import_has_no_resolvable_symbols'; return; }
      const uniqueSymbols = [...new Set(symbols)].sort();
      const { startLine, endLine } = nodeLineRange(file, node);
      const statementDigest = groundedSourceTextLineRangeDigest(source, startLine, endLine);
      if (!statementDigest) { unsupportedReason = 'relative_import_statement_range_invalid'; return; }
      declarations.push({ specifier: node.moduleSpecifier.text, symbols: uniqueSymbols,
        startLine, endLine, statementDigest });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)
      && relativeSpecifier(node.moduleReference.expression.text)) {
      unsupportedReason = 'require_relative_import_unsupported';
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const specifier = node.arguments[0].text;
      if (relativeSpecifier(specifier) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        unsupportedReason = node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? 'dynamic_relative_import_unsupported' : 'require_relative_import_unsupported';
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (unsupportedReason) return { complete: false, reason: unsupportedReason, declarations };
  declarations.sort((left, right) => left.specifier.localeCompare(right.specifier)
    || left.startLine - right.startLine || left.statementDigest.localeCompare(right.statementDigest));
  return { complete: true, declarations };
}

function modifiersOf(node: ts.Node): readonly ts.ModifierLike[] | undefined {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
}

function isExported(node: ts.Node): boolean {
  return (modifiersOf(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefaultExport(node: ts.Node): boolean {
  return (modifiersOf(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function namesOf(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement))
    && statement.name && ts.isIdentifier(statement.name)) return [statement.name.text];
  return [];
}

function findLocalDeclarations(file: ts.SourceFile, name: string): ts.Statement[] {
  return file.statements.filter((statement) => namesOf(statement).includes(name));
}

function definitionFor(file: ts.SourceFile, symbol: string): { node?: ts.Node; reason?: string; names?: string[] } {
  const direct: ts.Node[] = [];
  const aliased: Array<{ localName: string; exportName: string }> = [];
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement) && symbol === 'default') {
      if (ts.isIdentifier(statement.expression)) {
        const locals = findLocalDeclarations(file, statement.expression.text);
        if (locals.length === 1) direct.push(locals[0]);
        else if (locals.length > 1) return { reason: 'ambiguous_export' };
      } else direct.push(statement);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const matches = statement.exportClause.elements.filter((element) => element.name.text === symbol);
      if (matches.length > 0 && statement.moduleSpecifier) return { reason: 'unsupported_reexport' };
      for (const element of matches) aliased.push({ localName: element.propertyName?.text ?? element.name.text,
        exportName: element.name.text });
      continue;
    }
    if (!isExported(statement)) continue;
    if (symbol === 'default' && isDefaultExport(statement)) direct.push(statement);
    else if (!isDefaultExport(statement) && namesOf(statement).includes(symbol)) direct.push(statement);
  }
  for (const alias of aliased) {
    const locals = findLocalDeclarations(file, alias.localName);
    if (locals.length > 1) return { reason: 'ambiguous_export' };
    if (locals.length === 1) direct.push(locals[0]);
  }
  const unique = [...new Set(direct)];
  if (unique.length === 0) return { reason: 'export_not_found' };
  if (unique.length > 1) return { reason: 'ambiguous_export' };
  const node = unique[0];
  const localNames = new Set<string>();
  for (const statement of file.statements) {
    if (statement === node) for (const name of namesOf(statement)) localNames.add(name);
  }
  if (symbol !== 'default') localNames.add(symbol);
  return { node, names: [...localNames].sort() };
}

export function resolveGroundedExportDefinition(source: string, path: string, symbol: string): GroundedExportDefinitionResult {
  const file = parseSource(path, source);
  if (!file) return { complete: false, reason: 'contract_source_parse_failed' };
  const resolved = definitionFor(file, symbol);
  if (!resolved.node) return { complete: false, reason: resolved.reason ?? 'export_not_found' };
  const { startLine, endLine } = nodeLineRange(file, resolved.node);
  const digest = groundedSourceTextLineRangeDigest(source, startLine, endLine);
  if (!digest) return { complete: false, reason: 'contract_definition_range_invalid' };
  return { complete: true, symbols: [...new Set([symbol, ...(resolved.names ?? [])])].sort(),
    startLine, endLine, digest, source: lineSlice(file, source, startLine, endLine) };
}

/** Resolve the unique exported declaration that contains one exact old-side changed line. */
export function resolveGroundedExportAtLine(source: string, path: string, line: number): GroundedExportAtLineResult {
  const file = parseSource(path, source);
  if (!file || !Number.isSafeInteger(line) || line < 1) return { complete: false, reason: 'contract_source_parse_failed' };
  const matches: string[] = [];
  for (const statement of file.statements) {
    const range = nodeLineRange(file, statement);
    if (line < range.startLine || line > range.endLine) continue;
    if (ts.isExportDeclaration(statement)) return { complete: false, reason: 'unsupported_reexport' };
    if (ts.isExportAssignment(statement)) {
      matches.push('default');
      continue;
    }
    if (!isExported(statement) && !isDefaultExport(statement)) continue;
    if (isDefaultExport(statement)) matches.push('default');
    else matches.push(...namesOf(statement));
  }
  const symbols = [...new Set(matches)].sort();
  if (symbols.length !== 1) return { complete: false, reason: symbols.length ? 'ambiguous_export_at_changed_line' : 'export_not_found_at_changed_line' };
  const definition = resolveGroundedExportDefinition(source, path, symbols[0]!);
  return definition.complete ? { complete: true, symbol: symbols[0]!, definition }
    : { complete: false, reason: definition.reason };
}
