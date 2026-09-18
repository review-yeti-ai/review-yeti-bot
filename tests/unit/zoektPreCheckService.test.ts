import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  extractModifiedSymbols,
  executeZoektPreCheck,
  formatZoektPreCheckPrompt,
  isSameFile,
  isDefinitionLine,
  CandidateSymbol,
  ZoektPreCheckResult,
} from '../../src/services/zoektPreCheckService';
import { ChangedFile } from '../../src/pipeline/hunkFilter';

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

describe('zoektPreCheckService.test.ts — Milestone 3 Unit Tests', () => {

  // =========================================================================
  // SUITE 1: SYMBOL EXTRACTION FROM DIFF HUNKS
  // =========================================================================
  describe('Suite 1: extractModifiedSymbols', () => {
    it('1.1: extracts enclosing TypeScript function and interface from modified hunks', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/services/orderService.ts',
          patch: `@@ -10,6 +10,8 @@ export interface OrderConfig {\n+  timeoutMs: number;\n }\n@@ -25,7 +27,9 @@ export async function processOrder(orderId: string): Promise<void> {\n+  const tax = calculateTax(orderId);\n   return;\n }`,
          content: `export interface OrderConfig {\n  id: string;\n  timeoutMs: number;\n}\n\nexport async function processOrder(orderId: string): Promise<void> {\n  const tax = calculateTax(orderId);\n  return;\n}\n`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('processOrder');
      expect(names).toContain('OrderConfig');
      const processOrderSym = symbols.find((s) => s.name === 'processOrder');
      expect(processOrderSym?.isModifiedDefinition).toBe(true);
    });

    it('1.2: extracts referenced function call on added (+) lines', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/app.ts',
          patch: `@@ -15,3 +15,5 @@ function startApp() {\n+  initializeDatabasePool();\n+  validateLicenseKey(key);\n }`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('initializeDatabasePool');
      expect(names).toContain('validateLicenseKey');
      const callSym = symbols.find((s) => s.name === 'initializeDatabasePool');
      expect(callSym?.isModifiedDefinition).toBe(false);
    });

    it('1.3: extracts Go func definitions and receiver methods from diff hunks', async () => {
      const files: ChangedFile[] = [
        {
          path: 'pkg/orders/processor.go',
          patch: `@@ -40,5 +40,8 @@ func (p *Processor) HandleOrder(ctx context.Context, orderID string) error {\n+  if err := p.validateOrder(orderID); err != nil {\n+    return err\n+  }\n   return nil\n }`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('HandleOrder');
      expect(names).toContain('validateOrder');
    });

    it('1.4: extracts Elixir defmodule and def functions from diff hunks', async () => {
      const files: ChangedFile[] = [
        {
          path: 'lib/orders/tax.ex',
          patch: `@@ -1,5 +1,7 @@ defmodule Orders.Tax do\n+  def calculate_vat(subtotal, rate) do\n+    Decimal.mult(subtotal, rate)\n+  end\n end`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('Tax');
      expect(names).toContain('calculate_vat');
    });

    it('1.5: extracts Python class and def functions from diff hunks', async () => {
      const files: ChangedFile[] = [
        {
          path: 'services/worker.py',
          patch: `@@ -1,5 +1,8 @@ class PaymentWorker:\n+    async def process_payment(self, amount):\n+        return await self.gateway.charge(amount)\n`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('PaymentWorker');
      expect(names).toContain('process_payment');
    });

    it('1.6: filters out language keywords and noisy tokens (< 3 characters)', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/util.ts',
          patch: `@@ -1,4 +1,6 @@\n+  if (x > 0) {\n+    const id = 5;\n+    return true;\n+  }`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).not.toContain('if');
      expect(names).not.toContain('const');
      expect(names).not.toContain('return');
      expect(names).not.toContain('true');
      expect(names).not.toContain('id'); // length 2
    });
  });

  // =========================================================================
  // SUITE 2: QUERY EXECUTION & MATCH DISCOVERY
  // =========================================================================
  describe('Suite 2: executeZoektPreCheck — Query Execution & Discovery', () => {
    let mockFs: any;
    let mockSpawn: any;

    beforeEach(() => {
      mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['index-001.zoekt']),
        statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
      };
    });

    it('2.1: categorizes external callers under callSites and excludes same-file matches', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        {
          name: 'calculateTax',
          sourcePath: 'src/billing/tax.ts',
          line: 10,
          kind: 'function',
          role: 'enclosing_function',
          isModifiedDefinition: true,
          score: 100,
        },
      ];

      mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.write(jsonlLine('src/billing/tax.ts', [{ line: 10, text: 'export function calculateTax(val: number) {' }]) + '\n');
          child.stdout.write(jsonlLine('src/orders/checkout.ts', [{ line: 88, text: 'const tax = calculateTax(subtotal);' }]) + '\n');
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols,
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.symbols).toHaveLength(1);
      const sym = result.symbols[0];
      expect(sym.symbol).toBe('calculateTax');
      expect(sym.callSites).toHaveLength(1);
      expect(sym.callSites[0].path).toBe('src/orders/checkout.ts');
      expect(sym.callSites[0].line).toBe(88);
    });

    it('2.2: categorizes external definition under definitions for referenced symbols', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        {
          name: 'CustomerRepository',
          sourcePath: 'src/services/customerService.ts',
          line: 5,
          kind: 'call',
          role: 'call',
          isModifiedDefinition: false,
          score: 50,
        },
      ];

      mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.write(jsonlLine('src/repositories/customerRepo.ts', [{ line: 15, text: 'export class CustomerRepository implements IRepo {' }]) + '\n');
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols,
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.symbols[0].definitions).toHaveLength(1);
      expect(result.symbols[0].definitions[0].path).toBe('src/repositories/customerRepo.ts');
      expect(result.symbols[0].definitions[0].line).toBe(15);
    });

    it('2.3: enforces word boundaries in post-processing', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        {
          name: 'tax',
          sourcePath: 'src/tax.ts',
          line: 1,
          kind: 'function',
          role: 'enclosing_function',
          isModifiedDefinition: true,
          score: 100,
        },
      ];

      mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.write(jsonlLine('src/parser/syntax.ts', [{ line: 5, text: 'const syntaxTree = parse();' }]) + '\n');
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols,
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.symbols).toHaveLength(0); // Noise filtered out
    });
  });

  // =========================================================================
  // SUITE 3: BUDGET BOUNDING & MAX_SYMBOLS CAPPING
  // =========================================================================
  describe('Suite 3: Budget Bounding & max_symbols', () => {
    it('3.1: caps candidate symbol execution to configured max_symbols (default 25)', async () => {
      // Generate 35 candidate symbols
      const candidateSymbols: CandidateSymbol[] = Array.from({ length: 35 }, (_, idx) => ({
        name: `func_${idx}`,
        sourcePath: `src/mod_${idx}.ts`,
        line: 10,
        kind: 'function',
        role: 'enclosing_function' as const,
        isModifiedDefinition: true,
        score: 100 - idx,
      }));

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      let spawnCallCount = 0;
      const mockSpawn = vi.fn().mockImplementation(() => {
        spawnCallCount++;
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols,
        config: { enabled: true, max_symbols: 10 },
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.scannedSymbolsCount).toBe(10);
      expect(spawnCallCount).toBe(10);
      expect(result.receipt.truncated).toBe(true);
    });

    it('3.2: prioritizes modified definitions ahead of references when capping', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        { name: 'ref1', sourcePath: 'a.ts', line: 1, kind: 'call', role: 'call', isModifiedDefinition: false, score: 50 },
        { name: 'def1', sourcePath: 'b.ts', line: 1, kind: 'function', role: 'enclosing_function', isModifiedDefinition: true, score: 100 },
        { name: 'ref2', sourcePath: 'c.ts', line: 1, kind: 'call', role: 'call', isModifiedDefinition: false, score: 50 },
      ];

      const queriesExecuted: string[] = [];
      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };
      const mockSpawn = vi.fn().mockImplementation((_bin, args) => {
        const q = args[args.length - 1];
        queriesExecuted.push(q);
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      await executeZoektPreCheck({
        candidateSymbols,
        config: { enabled: true, max_symbols: 1 },
        indexDir: '/tmp/zoekt-index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(queriesExecuted).toEqual(['def1']); // Def prioritized
    });
  });

  // =========================================================================
  // SUITE 4: FAIL-SOFT MECHANICS
  // =========================================================================
  describe('Suite 4: Fail-Soft Mechanics', () => {
    it('4.1: returns status: disabled when pre_checks.zoekt.enabled is false', async () => {
      const mockSpawn = vi.fn();
      const result = await executeZoektPreCheck({
        config: { enabled: false, max_symbols: 25 },
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('disabled');
      expect(result.reason).toBe('disabled');
      expect(result.symbols).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('4.2: returns status: unavailable when indexDir is missing or contains no .zoekt shard', async () => {
      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['some-unrelated-file.txt']),
      };

      const result = await executeZoektPreCheck({
        indexDir: '/tmp/empty-index',
        fsImpl: mockFs,
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('zoekt_index_unavailable');
    });

    it('4.3: returns status: unavailable when Zoekt binary is missing (ENOENT)', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        { name: 'foo', sourcePath: 'a.ts', line: 1, role: 'enclosing_function', isModifiedDefinition: true, score: 100 },
      ];

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      const mockSpawn = vi.fn().mockImplementation(() => {
        const err: any = new Error('spawn zoekt ENOENT');
        err.code = 'ENOENT';
        throw err;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols,
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('zoekt_binary_missing');
    });

    it('4.4: returns status: unavailable when queries time out', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        { name: 'timeoutSymbol', sourcePath: 'a.ts', line: 1, role: 'enclosing_function', isModifiedDefinition: true, score: 100 },
      ];

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      // Mock search tool timeout by taking longer than timeoutMs
      const mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols,
        config: { enabled: true, max_symbols: 25, timeoutMs: 10 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('request_timeout');
    });

    it('4.5: returns status: unavailable when abort signal is triggered', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await executeZoektPreCheck({
        signal: controller.signal,
        indexDir: '/tmp/index',
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('cancelled');
    });

    it('4.6: returns status: skipped when candidate symbols array is empty', async () => {
      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      const result = await executeZoektPreCheck({
        candidateSymbols: [],
        indexDir: '/tmp/index',
        fsImpl: mockFs,
      });

      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no_candidate_symbols');
    });
  });

  // =========================================================================
  // SUITE 5: PROMPT FORMATTING HELPER
  // =========================================================================
  describe('Suite 5: formatZoektPreCheckPrompt', () => {
    it('5.1: formats ok result with symbols, definitions, and call sites', () => {
      const result: ZoektPreCheckResult = {
        status: 'ok',
        scannedSymbolsCount: 2,
        matchedSymbolsCount: 2,
        symbols: [
          {
            symbol: 'calculateTax',
            kind: 'function',
            sourcePath: 'src/tax.ts',
            isModifiedDefinition: true,
            definitions: [],
            callSites: [
              { path: 'src/orders/checkout.ts', line: 42, text: 'const tax = calculateTax(subtotal);' },
            ],
          },
          {
            symbol: 'CustomerRepo',
            kind: 'class',
            sourcePath: 'src/tax.ts',
            isModifiedDefinition: false,
            definitions: [
              { path: 'src/repos/customer.ts', line: 10, text: 'export class CustomerRepo' },
            ],
            callSites: [],
          },
        ],
        receipt: { totalQueries: 2, durationMs: 15 },
      };

      const prompt = formatZoektPreCheckPrompt(result);

      expect(prompt).toContain('=== PRE-CHECK SYMBOL & REPOSITORY CONTEXT (ZOEKT) ===');
      expect(prompt).toContain("Symbol 'calculateTax' (function) (defined in src/tax.ts):");
      expect(prompt).toContain('External call sites (1 found across repository):');
      expect(prompt).toContain('- src/orders/checkout.ts:42: const tax = calculateTax(subtotal);');
      expect(prompt).toContain("Symbol 'CustomerRepo' (class) (referenced in src/tax.ts):");
      expect(prompt).toContain('Canonical definition:');
      expect(prompt).toContain('- src/repos/customer.ts:10: export class CustomerRepo');
    });

    it('5.2: bounds displayed call sites to 5 with overflow notice', () => {
      const callSites = Array.from({ length: 8 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        line: 10 + i,
        text: `calculateTax(val_${i})`,
      }));

      const result: ZoektPreCheckResult = {
        status: 'ok',
        scannedSymbolsCount: 1,
        matchedSymbolsCount: 1,
        symbols: [
          {
            symbol: 'calculateTax',
            sourcePath: 'src/tax.ts',
            isModifiedDefinition: true,
            definitions: [],
            callSites,
          },
        ],
        receipt: { totalQueries: 1, durationMs: 10 },
      };

      const prompt = formatZoektPreCheckPrompt(result);

      expect(prompt).toContain('External call sites (8 found across repository):');
      expect(prompt).toContain('src/file_4.ts:14');
      expect(prompt).not.toContain('src/file_5.ts:15');
      expect(prompt).toContain('... (+3 more external call sites)');
    });

    it('5.3: formats unavailable status with clear fallback message', () => {
      const result: ZoektPreCheckResult = {
        status: 'unavailable',
        reason: 'zoekt_index_unavailable',
        scannedSymbolsCount: 0,
        matchedSymbolsCount: 0,
        symbols: [],
        receipt: { totalQueries: 0, durationMs: 0 },
      };

      const prompt = formatZoektPreCheckPrompt(result);

      expect(prompt).toContain('[Status: unavailable | Reason: zoekt_index_unavailable]');
      expect(prompt).toContain('Use on-demand exploration tools');
    });

    it('5.4: formats disabled status cleanly', () => {
      const result: ZoektPreCheckResult = {
        status: 'disabled',
        reason: 'disabled',
        scannedSymbolsCount: 0,
        matchedSymbolsCount: 0,
        symbols: [],
        receipt: { totalQueries: 0, durationMs: 0 },
      };

      const prompt = formatZoektPreCheckPrompt(result);

      expect(prompt).toContain('[Status: disabled]');
      expect(prompt).toContain('disabled in repository configuration');
    });

    it('5.5: formats skipped status cleanly', () => {
      const result: ZoektPreCheckResult = {
        status: 'skipped',
        reason: 'no_candidate_symbols',
        scannedSymbolsCount: 0,
        matchedSymbolsCount: 0,
        symbols: [],
        receipt: { totalQueries: 0, durationMs: 0 },
      };

      const prompt = formatZoektPreCheckPrompt(result);

      expect(prompt).toContain('[Status: skipped | Reason: no_candidate_symbols]');
      expect(prompt).toContain('No modified symbols eligible for external search');
    });
  });

  describe('inferred definitions are not presented as canonical', () => {
    // When no line matches the definition heuristic, the service adopts the first non-import
    // match as a stand-in. That is a guess. Rendering it under "Canonical definition:" tells a
    // reviewer model the location is established fact, and a model that believes a wrong location
    // produces exactly the confident, specific, false blocking finding this pipeline exists to
    // avoid -- the same failure shape as reporting a symbol missing because the search was only
    // patch-scoped.
    const symbol = (definitionsAreInferred: boolean) => ({
      status: 'ok' as const,
      symbols: [{
        symbol: 'replace_filters',
        kind: 'function',
        sourcePath: 'lib/catalog.ex',
        isModifiedDefinition: false,
        definitions: [{ path: 'lib/other.ex', line: 41, text: 'defp replace_filters(x)' }],
        definitionsAreInferred,
        callSites: [],
      }],
      receipt: { totalQueries: 1 } as any,
    });

    it('labels an inferred definition UNCONFIRMED and tells the model to verify it', () => {
      const prompt = formatZoektPreCheckPrompt(symbol(true) as any);
      expect(prompt).toContain('UNCONFIRMED');
      expect(prompt).toMatch(/may be the wrong location/i);
      expect(prompt).not.toContain('Canonical definition:');
    });

    it('still calls a matched definition canonical', () => {
      const prompt = formatZoektPreCheckPrompt(symbol(false) as any);
      expect(prompt).toContain('Canonical definition:');
      expect(prompt).not.toContain('UNCONFIRMED');
    });
  });

});
