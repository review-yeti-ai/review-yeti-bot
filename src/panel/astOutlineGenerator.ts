import ts from 'typescript';
import { ASTParser, ASTSymbol, SupportedLanguage } from '../indexer/astParser';
import {
  classifyPathByHeuristic,
  DomainLane,
  DOMAIN_LANES,
} from '../pathDomainContract';
import { extractChangedLineNumbers } from '../pipeline/diffCompactor';
import { PERSONA_DOMAIN_AFFINITY } from './classifierEngine';
import {
  ASTFileOutline,
  ASTSymbolOutline,
  DiffHunkBoundary,
  FileTreeOutline,
  GenerateASTOutlineOptions,
  TaskScopedOutlineOptions,
} from './astOutlineContract';

/**
 * Parses unified diff patch into structured hunk boundaries and line numbers.
 */
export function parseDiffHunkBoundaries(patch?: string): {
  boundaries: DiffHunkBoundary[];
  addedLineNumbers: number[];
  deletedLineNumbers: number[];
  additions: number;
  deletions: number;
} {
  const addedLineNumbers: number[] = [];
  const deletedLineNumbers: number[] = [];
  let additions = 0;
  let deletions = 0;

  if (!patch || !patch.trim()) {
    return {
      boundaries: [],
      addedLineNumbers,
      deletedLineNumbers,
      additions: 0,
      deletions: 0,
    };
  }

  const lines = patch.split(/\r?\n/);
  const parsedBoundaries: DiffHunkBoundary[] = [];
  let currentBoundary: DiffHunkBoundary | null = null;
  let currentOld = 0;
  let currentNew = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      if (currentBoundary) {
        parsedBoundaries.push(currentBoundary);
      }
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      const section = hunkMatch[5]?.trim() || undefined;

      currentOld = oldStart;
      currentNew = newStart;
      currentBoundary = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        section,
        modifiedLineNumbers: [],
      };
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentBoundary) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLineNumbers.push(currentNew);
      currentBoundary.modifiedLineNumbers?.push(currentNew);
      additions++;
      currentNew++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletedLineNumbers.push(currentOld);
      deletions++;
      currentOld++;
    } else if (line.startsWith(' ')) {
      currentOld++;
      currentNew++;
    }
  }

  if (currentBoundary) {
    parsedBoundaries.push(currentBoundary);
  }

  // Also verify against extractChangedLineNumbers for completeness
  const compactorRecords = extractChangedLineNumbers(patch);
  for (const rec of compactorRecords) {
    if (rec.type === 'add' && rec.newLineNumber != null && !addedLineNumbers.includes(rec.newLineNumber)) {
      addedLineNumbers.push(rec.newLineNumber);
    }
  }

  return {
    boundaries: parsedBoundaries,
    addedLineNumbers,
    deletedLineNumbers,
    additions,
    deletions,
  };
}

/**
 * Synthesizes source text from a diff patch when full file content is unavailable.
 * Places added and context lines at their exact newLineNumber in the target file.
 */
export function reconstructSourceFromPatch(patch: string): string {
  if (!patch || !patch.trim()) return '';

  const lines = patch.split(/\r?\n/);
  const reconstructed: string[] = [];
  let currentNew = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      currentNew = parseInt(hunkMatch[3], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      while (reconstructed.length < currentNew - 1) {
        reconstructed.push('');
      }
      reconstructed[currentNew - 1] = line.slice(1);
      currentNew++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deleted line, omitted in target SHA
    } else if (line.startsWith(' ')) {
      while (reconstructed.length < currentNew - 1) {
        reconstructed.push('');
      }
      reconstructed[currentNew - 1] = line.slice(1);
      currentNew++;
    }
  }

  return reconstructed.join('\n');
}

/**
 * Tests whether an AST symbol intersects with diff additions or hunk boundaries.
 */
export function isSymbolModifiedByDiff(
  symbol: ASTSymbol,
  addedLineNumbers: number[],
  boundaries: DiffHunkBoundary[],
): boolean {
  // 1. Exact line intersection: any added line falls within [startLine, endLine]
  for (const addedLine of addedLineNumbers) {
    if (addedLine >= symbol.startLine && addedLine <= symbol.endLine) {
      return true;
    }
  }

  // 2. Hunk range overlap: hunk span overlaps [startLine, endLine] (e.g. deletions or multi-line edits)
  for (const hunk of boundaries) {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(0, hunk.newCount - 1);
    if (hunk.newCount === 0) {
      if (hunk.newStart >= symbol.startLine && hunk.newStart <= symbol.endLine) {
        return true;
      }
    } else {
      if (Math.max(symbol.startLine, hunkStart) <= Math.min(symbol.endLine, hunkEnd)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Cleans braces and trailing semicolons from AST signatures for lean presentation.
 */
export function cleanSignature(signature: string): string {
  return signature
    .replace(/\s*\{\s*\}?\s*$/, '')
    .replace(/;\s*$/, '')
    .trim();
}

/**
 * Estimates token count using standard 4 chars per token heuristic.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/**
 * Renders a lean textual summary of a FileTreeOutline (<500 tokens).
 */
export function renderOutlineSummary(outline: {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: ASTFileOutline[];
  filesByDomain: Record<DomainLane, ASTFileOutline[]>;
}): string {
  const lines: string[] = [];
  lines.push(
    `=== AST FILE-TREE OUTLINE (${outline.totalFiles} file(s), +${outline.totalAdditions}/-${outline.totalDeletions} lines) ===`,
  );

  for (const lane of DOMAIN_LANES) {
    const laneFiles = outline.filesByDomain[lane];
    if (!laneFiles || laneFiles.length === 0) continue;

    lines.push(`\n[${lane}] (${laneFiles.length} file${laneFiles.length === 1 ? '' : 's'})`);
    for (const f of laneFiles) {
      lines.push(`  ${f.filePath} (+${f.additions}, -${f.deletions} lines)`);
      if (f.modifiedSymbols.length > 0) {
        for (const sym of f.modifiedSymbols) {
          const exportPrefix = sym.exported && !sym.signature?.startsWith('export') ? 'export ' : '';
          const lineSpan =
            sym.startLine === sym.endLine
              ? `line ${sym.startLine}`
              : `lines ${sym.startLine}-${sym.endLine}`;
          const sig = sym.signature
            ? cleanSignature(sym.signature)
            : `${exportPrefix}${sym.kind} ${sym.name}()`;
          lines.push(`    - ${exportPrefix}${sig} (${lineSpan})`);
        }
      } else if (f.hunkBoundaries.length > 0) {
        const hunkSummary = f.hunkBoundaries
          .slice(0, 3)
          .map(
            (h) =>
              `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${
                h.section ? ` ${h.section}` : ''
              }`,
          )
          .join('; ');
        const extra =
          f.hunkBoundaries.length > 3 ? ` (+${f.hunkBoundaries.length - 3} more hunks)` : '';
        lines.push(`    [diff: ${hunkSummary}${extra}]`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Extracts top-level variable and type declarations in TypeScript/JavaScript files
 * that might not be parsed as functions or classes by ASTParser.
 */
export function extractAdditionalTypeScriptSymbols(
  filePath: string,
  source: string,
): ASTSymbol[] {
  const extra: ASTSymbol[] = [];
  const lower = filePath.toLowerCase();
  if (
    !lower.endsWith('.ts') &&
    !lower.endsWith('.tsx') &&
    !lower.endsWith('.js') &&
    !lower.endsWith('.jsx') &&
    !lower.endsWith('.mjs') &&
    !lower.endsWith('.cjs')
  ) {
    return extra;
  }

  try {
    const isTsx = lower.endsWith('.tsx') || lower.endsWith('.jsx');
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const getLineAndChar = (pos: number) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
      return { line: line + 1, column: character };
    };

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isVariableStatement(node)) {
        const isExported = Boolean(
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        );
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const start = getLineAndChar(node.getStart(sourceFile));
            const end = getLineAndChar(node.getEnd());
            const signature = node.getText(sourceFile).split('\n')[0].replace(/;?\s*$/, '');
            extra.push({
              id: `${filePath}:variable:${name}:${start.line}`,
              name,
              kind: 'variable',
              filePath,
              startLine: start.line,
              endLine: end.line,
              startColumn: start.column,
              endColumn: start.column + name.length,
              signature,
              exported: isExported,
            });
          }
        }
      } else if (ts.isTypeAliasDeclaration(node)) {
        const isExported = Boolean(
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        );
        const name = node.name.text;
        const start = getLineAndChar(node.getStart(sourceFile));
        const end = getLineAndChar(node.getEnd());
        const signature = node.getText(sourceFile).split('\n')[0].replace(/;?\s*$/, '');
        extra.push({
          id: `${filePath}:type:${name}:${start.line}`,
          name,
          kind: 'variable',
          filePath,
          startLine: start.line,
          endLine: end.line,
          startColumn: start.column,
          endColumn: start.column + name.length,
          signature,
          exported: isExported,
        });
      }
    });
  } catch {
    // Ignore fallback
  }

  return extra;
}

/**
 * Generates an AST file-tree outline from an array of changed files and patches.
 */
export function generateFileTreeOutline(
  files: Array<{ path: string; patch?: string; content?: string }>,
  options?: GenerateASTOutlineOptions,
): FileTreeOutline {
  const astParser = new ASTParser();
  const fileOutlines: ASTFileOutline[] = [];
  const filesByDomain: Record<DomainLane, ASTFileOutline[]> = {
    security_auth: [],
    data_persistence: [],
    api_contracts: [],
    system_runtime: [],
    ui_frontend: [],
    docs_assets: [],
  };

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    const filePath = file.path;
    const lane = options?.domainLanes?.[filePath] || classifyPathByHeuristic(filePath);
    const { boundaries, addedLineNumbers, additions, deletions } = parseDiffHunkBoundaries(file.patch);

    totalAdditions += additions;
    totalDeletions += deletions;

    const modifiedSymbols: ASTSymbolOutline[] = [];

    // Parse AST only for supported code files
    if (astParser.isSupportedFile(filePath)) {
      const source = file.content || reconstructSourceFromPatch(file.patch || '');
      if (source.trim().length > 0) {
        try {
          const parsed = astParser.parseSource(filePath, source);
          const structuralSymbols = parsed.symbols.filter(
            (s) => s.kind !== 'import' && s.kind !== 'export',
          );

          // Add extra top-level variables and types if not already captured
          const extraSymbols = extractAdditionalTypeScriptSymbols(filePath, source);
          const existingNames = new Set(structuralSymbols.map((s) => s.name));
          for (const extra of extraSymbols) {
            if (!existingNames.has(extra.name)) {
              structuralSymbols.push(extra);
            }
          }

          for (const sym of structuralSymbols) {
            if (isSymbolModifiedByDiff(sym, addedLineNumbers, boundaries)) {
              const kind = (
                ['function', 'method', 'class', 'interface', 'variable', 'type'].includes(sym.kind)
                  ? sym.kind
                  : 'function'
              ) as ASTSymbolOutline['kind'];

              modifiedSymbols.push({
                name: sym.name,
                kind,
                startLine: sym.startLine,
                endLine: sym.endLine,
                exported: sym.exported ?? false,
                signature: sym.signature,
                containerName: sym.containerName,
              });
            }
          }
        } catch {
          // Graceful fallback on parse error
        }
      }
    }

    const fileOutline: ASTFileOutline = {
      filePath,
      domainLane: lane,
      additions,
      deletions,
      hunkBoundaries: boundaries,
      modifiedSymbols,
    };

    fileOutlines.push(fileOutline);
    filesByDomain[lane].push(fileOutline);
  }

  const summaryText = renderOutlineSummary({
    totalFiles: fileOutlines.length,
    totalAdditions,
    totalDeletions,
    files: fileOutlines,
    filesByDomain,
  });

  return {
    totalFiles: fileOutlines.length,
    totalAdditions,
    totalDeletions,
    files: fileOutlines,
    filesByDomain,
    summaryText,
  };
}

/**
 * Alias for buildAstFileTreeOutline for compatibility with existing survey references.
 */
export const buildAstFileTreeOutline = generateFileTreeOutline;

/**
 * Filters a FileTreeOutline to only the files, symbols, and domains assigned to a specific task / persona.
 */
export function generateTaskScopedASTOutline(
  outline: FileTreeOutline,
  options: TaskScopedOutlineOptions,
): FileTreeOutline {
  let matchedFiles: ASTFileOutline[] = [];
  const assignedPaths = options.task?.paths ?? options.paths;

  if (assignedPaths && assignedPaths.length > 0) {
    const pathSet = new Set(assignedPaths);
    matchedFiles = outline.files.filter((f) => pathSet.has(f.filePath));
  }

  // If path matching produced no files, check domain lane or persona affinity
  if (matchedFiles.length === 0) {
    const laneFilters = new Set<DomainLane>(options.domainLanes || []);
    if (laneFilters.size === 0) {
      if (options.task?.dimension) {
        const affinities =
          PERSONA_DOMAIN_AFFINITY[options.task.dimension] ||
          PERSONA_DOMAIN_AFFINITY[`${options.task.dimension}-lane`] ||
          [];
        for (const a of affinities) laneFilters.add(a);
      }
      if (options.persona) {
        const affinities = PERSONA_DOMAIN_AFFINITY[options.persona] || [];
        for (const a of affinities) laneFilters.add(a);
      }
    }
    if (laneFilters.size > 0) {
      matchedFiles = outline.files.filter((f) => laneFilters.has(f.domainLane));
    }
  }

  // If still no matches, fall back to all files (mirroring buildTaskScopedFiles fallback)
  if (matchedFiles.length === 0) {
    matchedFiles = [...outline.files];
  }

  const filesByDomain: Record<DomainLane, ASTFileOutline[]> = {
    security_auth: [],
    data_persistence: [],
    api_contracts: [],
    system_runtime: [],
    ui_frontend: [],
    docs_assets: [],
  };

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const f of matchedFiles) {
    filesByDomain[f.domainLane].push(f);
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  const scopedOutline: FileTreeOutline = {
    totalFiles: matchedFiles.length,
    totalAdditions,
    totalDeletions,
    files: matchedFiles,
    filesByDomain,
    summaryText: renderOutlineSummary({
      totalFiles: matchedFiles.length,
      totalAdditions,
      totalDeletions,
      files: matchedFiles,
      filesByDomain,
    }),
  };

  return scopedOutline;
}
