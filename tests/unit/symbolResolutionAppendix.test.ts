import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  SYMBOL_APPENDIX_MAX_CANDIDATES,
  SYMBOL_APPENDIX_CONTEXT_LINES,
  SYMBOL_APPENDIX_MAX_SYMBOLS,
  parseAddedLines,
  extractDiffReferencedSymbols,
  classifySymbolCandidates,
  fitEntriesToBudget,
  formatSymbolResolutionAppendixPrompt,
  executeSymbolResolutionAppendix,
  SymbolResolutionEntry,
  RawSymbolMatch,
} from '../../src/services/symbolResolutionAppendix';
import { ChangedFile } from '../../src/pipeline/hunkFilter';

// ---------------------------------------------------------------------------
// Shared zoekt spawn fixture -- mirrors tests/unit/zoektPreCheckService.test.ts's fake child
// pattern so this suite exercises the exact same zoektSearchTool.js transport.
// ---------------------------------------------------------------------------

function jsonlLine(filePath: string, matches: Array<{ line: number; text: string }>) {
  return JSON.stringify({
    FileName: filePath,
    LineMatches: matches.map((m) => ({
      LineNumber: m.line,
      FileName: false,
      Line: Buffer.from(m.text, 'utf8').toString('base64'),
    })),
  });
}

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit('exit', 137);
  });
  return child;
}

/** Routes each spawned zoekt query (by its query string, the last argv element) to a fixture. */
function makeRoutedSpawn(byQuery: Record<string, Array<{ path: string; line: number; text: string }>>) {
  return vi.fn().mockImplementation((_bin: string, args: string[]) => {
    const query = args[args.length - 1];
    const child = makeFakeChild();
    queueMicrotask(() => {
      const matches = byQuery[query] || [];
      for (const m of matches) {
        child.stdout.write(jsonlLine(m.path, [{ line: m.line, text: m.text }]) + '\n');
      }
      child.stdout.end();
      child.emit('close', 0);
      child.emit('exit', 0);
    });
    return child;
  });
}

const mockFs = {
  existsSync: vi.fn().mockReturnValue(true),
  readdirSync: vi.fn().mockReturnValue(['index-001.zoekt']),
};

describe('symbolResolutionAppendix.ts', () => {
  // =========================================================================
  // parseAddedLines
  // =========================================================================
  describe('parseAddedLines', () => {
    it('maps a single added line to its new-file line number', () => {
      const patch = ['@@ -2,1 +3,1 @@ export function update(conn, params) {', '+  replace_filters(conn, params);'].join('\n');
      const entries = parseAddedLines(patch);
      expect(entries).toEqual([{ line: 3, text: '  replace_filters(conn, params);' }]);
    });

    it('advances the new-line counter across context and deletion lines correctly', () => {
      const patch = [
        '@@ -10,4 +10,4 @@',
        ' unchanged one',
        '-deleted line',
        '+added line',
        ' unchanged two',
      ].join('\n');
      const entries = parseAddedLines(patch);
      // line 10 = "unchanged one" (context, consumes 10), deletion does not advance, "added line"
      // lands at 11.
      expect(entries).toEqual([{ line: 11, text: 'added line' }]);
    });

    it('returns an empty array for an empty or missing patch', () => {
      expect(parseAddedLines(undefined)).toEqual([]);
      expect(parseAddedLines('')).toEqual([]);
    });
  });

  // =========================================================================
  // extractDiffReferencedSymbols
  // =========================================================================
  describe('extractDiffReferencedSymbols', () => {
    it('extracts a call reference from REAL file content at the diff-added line (TypeScript)', async () => {
      const filler = Array.from({ length: 196 }, (_, i) => `// filler ${i}`);
      const contentLines = [
        `import { Conn } from './types';`,
        `export function update(conn: Conn, params: Record<string, unknown>) {`,
        `  replace_filters(conn, params);`,
        `  return conn;`,
        `}`,
        '',
        ...filler,
        `export function replace_filters(conn: Conn, params: Record<string, unknown>) {`,
        `  return params;`,
        `}`,
      ];
      const content = contentLines.join('\n');

      const changedFiles: ChangedFile[] = [{
        path: 'src/orders/controller.ts',
        patch: ['@@ -2,1 +3,1 @@ export function update(conn, params) {', '+  replace_filters(conn, params);'].join('\n'),
      }];

      const repoFileProvider = { readFile: vi.fn().mockResolvedValue(content) };

      const refs = await extractDiffReferencedSymbols(changedFiles, repoFileProvider);

      expect(refs).toEqual([{ symbol: 'replace_filters', sourcePath: 'src/orders/controller.ts', sourceLine: 3 }]);
      expect(repoFileProvider.readFile).toHaveBeenCalledWith('src/orders/controller.ts');
    });

    it('does NOT extract a reference from patch text alone -- a mangled patch fragment must not be fed to the parser', async () => {
      // This is the exact defect shape: the diff-only text is not valid syntax on its own (it is
      // one line ripped out of context). If the extractor fell back to parsing `file.patch` as a
      // full source file (the toolRuntime.ts:191 bug this appendix replaces), that is unreliable.
      // Here repoFileProvider deliberately returns null (file unreadable at head) so the AST track
      // is skipped for this file -- the regex fallback below is what actually finds the symbol.
      const changedFiles: ChangedFile[] = [{
        path: 'src/orders/controller.ts',
        patch: ['@@ -2,1 +3,1 @@ export function update(conn, params) {', '+  replace_filters(conn, params);'].join('\n'),
      }];
      const repoFileProvider = { readFile: vi.fn().mockResolvedValue(null) };

      const refs = await extractDiffReferencedSymbols(changedFiles, repoFileProvider);

      // Falls through to the bounded regex-on-added-lines fallback track, which still finds it
      // (coarser, but does not require a successful AST parse of unreadable content).
      expect(refs).toEqual([{ symbol: 'replace_filters', sourcePath: 'src/orders/controller.ts', sourceLine: 3 }]);
    });

    it('falls back to a bounded regex scan of added lines for an unsupported language (Elixir)', async () => {
      const changedFiles: ChangedFile[] = [{
        path: 'lib/orders/controller.ex',
        patch: ['@@ -10,1 +10,1 @@ def update(conn, params) do', '+  replace_filters(conn, params)'].join('\n'),
      }];
      const repoFileProvider = { readFile: vi.fn() };

      const refs = await extractDiffReferencedSymbols(changedFiles, repoFileProvider);

      expect(refs).toEqual([{ symbol: 'replace_filters', sourcePath: 'lib/orders/controller.ex', sourceLine: 10 }]);
      // Elixir is not an ASTParser-supported language -- readFile must not even be attempted.
      expect(repoFileProvider.readFile).not.toHaveBeenCalled();
    });

    it('filters out generic/denylisted call names and control-flow keywords', async () => {
      const changedFiles: ChangedFile[] = [{
        path: 'lib/orders/controller.ex',
        patch: [
          '@@ -1,1 +1,4 @@',
          '+  if (x) do',
          '+    items.map(fn)',
          '+    console.log(x)',
          '+  end',
        ].join('\n'),
      }];
      const refs = await extractDiffReferencedSymbols(changedFiles, { readFile: vi.fn() });
      expect(refs).toEqual([]);
    });

    it('dedupes repeated references to the same symbol, keeping the first occurrence', async () => {
      const changedFiles: ChangedFile[] = [{
        path: 'lib/orders/controller.ex',
        patch: [
          '@@ -1,1 +1,2 @@',
          '+  replace_filters(conn, params)',
          '+  replace_filters(conn, other_params)',
        ].join('\n'),
      }];
      const refs = await extractDiffReferencedSymbols(changedFiles, { readFile: vi.fn() });
      expect(refs).toHaveLength(1);
      expect(refs[0].sourceLine).toBe(1);
    });
  });

  // =========================================================================
  // classifySymbolCandidates -- the never-guess boundary (mutation target 1)
  // =========================================================================
  describe('classifySymbolCandidates', () => {
    const m = (path: string, line: number): RawSymbolMatch => ({ path, line, text: `def ${path}` });

    it('zero matches -> not_found', () => {
      const result = classifySymbolCandidates([], SYMBOL_APPENDIX_MAX_CANDIDATES);
      expect(result.status).toBe('not_found');
      expect(result.candidates).toEqual([]);
      expect(result.totalCandidateCount).toBe(0);
    });

    it('exactly one match -> resolved', () => {
      const result = classifySymbolCandidates([m('a.ts', 10)], SYMBOL_APPENDIX_MAX_CANDIDATES);
      expect(result.status).toBe('resolved');
      expect(result.candidates).toHaveLength(1);
      expect(result.totalCandidateCount).toBe(1);
    });

    it('more than one match -> ambiguous with EVERY candidate present, never narrowed to one', () => {
      const matches = [m('a.ts', 10), m('b.ts', 20), m('c.ts', 30)];
      const result = classifySymbolCandidates(matches, SYMBOL_APPENDIX_MAX_CANDIDATES);
      expect(result.status).toBe('ambiguous');
      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.map((c) => c.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
      expect(result.candidatesTruncated).toBe(false);
      expect(result.totalCandidateCount).toBe(3);
    });

    it('caps the shown candidate list at K but reports the true total and marks it truncated', () => {
      const matches = Array.from({ length: 11 }, (_, i) => m(`f${i}.ts`, i));
      const result = classifySymbolCandidates(matches, SYMBOL_APPENDIX_MAX_CANDIDATES);
      expect(result.status).toBe('ambiguous');
      expect(result.candidates).toHaveLength(SYMBOL_APPENDIX_MAX_CANDIDATES);
      expect(result.candidatesTruncated).toBe(true);
      expect(result.totalCandidateCount).toBe(11);
    });
  });

  // =========================================================================
  // fitEntriesToBudget -- the never-truncate-silently boundary (mutation target 2)
  // =========================================================================
  describe('fitEntriesToBudget', () => {
    function entry(overrides: Partial<SymbolResolutionEntry> = {}): SymbolResolutionEntry {
      return {
        symbol: 'replace_filters',
        sourcePath: 'src/orders/controller.ts',
        sourceLine: 3,
        status: 'resolved',
        scope: 'full-repository-zoekt',
        exhaustive: true,
        candidates: [{ path: 'src/orders/controller.ts', line: 200, snippet: 'line '.repeat(200) }],
        candidatesTruncated: false,
        totalCandidateCount: 1,
        ...overrides,
      };
    }

    it('includes a full entry (with context) when it comfortably fits the budget', () => {
      const fit = fitEntriesToBudget([entry()], 100_000);
      expect(fit.entries).toHaveLength(1);
      expect(fit.entries[0].contextOmitted).toBe(false);
      expect(fit.omittedSymbols).toEqual([]);
      expect(fit.totalChars).toBeLessThanOrEqual(100_000);
    });

    it('degrades to a snippet-less entry (never a partial one) when only the full form overflows', () => {
      const big = entry({ candidates: [{ path: 'a.ts', line: 1, snippet: 'x'.repeat(5000) }] });
      // A budget well above a plain "no-snippet" entry's rendering (a handful of short lines,
      // comfortably under 1000 chars) but far below the ~5000-char full (snippet-bearing) one.
      const fit = fitEntriesToBudget([big], 1000);

      expect(fit.omittedSymbols).toEqual([]);
      expect(fit.entries).toHaveLength(1);
      expect(fit.entries[0].contextOmitted).toBe(true);
      expect(fit.totalChars).toBeLessThanOrEqual(1000);
      // The included block must be the exact degraded rendering, never a truncated slice of the
      // full (snippet-bearing) rendering -- it must not contain any fragment of the 5000-char snippet.
      expect(fit.entries[0].candidates[0].snippet).toBeUndefined();
    });

    it('omits a symbol entirely -- never emits a truncated fragment -- when even the degraded form does not fit', () => {
      const tiny = entry({ symbol: 'wayTooBig', candidates: [{ path: 'a.ts', line: 1, snippet: 'x'.repeat(500) }] });
      const fit = fitEntriesToBudget([tiny], 10);

      expect(fit.entries).toEqual([]);
      expect(fit.omittedSymbols).toEqual(['wayTooBig']);
      expect(fit.totalChars).toBe(0);
    });

    it('never lets total rendered characters exceed the ceiling across multiple entries', () => {
      const entries = Array.from({ length: 5 }, (_, i) => entry({
        symbol: `sym${i}`,
        candidates: [{ path: `f${i}.ts`, line: i, snippet: 'y'.repeat(2000) }],
      }));
      const fit = fitEntriesToBudget(entries, 4000);
      expect(fit.totalChars).toBeLessThanOrEqual(4000);
      // At least one entry must have been degraded or omitted -- 5 entries at ~2000+ chars each
      // cannot all fit in full inside a 4000-char ceiling.
      const anyDegradedOrOmitted = fit.entries.some((e) => e.contextOmitted) || fit.omittedSymbols.length > 0;
      expect(anyDegradedOrOmitted).toBe(true);
    });
  });

  // =========================================================================
  // formatSymbolResolutionAppendixPrompt
  // =========================================================================
  describe('formatSymbolResolutionAppendixPrompt', () => {
    it('is fail-soft: empty string for a non-ok or empty result', () => {
      expect(formatSymbolResolutionAppendixPrompt(undefined)).toBe('');
      expect(formatSymbolResolutionAppendixPrompt({ status: 'unavailable', reason: 'x', entries: [], omittedSymbols: [], receipt: {} as any })).toBe('');
      expect(formatSymbolResolutionAppendixPrompt({ status: 'ok', entries: [], omittedSymbols: [], receipt: {} as any })).toBe('');
    });

    it('renders the scope/exhaustive envelope using the vocabulary already established in toolRuntime.ts', () => {
      const resolved: SymbolResolutionEntry = {
        symbol: 'replace_filters',
        sourcePath: 'src/orders/controller.ts',
        sourceLine: 3,
        status: 'resolved',
        scope: 'full-repository-zoekt',
        exhaustive: true,
        candidates: [{ path: 'src/orders/controller.ts', line: 200, snippet: '    > 200| export function replace_filters() {' }],
        candidatesTruncated: false,
        totalCandidateCount: 1,
      };
      const text = formatSymbolResolutionAppendixPrompt({ status: 'ok', entries: [resolved], omittedSymbols: [], receipt: {} as any });
      expect(text).toContain('[SCOPE: full-repository-zoekt | EXHAUSTIVE: true]');
      expect(text).toContain('[RESOLVED]');
      expect(text).toContain('src/orders/controller.ts:200');
    });

    it('never presents a not_found symbol as confirmed-absent-from-the-repository when the search was not exhaustive', () => {
      const notFound: SymbolResolutionEntry = {
        symbol: 'ghost_fn',
        sourcePath: 'a.ts',
        sourceLine: 1,
        status: 'not_found',
        scope: 'full-repository-zoekt',
        exhaustive: false,
        candidates: [],
        candidatesTruncated: false,
        totalCandidateCount: 0,
      };
      const text = formatSymbolResolutionAppendixPrompt({ status: 'ok', entries: [notFound], omittedSymbols: [], receipt: {} as any });
      expect(text).toContain('inconclusive, not as confirmed-absent');
      expect(text).not.toContain('exhaustive full-repository index search --');
    });

    it('lists every ambiguous candidate and instructs the model not to assume one', () => {
      const ambiguous: SymbolResolutionEntry = {
        symbol: 'processPayment',
        sourcePath: 'a.ts',
        sourceLine: 1,
        status: 'ambiguous',
        scope: 'full-repository-zoekt',
        exhaustive: true,
        candidates: [{ path: 'x.ts', line: 5 }, { path: 'y.ts', line: 9 }],
        candidatesTruncated: false,
        totalCandidateCount: 2,
      };
      const text = formatSymbolResolutionAppendixPrompt({ status: 'ok', entries: [ambiguous], omittedSymbols: [], receipt: {} as any });
      expect(text).toContain('x.ts:5');
      expect(text).toContain('y.ts:9');
      expect(text).toContain('Do not assume any one of them');
    });

    it('lists omitted symbols in a footer so the appendix never silently looks complete', () => {
      const resolved: SymbolResolutionEntry = {
        symbol: 'a', sourcePath: 'a.ts', sourceLine: 1, status: 'resolved', scope: 'full-repository-zoekt',
        exhaustive: true, candidates: [{ path: 'a.ts', line: 1 }], candidatesTruncated: false, totalCandidateCount: 1,
      };
      const text = formatSymbolResolutionAppendixPrompt({
        status: 'ok', entries: [resolved], omittedSymbols: ['droppedSymbol'], receipt: {} as any,
      });
      expect(text).toContain('droppedSymbol');
      expect(text).toContain('omitted from this appendix for size budget');
    });
  });

  // =========================================================================
  // executeSymbolResolutionAppendix -- end to end, and fail-soft contract
  // =========================================================================
  describe('executeSymbolResolutionAppendix', () => {
    it('REGRESSION (replace_filters shape): a symbol defined outside the diff resolves to a real file:line', async () => {
      const filler = Array.from({ length: 196 }, (_, i) => `// filler ${i}`);
      const contentLines = [
        `import { Conn } from './types';`,
        `export function update(conn: Conn, params: Record<string, unknown>) {`,
        `  replace_filters(conn, params);`,
        `  return conn;`,
        `}`,
        '',
        ...filler,
        `export function replace_filters(conn: Conn, params: Record<string, unknown>) {`,
        `  return params;`,
        `}`,
      ];
      const content = contentLines.join('\n');
      const definitionLineNumber = contentLines.findIndex((l) => l.startsWith('export function replace_filters')) + 1;

      const changedFiles: ChangedFile[] = [{
        path: 'src/orders/controller.ts',
        patch: ['@@ -2,1 +3,1 @@ export function update(conn, params) {', '+  replace_filters(conn, params);'].join('\n'),
      }];

      const repoFileProvider = { readFile: vi.fn().mockResolvedValue(content) };
      const spawnImpl = makeRoutedSpawn({
        replace_filters: [{
          path: 'src/orders/controller.ts',
          line: definitionLineNumber,
          text: `export function replace_filters(conn: Conn, params: Record<string, unknown>) {`,
        }],
      });

      const result = await executeSymbolResolutionAppendix({
        changedFiles,
        repoFileProvider,
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl,
      });

      expect(result.status).toBe('ok');
      expect(result.entries).toHaveLength(1);
      const [foundEntry] = result.entries;
      expect(foundEntry.symbol).toBe('replace_filters');
      expect(foundEntry.status).toBe('resolved');
      expect(foundEntry.scope).toBe('full-repository-zoekt');
      expect(foundEntry.exhaustive).toBe(true);
      expect(foundEntry.candidates).toHaveLength(1);
      expect(foundEntry.candidates[0].path).toBe('src/orders/controller.ts');
      expect(foundEntry.candidates[0].line).toBe(definitionLineNumber);
      expect(foundEntry.candidates[0].snippet).toContain('export function replace_filters');

      const prompt = formatSymbolResolutionAppendixPrompt(result);
      expect(prompt).toContain(`[RESOLVED] Symbol 'replace_filters'`);
      expect(prompt).toContain(`src/orders/controller.ts:${definitionLineNumber}`);
    });

    it('reports ambiguous with every candidate and not_found with the exhaustive claim, in the same pass', async () => {
      const changedFiles: ChangedFile[] = [{
        path: 'lib/orders/controller.ex',
        patch: [
          '@@ -1,1 +1,3 @@',
          '+  process_payment(conn, params)',
          '+  ghost_function(conn)',
        ].join('\n'),
      }];

      const spawnImpl = makeRoutedSpawn({
        process_payment: [
          { path: 'lib/payments/a.ex', line: 5, text: 'def process_payment(conn, params) do' },
          { path: 'lib/payments/b.ex', line: 12, text: 'def process_payment(conn, extra) do' },
        ],
        ghost_function: [],
      });

      const result = await executeSymbolResolutionAppendix({
        changedFiles,
        repoFileProvider: { readFile: vi.fn().mockResolvedValue(null) },
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl,
      });

      expect(result.status).toBe('ok');
      const byName = Object.fromEntries(result.entries.map((e) => [e.symbol, e]));
      expect(byName.process_payment.status).toBe('ambiguous');
      expect(byName.process_payment.candidates).toHaveLength(2);
      expect(byName.ghost_function.status).toBe('not_found');
      expect(byName.ghost_function.exhaustive).toBe(true);

      const prompt = formatSymbolResolutionAppendixPrompt(result);
      expect(prompt).toContain('[AMBIGUOUS]');
      expect(prompt).toContain('lib/payments/a.ex:5');
      expect(prompt).toContain('lib/payments/b.ex:12');
      expect(prompt).toContain('[NOT_FOUND]');
      expect(prompt).toContain('exhaustive full-repository index search');
    });

    // -----------------------------------------------------------------------
    // Fail-soft contract -- mirrors ../mcp/zoektGrounding.js: never throws.
    // -----------------------------------------------------------------------

    it('is unavailable (not thrown) when no repoFileProvider is supplied', async () => {
      const result = await executeSymbolResolutionAppendix({
        changedFiles: [{ path: 'a.ts', patch: '@@ -1,1 +1,1 @@\n+foo();' }],
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
      });
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('no_repo_file_provider');
      expect(result.entries).toEqual([]);
    });

    it('is unavailable (not thrown) when the zoekt index is absent', async () => {
      const result = await executeSymbolResolutionAppendix({
        changedFiles: [{ path: 'a.ts', patch: '@@ -1,1 +1,1 @@\n+foo();' }],
        repoFileProvider: { readFile: vi.fn() },
        indexDir: undefined,
        fsImpl: { existsSync: vi.fn().mockReturnValue(false), readdirSync: vi.fn() },
      });
      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('zoekt_index_unavailable');
    });

    it('is disabled (not thrown) when config.enabled is false', async () => {
      const result = await executeSymbolResolutionAppendix({
        changedFiles: [],
        repoFileProvider: { readFile: vi.fn() },
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        config: { enabled: false },
      });
      expect(result.status).toBe('disabled');
    });

    it('is skipped (not thrown) when no eligible symbol is referenced', async () => {
      const result = await executeSymbolResolutionAppendix({
        changedFiles: [{ path: 'README.md', patch: '@@ -1,1 +1,1 @@\n+hello' }],
        repoFileProvider: { readFile: vi.fn() },
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
      });
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no_candidate_symbols');
    });

    it('never throws even when repoFileProvider.readFile rejects unexpectedly', async () => {
      const changedFiles: ChangedFile[] = [{
        path: 'src/orders/controller.ts',
        patch: ['@@ -2,1 +3,1 @@', '+  replace_filters(conn, params);'].join('\n'),
      }];
      const repoFileProvider = { readFile: vi.fn().mockRejectedValue(new Error('boom')) };

      await expect(executeSymbolResolutionAppendix({
        changedFiles,
        repoFileProvider,
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl: makeRoutedSpawn({}),
      })).resolves.toMatchObject({ status: expect.any(String) });
    });

    it('caps distinct symbols per review at SYMBOL_APPENDIX_MAX_SYMBOLS', async () => {
      const lines = Array.from({ length: SYMBOL_APPENDIX_MAX_SYMBOLS + 5 }, (_, i) => `+  fn${i}(x)`);
      const changedFiles: ChangedFile[] = [{
        path: 'lib/a.ex',
        patch: ['@@ -1,1 +1,' + lines.length + ' @@', ...lines].join('\n'),
      }];
      const spawnImpl = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => { child.stdout.end(); child.emit('close', 0); child.emit('exit', 0); });
        return child;
      });

      const result = await executeSymbolResolutionAppendix({
        changedFiles,
        repoFileProvider: { readFile: vi.fn() },
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl,
      });

      expect(result.status).toBe('ok');
      expect(result.receipt.symbolsConsidered).toBe(SYMBOL_APPENDIX_MAX_SYMBOLS);
      expect(spawnImpl).toHaveBeenCalledTimes(SYMBOL_APPENDIX_MAX_SYMBOLS);
    });
  });
});
