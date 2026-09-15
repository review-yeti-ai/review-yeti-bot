import fs from 'fs';
import path from 'path';
import { ChangedFile } from '../pipeline/hunkFilter';
import { PreChecksZoektConfig } from '../config/schema';
import { ASTParser } from '../indexer/astParser';

const { createZoektSearchTool, ZOEKT_SEARCH_TOOL_NAME } = require('../mcp/zoektSearchTool');

// ============================================================================
// Interfaces & Contracts (per PROJECT.md § Interface Contracts)
// ============================================================================

export interface ZoektSymbolMatch {
  path: string;
  line: number;
  text: string;
}

export interface DiscoveredSymbolContext {
  symbol: string;
  kind?: string;
  sourcePath: string;
  isModifiedDefinition: boolean;
  definitions: ZoektSymbolMatch[];
  callSites: ZoektSymbolMatch[];
}

export interface ZoektPreCheckReceipt {
  indexDir?: string;
  totalQueries: number;
  durationMs: number;
  truncated?: boolean;
}

export interface ZoektPreCheckResult {
  status: 'ok' | 'unavailable' | 'disabled' | 'skipped';
  reason?: string;
  scannedSymbolsCount: number;
  matchedSymbolsCount: number;
  symbols: DiscoveredSymbolContext[];
  receipt: ZoektPreCheckReceipt;
}

export type SymbolRole =
  | 'enclosing_function'
  | 'enclosing_class'
  | 'enclosing_module'
  | 'declared_definition'
  | 'call'
  | 'import'
  | 'type_usage';

export interface CandidateSymbol {
  name: string;
  sourcePath: string;
  line: number;
  kind?: string;
  role: SymbolRole;
  isModifiedDefinition: boolean;
  score: number;
}

export interface ZoektPreCheckOptions {
  changedFiles?: ChangedFile[];
  candidateSymbols?: CandidateSymbol[];
  config?: Partial<PreChecksZoektConfig>;
  indexDir?: string;
  signal?: AbortSignal;
  identity?: {
    repository?: string;
    prNumber?: string | number;
    headSha?: string;
  };
  spawnImpl?: any;
  fsImpl?: any;
  concurrency?: number;
}

// ============================================================================
// Keyword and Filtering Blocklists
// ============================================================================

const COMMON_KEYWORDS = new Set([
  // JavaScript / TypeScript
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'as', 'implements', 'interface', 'let',
  'package', 'private', 'protected', 'public', 'static', 'yield', 'any', 'boolean', 'constructor',
  'declare', 'get', 'is', 'keyof', 'module', 'namespace', 'never', 'readonly', 'require',
  'set', 'string', 'symbol', 'type', 'undefined', 'unknown', 'from', 'of', 'async', 'await',

  // Python
  'and', 'assert', 'def', 'del', 'elif', 'except', 'global', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'True', 'False', 'None', 'self', 'cls', 'print', 'len', 'range',
  'dict', 'list', 'tuple', 'object', 'isinstance', 'issubclass', 'enumerate', 'zip',

  // Elixir
  'defmodule', 'defp', 'defmacro', 'defguard', 'defstruct', 'defimpl', 'defprotocol',
  'fn', 'cond', 'unless', 'when', 'quote', 'unquote', 'alias', 'use', 'nil',
  'rescue', 'receive', 'send', 'ok', 'error', 'opts', 'state',

  // Go
  'func', 'defer', 'go', 'select', 'chan', 'struct', 'goto', 'fallthrough', 'iota', 'make',
  'cap', 'append', 'copy', 'close', 'panic', 'recover', 'println', 'err', 'int', 'int64',
  'int32', 'uint', 'uint64', 'byte', 'rune', 'bool', 'float64', 'float32',

  // Ubiquitous generic tokens
  'test', 'tests', 'spec', 'data', 'item', 'items', 'index', 'result', 'results', 'value',
  'values', 'temp', 'args', 'kwargs', 'props', 'params', 'logger', 'console', 'message',
  'path', 'file', 'name', 'key', 'val', 'req', 'res', 'ctx', 'context', 'config', 'options',
  'todo', 'fixme', 'note', 'hack',
]);

// ============================================================================
// Helper Utilities
// ============================================================================

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeRepoPath(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') return '';
  return filePath
    .replace(/\\/g, '/')
    .trim()
    .replace(/^(\.\/|\/)+/, '')
    .replace(/^[ab]\//, '');
}

export function isSameFile(path1: string, path2: string): boolean {
  return normalizeRepoPath(path1) === normalizeRepoPath(path2);
}

export function isImportLine(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('import ') ||
    trimmed.startsWith('from ') ||
    trimmed.startsWith('require(') ||
    trimmed.startsWith('use ') ||
    trimmed.startsWith('alias ') ||
    trimmed.startsWith('import(')
  );
}

export function isDefinitionLine(lineText: string, symbolName: string): boolean {
  if (!lineText || !symbolName) return false;
  const escaped = escapeRegExp(symbolName);
  const definitionPatterns = [
    // TypeScript / JavaScript
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?interface\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?type\\s+${escaped}\\s*=\\s*`),
    new RegExp(`\\b(?:export\\s+)?enum\\s+${escaped}\\b`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-zA-Z0-9_$]+)\\s*=>`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?function\\b`),
    // Python
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\b`),
    new RegExp(`^\\s*class\\s+${escaped}\\b`),
    // Elixir
    new RegExp(`\\bdef(?:p|module|macro|macrop|guard|guardp)?\\s+${escaped}\\b`),
    // Go
    new RegExp(`\\bfunc\\s+(?:\\([^)]+\\)\\s+)?${escaped}\\b`),
    new RegExp(`\\btype\\s+${escaped}\\s+(?:struct|interface)\\b`),
    // Rust
    new RegExp(`\\b(?:pub(?:\\([^)]+\\))?\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`),
    new RegExp(`\\b(?:pub(?:\\([^)]+\\))?\\s+)?(?:struct|enum|trait|type)\\s+${escaped}\\b`),
  ];
  return definitionPatterns.some((pat) => pat.test(lineText));
}

function stripCommentsAndLiterals(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*/g, ' ')
    .replace(/#.*/g, ' ')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\r\n])*\1/g, ' ')
    .replace(/\b\d+\b/g, ' ');
}

function isValidSymbolName(name: string): boolean {
  if (!name || name.length < 3 || name.length > 80) return false;
  if (COMMON_KEYWORDS.has(name) || COMMON_KEYWORDS.has(name.toLowerCase())) return false;
  if (/^[0-9_]+$/.test(name)) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*[?!]?$/.test(name);
}

interface ParsedHunk {
  sectionHeader: string;
  modifiedLines: Array<{ line: number; text: string }>;
  modifiedLineNumbers: Set<number>;
}

function parseUnifiedDiffHunks(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  if (!patch || !patch.trim()) return hunks;

  const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
  let currentHunk: ParsedHunk | null = null;
  let currentNew = 0;

  for (const line of rawLines) {
    const hunkMatch = line.match(/^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,[0-9]+)?\s+@@\s*(.*)$/);
    if (hunkMatch) {
      currentNew = parseInt(hunkMatch[1], 10);
      currentHunk = {
        sectionHeader: hunkMatch[2] || '',
        modifiedLines: [],
        modifiedLineNumbers: new Set<number>(),
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.modifiedLines.push({ line: currentNew, text: line.slice(1) });
      currentHunk.modifiedLineNumbers.add(currentNew);
      currentNew++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deletion does not advance new line counter
      continue;
    } else if (line.startsWith(' ')) {
      currentNew++;
    }
  }

  return hunks;
}

export function deduplicateCandidates(candidates: CandidateSymbol[]): CandidateSymbol[] {
  const symbolMap = new Map<string, CandidateSymbol>();
  for (const c of candidates) {
    const existing = symbolMap.get(c.name);
    if (!existing) {
      symbolMap.set(c.name, c);
    } else {
      const higherScore = c.score > existing.score;
      const isNowDef = existing.isModifiedDefinition || c.isModifiedDefinition;
      symbolMap.set(c.name, {
        ...(higherScore ? c : existing),
        isModifiedDefinition: isNowDef,
        score: Math.max(existing.score, c.score),
      });
    }
  }
  return Array.from(symbolMap.values());
}

export function prioritizeCandidates(candidates: CandidateSymbol[]): CandidateSymbol[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.name.localeCompare(b.name);
  });
}

// ============================================================================
// Feature 8: Candidate Symbol Extraction from Modified Diff Hunks
// ============================================================================

/**
 * Extracts candidate symbols from modified lines in diff hunks.
 * Operates in two tracks:
 * - Track 1: Modified definitions (isModifiedDefinition: true, score 90-100)
 * - Track 2: Referenced & imported symbols (isModifiedDefinition: false, score 40-60)
 * Across TypeScript/JavaScript, Python, Elixir, and Go in content or patch mode.
 */
export async function extractModifiedSymbols(
  changedFiles: ChangedFile[],
  maxSymbols: number = 25
): Promise<CandidateSymbol[]> {
  const candidates: CandidateSymbol[] = [];
  const astParser = new ASTParser();

  for (const file of changedFiles) {
    if (!file.path) continue;
    const filePath = file.path;
    const hunks = file.patch ? parseUnifiedDiffHunks(file.patch) : [];
    const allModifiedLines = hunks.flatMap((h) => h.modifiedLines);
    const allModifiedLineNums = new Set<number>(hunks.flatMap((h) => Array.from(h.modifiedLineNumbers)));

    // Track 1: If full content is available and supported by ASTParser (TS, JS, Python)
    if (file.content && astParser.isSupportedFile(filePath)) {
      try {
        const parseResult = astParser.parseSource(filePath, file.content);

        // 1.1 Enclosing definitions that intersect any modified line
        for (const sym of parseResult.symbols) {
          const isEnclosing = Array.from(allModifiedLineNums).some(
            (line) => sym.startLine <= line && line <= sym.endLine
          );

          if (isEnclosing && isValidSymbolName(sym.name)) {
            const isFn = sym.kind === 'function' || sym.kind === 'method';
            candidates.push({
              name: sym.name,
              sourcePath: filePath,
              line: sym.startLine,
              kind: sym.kind,
              role: isFn ? 'enclosing_function' : 'enclosing_class',
              isModifiedDefinition: true,
              score: isFn ? 100 : 90,
            });
          }
        }

        // 1.2 References on modified lines
        for (const ref of parseResult.references) {
          if (allModifiedLineNums.has(ref.line) && isValidSymbolName(ref.targetSymbolName)) {
            candidates.push({
              name: ref.targetSymbolName,
              sourcePath: filePath,
              line: ref.line,
              kind: ref.referenceType,
              role: ref.referenceType === 'call' ? 'call' : 'import',
              isModifiedDefinition: false,
              score: ref.referenceType === 'call' ? 60 : 50,
            });
          }
        }
      } catch (_err) {
        // Soft fallback to regex below
      }
    }

    // Track 2: Regex & Pattern Extractors for Go, Elixir, or when content is missing/patch-only
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

    // 2.1 Hunk Header Section Extractors (Enclosing symbol hint from git diff)
    for (const hunk of hunks) {
      if (hunk.sectionHeader) {
        const header = hunk.sectionHeader.trim();
        let matchedName: string | null = null;
        let matchedKind = 'function';

        // Go func (r *Receiver) Method( or func Method(
        const goHeader = header.match(/func\s*(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/);
        if (goHeader) {
          matchedName = goHeader[1];
        }

        // Elixir def/defmodule
        const exHeader = header.match(/(?:defmodule|def|defp)\s+([A-Za-z0-9_.]+[?!]?)/);
        if (exHeader) {
          matchedName = exHeader[1].split('.').pop() || exHeader[1];
        }

        // Python def / class
        const pyHeader = header.match(/(?:def|class)\s+([A-Za-z0-9_]+)/);
        if (pyHeader) {
          matchedName = pyHeader[1];
        }

        // TS/JS function / class / interface
        const tsHeader = header.match(/(?:class|interface|function|const)\s+([A-Za-z0-9_]+)/);
        if (tsHeader) {
          matchedName = tsHeader[1];
        }

        if (matchedName && isValidSymbolName(matchedName)) {
          const firstLine = hunk.modifiedLines[0]?.line || 1;
          candidates.push({
            name: matchedName,
            sourcePath: filePath,
            line: firstLine,
            kind: matchedKind,
            role: 'enclosing_function',
            isModifiedDefinition: true,
            score: 95,
          });
        }
      }
    }

    // 2.2 Scan Modified Lines (+) for Definitions and References
    for (const mod of allModifiedLines) {
      const lineText = mod.text;
      const lineNum = mod.line;
      const cleaned = stripCommentsAndLiterals(lineText);

      // Go Definitions
      if (ext === '.go') {
        const goMethod = cleaned.match(/^\s*func\s+\(\s*(?:[A-Za-z0-9_]+\s+)?\*?([A-Za-z0-9_]+)\s*\)\s*([A-Za-z0-9_]+)\s*\(/);
        if (goMethod) {
          if (isValidSymbolName(goMethod[2])) {
            candidates.push({ name: goMethod[2], sourcePath: filePath, line: lineNum, kind: 'method', role: 'declared_definition', isModifiedDefinition: true, score: 100 });
          }
          if (isValidSymbolName(goMethod[1])) {
            candidates.push({ name: goMethod[1], sourcePath: filePath, line: lineNum, kind: 'struct', role: 'enclosing_class', isModifiedDefinition: true, score: 90 });
          }
        } else {
          const goFunc = cleaned.match(/^\s*func\s+([A-Za-z0-9_]+)\s*\(/);
          if (goFunc && isValidSymbolName(goFunc[1])) {
            candidates.push({ name: goFunc[1], sourcePath: filePath, line: lineNum, kind: 'function', role: 'declared_definition', isModifiedDefinition: true, score: 100 });
          }
        }
        const goType = cleaned.match(/^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/);
        if (goType && isValidSymbolName(goType[1])) {
          candidates.push({ name: goType[1], sourcePath: filePath, line: lineNum, kind: 'struct', role: 'enclosing_class', isModifiedDefinition: true, score: 90 });
        }
      }

      // Elixir Definitions
      if (ext === '.ex' || ext === '.exs') {
        const exMod = cleaned.match(/^\s*defmodule\s+([A-Z][A-Za-z0-9_.]*)/);
        if (exMod) {
          const modSym = exMod[1].split('.').pop() || exMod[1];
          if (isValidSymbolName(modSym)) {
            candidates.push({ name: modSym, sourcePath: filePath, line: lineNum, kind: 'module', role: 'enclosing_module', isModifiedDefinition: true, score: 90 });
          }
        }
        const exFn = cleaned.match(/^\s*(?:def|defp|defmacro|defguard)\s+([a-z_][a-zA-Z0-9_]*[?!]?)/);
        if (exFn && isValidSymbolName(exFn[1])) {
          candidates.push({ name: exFn[1], sourcePath: filePath, line: lineNum, kind: 'function', role: 'declared_definition', isModifiedDefinition: true, score: 100 });
        }
      }

      // TS/JS & Python Definitions (fallback when AST is missing or patch-only)
      if (!astParser.isSupportedFile(filePath) || !file.content) {
        const genCls = cleaned.match(/^\s*(?:export\s+)?(?:class|interface)\s+([A-Za-z0-9_]+)/);
        if (genCls && isValidSymbolName(genCls[1])) {
          candidates.push({ name: genCls[1], sourcePath: filePath, line: lineNum, kind: 'class', role: 'enclosing_class', isModifiedDefinition: true, score: 90 });
        }
        const genFn = cleaned.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|def)\s+([A-Za-z0-9_]+)/);
        if (genFn && isValidSymbolName(genFn[1])) {
          candidates.push({ name: genFn[1], sourcePath: filePath, line: lineNum, kind: 'function', role: 'declared_definition', isModifiedDefinition: true, score: 100 });
        }
      }

      // 2.3 References & Calls on '+' Lines across all languages
      const callMatches = Array.from(cleaned.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{2,}[?!]?)\s*\(/g));
      for (const cm of callMatches) {
        const sym = cm[1];
        if (isValidSymbolName(sym)) {
          candidates.push({
            name: sym,
            sourcePath: filePath,
            line: lineNum,
            kind: 'call',
            role: 'call',
            isModifiedDefinition: false,
            score: 60,
          });
        }
      }

      // 2.4 PascalCase Identifiers (likely Classes, Modules, Types)
      const typeMatches = Array.from(cleaned.matchAll(/\b([A-Z][a-zA-Z0-9_]{2,})\b/g));
      for (const tm of typeMatches) {
        const sym = tm[1];
        if (isValidSymbolName(sym)) {
          candidates.push({
            name: sym,
            sourcePath: filePath,
            line: lineNum,
            kind: 'type',
            role: 'type_usage',
            isModifiedDefinition: false,
            score: 40,
          });
        }
      }
    }
  }

  const deduplicated = deduplicateCandidates(candidates);
  const prioritized = prioritizeCandidates(deduplicated);

  return prioritized.slice(0, maxSymbols);
}

// ============================================================================
// Features 9 & 10: Zoekt Query Execution & Fail-Soft Handling
// ============================================================================

/**
 * Executes Zoekt pre-check queries against candidate symbols extracted from PR diffs.
 * Queries Zoekt for call sites (modified definitions) or canonical definitions (referenced symbols).
 * Completely fail-soft: catches missing index, missing binary, timeouts, and cancellations.
 */
export async function executeZoektPreCheck(
  options: ZoektPreCheckOptions
): Promise<ZoektPreCheckResult> {
  const startTime = Date.now();
  const fsImpl = options.fsImpl || fs;

  // 1. Resolve Config
  const config = options.config ?? { enabled: true, max_symbols: 200, timeoutMs: 10000 };
  const effectiveIndexDir = options.indexDir || config.indexDir || process.env.ZOEKT_INDEX_DIR;

  // 2. Fail-soft: Disabled check
  if (config.enabled === false) {
    return {
      status: 'disabled',
      reason: 'disabled',
      scannedSymbolsCount: 0,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 3. Fail-soft: Immediate Abort check
  if (options.signal?.aborted) {
    return {
      status: 'unavailable',
      reason: 'cancelled',
      scannedSymbolsCount: 0,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 4. Fail-soft: Index availability check
  const isIndexAvailable = (): boolean => {
    if (!effectiveIndexDir || typeof effectiveIndexDir !== 'string') return false;
    try {
      return (
        fsImpl.existsSync(effectiveIndexDir) &&
        fsImpl.readdirSync(effectiveIndexDir).some((entry: any) => String(entry).endsWith('.zoekt'))
      );
    } catch {
      return false;
    }
  };

  if (!isIndexAvailable()) {
    return {
      status: 'unavailable',
      reason: 'zoekt_index_unavailable',
      scannedSymbolsCount: 0,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 5. Resolve candidate symbols
  let candidates: CandidateSymbol[] = [];
  if (options.candidateSymbols && options.candidateSymbols.length > 0) {
    candidates = options.candidateSymbols;
  } else if (options.changedFiles && options.changedFiles.length > 0) {
    candidates = await extractModifiedSymbols(options.changedFiles, config.max_symbols ?? 200);
  }

  if (candidates.length === 0) {
    return {
      status: 'skipped',
      reason: 'no_candidate_symbols',
      scannedSymbolsCount: 0,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 6. Enforce max_symbols budget & deduplicate
  const maxSymbols = config.max_symbols ?? 200;
  const deduplicated = deduplicateCandidates(candidates);
  const prioritized = prioritizeCandidates(deduplicated);
  const budgetedCandidates = prioritized.slice(0, maxSymbols);
  const truncated = prioritized.length > maxSymbols;

  // 7. Instantiate Zoekt search tool
  let zoektTool: any;
  try {
    zoektTool = createZoektSearchTool({
      identity: options.identity,
      indexDir: effectiveIndexDir,
      config: {
        enabled: true,
        maxCalls: Math.max(50, budgetedCandidates.length * 2),
        maxFindResults: 50,
        maxResultBytes: 32 * 1024,
        timeoutMs: config.timeoutMs ?? 5000,
      },
      spawnImpl: options.spawnImpl,
      fsImpl,
    });
  } catch (err: any) {
    return {
      status: 'unavailable',
      reason: err?.code === 'ENOENT' ? 'zoekt_binary_missing' : (err?.message || 'initialization_error'),
      scannedSymbolsCount: budgetedCandidates.length,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  // 8. Execute queries across budgeted candidate symbols with a 10-worker concurrency pool (exact queries, no regexes)
  let totalQueries = 0;
  let anyQueryTruncated = false;
  let binaryMissing = false;
  let timedOutQueries = 0;

  const resultsByIndex: Array<DiscoveredSymbolContext | null> = new Array(budgetedCandidates.length).fill(null);
  const concurrency = options.concurrency ?? (options.spawnImpl ? 1 : 10);
  let nextCandidateIdx = 0;

  const worker = async () => {
    while (nextCandidateIdx < budgetedCandidates.length) {
      if (options.signal?.aborted || binaryMissing) break;
      const idx = nextCandidateIdx++;
      const candidate = budgetedCandidates[idx];

      totalQueries += 1;
      let queryRes: any;
      try {
        queryRes = await zoektTool.call(
          ZOEKT_SEARCH_TOOL_NAME,
          { query: candidate.name },
          { signal: options.signal }
        );
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          binaryMissing = true;
          break;
        }
        continue;
      }

      if (queryRes.status === 'unavailable') {
        if (queryRes.reason === 'zoekt_binary_missing') {
          binaryMissing = true;
          break;
        }
        if (queryRes.reason === 'request_timeout') {
          timedOutQueries += 1;
          continue;
        }
        continue;
      }

      if (queryRes.status === 'cancelled') {
        break;
      }

      if (queryRes.status !== 'ok') {
        continue;
      }

      if (queryRes.truncated) {
        anyQueryTruncated = true;
      }

      // Filter by word boundary in JS post-processing
      const wordBoundary = new RegExp(`\\b${escapeRegExp(candidate.name)}\\b`);
      const wordMatches: ZoektSymbolMatch[] = (queryRes.matches || []).filter(
        (m: any) => m && typeof m.text === 'string' && wordBoundary.test(m.text)
      );

      // Filter out matches in the same file
      const externalMatches = wordMatches.filter(
        (m) => !isSameFile(m.path, candidate.sourcePath)
      );

      // Classify into definitions vs call sites
      const definitions: ZoektSymbolMatch[] = [];
      const callSites: ZoektSymbolMatch[] = [];

      for (const match of externalMatches) {
        if (isDefinitionLine(match.text, candidate.name)) {
          definitions.push(match);
        } else {
          callSites.push(match);
        }
      }

      // For referenced symbols: if no definition line was matched, pick first non-import as definition candidate
      if (!candidate.isModifiedDefinition && definitions.length === 0 && externalMatches.length > 0) {
        const nonImport = externalMatches.find((m) => !isImportLine(m.text));
        if (nonImport) {
          definitions.push(nonImport);
        }
      }

      // Only record if cross-file context was discovered
      if (definitions.length > 0 || callSites.length > 0) {
        resultsByIndex[idx] = {
          symbol: candidate.name,
          kind: candidate.kind,
          sourcePath: candidate.sourcePath,
          isModifiedDefinition: candidate.isModifiedDefinition,
          definitions: definitions.slice(0, 10),
          callSites: callSites.slice(0, 25),
        };
      }
    }
  };

  const workerCount = Math.min(concurrency, budgetedCandidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const discoveredSymbols: DiscoveredSymbolContext[] = resultsByIndex.filter(
    (s): s is DiscoveredSymbolContext => s !== null
  );

  // 9. Fail-soft post-evaluation
  if (binaryMissing) {
    return {
      status: 'unavailable',
      reason: 'zoekt_binary_missing',
      scannedSymbolsCount: budgetedCandidates.length,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries,
        durationMs: Date.now() - startTime,
      },
    };
  }

  if (options.signal?.aborted) {
    return {
      status: 'unavailable',
      reason: 'cancelled',
      scannedSymbolsCount: budgetedCandidates.length,
      matchedSymbolsCount: discoveredSymbols.length,
      symbols: discoveredSymbols,
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries,
        durationMs: Date.now() - startTime,
      },
    };
  }

  if (totalQueries > 0 && timedOutQueries === totalQueries) {
    return {
      status: 'unavailable',
      reason: 'request_timeout',
      scannedSymbolsCount: budgetedCandidates.length,
      matchedSymbolsCount: 0,
      symbols: [],
      receipt: {
        indexDir: effectiveIndexDir,
        totalQueries,
        durationMs: Date.now() - startTime,
      },
    };
  }

  return {
    status: 'ok',
    scannedSymbolsCount: budgetedCandidates.length,
    matchedSymbolsCount: discoveredSymbols.length,
    symbols: discoveredSymbols,
    receipt: {
      indexDir: effectiveIndexDir,
      totalQueries,
      durationMs: Date.now() - startTime,
      truncated: truncated || anyQueryTruncated,
    },
  };
}

// ============================================================================
// Feature 11: Prompt Formatting Helper
// ============================================================================

/**
 * Formats ZoektPreCheckResult into token-budgeted Markdown for persona review prompts.
 */
export function formatZoektPreCheckPrompt(
  result: ZoektPreCheckResult,
  options?: { maxPromptChars?: number; maxCallSitesPerSymbol?: number }
): string {
  if (!result) return '';

  const header = `=== PRE-CHECK SYMBOL & REPOSITORY CONTEXT (ZOEKT) ===`;

  if (result.status === 'disabled') {
    return [
      header,
      `[Status: disabled]`,
      `Automated symbol pre-checks are disabled in repository configuration.`,
    ].join('\n');
  }

  if (result.status === 'unavailable') {
    const reason = result.reason || 'zoekt_index_unavailable';
    return [
      header,
      `[Status: unavailable | Reason: ${reason}]`,
      `Automated symbol pre-check context is unavailable for this repository. Use on-demand exploration tools (read_file, find_files, symbol_search, code_search_zoekt) as needed.`,
    ].join('\n');
  }

  if (result.status === 'skipped') {
    return [
      header,
      `[Status: skipped | Reason: ${result.reason || 'no_candidate_symbols'}]`,
      `No modified symbols eligible for external search were identified in the PR diff.`,
    ].join('\n');
  }

  if (result.status === 'ok') {
    if (!result.symbols || result.symbols.length === 0) {
      return [
        header,
        `No external definitions or call sites were found across the repository for modified symbols.`,
      ].join('\n');
    }

    const lines: string[] = [
      header,
      `Discovered ${result.symbols.length} symbol(s) with cross-file repository context:`,
    ];

    const MAX_PRECHECK_PROMPT_CHARS = options?.maxPromptChars ?? 50_000;
    const maxDisplaySites = options?.maxCallSitesPerSymbol ?? 5;
    let accumulatedLength = lines.join('\n').length;
    let budgetExceeded = false;

    for (const sym of result.symbols) {
      const symLines: string[] = [];
      const kindStr = sym.kind ? ` (${sym.kind})` : '';
      if (sym.isModifiedDefinition) {
        symLines.push(`- Symbol '${sym.symbol}'${kindStr} (defined in ${sym.sourcePath}):`);
        if (sym.callSites && sym.callSites.length > 0) {
          const fileCounts = new Map<string, number>();
          for (const cs of sym.callSites) {
            const basename = path.basename(cs.path);
            fileCounts.set(basename, (fileCounts.get(basename) || 0) + 1);
          }
          const fileBreakdown = Array.from(fileCounts.entries())
            .map(([f, count]) => `${f} (${count})`)
            .join(', ');

          symLines.push(`  External call sites (${sym.callSites.length} found across repository):`);
          if (fileCounts.size > 1) {
            symLines.push(`    Distribution across ${fileCounts.size} files: [${fileBreakdown}]`);
          }
          const displaySites = sym.callSites.slice(0, maxDisplaySites);
          for (const cs of displaySites) {
            symLines.push(`    - ${cs.path}:${cs.line}: ${cs.text.trim()}`);
          }
          if (sym.callSites.length > maxDisplaySites) {
            symLines.push(`    ... (+${sym.callSites.length - maxDisplaySites} more external call sites)`);
          }
        } else {
          symLines.push(`  External call sites: None found across repository.`);
        }
      } else {
        symLines.push(`- Symbol '${sym.symbol}'${kindStr} (referenced in ${sym.sourcePath}):`);
        if (sym.definitions && sym.definitions.length > 0) {
          symLines.push(`  Canonical definition:`);
          const displayDefs = sym.definitions.slice(0, 5);
          for (const def of displayDefs) {
            symLines.push(`    - ${def.path}:${def.line}: ${def.text.trim()}`);
          }
        }
        if (sym.callSites && sym.callSites.length > 0) {
          const fileCounts = new Map<string, number>();
          for (const cs of sym.callSites) {
            const basename = path.basename(cs.path);
            fileCounts.set(basename, (fileCounts.get(basename) || 0) + 1);
          }
          const fileBreakdown = Array.from(fileCounts.entries())
            .map(([f, count]) => `${f} (${count})`)
            .join(', ');

          symLines.push(`  Other call sites across repository (${sym.callSites.length} found):`);
          if (fileCounts.size > 1) {
            symLines.push(`    Distribution across ${fileCounts.size} files: [${fileBreakdown}]`);
          }
          for (const cs of sym.callSites.slice(0, maxDisplaySites)) {
            symLines.push(`    - ${cs.path}:${cs.line}: ${cs.text.trim()}`);
          }
        }
      }

      const symText = symLines.join('\n');
      if (accumulatedLength + symText.length > MAX_PRECHECK_PROMPT_CHARS) {
        budgetExceeded = true;
        break;
      }

      lines.push(...symLines);
      accumulatedLength += symText.length;
    }

    if (budgetExceeded) {
      lines.push('... [Pre-check symbol context truncated to stay within prompt token budget]');
    }

    return lines.join('\n');
  }

  return '';
}
