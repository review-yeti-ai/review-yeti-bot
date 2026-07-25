import ts from 'typescript';

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'unknown';

export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'variable'
  | 'import'
  | 'export';

export type ReferenceType =
  | 'call'
  | 'import'
  | 'extends'
  | 'implements'
  | 'type_usage';

export interface ASTSymbol {
  id: string; // `${filePath}:${kind}:${name}:${startLine}`
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docComment?: string;
  containerName?: string;
  signature?: string;
  exported: boolean;
  callers?: string[];
  callees?: string[];
}

export interface SymbolReference {
  sourceSymbolId?: string;
  targetSymbolName: string;
  referenceType: ReferenceType;
  filePath: string;
  line: number;
  column: number;
  contextSnippet: string;
}

export interface ImportInfo {
  source: string;
  specifiers: string[];
}

export interface ParseResult {
  filePath: string;
  language: SupportedLanguage;
  symbols: ASTSymbol[];
  references: SymbolReference[];
  imports: ImportInfo[];
  linesOfCode: number;
  parseDurationMs: number;
}

export interface ASTParserOptions {
  maxFileSizeKb?: number;
  includePrivateSymbols?: boolean;
}

export class ASTParser {
  private options: ASTParserOptions;

  constructor(options: ASTParserOptions = {}) {
    this.options = {
      maxFileSizeKb: options.maxFileSizeKb ?? 1024,
      includePrivateSymbols: options.includePrivateSymbols ?? true,
    };
  }

  public isSupportedFile(filePath: string): boolean {
    const lang = this.detectLanguage(filePath);
    return lang !== 'unknown';
  }

  public detectLanguage(filePath: string): SupportedLanguage {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      case '.py':
        return 'python';
      default:
        return 'unknown';
    }
  }

  public parseSource(filePath: string, content: string): ParseResult {
    const startTime = performance.now();
    const language = this.detectLanguage(filePath);
    const lines = content.split(/\r?\n/);
    const linesOfCode = lines.length;

    try {
      if (language === 'typescript' || language === 'javascript') {
        return this.parseTypeScriptSource(filePath, content, language, lines, startTime);
      } else if (language === 'python') {
        return this.parsePythonSource(filePath, content, lines, startTime);
      } else {
        return this.fallbackParse(filePath, content, language, lines, startTime);
      }
    } catch {
      // Robust fallback on syntax or parser error
      return this.fallbackParse(filePath, content, language, lines, startTime);
    }
  }

  private parseTypeScriptSource(
    filePath: string,
    content: string,
    language: SupportedLanguage,
    lines: string[],
    startTime: number
  ): ParseResult {
    const scriptTarget = ts.ScriptTarget.Latest;
    const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(filePath, content, scriptTarget, true, scriptKind);

    const symbols: ASTSymbol[] = [];
    const references: SymbolReference[] = [];
    const imports: ImportInfo[] = [];

    const scopeStack: ASTSymbol[] = [];

    const getLineAndChar = (pos: number) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
      return { line: line + 1, column: character };
    };

    const getDocComment = (node: ts.Node): string | undefined => {
      const fullText = sourceFile.getFullText();
      const commentRanges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
      if (commentRanges && commentRanges.length > 0) {
        for (let i = commentRanges.length - 1; i >= 0; i--) {
          const range = commentRanges[i];
          const commentText = fullText.slice(range.pos, range.end);
          if (commentText.startsWith('/**')) {
            return commentText
              .replace(/^\/\*\*|\*\/$/g, '')
              .split('\n')
              .map((l) => l.replace(/^\s*\*?\s?/, ''))
              .join('\n')
              .trim();
          }
        }
      }
      return undefined;
    };

    const visit = (node: ts.Node) => {
      const start = getLineAndChar(node.getStart(sourceFile));
      const end = getLineAndChar(node.getEnd());
      const currentScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : undefined;

      // 1. Imports
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
        const specifiers: string[] = [];

        if (node.importClause) {
          if (node.importClause.name) {
            specifiers.push(node.importClause.name.getText(sourceFile));
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const elt of node.importClause.namedBindings.elements) {
                specifiers.push(elt.name.getText(sourceFile));
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              specifiers.push(`* as ${node.importClause.namedBindings.name.getText(sourceFile)}`);
            }
          }
        }

        imports.push({ source: moduleSpecifier, specifiers });

        for (const spec of specifiers) {
          references.push({
            sourceSymbolId: currentScope?.id,
            targetSymbolName: spec.replace('* as ', ''),
            referenceType: 'import',
            filePath,
            line: start.line,
            column: start.column,
            contextSnippet: lines[start.line - 1] || '',
          });
        }
      }

      // 2. Class Declaration
      else if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.getText(sourceFile);
        const isExported = Boolean((node as any).modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));

        const classSymbol: ASTSymbol = {
          id: `${filePath}:class:${name}:${start.line}`,
          name,
          kind: 'class',
          filePath,
          startLine: start.line,
          endLine: end.line,
          startColumn: start.column,
          endColumn: end.column,
          docComment: getDocComment(node),
          exported: isExported,
          callers: [],
          callees: [],
        };
        symbols.push(classSymbol);

        // Check heritage (extends / implements)
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const refType: ReferenceType = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
            for (const typeNode of clause.types) {
              const targetName = typeNode.expression.getText(sourceFile);
              references.push({
                sourceSymbolId: classSymbol.id,
                targetSymbolName: targetName,
                referenceType: refType,
                filePath,
                line: start.line,
                column: start.column,
                contextSnippet: lines[start.line - 1] || '',
              });
            }
          }
        }

        scopeStack.push(classSymbol);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      // 3. Interface Declaration
      else if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.getText(sourceFile);
        const isExported = Boolean((node as any).modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));

        const interfaceSymbol: ASTSymbol = {
          id: `${filePath}:interface:${name}:${start.line}`,
          name,
          kind: 'interface',
          filePath,
          startLine: start.line,
          endLine: end.line,
          startColumn: start.column,
          endColumn: end.column,
          docComment: getDocComment(node),
          exported: isExported,
          callers: [],
          callees: [],
        };
        symbols.push(interfaceSymbol);

        scopeStack.push(interfaceSymbol);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      // 4. Function & Method Declaration
      else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        const nameNode = node.name;
        const name = nameNode ? nameNode.getText(sourceFile) : 'anonymous';
        const isMethod = ts.isMethodDeclaration(node);
        const kind: SymbolKind = isMethod ? 'method' : 'function';
        const isExported = Boolean((node as any).modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));

        const signature = node.getText(sourceFile).split('\n')[0].replace(/\{$/, '').trim();
        const containerName = currentScope?.name;

        const fnSymbol: ASTSymbol = {
          id: `${filePath}:${kind}:${name}:${start.line}`,
          name,
          kind,
          filePath,
          startLine: start.line,
          endLine: end.line,
          startColumn: start.column,
          endColumn: end.column,
          docComment: getDocComment(node),
          containerName,
          signature,
          exported: isExported,
          callers: [],
          callees: [],
        };
        symbols.push(fnSymbol);

        scopeStack.push(fnSymbol);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      // 5. Arrow Function / Function Expression in variable declaration
      else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        const name = node.name.getText(sourceFile);
        const parentVarStatement = node.parent?.parent;
        const isExported = parentVarStatement && ts.canHaveModifiers(parentVarStatement)
          ? ts.getModifiers(parentVarStatement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
          : false;

        const fnSymbol: ASTSymbol = {
          id: `${filePath}:function:${name}:${start.line}`,
          name,
          kind: 'function',
          filePath,
          startLine: start.line,
          endLine: end.line,
          startColumn: start.column,
          endColumn: end.column,
          docComment: getDocComment(node.parent?.parent || node),
          containerName: currentScope?.name,
          signature: lines[start.line - 1]?.trim(),
          exported: isExported,
          callers: [],
          callees: [],
        };
        symbols.push(fnSymbol);

        scopeStack.push(fnSymbol);
        ts.forEachChild(node, visit);
        scopeStack.pop();
        return;
      }

      // 6. Call Expression & New Expression
      else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let calleeName = '';
        if (ts.isIdentifier(node.expression)) {
          calleeName = node.expression.getText(sourceFile);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          calleeName = node.expression.name.getText(sourceFile);
        }

        if (calleeName) {
          references.push({
            sourceSymbolId: currentScope?.id,
            targetSymbolName: calleeName,
            referenceType: 'call',
            filePath,
            line: start.line,
            column: start.column,
            contextSnippet: lines[start.line - 1] || '',
          });

          if (currentScope) {
            if (!currentScope.callees) currentScope.callees = [];
            if (!currentScope.callees.includes(calleeName)) {
              currentScope.callees.push(calleeName);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Populate callers across symbols in the file
    for (const ref of references) {
      if (ref.referenceType === 'call' && ref.sourceSymbolId) {
        const callerSymbol = symbols.find((s) => s.id === ref.sourceSymbolId);
        const targetSymbols = symbols.filter((s) => s.name === ref.targetSymbolName);
        for (const targetSymbol of targetSymbols) {
          if (callerSymbol && !targetSymbol.callers?.includes(callerSymbol.name)) {
            if (!targetSymbol.callers) targetSymbol.callers = [];
            targetSymbol.callers.push(callerSymbol.name);
          }
        }
      }
    }

    const durationMs = performance.now() - startTime;
    return {
      filePath,
      language,
      symbols,
      references,
      imports,
      linesOfCode: lines.length,
      parseDurationMs: durationMs,
    };
  }

  private parsePythonSource(
    filePath: string,
    content: string,
    lines: string[],
    startTime: number
  ): ParseResult {
    const symbols: ASTSymbol[] = [];
    const references: SymbolReference[] = [];
    const imports: ImportInfo[] = [];

    let currentClass: { name: string; startLine: number } | null = null;

    const extractPythonDocstring = (startIdx: number): string | undefined => {
      for (let j = startIdx + 1; j < lines.length; j++) {
        const lineTrim = lines[j].trim();
        if (!lineTrim) continue;

        if (lineTrim.startsWith('"""') || lineTrim.startsWith("'''")) {
          const quote = lineTrim.slice(0, 3);
          if (lineTrim.endsWith(quote) && lineTrim.length > 3) {
            return lineTrim.slice(3, -3).trim();
          }
          const docLines: string[] = [lineTrim.slice(3)];
          for (let k = j + 1; k < lines.length; k++) {
            if (lines[k].includes(quote)) {
              docLines.push(lines[k].replace(quote, ''));
              return docLines.join('\n').trim();
            }
            docLines.push(lines[k]);
          }
          return docLines.join('\n').trim();
        }
        break;
      }
      return undefined;
    };

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      const isIndented = line.startsWith(' ') || line.startsWith('\t');
      if (!isIndented && currentClass && !trimmed.startsWith('class ')) {
        currentClass = null;
      }

      // Imports
      const importMatch = trimmed.match(/^import\s+([a-zA-Z0-9_,\s]+)/);
      const fromImportMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_,\s*()]+)/);

      if (importMatch) {
        const specifiers = importMatch[1].split(',').map((s) => s.trim().split(' ')[0]);
        imports.push({ source: importMatch[1].trim(), specifiers });
        for (const spec of specifiers) {
          references.push({
            targetSymbolName: spec,
            referenceType: 'import',
            filePath,
            line: lineNum,
            column: line.indexOf(spec),
            contextSnippet: trimmed,
          });
        }
      } else if (fromImportMatch) {
        const source = fromImportMatch[1];
        const specifiers = fromImportMatch[2].replace(/[()]/g, '').split(',').map((s) => s.trim());
        imports.push({ source, specifiers });
        for (const spec of specifiers) {
          references.push({
            targetSymbolName: spec,
            referenceType: 'import',
            filePath,
            line: lineNum,
            column: line.indexOf(spec),
            contextSnippet: trimmed,
          });
        }
      }

      // Class Definition
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\(([^)]+)\))?:/);
      if (classMatch) {
        const name = classMatch[1];
        const superclasses = classMatch[2] ? classMatch[2].split(',').map((s) => s.trim()) : [];

        let endLine = lineNum;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() && !lines[j].startsWith(' ') && !lines[j].startsWith('\t')) {
            break;
          }
          endLine = j + 1;
        }

        const docComment = extractPythonDocstring(i);

        const classSymbol: ASTSymbol = {
          id: `${filePath}:class:${name}:${lineNum}`,
          name,
          kind: 'class',
          filePath,
          startLine: lineNum,
          endLine,
          startColumn: line.indexOf(name),
          endColumn: line.indexOf(name) + name.length,
          docComment,
          exported: !name.startsWith('_'),
          callers: [],
          callees: [],
        };
        symbols.push(classSymbol);
        currentClass = { name, startLine: lineNum };

        for (const sup of superclasses) {
          references.push({
            sourceSymbolId: classSymbol.id,
            targetSymbolName: sup,
            referenceType: 'extends',
            filePath,
            line: lineNum,
            column: line.indexOf(sup),
            contextSnippet: trimmed,
          });
        }
        continue;
      }

      // Function / Method Definition
      const fnMatch = trimmed.match(/^def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const isMethod = line.startsWith('    ') || line.startsWith('\t') || (currentClass !== null);
        const kind: SymbolKind = isMethod ? 'method' : 'function';

        let endLine = lineNum;
        const indentLevel = line.search(/\S/);
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrimmed = lines[j].trim();
          if (!nextTrimmed) continue;
          const nextIndent = lines[j].search(/\S/);
          if (nextIndent <= indentLevel) break;
          endLine = j + 1;
        }

        const containerName = isMethod && currentClass ? currentClass.name : undefined;
        const signature = `def ${name}(${fnMatch[2]})`;
        const docComment = extractPythonDocstring(i);

        const fnSymbol: ASTSymbol = {
          id: `${filePath}:${kind}:${name}:${lineNum}`,
          name,
          kind,
          filePath,
          startLine: lineNum,
          endLine,
          startColumn: line.indexOf(name),
          endColumn: line.indexOf(name) + name.length,
          docComment,
          containerName,
          signature,
          exported: !name.startsWith('_'),
          callers: [],
          callees: [],
        };
        symbols.push(fnSymbol);
      }

      // Function calls
      if (!trimmed.startsWith('def ') && !trimmed.startsWith('class ')) {
        const callMatches = Array.from(trimmed.matchAll(/([a-zA-Z0-9_]+)\s*\(/g));
        for (const cm of callMatches) {
          const calleeName = cm[1];
          if (['if', 'while', 'for', 'def', 'class', 'return', 'print'].includes(calleeName)) continue;

          const enclosingFn = symbols
            .filter((s) => (s.kind === 'function' || s.kind === 'method') && s.startLine <= lineNum && s.endLine >= lineNum)
            .sort((a, b) => b.startLine - a.startLine)[0];

          references.push({
            sourceSymbolId: enclosingFn?.id,
            targetSymbolName: calleeName,
            referenceType: 'call',
            filePath,
            line: lineNum,
            column: line.indexOf(calleeName),
            contextSnippet: trimmed,
          });

          if (enclosingFn) {
            if (!enclosingFn.callees) enclosingFn.callees = [];
            if (!enclosingFn.callees.includes(calleeName)) {
              enclosingFn.callees.push(calleeName);
            }
          }
        }
      }
    }

    // Populate callers across Python symbols in the file
    for (const ref of references) {
      if (ref.referenceType === 'call' && ref.sourceSymbolId) {
        const callerSymbol = symbols.find((s) => s.id === ref.sourceSymbolId);
        const targetSymbols = symbols.filter((s) => s.name === ref.targetSymbolName);
        for (const targetSymbol of targetSymbols) {
          if (callerSymbol && !targetSymbol.callers?.includes(callerSymbol.name)) {
            if (!targetSymbol.callers) targetSymbol.callers = [];
            targetSymbol.callers.push(callerSymbol.name);
          }
        }
      }
    }

    const durationMs = performance.now() - startTime;
    return {
      filePath,
      language: 'python',
      symbols,
      references,
      imports,
      linesOfCode: lines.length,
      parseDurationMs: durationMs,
    };
  }

  private fallbackParse(
    filePath: string,
    content: string,
    language: SupportedLanguage,
    lines: string[],
    startTime: number
  ): ParseResult {
    const symbols: ASTSymbol[] = [];
    const references: SymbolReference[] = [];
    const imports: ImportInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      const trimmed = line.trim();

      // General class match
      const classMatch = trimmed.match(/(?:class|interface)\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        const name = classMatch[1];
        const kind: SymbolKind = trimmed.startsWith('interface') ? 'interface' : 'class';
        symbols.push({
          id: `${filePath}:${kind}:${name}:${lineNum}`,
          name,
          kind,
          filePath,
          startLine: lineNum,
          endLine: Math.min(lineNum + 20, lines.length),
          startColumn: line.indexOf(name),
          endColumn: line.indexOf(name) + name.length,
          exported: trimmed.includes('export'),
          callers: [],
          callees: [],
        });
      }

      // General function match
      const fnMatch = trimmed.match(/(?:function|def|const|let|var)\s+([a-zA-Z0-9_]+)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\()/);
      if (fnMatch) {
        const name = fnMatch[1];
        symbols.push({
          id: `${filePath}:function:${name}:${lineNum}`,
          name,
          kind: 'function',
          filePath,
          startLine: lineNum,
          endLine: Math.min(lineNum + 15, lines.length),
          startColumn: line.indexOf(name),
          endColumn: line.indexOf(name) + name.length,
          signature: trimmed,
          exported: trimmed.includes('export'),
          callers: [],
          callees: [],
        });
      }
    }

    const durationMs = performance.now() - startTime;
    return {
      filePath,
      language,
      symbols,
      references,
      imports,
      linesOfCode: lines.length,
      parseDurationMs: durationMs,
    };
  }
}
