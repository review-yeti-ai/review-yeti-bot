/**
 * Symbol Resolution Appendix -- deterministic, pre-computed symbol resolution for the static
 * review prefix.
 *
 * The defect this fixes: a reviewer persona called `symbol_search("replace_filters")`. The
 * symbol was defined ~190 lines below the diff hunk, so the patch-scoped tool (see
 * `../panel/toolRuntime.ts`'s `symbol_search` branch, which parses `f.content || f.patch` --
 * diff text, not the real file) answered "No symbols found", and the model faithfully reported a
 * blocking P1: "no definition could be located anywhere in lib/ or test/ via symbol and code
 * search." The finding was false -- the tool promised repository reach it did not have, and the
 * model believed it.
 *
 * This module computes, ONCE per review before any persona/task turn, a deterministic resolution
 * for every symbol referenced on a diff-added line:
 *   1. Extract -- symbols referenced on changed lines, parsed from REAL file content (fetched via
 *      `RepoFileProvider`), never from patch text. Patch text carries `+`/`-` markers and
 *      truncated context, which is exactly why `toolRuntime.ts`'s existing call site is unreliable.
 *   2. Locate -- each symbol through the per-run Zoekt index (`../mcp/zoektSearchTool.js`).
 *   3. Exactly one candidate -> resolved: emit `file:line` plus surrounding context.
 *   4. More than one candidate -> ambiguous: emit EVERY candidate (bounded), explicitly labelled.
 *      This module never guesses and never silently picks the first candidate.
 *   5. Zero candidates -> reported as "not found by an exhaustive full-repository search", which
 *      is a materially different claim than "not found in the diff" -- the whole point of the
 *      `scope`/`exhaustive` envelope this module reuses verbatim from `toolRuntime.ts`.
 *
 * The result belongs in the shared static prefix (see `../panel/composedEngine.ts`'s
 * `buildStaticPrefix` and `../panel/panelEngine.ts`'s per-persona `staticPrefix`) so every
 * lane/task reuses it from the cached prefix instead of re-discovering it with serial tool turns.
 *
 * Fail-soft, exactly like `../mcp/zoektGrounding.js`: this module never throws. A missing index,
 * a missing repoFileProvider, an aborted signal, or an unexpected error all resolve to
 * `status !== 'ok'`, and `formatSymbolResolutionAppendixPrompt` returns `''` for anything other
 * than a non-empty `'ok'` result -- the appendix is simply absent and the review proceeds exactly
 * as it would without this module.
 *
 * Budget discipline: "all related lines for every symbol" blows any prompt budget, so three named
 * constants bound the output below. When the bounded output would still exceed the total
 * character ceiling, `fitEntriesToBudget` degrades an entry (drops its source snippets, keeps its
 * full status and candidate list) or omits it entirely -- it NEVER truncates rendered text
 * mid-entry, because a truncated block that still looks complete is worse than an absent one.
 */
import { ASTParser } from '../indexer/astParser';
import type { ChangedFile } from '../pipeline/hunkFilter';
import type { RepoFileProvider } from '../panel/panelEngine';
import { escapeRegExp, isDefinitionLine } from './zoektPreCheckService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createZoektSearchTool, ZOEKT_SEARCH_TOOL_NAME } = require('../mcp/zoektSearchTool');

// ---------------------------------------------------------------------------
// Budget constants (named per the design brief). Nothing in this module or its callers may
// hardcode an equivalent literal -- these are the single source of truth.
// ---------------------------------------------------------------------------

/** Distinct symbols resolved per review. Also bounds Zoekt query count: one query per symbol. */
export const SYMBOL_APPENDIX_MAX_SYMBOLS = 12;
/** Candidates shown per ambiguous symbol. An entry never shows a partial subset silently -- if
 *  more exist than this, the entry says so explicitly (`candidatesTruncated`). */
export const SYMBOL_APPENDIX_MAX_CANDIDATES = 8;
/** Lines of source shown above and below each resolved/candidate definition line. */
export const SYMBOL_APPENDIX_CONTEXT_LINES = 12;
/** Hard ceiling, in characters, for the whole rendered appendix. Chosen to comfortably fit
 *  SYMBOL_APPENDIX_MAX_SYMBOLS fully-resolved entries with context (roughly 25 lines x ~80 chars
 *  each) while staying a small fraction of a typical PR diff section -- this is meant to be a
 *  cheap, always-on addition to the static prefix, not a second diff. */
export const SYMBOL_APPENDIX_MAX_CHARS = 16_000;

const SCOPE = 'full-repository-zoekt' as const;

// Reference types worth resolving. `import` is excluded: the diff's own import statement already
// names the module, so pointing an appendix entry at it adds no information the model doesn't
// already have in the diff section.
const REFERENCE_TYPES_OF_INTEREST = new Set(['call', 'extends', 'implements', 'type_usage']);

// Call-shaped identifiers that are legitimately ambiguous almost everywhere (array/promise/string
// prototype methods, console, control-flow keywords a bare regex scan could mistake for a call)
// and would otherwise dominate the symbol budget with zero-value noise.
const NAME_DENYLIST = new Set([
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every', 'includes', 'push',
  'pop', 'shift', 'unshift', 'slice', 'splice', 'join', 'concat', 'sort', 'reverse', 'indexOf',
  'then', 'catch', 'finally', 'toString', 'valueOf', 'hasOwnProperty', 'bind', 'call', 'apply',
  'log', 'warn', 'error', 'info', 'debug', 'assert', 'trim', 'split', 'replace', 'replaceAll',
  'match', 'test', 'exec', 'parse', 'stringify', 'keys', 'values', 'entries', 'assign', 'freeze',
  'require', 'import',
  // Control-flow keywords a bare regex scan (the unsupported-language fallback track) could
  // mistake for a call when followed by `(`.
  'if', 'for', 'while', 'switch', 'return', 'do', 'unless', 'case', 'fn', 'with', 'when', 'cond',
]);

const CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]{2,}[?!]?)\s*\(/g;

export type SymbolResolutionStatus = 'resolved' | 'ambiguous' | 'not_found';

export interface SymbolResolutionCandidate {
  path: string;
  line: number;
  snippet?: string;
}

export interface SymbolResolutionEntry {
  symbol: string;
  sourcePath: string;
  sourceLine: number;
  status: SymbolResolutionStatus;
  scope: typeof SCOPE;
  exhaustive: boolean;
  candidates: SymbolResolutionCandidate[];
  /** True when repository-wide candidates exceeded the K bound and this list is a subset. */
  candidatesTruncated: boolean;
  /** Total repository-wide candidate count found (>= candidates.length). */
  totalCandidateCount: number;
  /** Set by budget fitting: source snippets were dropped from this entry to fit the char ceiling. */
  contextOmitted?: boolean;
}

export interface SymbolResolutionAppendixReceipt {
  indexDir?: string;
  symbolsConsidered: number;
  symbolsResolved: number;
  symbolsAmbiguous: number;
  symbolsNotFound: number;
  queriesRun: number;
  durationMs: number;
  totalChars: number;
}

export interface SymbolResolutionAppendixResult {
  status: 'ok' | 'unavailable' | 'disabled' | 'skipped';
  reason?: string;
  entries: SymbolResolutionEntry[];
  omittedSymbols: string[];
  receipt: SymbolResolutionAppendixReceipt;
}

export interface SymbolResolutionAppendixConfig {
  enabled?: boolean;
  indexDir?: string;
  maxSymbols?: number;
  maxCandidates?: number;
  contextLines?: number;
  maxChars?: number;
  timeoutMs?: number;
}

export interface SymbolResolutionAppendixOptions {
  changedFiles: ChangedFile[];
  repoFileProvider?: Pick<RepoFileProvider, 'readFile'>;
  indexDir?: string;
  identity?: { repository?: string; prNumber?: string | number; headSha?: string };
  signal?: AbortSignal;
  config?: SymbolResolutionAppendixConfig;
  spawnImpl?: any;
  fsImpl?: any;
}

export interface ReferencedSymbol {
  symbol: string;
  sourcePath: string;
  sourceLine: number;
}

export interface RawSymbolMatch {
  path: string;
  line: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function isPlausibleSymbolName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length < 3 || name.length > 80) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*[?!]?$/.test(name)) return false;
  if (NAME_DENYLIST.has(name) || NAME_DENYLIST.has(name.toLowerCase())) return false;
  return true;
}

function stripStringsAndComments(text: string): string {
  return text
    .replace(/\/\/.*/g, ' ')
    .replace(/#.*/g, ' ')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\r\n])*\1/g, ' ');
}

/**
 * Parses a unified diff patch into its added ('+') lines, each carrying the NEW-file line number
 * unified-diff hunk headers already give us -- no need to re-derive it. Exported so extraction
 * behaviour is independently testable without going through the full pipeline.
 */
export function parseAddedLines(patch: string | undefined): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  if (!patch) return out;
  const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
  let newLine = 0;
  let inHunk = false;
  for (const raw of rawLines) {
    const hunkMatch = raw.match(/^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      out.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // Deletions do not advance the new-file line counter.
    } else {
      newLine += 1;
    }
  }
  return out;
}

/**
 * Extracts the symbols referenced on diff-added lines across all changed files.
 *
 * Two tracks, exactly like the established pattern in `./zoektPreCheckService.ts`:
 *   - Supported languages (TypeScript/JavaScript/Python, per `ASTParser.isSupportedFile`): parse
 *     the REAL file content fetched from `repoFileProvider` and take `call`/`extends`/
 *     `implements`/`type_usage` references whose line lands on a diff-added line. This is the
 *     reliable path the brief calls for -- an AST parse of a patch fragment is unreliable because
 *     the fragment is not valid source (`+`/`-` markers, truncated context); a parse of the real
 *     file at head is exact.
 *   - Everything else (unsupported languages, or a file `repoFileProvider` could not read): a
 *     bounded regex scan of the diff's own added-line text. Coarser, but the identifier text on
 *     an added line is exact regardless of language -- only feeding a patch FRAGMENT to a real
 *     parser is what's unreliable, not reading the line's own text.
 */
export async function extractDiffReferencedSymbols(
  changedFiles: ChangedFile[],
  repoFileProvider: Pick<RepoFileProvider, 'readFile'>,
  options: { signal?: AbortSignal; astParser?: ASTParser; extractionCap?: number } = {},
): Promise<ReferencedSymbol[]> {
  const parser = options.astParser || new ASTParser();
  const extractionCap = boundedPositive(options.extractionCap, SYMBOL_APPENDIX_MAX_SYMBOLS * 5);
  const seen = new Set<string>();
  const out: ReferencedSymbol[] = [];
  const push = (ref: ReferencedSymbol) => {
    if (seen.has(ref.symbol) || out.length >= extractionCap) return;
    seen.add(ref.symbol);
    out.push(ref);
  };

  for (const file of changedFiles) {
    if (options.signal?.aborted || out.length >= extractionCap) break;
    if (!file.path || !file.patch) continue;
    const addedEntries = parseAddedLines(file.patch);
    if (addedEntries.length === 0) continue;

    let handledByAst = false;
    if (parser.isSupportedFile(file.path)) {
      let content: string | null = null;
      try {
        content = await repoFileProvider.readFile(file.path);
      } catch {
        content = null;
      }
      if (typeof content === 'string') {
        handledByAst = true;
        const addedLineNums = new Set(addedEntries.map((e) => e.line));
        try {
          const parsed = parser.parseSource(file.path, content);
          for (const ref of parsed.references) {
            if (!REFERENCE_TYPES_OF_INTEREST.has(ref.referenceType)) continue;
            if (!addedLineNums.has(ref.line)) continue;
            if (!isPlausibleSymbolName(ref.targetSymbolName)) continue;
            push({ symbol: ref.targetSymbolName, sourcePath: file.path, sourceLine: ref.line });
          }
        } catch {
          // Fail soft per-file: fall through to the generic scan below for this one file.
          handledByAst = false;
        }
      }
    }

    if (handledByAst) continue;

    for (const entry of addedEntries) {
      if (out.length >= extractionCap) break;
      const cleaned = stripStringsAndComments(entry.text);
      for (const m of cleaned.matchAll(CALL_PATTERN)) {
        if (!isPlausibleSymbolName(m[1])) continue;
        push({ symbol: m[1], sourcePath: file.path, sourceLine: entry.line });
      }
    }
  }

  return out;
}

/**
 * Classifies repository-wide definition matches for one symbol. This is the never-guess boundary
 * the whole module exists to enforce: exactly one match resolves; two or more are ALL returned,
 * labelled ambiguous, bounded to `maxCandidates` -- this function must never narrow an ambiguous
 * result down to a single "best" candidate.
 */
export function classifySymbolCandidates(
  matches: RawSymbolMatch[],
  maxCandidates: number,
): {
  status: SymbolResolutionStatus;
  candidates: RawSymbolMatch[];
  candidatesTruncated: boolean;
  totalCandidateCount: number;
} {
  if (matches.length === 0) {
    return { status: 'not_found', candidates: [], candidatesTruncated: false, totalCandidateCount: 0 };
  }
  if (matches.length === 1) {
    return { status: 'resolved', candidates: matches.slice(0, 1), candidatesTruncated: false, totalCandidateCount: 1 };
  }
  return {
    status: 'ambiguous',
    candidates: matches.slice(0, Math.max(1, maxCandidates)),
    candidatesTruncated: matches.length > maxCandidates,
    totalCandidateCount: matches.length,
  };
}

function sliceContext(content: string, line: number, contextLines: number): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, line - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  const width = String(end).length;
  const rows: string[] = [];
  for (let n = start; n <= end; n++) {
    const marker = n === line ? '>' : ' ';
    rows.push(`    ${marker} ${String(n).padStart(width, ' ')}| ${lines[n - 1] ?? ''}`);
  }
  return rows.join('\n');
}

function zoektIndexAvailable(indexDir: string | undefined, fsImpl?: any): boolean {
  if (typeof indexDir !== 'string' || !indexDir) return false;
  const fsMod = fsImpl || require('fs');
  try {
    return fsMod.existsSync(indexDir) && fsMod.readdirSync(indexDir).some((entry: any) => String(entry).endsWith('.zoekt'));
  } catch {
    return false;
  }
}

function renderEntry(entry: SymbolResolutionEntry, omitContext: boolean): string {
  const header = `[${entry.status.toUpperCase()}] Symbol '${entry.symbol}' referenced at ${entry.sourcePath}:${entry.sourceLine} [SCOPE: ${entry.scope} | EXHAUSTIVE: ${entry.exhaustive}]`;

  if (entry.status === 'not_found') {
    const note = entry.exhaustive
      ? 'No definition found anywhere in the repository by an exhaustive full-repository index search -- this is not merely "absent from the diff"; the full repository at the reviewed head was searched.'
      : 'No definition matched, but this repository-wide search result was truncated -- treat this as inconclusive, not as confirmed-absent.';
    return [header, `  ${note}`].join('\n');
  }

  const lines = [header];
  if (entry.status === 'ambiguous') {
    lines.push(entry.candidatesTruncated
      ? `  ${entry.totalCandidateCount} candidate definitions found repository-wide; showing the first ${entry.candidates.length}. Do not assume any one of them -- report this symbol as ambiguous, not resolved.`
      : `  ${entry.totalCandidateCount} candidate definitions found repository-wide. Do not assume any one of them -- report this symbol as ambiguous, not resolved.`);
  } else {
    lines.push('  Resolved to exactly one repository-wide definition.');
  }
  for (const c of entry.candidates) {
    lines.push(`  - ${c.path}:${c.line}`);
    if (!omitContext && c.snippet) {
      lines.push(c.snippet);
    }
  }
  if (omitContext && entry.candidates.length > 0) {
    lines.push('  (source context omitted for this entry -- appendix character budget)');
  }
  return lines.join('\n');
}

/**
 * Fits rendered entries into a hard character ceiling. Whole-block decisions only: an entry is
 * included in full, included degraded (candidate list intact, source snippets dropped), or
 * omitted entirely (recorded in `omittedSymbols`). This function must never slice a rendered
 * string -- a truncated block that still looks like a complete entry is worse than an absent one,
 * because a model reasons from it as if it were exhaustive.
 */
export function fitEntriesToBudget(entries: SymbolResolutionEntry[], maxChars: number): {
  entries: SymbolResolutionEntry[];
  omittedSymbols: string[];
  totalChars: number;
} {
  const included: SymbolResolutionEntry[] = [];
  const omittedSymbols: string[] = [];
  let total = 0;

  for (const entry of entries) {
    const full = renderEntry(entry, false);
    const fullLen = full.length + 1;
    if (total + fullLen <= maxChars) {
      included.push({ ...entry, contextOmitted: false });
      total += fullLen;
      continue;
    }
    const degraded = renderEntry(entry, true);
    const degradedLen = degraded.length + 1;
    if (total + degradedLen <= maxChars) {
      // Strip the snippet text from the structural copy too, not just the rendered text -- once
      // an entry is budget-degraded, nothing downstream (logging, telemetry, a future consumer of
      // `entries`) should still be able to reach the content this function decided not to spend
      // budget on.
      included.push({
        ...entry,
        contextOmitted: true,
        candidates: entry.candidates.map((c) => ({ path: c.path, line: c.line })),
      });
      total += degradedLen;
      continue;
    }
    omittedSymbols.push(entry.symbol);
  }

  return { entries: included, omittedSymbols, totalChars: total };
}

/**
 * Renders a computed appendix result into prompt text. Returns `''` for anything other than a
 * non-empty `'ok'` result -- this is the fail-soft contract: an unavailable/disabled/skipped/empty
 * appendix must leave the static prefix byte-identical to a build without this module.
 */
export function formatSymbolResolutionAppendixPrompt(result: SymbolResolutionAppendixResult | undefined): string {
  if (!result || result.status !== 'ok' || result.entries.length === 0) return '';

  const header = [
    '=== SYMBOL RESOLUTION APPENDIX (deterministic, pre-computed via full-repository Zoekt search) ===',
    'Every symbol below was referenced on a changed (+) line in this diff and resolved against the FULL repository at the reviewed head -- not just the diff hunks. Trust these results over your own symbol_search/code_search for the exact symbols listed; do not re-search them. A symbol NOT listed here was not covered by this deterministic pass (unsupported extraction shape, over budget, or no repository-wide match attempted) -- use symbol_search/code_search_zoekt for it as usual, and its scope/exhaustive envelope there governs what you may claim.',
  ];
  const body = result.entries.map((e) => renderEntry(e, Boolean(e.contextOmitted)));
  const footer = result.omittedSymbols.length > 0
    ? [`Symbols omitted from this appendix for size budget (not pre-resolved -- use symbol_search/code_search_zoekt manually if needed): ${result.omittedSymbols.join(', ')}`]
    : [];

  return [...header, '', ...body, ...footer].join('\n');
}

/**
 * Top-level orchestrator. Never throws -- see module doc comment for the fail-soft contract.
 */
export async function executeSymbolResolutionAppendix(
  options: SymbolResolutionAppendixOptions,
): Promise<SymbolResolutionAppendixResult> {
  const startTime = Date.now();
  const cfg = options.config || {};
  const maxSymbols = boundedPositive(cfg.maxSymbols, SYMBOL_APPENDIX_MAX_SYMBOLS);
  const maxCandidates = boundedPositive(cfg.maxCandidates, SYMBOL_APPENDIX_MAX_CANDIDATES);
  const contextLines = boundedPositive(cfg.contextLines, SYMBOL_APPENDIX_CONTEXT_LINES);
  const maxChars = boundedPositive(cfg.maxChars, SYMBOL_APPENDIX_MAX_CHARS);
  const indexDir = options.indexDir || cfg.indexDir;

  const receipt = (extra: Partial<SymbolResolutionAppendixReceipt> = {}): SymbolResolutionAppendixReceipt => ({
    indexDir,
    symbolsConsidered: 0,
    symbolsResolved: 0,
    symbolsAmbiguous: 0,
    symbolsNotFound: 0,
    queriesRun: 0,
    durationMs: Date.now() - startTime,
    totalChars: 0,
    ...extra,
  });

  try {
    if (cfg.enabled === false) {
      return { status: 'disabled', reason: 'disabled', entries: [], omittedSymbols: [], receipt: receipt() };
    }
    if (options.signal?.aborted) {
      return { status: 'unavailable', reason: 'cancelled', entries: [], omittedSymbols: [], receipt: receipt() };
    }
    if (!options.repoFileProvider) {
      return { status: 'unavailable', reason: 'no_repo_file_provider', entries: [], omittedSymbols: [], receipt: receipt() };
    }
    if (!zoektIndexAvailable(indexDir, options.fsImpl)) {
      return { status: 'unavailable', reason: 'zoekt_index_unavailable', entries: [], omittedSymbols: [], receipt: receipt() };
    }

    const referenced = await extractDiffReferencedSymbols(options.changedFiles || [], options.repoFileProvider, {
      signal: options.signal,
    });
    if (referenced.length === 0) {
      return { status: 'skipped', reason: 'no_candidate_symbols', entries: [], omittedSymbols: [], receipt: receipt() };
    }
    const budgeted = referenced.slice(0, maxSymbols);

    const zoektTool = createZoektSearchTool({
      identity: options.identity,
      indexDir,
      config: {
        enabled: true,
        maxCalls: budgeted.length,
        maxFindResults: Math.max(maxCandidates * 4, 32),
        maxResultBytes: 32 * 1024,
        timeoutMs: cfg.timeoutMs ?? 3000,
      },
      spawnImpl: options.spawnImpl,
      fsImpl: options.fsImpl,
    });

    const contentCache = new Map<string, Promise<string | null>>();
    const readCached = (path: string): Promise<string | null> => {
      if (!contentCache.has(path)) {
        // Promise.resolve(...) defends against a non-conformant provider that does not actually
        // return a promise -- readCached must never throw synchronously or reject unhandled.
        contentCache.set(path, Promise.resolve(options.repoFileProvider!.readFile(path)).catch(() => null));
      }
      return contentCache.get(path)!;
    };

    const entries: SymbolResolutionEntry[] = [];
    let queriesRun = 0;
    let resolvedCount = 0;
    let ambiguousCount = 0;
    let notFoundCount = 0;

    for (const ref of budgeted) {
      if (options.signal?.aborted) break;
      queriesRun += 1;
      let queryRes: any;
      try {
        queryRes = await zoektTool.call(ZOEKT_SEARCH_TOOL_NAME, { query: ref.symbol }, { signal: options.signal });
      } catch {
        continue; // Fail soft per symbol: skip it, do not fail the whole appendix.
      }
      if (queryRes.status !== 'ok') continue; // unavailable/cancelled/invalid: skip this symbol only

      const wordBoundary = new RegExp(`\\b${escapeRegExp(ref.symbol)}\\b`);
      const definitionMatches: RawSymbolMatch[] = (queryRes.matches || [])
        .filter((m: any) => m && typeof m.text === 'string' && wordBoundary.test(m.text) && isDefinitionLine(m.text, ref.symbol))
        .map((m: any) => ({ path: m.path, line: m.line, text: m.text }));

      const dedupedByLocation = Array.from(
        new Map(definitionMatches.map((m) => [`${m.path}:${m.line}`, m] as const)).values(),
      );

      const classification = classifySymbolCandidates(dedupedByLocation, maxCandidates);
      const exhaustive = queryRes.truncated !== true;
      if (classification.status === 'resolved') resolvedCount += 1;
      else if (classification.status === 'ambiguous') ambiguousCount += 1;
      else notFoundCount += 1;

      const candidates: SymbolResolutionCandidate[] = [];
      for (const c of classification.candidates) {
        const content = await readCached(c.path);
        const snippet = typeof content === 'string' ? sliceContext(content, c.line, contextLines) : undefined;
        candidates.push({ path: c.path, line: c.line, snippet });
      }

      entries.push({
        symbol: ref.symbol,
        sourcePath: ref.sourcePath,
        sourceLine: ref.sourceLine,
        status: classification.status,
        scope: SCOPE,
        exhaustive,
        candidates,
        candidatesTruncated: classification.candidatesTruncated,
        totalCandidateCount: classification.totalCandidateCount,
      });
    }

    const fit = fitEntriesToBudget(entries, maxChars);

    return {
      status: 'ok',
      entries: fit.entries,
      omittedSymbols: fit.omittedSymbols,
      receipt: receipt({
        symbolsConsidered: budgeted.length,
        symbolsResolved: resolvedCount,
        symbolsAmbiguous: ambiguousCount,
        symbolsNotFound: notFoundCount,
        queriesRun,
        totalChars: fit.totalChars,
      }),
    };
  } catch (error: any) {
    return {
      status: 'unavailable',
      reason: (error && error.message) || 'symbol_resolution_appendix_error',
      entries: [],
      omittedSymbols: [],
      receipt: receipt(),
    };
  }
}
