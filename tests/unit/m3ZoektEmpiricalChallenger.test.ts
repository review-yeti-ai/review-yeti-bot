import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  extractModifiedSymbols,
  executeZoektPreCheck,
  formatZoektPreCheckPrompt,
  isSameFile,
  isDefinitionLine,
  isImportLine,
  escapeRegExp,
  normalizeRepoPath,
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

describe('m3ZoektEmpiricalChallenger.test.ts — Milestone 3 Adversarial Challenge Suite', () => {

  // =========================================================================
  // CHALLENGE AREA 1: SYMBOL EXTRACTION STRESS TESTING
  // =========================================================================
  describe('Challenge Area 1: Symbol Extraction Stress', () => {
    it('1.1: handles completely empty diff hunks, whitespace-only lines, and no-op additions', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/empty.ts',
          patch: `@@ -1,3 +1,6 @@\n+   \n+\t\t\n+\r\n`,
          content: `\n\n\n`,
        },
        {
          path: 'src/nodiff.ts',
          patch: '',
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      expect(symbols).toEqual([]);
    });

    it('1.2: ignores single-line comments and single-line block comments without mistaking them as calls', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/comments.ts',
          patch: `@@ -10,4 +10,8 @@\n+  // calculateTax(orderId)\n+  # python_style_comment(value)\n+  /* ignoredBlockCall(param) */\n+  actualFunctionCall(orderId);\n`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('actualFunctionCall');
      expect(names).not.toContain('calculateTax');
      expect(names).not.toContain('python_style_comment');
      expect(names).not.toContain('ignoredBlockCall');
    });

    it('1.3: handles severe syntax errors in TypeScript file content gracefully via AST fallback', async () => {
      const brokenContent = `
        export class BrokenService {
          public doSomething( {
            const === ;;; /// syntax disaster
            this is not valid typescript
      `;

      const files: ChangedFile[] = [
        {
          path: 'src/broken.ts',
          patch: `@@ -1,5 +1,7 @@\n+export function recoveredHelper(id: string) {\n+  return id;\n+}`,
          content: brokenContent,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      expect(Array.isArray(symbols)).toBe(true);
      const names = symbols.map((s) => s.name);
      expect(names).toContain('recoveredHelper');
    });

    it('1.4: handles severe syntax errors in Python file content gracefully', async () => {
      const brokenPython = `
        def func_with_syntax_error(
            x = [1, 2, 3
            def nested(
      `;

      const files: ChangedFile[] = [
        {
          path: 'services/broken.py',
          patch: `@@ -1,5 +1,8 @@\n+def payment_gateway_handler(transaction):\n+    return transaction.process()\n`,
          content: brokenPython,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      expect(Array.isArray(symbols)).toBe(true);
      const names = symbols.map((s) => s.name);
      expect(names).toContain('payment_gateway_handler');
    });

    it('1.5: extracts symbols from complex multi-line definitions and generics', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/genericService.ts',
          patch: `@@ -20,6 +20,11 @@\n+export async function executeComplexTransaction<\n+  TRequest extends BaseRequest,\n+  TResponse extends BaseResponse\n+>(req: TRequest, options?: TransactionOptions): Promise<TResponse> {\n+  return dispatchTransaction(req);\n+}`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      expect(names).toContain('dispatchTransaction');
      expect(names).toContain('TransactionOptions');
      expect(names).toContain('BaseRequest');
    });

    it('1.6: empirical boundary test: Unicode identifiers and non-ASCII characters are rejected by regex', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/unicode.ts',
          patch: `@@ -1,3 +1,5 @@\n+function calculateTäx(montant: number) {\n+  valider_données(montant);\n+  return montant;\n+}`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      // Empirical finding: isValidSymbolName uses ASCII-only regex /^[a-zA-Z_][a-zA-Z0-9_]*[?!]?$/
      // Non-ASCII identifiers like 'calculateTäx' or 'valider_données' are excluded from candidate symbols
      expect(names).not.toContain('calculateTäx');
      expect(names).not.toContain('valider_données');
    });

    it('1.7: validates token boundaries: allows Elixir ?/!, filters out keywords, digits, and short tokens', async () => {
      const files: ChangedFile[] = [
        {
          path: 'lib/verifier.ex',
          patch: `@@ -10,4 +10,7 @@ defmodule Verifier do\n+  def valid?(opts) do\n+    clean_up!(opts)\n+    ok\n+  end\n`,
        },
        {
          path: 'src/tokens.ts',
          patch: `@@ -1,4 +1,7 @@\n+  const ab = 1;\n+  const ___ = 2;\n+  const 1234 = 4;\n+  function validSymbolName() {}\n`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      // Elixir predicates/bangs allowed
      expect(names).toContain('valid?');
      expect(names).toContain('clean_up!');

      // Keyword 'ok' blocked
      expect(names).not.toContain('ok');

      // Short token 'ab' (length 2) blocked
      expect(names).not.toContain('ab');

      // Underscores-only or digits-only blocked
      expect(names).not.toContain('___');
      expect(names).not.toContain('1234');

      // Valid function identifier captured
      expect(names).toContain('validSymbolName');
    });

    it('1.8: polyglot monorepo diff extracting TS, Python, Elixir, and Go in a single pass', async () => {
      const files: ChangedFile[] = [
        {
          path: 'services/auth/token.go',
          patch: `@@ -15,4 +15,7 @@ func (s *TokenService) GenerateJWT(userID string) (string, error) {\n+  claims := NewUserClaims(userID)\n+  return signToken(claims)\n`,
        },
        {
          path: 'services/billing/worker.py',
          patch: `@@ -30,4 +30,6 @@ class BillingWorker:\n+    async def process_refund(self, invoice_id):\n+        return await self.gateway.refund(invoice_id)\n`,
        },
        {
          path: 'lib/telemetry/reporter.ex',
          patch: `@@ -5,4 +5,6 @@ defmodule Telemetry.Reporter do\n+  def report_latency(metric, duration) do\n+    StatsD.gauge(metric, duration)\n`,
        },
        {
          path: 'frontend/src/api/client.ts',
          patch: `@@ -50,4 +50,6 @@ export class ApiClient {\n+  public async fetchDashboardSummary(): Promise<Summary> {\n+    return this.http.get('/summary');\n`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      // Go
      expect(names).toContain('GenerateJWT');
      expect(names).toContain('NewUserClaims');
      expect(names).toContain('signToken');

      // Python
      expect(names).toContain('BillingWorker');
      expect(names).toContain('process_refund');

      // Elixir
      expect(names).toContain('Reporter');
      expect(names).toContain('report_latency');

      // TypeScript
      expect(names).toContain('ApiClient');
      expect(names).toContain('fetchDashboardSummary');
    });

    it('1.9: empirical boundary test: multi-line comments spanning diff lines are captured as calls', async () => {
      const files: ChangedFile[] = [
        {
          path: 'src/commentBlock.ts',
          patch: `@@ -1,3 +1,5 @@\n+  /*\n+   * executePayment(orderId)\n+   */\n`,
        },
      ];

      const symbols = await extractModifiedSymbols(files, 25);
      const names = symbols.map((s) => s.name);

      // Empirical finding: line-by-line regex cannot strip comments that span across multiple diff lines
      expect(names).toContain('executePayment');
    });

    it('1.10: empirical boundary test: arrow function extraction in AST mode vs patch-only mode', async () => {
      const patchOnlyFile: ChangedFile = {
        path: 'src/arrowPatch.ts',
        patch: `@@ -1,3 +1,5 @@\n+export const processOrder = (orderId: string) => {\n+  return true;\n+};\n`,
      };

      const withContentFile: ChangedFile = {
        path: 'src/arrowAst.ts',
        patch: `@@ -1,3 +1,5 @@\n+export const processOrder = (orderId: string) => {\n+  return true;\n+};\n`,
        content: `export const processOrder = (orderId: string) => {\n  return true;\n};\n`,
      };

      const patchSymbols = await extractModifiedSymbols([patchOnlyFile], 25);
      const astSymbols = await extractModifiedSymbols([withContentFile], 25);

      // In AST mode, arrow functions are extracted as full function definitions (score: 100)
      expect(astSymbols.map((s) => s.name)).toContain('processOrder');
      expect(astSymbols.find((s) => s.name === 'processOrder')?.isModifiedDefinition).toBe(true);

      // In patch-only mode, arrow functions are not matched by the function/def regex
      expect(patchSymbols.map((s) => s.name)).not.toContain('processOrder');
    });
  });

  // =========================================================================
  // CHALLENGE AREA 2: WORD BOUNDARY & SAME-FILE MATCHING
  // =========================================================================
  describe('Challenge Area 2: Word Boundary & Same-File Matching', () => {
    let mockFs: any;

    beforeEach(() => {
      mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['repo.zoekt']),
        statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
      };
    });

    it('2.1: prevents substring false positives (e.g., searching for "foo" matches "foo(x)" but ignores "foobar")', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        {
          name: 'foo',
          sourcePath: 'src/foo.ts',
          line: 1,
          kind: 'function',
          role: 'declared_definition',
          isModifiedDefinition: true,
          score: 100,
        },
      ];

      const mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.write(jsonlLine('src/other/test1.ts', [{ line: 10, text: 'const foobar = 123;' }]) + '\n');
          child.stdout.write(jsonlLine('src/other/test2.ts', [{ line: 20, text: 'const barfoo = 456;' }]) + '\n');
          child.stdout.write(jsonlLine('src/other/test3.ts', [{ line: 30, text: 'const my_foo_var = 789;' }]) + '\n');
          child.stdout.write(jsonlLine('src/other/valid.ts', [{ line: 40, text: 'const result = foo(42);' }]) + '\n');
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
      expect(sym.callSites).toHaveLength(1);
      expect(sym.callSites[0].path).toBe('src/other/valid.ts');
      expect(sym.callSites[0].line).toBe(40);
    });

    it('2.2: strictly excludes same-file matches across all path formatting variants', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        {
          name: 'calculateTax',
          sourcePath: 'src/billing/taxService.ts',
          line: 15,
          kind: 'function',
          role: 'declared_definition',
          isModifiedDefinition: true,
          score: 100,
        },
      ];

      const mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          // Different path formats referring to the SAME file:
          child.stdout.write(jsonlLine('src/billing/taxService.ts', [{ line: 15, text: 'export function calculateTax(amt: number) {' }]) + '\n');
          child.stdout.write(jsonlLine('./src/billing/taxService.ts', [{ line: 30, text: 'return calculateTax(base);' }]) + '\n');
          child.stdout.write(jsonlLine('a/src/billing/taxService.ts', [{ line: 45, text: 'calculateTax(subtotal)' }]) + '\n');
          child.stdout.write(jsonlLine('src\\billing\\taxService.ts', [{ line: 55, text: 'calculateTax(total)' }]) + '\n');
          // Truly external call site:
          child.stdout.write(jsonlLine('src/checkout/cart.ts', [{ line: 99, text: 'const tax = calculateTax(cartTotal);' }]) + '\n');
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
      // All same-file matches must be excluded; only external call site remains:
      expect(sym.callSites).toHaveLength(1);
      expect(sym.callSites[0].path).toBe('src/checkout/cart.ts');
      expect(sym.definitions).toHaveLength(0);
    });

    it('2.3: verifies path normalization helper edge cases directly', () => {
      expect(isSameFile('src/app.ts', 'src/app.ts')).toBe(true);
      expect(isSameFile('a/src/app.ts', 'src/app.ts')).toBe(true);
      expect(isSameFile('b/src/app.ts', 'src/app.ts')).toBe(true);
      expect(isSameFile('./src/app.ts', '/src/app.ts')).toBe(true);
      expect(isSameFile('src\\app.ts', 'src/app.ts')).toBe(true);
      expect(isSameFile('///src/app.ts', 'src/app.ts')).toBe(true);
      expect(isSameFile('src/app.ts', 'src/other.ts')).toBe(false);
      expect(isSameFile('', '')).toBe(true);
      expect(normalizeRepoPath('')).toBe('');
      expect(normalizeRepoPath(null as any)).toBe('');
    });

    it('2.4: correctly classifies external definition lines vs external call site lines', () => {
      expect(isDefinitionLine('export function executeOrder(id: string) {', 'executeOrder')).toBe(true);
      expect(isDefinitionLine('export class PaymentProcessor {', 'PaymentProcessor')).toBe(true);
      expect(isDefinitionLine('export const processPayment = (amt) => {', 'processPayment')).toBe(true);
      expect(isDefinitionLine('def handle_webhook(payload):', 'handle_webhook')).toBe(true);
      expect(isDefinitionLine('defmodule Accounts do', 'Accounts')).toBe(true);
      expect(isDefinitionLine('def calculate_rate(amt) do', 'calculate_rate')).toBe(true);
      expect(isDefinitionLine('func (s *Server) ListenAndServe() error {', 'ListenAndServe')).toBe(true);
      expect(isDefinitionLine('type Config struct {', 'Config')).toBe(true);

      // Empirical limitation: dot-prefixed Elixir module definition (defmodule MyApp.Accounts) is not matched
      expect(isDefinitionLine('defmodule MyApp.Accounts do', 'Accounts')).toBe(false);

      // Negative definition tests (these are call sites or references)
      expect(isDefinitionLine('const res = executeOrder(123);', 'executeOrder')).toBe(false);
      expect(isDefinitionLine('const p = new PaymentProcessor();', 'PaymentProcessor')).toBe(false);
      expect(isDefinitionLine('import { executeOrder } from "./order";', 'executeOrder')).toBe(false);
      expect(isDefinitionLine('Accounts.get_user(id)', 'Accounts')).toBe(false);
    });

    it('2.5: recognizes import statements via isImportLine', () => {
      expect(isImportLine('import { foo } from "./foo";')).toBe(true);
      expect(isImportLine('from os import path')).toBe(true);
      expect(isImportLine('const foo = require("foo");')).toBe(false);
      expect(isImportLine('require("dotenv").config();')).toBe(true);
      expect(isImportLine('use GenServer')).toBe(true);
      expect(isImportLine('alias MyApp.Repo')).toBe(true);
      expect(isImportLine('import("fmt")')).toBe(true);
      expect(isImportLine('const x = calculate();')).toBe(false);
    });

    it('2.6: referenced symbols fallback to first non-import external line as definition candidate', async () => {
      const candidateSymbols: CandidateSymbol[] = [
        {
          name: 'RemoteClient',
          sourcePath: 'src/caller.ts',
          line: 5,
          role: 'call',
          isModifiedDefinition: false,
          score: 60,
        },
      ];

      const mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          // Zoekt returns an import line and a usage line without explicit 'class RemoteClient' keyword
          child.stdout.write(jsonlLine('src/other1.ts', [{ line: 1, text: 'import { RemoteClient } from "./remote";' }]) + '\n');
          child.stdout.write(jsonlLine('src/other2.ts', [{ line: 15, text: 'const client = RemoteClient.connect();' }]) + '\n');
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
      // When no definition keyword is matched, first non-import line is selected as definition candidate:
      expect(sym.definitions).toHaveLength(1);
      expect(sym.definitions[0].path).toBe('src/other2.ts');
      expect(sym.definitions[0].line).toBe(15);
    });
  });

  // =========================================================================
  // CHALLENGE AREA 3: BUDGET CAPPING & IMPORTANCE SORTING
  // =========================================================================
  describe('Challenge Area 3: Budget Capping & Importance Sorting', () => {
    let mockFs: any;

    beforeEach(() => {
      mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };
    });

    it('3.1: strictly caps queries to max_symbols and reports truncated: true in receipt', async () => {
      const candidates: CandidateSymbol[] = Array.from({ length: 40 }, (_, i) => ({
        name: `Symbol_${String(i).padStart(2, '0')}`,
        sourcePath: `src/mod_${i}.ts`,
        line: 1,
        role: 'declared_definition',
        isModifiedDefinition: true,
        score: 100 - i,
      }));

      let executedQueries = 0;
      const mockSpawn = vi.fn().mockImplementation(() => {
        executedQueries++;
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 12 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.scannedSymbolsCount).toBe(12);
      expect(executedQueries).toBe(12);
      expect(result.receipt.totalQueries).toBe(12);
      expect(result.receipt.truncated).toBe(true);
    });

    it('3.2: preserves high-score definitions over low-score references across priority tiers', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'ImportRef', sourcePath: 'src/a.ts', line: 1, role: 'import', isModifiedDefinition: false, score: 50 },
        { name: 'TypeRef', sourcePath: 'src/b.ts', line: 1, role: 'type_usage', isModifiedDefinition: false, score: 40 },
        { name: 'CallRef', sourcePath: 'src/c.ts', line: 1, role: 'call', isModifiedDefinition: false, score: 60 },
        { name: 'ClassDef', sourcePath: 'src/d.ts', line: 1, role: 'enclosing_class', isModifiedDefinition: true, score: 90 },
        { name: 'HeaderFn', sourcePath: 'src/e.ts', line: 1, role: 'enclosing_function', isModifiedDefinition: true, score: 95 },
        { name: 'FunctionDef', sourcePath: 'src/f.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
      ];

      const queriedOrder: string[] = [];
      const mockSpawn = vi.fn().mockImplementation((_bin, args) => {
        const query = args[args.length - 1];
        queriedOrder.push(query);
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 6 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(queriedOrder).toEqual([
        'FunctionDef', // 100
        'HeaderFn',    // 95
        'ClassDef',    // 90
        'CallRef',     // 60
        'ImportRef',   // 50
        'TypeRef',     // 40
      ]);
    });

    it('3.3: performs alphabetical tie-breaking when importance scores are identical', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'zebraFunction', sourcePath: 'src/z.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
        { name: 'alphaFunction', sourcePath: 'src/a.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
        { name: 'betaFunction', sourcePath: 'src/b.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
      ];

      const queriedOrder: string[] = [];
      const mockSpawn = vi.fn().mockImplementation((_bin, args) => {
        queriedOrder.push(args[args.length - 1]);
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 3 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(queriedOrder).toEqual(['alphaFunction', 'betaFunction', 'zebraFunction']);
    });

    it('3.4: deduplicates identical symbols and merges isModifiedDefinition flag to true', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'sharedHelper', sourcePath: 'src/consumer.ts', line: 5, role: 'call', isModifiedDefinition: false, score: 60 },
        { name: 'sharedHelper', sourcePath: 'src/producer.ts', line: 10, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
      ];

      let queryCount = 0;
      const mockSpawn = vi.fn().mockImplementation(() => {
        queryCount++;
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 25 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(queryCount).toBe(1);
      expect(result.scannedSymbolsCount).toBe(1);
    });

    it('3.5: handles exact match with max_symbols budget without setting truncated: true', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'func1', sourcePath: 'a.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
        { name: 'func2', sourcePath: 'b.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
      ];

      const mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.emit('close', 0);
          child.emit('exit', 0);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 2 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.scannedSymbolsCount).toBe(2);
      expect(result.receipt.truncated).toBe(false);
    });
  });

  // =========================================================================
  // CHALLENGE AREA 4: FAIL-SOFT ROBUSTNESS
  // =========================================================================
  describe('Challenge Area 4: Fail-Soft Robustness', () => {
    it('4.1: handles missing Zoekt binary (ENOENT) during spawn without crashing or throwing', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'testFn', sourcePath: 'src/test.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
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
        candidateSymbols: candidates,
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('zoekt_binary_missing');
      expect(result.symbols).toEqual([]);
      expect(result.receipt.totalQueries).toBe(1);
    });

    it('4.2: handles unindexed repository (missing index directory or no .zoekt shards)', async () => {
      const mockFsMissing = {
        existsSync: vi.fn().mockReturnValue(false),
      };

      const result1 = await executeZoektPreCheck({
        indexDir: '/nonexistent/path',
        fsImpl: mockFsMissing,
      });

      expect(result1.status).toBe('unavailable');
      expect(result1.reason).toBe('zoekt_index_unavailable');

      const mockFsEmpty = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['readme.md', 'metadata.json']),
      };

      const result2 = await executeZoektPreCheck({
        indexDir: '/empty/index',
        fsImpl: mockFsEmpty,
      });

      expect(result2.status).toBe('unavailable');
      expect(result2.reason).toBe('zoekt_index_unavailable');
    });

    it('4.3: aborts cleanly when signal is triggered mid-execution and retains partial findings', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'firstSym', sourcePath: 'src/a.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
        { name: 'secondSym', sourcePath: 'src/b.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 90 },
      ];

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      const controller = new AbortController();
      let invocation = 0;

      const mockSpawn = vi.fn().mockImplementation(() => {
        invocation++;
        const child = makeFakeChild();
        queueMicrotask(() => {
          if (invocation === 1) {
            // First query succeeds and finds a call site
            child.stdout.write(jsonlLine('src/other.ts', [{ line: 50, text: 'const x = firstSym();' }]) + '\n');
            child.stdout.end();
            child.emit('close', 0);
            child.emit('exit', 0);
            // Abort immediately after first query finishes
            controller.abort();
          } else {
            child.stdout.end();
            child.emit('close', 0);
            child.emit('exit', 0);
          }
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        indexDir: '/tmp/index',
        signal: controller.signal,
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('cancelled');
      // Verify first symbol context was preserved before cancellation
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].symbol).toBe('firstSym');
      // Second query was not run
      expect(invocation).toBe(1);
    });

    it('4.4: handles query timeouts gracefully (marks request_timeout if all timeout)', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'hangingQuery', sourcePath: 'src/hang.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
      ];

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      const mockSpawn = vi.fn().mockImplementation(() => {
        return makeFakeChild(); // Never ends stdout
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 10, timeoutMs: 20 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('unavailable');
      expect(result.reason).toBe('request_timeout');
    });

    it('4.5: survives partial timeouts (if 1 query times out but another succeeds, status is ok)', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'hangingSymbol', sourcePath: 'src/hang.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
        { name: 'workingSymbol', sourcePath: 'src/work.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 90 },
      ];

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      let queryNum = 0;
      const mockSpawn = vi.fn().mockImplementation((_bin, args) => {
        queryNum++;
        const child = makeFakeChild();
        const sym = args[args.length - 1];
        if (sym === 'hangingSymbol') {
          // Never closes, will trigger zoektTool timeout
        } else {
          queueMicrotask(() => {
            child.stdout.write(jsonlLine('src/consumer.ts', [{ line: 12, text: 'workingSymbol();' }]) + '\n');
            child.stdout.end();
            child.emit('close', 0);
            child.emit('exit', 0);
          });
        }
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        config: { enabled: true, max_symbols: 10, timeoutMs: 20 },
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].symbol).toBe('workingSymbol');
    });

    it('4.6: absorbs child process crashes and broken JSON output cleanly', async () => {
      const candidates: CandidateSymbol[] = [
        { name: 'crashSym', sourcePath: 'src/crash.ts', line: 1, role: 'declared_definition', isModifiedDefinition: true, score: 100 },
      ];

      const mockFs = {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue(['shard.zoekt']),
      };

      const mockSpawn = vi.fn().mockImplementation(() => {
        const child = makeFakeChild();
        queueMicrotask(() => {
          child.stdout.write('INVALID JSON LINE {{{{ NOT JSON\n');
          child.stdout.end();
          child.emit('close', 1);
          child.emit('exit', 1);
        });
        return child;
      });

      const result = await executeZoektPreCheck({
        candidateSymbols: candidates,
        indexDir: '/tmp/index',
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(result.status).toBe('ok');
      expect(result.symbols).toHaveLength(0);
    });
  });

  // =========================================================================
  // CHALLENGE AREA 5: PROMPT FORMATTING HELPER RESILIENCE
  // =========================================================================
  describe('Challenge Area 5: Prompt Formatting Resilience', () => {
    it('5.1: safely handles empty, null, or undefined result objects', () => {
      expect(formatZoektPreCheckPrompt(null as any)).toBe('');
      expect(formatZoektPreCheckPrompt(undefined as any)).toBe('');
    });

    it('5.2: formats complex result with definition and call site details accurately', () => {
      const result: ZoektPreCheckResult = {
        status: 'ok',
        scannedSymbolsCount: 2,
        matchedSymbolsCount: 2,
        symbols: [
          {
            symbol: 'OrderManager',
            kind: 'class',
            sourcePath: 'src/orders/manager.ts',
            isModifiedDefinition: true,
            definitions: [],
            callSites: [
              { path: 'src/api/routes.ts', line: 25, text: 'const mgr = new OrderManager();' },
            ],
          },
          {
            symbol: 'PaymentClient',
            kind: 'interface',
            sourcePath: 'src/orders/manager.ts',
            isModifiedDefinition: false,
            definitions: [
              { path: 'src/clients/payment.ts', line: 10, text: 'export interface PaymentClient {' },
            ],
            callSites: [
              { path: 'src/billing/service.ts', line: 40, text: 'paymentClient.charge(amt);' },
            ],
          },
        ],
        receipt: { totalQueries: 2, durationMs: 45 },
      };

      const prompt = formatZoektPreCheckPrompt(result);

      expect(prompt).toContain("Symbol 'OrderManager' (class) (defined in src/orders/manager.ts):");
      expect(prompt).toContain('- src/api/routes.ts:25: const mgr = new OrderManager();');
      expect(prompt).toContain("Symbol 'PaymentClient' (interface) (referenced in src/orders/manager.ts):");
      expect(prompt).toContain('Canonical definition:');
      expect(prompt).toContain('- src/clients/payment.ts:10: export interface PaymentClient {');
      expect(prompt).toContain('Other call sites across repository (1 found):');
      expect(prompt).toContain('- src/billing/service.ts:40: paymentClient.charge(amt);');
    });

    it('5.3: handles ok result when no cross-file matches were discovered', () => {
      const result: ZoektPreCheckResult = {
        status: 'ok',
        scannedSymbolsCount: 5,
        matchedSymbolsCount: 0,
        symbols: [],
        receipt: { totalQueries: 5, durationMs: 20 },
      };

      const prompt = formatZoektPreCheckPrompt(result);
      expect(prompt).toContain('No external definitions or call sites were found across the repository');
    });
  });
});
