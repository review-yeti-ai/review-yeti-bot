import { describe, it, expect } from 'vitest';
import {
  parseDiffHunkBoundaries,
  reconstructSourceFromPatch,
  isSymbolModifiedByDiff,
  cleanSignature,
  estimateTokenCount,
  renderOutlineSummary,
  generateFileTreeOutline,
  generateTaskScopedASTOutline,
  extractAdditionalTypeScriptSymbols,
} from '../../src/panel/astOutlineGenerator';
import { ASTParser } from '../../src/indexer/astParser';
import type { ReviewTask } from '../../src/panel/reviewTask';

describe('astOutlineGenerator', () => {
  describe('Diff Hunk Parsing & Line Extraction', () => {
    it('parses single and multi-hunk unified diff patches', () => {
      const patch = [
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -10,3 +10,5 @@ function existing() {',
        '   const a = 1;',
        '+  const b = 2;',
        '+  const c = 3;',
        '   return a;',
        '@@ -50,4 +52,3 @@ class Manager {',
        '   run() {',
        '-    log();',
        '     return true;',
        '   }',
      ].join('\n');

      const result = parseDiffHunkBoundaries(patch);

      expect(result.boundaries).toHaveLength(2);
      expect(result.boundaries[0]).toEqual({
        oldStart: 10,
        oldCount: 3,
        newStart: 10,
        newCount: 5,
        section: 'function existing() {',
        modifiedLineNumbers: [11, 12],
      });
      expect(result.boundaries[1]).toEqual({
        oldStart: 50,
        oldCount: 4,
        newStart: 52,
        newCount: 3,
        section: 'class Manager {',
        modifiedLineNumbers: [],
      });
      expect(result.addedLineNumbers).toEqual([11, 12]);
      expect(result.deletedLineNumbers).toEqual([51]);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(1);
    });

    it('handles empty, null, or malformed diffs safely', () => {
      expect(parseDiffHunkBoundaries('')).toEqual({
        boundaries: [],
        addedLineNumbers: [],
        deletedLineNumbers: [],
        additions: 0,
        deletions: 0,
      });
      expect(parseDiffHunkBoundaries(undefined)).toEqual({
        boundaries: [],
        addedLineNumbers: [],
        deletedLineNumbers: [],
        additions: 0,
        deletions: 0,
      });
      expect(parseDiffHunkBoundaries('random garbage without hunks')).toEqual({
        boundaries: [],
        addedLineNumbers: [],
        deletedLineNumbers: [],
        additions: 0,
        deletions: 0,
      });
    });

    it('reconstructs source lines at exact new line offsets', () => {
      const patch = [
        '@@ -5,2 +5,4 @@',
        ' const x = 1;',
        '+export function newFunction() {',
        '+  return 42;',
        '+}',
      ].join('\n');

      const reconstructed = reconstructSourceFromPatch(patch);
      const lines = reconstructed.split('\n');

      // Lines 0..3 are empty padding
      expect(lines[0]).toBe('');
      expect(lines[3]).toBe('');
      // Line 5 (index 4) is context
      expect(lines[4]).toBe('const x = 1;');
      // Lines 6..8 (indices 5..7) are added
      expect(lines[5]).toBe('export function newFunction() {');
      expect(lines[6]).toBe('  return 42;');
      expect(lines[7]).toBe('}');
    });
  });

  describe('AST Symbol Intersection Across Languages', () => {
    describe('TypeScript & TSX', () => {
      it('intersects modified lines with function and class symbols in TypeScript', () => {
        const fullContent = [
          'export function unmodifiedHelper(): void {', // line 1
          '  console.log("unmodified");',               // line 2
          '}',                                           // line 3
          '',                                            // line 4
          'export function modifiedGuard(user: any): boolean {', // line 5
          '  if (!user) return false;',                  // line 6
          '  return true;',                              // line 7
          '}',                                           // line 8
          '',                                            // line 9
          'export class UserService {',                  // line 10
          '  public getUser(id: string) {',              // line 11
          '    return { id };',                          // line 12
          '  }',                                         // line 13
          '}',                                           // line 14
        ].join('\n');

        // Patch modifies line 6 inside modifiedGuard
        const patch = [
          '@@ -5,4 +5,5 @@',
          ' export function modifiedGuard(user: any): boolean {',
          '+  if (user.isBlocked) return false;',
          '   if (!user) return false;',
          '   return true;',
          ' }',
        ].join('\n');

        const outline = generateFileTreeOutline([
          { path: 'src/auth/guard.ts', patch, content: fullContent },
        ]);

        expect(outline.files).toHaveLength(1);
        const file = outline.files[0];
        expect(file.filePath).toBe('src/auth/guard.ts');
        expect(file.domainLane).toBe('security_auth');

        const symNames = file.modifiedSymbols.map((s) => s.name);
        expect(symNames).toContain('modifiedGuard');
        expect(symNames).not.toContain('unmodifiedHelper');
        expect(symNames).not.toContain('UserService');

        const guardSym = file.modifiedSymbols.find((s) => s.name === 'modifiedGuard')!;
        expect(guardSym.kind).toBe('function');
        expect(guardSym.exported).toBe(true);
        expect(guardSym.startLine).toBe(5);
        expect(guardSym.endLine).toBe(8);
      });

      it('detects interface and type modifications in TypeScript', () => {
        const content = [
          'export interface AuthSession {', // line 1
          '  sessionId: string;',           // line 2
          '  expiresAt: number;',           // line 3
          '}',                              // line 4
        ].join('\n');

        const patch = [
          '@@ -1,4 +1,5 @@',
          ' export interface AuthSession {',
          '+  refreshToken?: string;',
          '   sessionId: string;',
          '   expiresAt: number;',
          ' }',
        ].join('\n');

        const outline = generateFileTreeOutline([
          { path: 'src/auth/types.ts', patch, content },
        ]);

        expect(outline.files[0].modifiedSymbols).toHaveLength(1);
        const sym = outline.files[0].modifiedSymbols[0];
        expect(sym.name).toBe('AuthSession');
        expect(sym.kind).toBe('interface');
        expect(sym.exported).toBe(true);
      });

      it('extracts top-level exported variables and constants in TS', () => {
        const patch = '@@ -1,1 +1,2 @@\n+export const AUTH_HEADER = "X-Auth-Token";';
        const outline = generateFileTreeOutline([
          { path: 'src/auth/constants.ts', patch },
        ]);

        expect(outline.files[0].modifiedSymbols).toHaveLength(1);
        const sym = outline.files[0].modifiedSymbols[0];
        expect(sym.name).toBe('AUTH_HEADER');
        expect(sym.kind).toBe('variable');
        expect(sym.exported).toBe(true);
        expect(sym.signature).toContain('AUTH_HEADER');
      });
    });

    describe('JavaScript & JSX', () => {
      it('intersects modified lines with JS function and class declarations', () => {
        const content = [
          'function computeTotal(items) {', // line 1
          '  return items.reduce((a, b) => a + b, 0);', // line 2
          '}', // line 3
          '', // line 4
          'class CartManager {', // line 5
          '  checkout() {', // line 6
          '    return true;', // line 7
          '  }', // line 8
          '}', // line 9
        ].join('\n');

        const patch = [
          '@@ -6,3 +6,4 @@',
          '   checkout() {',
          '+    this.validate();',
          '     return true;',
          '   }',
        ].join('\n');

        const outline = generateFileTreeOutline([
          { path: 'src/billing/cart.js', patch, content },
        ]);

        expect(outline.files[0].modifiedSymbols.some((s) => s.name === 'CartManager' || s.name === 'checkout')).toBe(true);
        expect(outline.files[0].modifiedSymbols.some((s) => s.name === 'computeTotal')).toBe(false);
      });
    });

    describe('Python', () => {
      it('intersects modified lines with Python functions and classes', () => {
        const content = [
          'def calculate_tax(amount):', // line 1
          '    return amount * 0.05',  // line 2
          '',                          // line 3
          'class PaymentGateway:',     // line 4
          '    def charge(self, card, amount):', // line 5
          '        return True',       // line 6
        ].join('\n');

        const patch = [
          '@@ -5,2 +5,3 @@',
          '     def charge(self, card, amount):',
          '+        self.audit_log(card)',
          '         return True',
        ].join('\n');

        const outline = generateFileTreeOutline([
          { path: 'src/api/payment.py', patch, content },
        ]);

        expect(outline.files).toHaveLength(1);
        const file = outline.files[0];
        expect(file.domainLane).toBe('api_contracts');
        const names = file.modifiedSymbols.map((s) => s.name);
        expect(names).toContain('charge');
        expect(names).not.toContain('calculate_tax');
      });

      it('parses in-memory Python patch without full content file', () => {
        const patch = [
          '@@ -1,1 +1,3 @@',
          '+def authenticate_user(username, password):',
          '+    return username == "admin"',
        ].join('\n');

        const outline = generateFileTreeOutline([
          { path: 'src/auth/authenticator.py', patch },
        ]);

        expect(outline.files[0].modifiedSymbols).toHaveLength(1);
        const sym = outline.files[0].modifiedSymbols[0];
        expect(sym.name).toBe('authenticate_user');
        expect(sym.kind).toBe('function');
      });
    });

    describe('Deletions-Only & Boundary Overlaps', () => {
      it('identifies symbol modified when code is deleted without additions', () => {
        const content = [
          'export function processOrder(order: any) {', // line 1
          '  validate(order);',                         // line 2
          '  return save(order);',                      // line 3
          '}',                                          // line 4
        ].join('\n');

        // Line 2 is deleted
        const patch = [
          '@@ -1,4 +1,3 @@',
          ' export function processOrder(order: any) {',
          '-  validate(order);',
          '   return save(order);',
          ' }',
        ].join('\n');

        const outline = generateFileTreeOutline([
          { path: 'src/orders/processor.ts', patch, content },
        ]);

        const symNames = outline.files[0].modifiedSymbols.map((s) => s.name);
        expect(symNames).toContain('processOrder');
      });
    });
  });

  describe('Domain Classification and Lane Partitioning', () => {
    it('classifies files across all 6 domain lanes and groups them in filesByDomain', () => {
      const files = [
        { path: 'src/auth/jwtAuth.ts', patch: '@@ -1,1 +1,2 @@\n+export function verifyJwt() {}' },
        { path: 'priv/repo/migrations/20261001_create_users.sql', patch: '@@ -1,1 +1,2 @@\n+CREATE TABLE users;' },
        { path: 'src/api/v1/userContract.ts', patch: '@@ -1,1 +1,2 @@\n+export interface UserDto {}' },
        { path: 'src/runtime/workerSupervisor.ts', patch: '@@ -1,1 +1,2 @@\n+export class Supervisor {}' },
        { path: 'src/ui/components/UserAvatar.tsx', patch: '@@ -1,1 +1,2 @@\n+export function UserAvatar() {}' },
        { path: 'docs/architecture/review-flow.md', patch: '@@ -1,1 +1,2 @@\n+# Review Flow' },
      ];

      const outline = generateFileTreeOutline(files);

      expect(outline.totalFiles).toBe(6);
      expect(outline.filesByDomain.security_auth).toHaveLength(1);
      expect(outline.filesByDomain.security_auth[0].filePath).toBe('src/auth/jwtAuth.ts');

      expect(outline.filesByDomain.data_persistence).toHaveLength(1);
      expect(outline.filesByDomain.data_persistence[0].filePath).toBe('priv/repo/migrations/20261001_create_users.sql');

      expect(outline.filesByDomain.api_contracts).toHaveLength(1);
      expect(outline.filesByDomain.api_contracts[0].filePath).toBe('src/api/v1/userContract.ts');

      expect(outline.filesByDomain.system_runtime).toHaveLength(1);
      expect(outline.filesByDomain.system_runtime[0].filePath).toBe('src/runtime/workerSupervisor.ts');

      expect(outline.filesByDomain.ui_frontend).toHaveLength(1);
      expect(outline.filesByDomain.ui_frontend[0].filePath).toBe('src/ui/components/UserAvatar.tsx');

      expect(outline.filesByDomain.docs_assets).toHaveLength(1);
      expect(outline.filesByDomain.docs_assets[0].filePath).toBe('docs/architecture/review-flow.md');
    });
  });

  describe('Task-Scoped Filtering & Context Isolation', () => {
    const multiFiles = [
      { path: 'src/auth/login.ts', patch: '@@ -1,1 +1,2 @@\n+export function login() {}' },
      { path: 'src/db/migrate.ts', patch: '@@ -1,1 +1,2 @@\n+export function runMigration() {}' },
      { path: 'src/api/routes.ts', patch: '@@ -1,1 +1,2 @@\n+export function registerRoutes() {}' },
      { path: 'src/ui/Dashboard.tsx', patch: '@@ -1,1 +1,2 @@\n+export function Dashboard() {}' },
    ];

    it('filters outline strictly to files assigned to task.paths', () => {
      const fullOutline = generateFileTreeOutline(multiFiles);
      const task: ReviewTask = {
        id: 'task-sec',
        dimension: 'security',
        paths: ['src/auth/login.ts'],
        question: 'Is auth secure?',
        rationale: 'Security analysis',
      };

      const scoped = generateTaskScopedASTOutline(fullOutline, { task });

      expect(scoped.totalFiles).toBe(1);
      expect(scoped.files[0].filePath).toBe('src/auth/login.ts');
      expect(scoped.filesByDomain.security_auth).toHaveLength(1);
      expect(scoped.filesByDomain.data_persistence).toHaveLength(0);
      expect(scoped.filesByDomain.ui_frontend).toHaveLength(0);

      expect(scoped.summaryText).toContain('src/auth/login.ts');
      expect(scoped.summaryText).toContain('export function login()');
      expect(scoped.summaryText).not.toContain('src/db/migrate.ts');
      expect(scoped.summaryText).not.toContain('runMigration');
      expect(scoped.summaryText).not.toContain('Dashboard');
    });

    it('filters outline by domain affinity when task paths are unassigned', () => {
      const fullOutline = generateFileTreeOutline(multiFiles);
      const task: ReviewTask = {
        id: 'task-db',
        dimension: 'architecture',
        paths: [],
        question: 'Database persistence?',
        rationale: 'DB check',
      };

      const scoped = generateTaskScopedASTOutline(fullOutline, {
        task,
        domainLanes: ['data_persistence'],
      });

      expect(scoped.totalFiles).toBe(1);
      expect(scoped.files[0].filePath).toBe('src/db/migrate.ts');
      expect(scoped.summaryText).toContain('runMigration');
      expect(scoped.summaryText).not.toContain('login');
    });

    it('falls back to all files when neither paths nor domain filters match', () => {
      const fullOutline = generateFileTreeOutline(multiFiles);
      const scoped = generateTaskScopedASTOutline(fullOutline, {});
      expect(scoped.totalFiles).toBe(4);
    });
  });

  describe('Token Compaction Benchmark (>60% Reduction)', () => {
    it('achieves >60% token reduction compared to monolithic raw unified diffs and stays under 500 tokens', () => {
      const filesWithLargeDiffs = [
        {
          path: 'src/auth/sessionManager.ts',
          patch: [
            '@@ -1,50 +1,50 @@',
            ' export class SessionManager {',
            '+  private tokenStore: Map<string, string> = new Map();',
            '+  public createSession(userId: string): string {',
            '+    const token = crypto.randomUUID();',
            '+    this.tokenStore.set(token, userId);',
            '+    return token;',
            '+  }',
            '+  public validateSession(token: string): boolean {',
            '+    return this.tokenStore.has(token);',
            '+  }',
            ...Array.from({ length: 40 }, (_, i) => `+  // verbose implementation detail line ${i}`),
            ' }',
          ].join('\n'),
        },
        {
          path: 'src/db/userRepository.ts',
          patch: [
            '@@ -1,45 +1,45 @@',
            ' export class UserRepository {',
            '+  public async findByEmail(email: string): Promise<User | null> {',
            '+    const query = "SELECT * FROM users WHERE email = $1";',
            '+    return db.queryOne(query, [email]);',
            '+  }',
            ...Array.from({ length: 35 }, (_, i) => `+  // query execution logic line ${i}`),
            ' }',
          ].join('\n'),
        },
        {
          path: 'src/api/userController.ts',
          patch: [
            '@@ -1,60 +1,60 @@',
            ' export class UserController {',
            '+  public async handleLogin(req: Request, res: Response) {',
            '+    const { email, password } = req.body;',
            '+    return res.json({ status: "ok" });',
            '+  }',
            ...Array.from({ length: 50 }, (_, i) => `+  // controller middleware validation ${i}`),
            ' }',
          ].join('\n'),
        },
      ];

      const rawDiffText = filesWithLargeDiffs.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch}`).join('\n\n');
      const rawDiffTokens = estimateTokenCount(rawDiffText);

      const outline = generateFileTreeOutline(filesWithLargeDiffs);
      const outlineTokens = estimateTokenCount(outline.summaryText);

      const reductionPercentage = ((rawDiffTokens - outlineTokens) / rawDiffTokens) * 100;

      // Assertions
      expect(outlineTokens).toBeLessThan(500);
      expect(reductionPercentage).toBeGreaterThan(60);
      expect(outline.summaryText).toContain('SessionManager');
      expect(outline.summaryText).toContain('UserRepository');
      expect(outline.summaryText).toContain('UserController');
    });
  });

  describe('Graceful Fallback for Non-Code & Asset Files', () => {
    it('gracefully handles markdown, json, yaml, and images without crashing', () => {
      const nonCodeFiles = [
        { path: 'README.md', patch: '@@ -1,2 +1,5 @@\n # Review Yeti\n+New documentation paragraph\n+Another line' },
        { path: 'package.json', patch: '@@ -10,3 +10,4 @@\n   "version": "1.0.0",\n+  "private": true,' },
        { path: 'k8s/deployment.yaml', patch: '@@ -5,2 +5,4 @@\n replicas: 3\n+env:\n+  - name: FOO\n+    value: BAR' },
        { path: 'assets/logo.png', patch: 'Binary files a/assets/logo.png and b/assets/logo.png differ' },
      ];

      const outline = generateFileTreeOutline(nonCodeFiles);

      expect(outline.totalFiles).toBe(4);
      for (const file of outline.files) {
        expect(file.modifiedSymbols).toEqual([]);
      }

      expect(outline.filesByDomain.docs_assets.map((f) => f.filePath)).toContain('README.md');
      expect(outline.filesByDomain.docs_assets.map((f) => f.filePath)).toContain('assets/logo.png');
      expect(outline.filesByDomain.system_runtime.map((f) => f.filePath)).toContain('k8s/deployment.yaml');

      expect(outline.summaryText).toContain('README.md');
      expect(outline.summaryText).toContain('package.json');
      expect(outline.summaryText).toContain('k8s/deployment.yaml');
    });
  });
});
