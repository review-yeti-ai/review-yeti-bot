import fs from 'fs';
import path from 'path';
import { ASTParser, ASTSymbol } from '../indexer/astParser';

export interface MillerToolArgs {
  filePath: string;
  patch?: string;
  maxDepth?: number;
}

export interface MillerNodeSnippet {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface MillerToolResult {
  filePath: string;
  language: string;
  mode: 'ast_bounded' | 'hunk_fallback';
  nodes?: MillerNodeSnippet[];
  miller: string;
}

/**
 * Helper to parse a git diff patch and extract 1-indexed line numbers modified in the new file.
 */
function parseChangedLinesFromPatch(patch?: string): number[] {
  if (!patch) return [];
  const changedLines: number[] = [];
  const lines = patch.split(/\r?\n/);
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkHeader) {
      currentNewLine = parseInt(hunkHeader[1], 10);
      inHunk = true;
      continue;
    }

    if (inHunk) {
      if (line.startsWith('+')) {
        changedLines.push(currentNewLine);
        currentNewLine++;
      } else if (line.startsWith('-')) {
        // Old file deletion, line number in new file doesn't advance
      } else if (line.startsWith(' ')) {
        currentNewLine++;
      } else if (line.startsWith('\\')) {
        // No newline warning
      } else {
        inHunk = false;
      }
    }
  }
  return changedLines;
}

/**
 * Execute Miller Tool: AST diff context filtering service.
 * Extracts enclosing AST nodes overlapping changed lines in code files.
 * Cleanly falls back to standard hunk context for non-code files (Markdown, JSON, YAML, etc.).
 */
export async function executeMillerTool(args: MillerToolArgs): Promise<MillerToolResult> {
  const { filePath, patch, maxDepth = 3 } = args || {};

  if (!filePath || typeof filePath !== 'string') {
    return {
      filePath: filePath || 'unknown',
      language: 'unknown',
      mode: 'hunk_fallback',
      miller: `[Miller Error] Invalid or missing filePath parameter.`,
    };
  }

  // Attempt to load file content from disk or fallback to patch / empty
  let fileContent = '';
  try {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (fs.existsSync(resolvedPath)) {
      fileContent = fs.readFileSync(resolvedPath, 'utf8');
    }
  } catch (_) {}

  const parser = new ASTParser();
  const language = parser.detectLanguage(filePath);
  const isNonCodeFile = language === 'unknown' || /\.(md|json|yaml|yml|txt|toml|csv|ini|log)$/i.test(filePath);

  // Fallback for non-code files or unreadable content without patch
  if (isNonCodeFile || (!fileContent && !patch)) {
    const fallbackText = patch || fileContent || `Standard hunk context for ${filePath} (non-code file)`;
    const formattedMiller = `=== MILLER CONTEXT (Hunk Fallback: ${filePath}) ===\n${fallbackText}`;
    return {
      filePath,
      language: language || 'non-code',
      mode: 'hunk_fallback',
      miller: formattedMiller,
    };
  }

  // Parse source code using ASTParser
  const parseTargetContent = fileContent || patch || '';
  const parseResult = parser.parseSource(filePath, parseTargetContent);
  const changedLines = parseChangedLinesFromPatch(patch);

  const lines = parseTargetContent.split(/\r?\n/);

  // Find enclosing symbols that overlap with changed lines
  const overlappingSymbols: ASTSymbol[] = [];
  if (changedLines.length > 0) {
    for (const sym of parseResult.symbols) {
      const overlaps = changedLines.some((l) => l >= sym.startLine && l <= sym.endLine);
      if (overlaps) {
        overlappingSymbols.push(sym);
      }
    }
  } else {
    // If no specific patch lines, include top-level / major symbols up to maxDepth
    overlappingSymbols.push(...parseResult.symbols.slice(0, 10));
  }

  if (overlappingSymbols.length === 0) {
    const fallbackText = patch || lines.slice(0, 50).join('\n');
    const formattedMiller = `=== MILLER CONTEXT (Hunk Fallback: ${filePath}) ===\n${fallbackText}`;
    return {
      filePath,
      language,
      mode: 'hunk_fallback',
      miller: formattedMiller,
    };
  }

  // Build compact AST node snippets
  const nodes: MillerNodeSnippet[] = [];
  const formattedSections: string[] = [];

  // Sort symbols by startLine, cap by maxDepth / limit
  const selectedSymbols = overlappingSymbols.slice(0, maxDepth * 3);

  for (const sym of selectedSymbols) {
    const startIdx = Math.max(0, sym.startLine - 1);
    const endIdx = Math.min(lines.length, sym.endLine);
    const snippetLines = lines.slice(startIdx, endIdx);
    const snippet = snippetLines.join('\n');

    nodes.push({
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      snippet,
    });

    formattedSections.push(
      `--- [AST Node: ${sym.kind} ${sym.name} (Lines ${sym.startLine}-${sym.endLine})] ---\n${snippet}`
    );
  }

  const formattedMiller = `=== MILLER CONTEXT (Syntactically Bounded AST: ${filePath}) ===\n` + formattedSections.join('\n\n');

  return {
    filePath,
    language,
    mode: 'ast_bounded',
    nodes,
    miller: formattedMiller,
  };
}
