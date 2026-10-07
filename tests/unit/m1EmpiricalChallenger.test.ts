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
import {
  classifyPathByHeuristic,
  classifyDomainLanesByHeuristic,
  DomainLane,
} from '../../src/pathDomainContract';
import type { ReviewTask } from '../../src/panel/reviewTask';

describe('Empirical Challenger M1: Stress Tests & Invariants', () => {
  // =========================================================================
  // 1. TOKEN COMPACTION & OUTLINE SCALING
  // =========================================================================
  describe('Dimension 1: Token Compaction & Prompt Scaling Verification', () => {
    it('verifies token compaction >60% on small PR (2 files, 80 lines)', () => {
      const smallFiles = [
        {
          path: 'src/auth/tokenValidator.ts',
          patch: [
            '@@ -1,20 +1,25 @@',
            ' export class TokenValidator {',
            '+  private cache = new Map<string, boolean>();',
            '+  public validate(token: string): boolean {',
            '+    if (this.cache.has(token)) return this.cache.get(token)!;',
            '+    const valid = token.startsWith("ey");',
            '+    this.cache.set(token, valid);',
            '+    return valid;',
            '+  }',
            ...Array.from({ length: 15 }, (_, i) => `+  // additional validation logic step ${i}`),
            ' }',
          ].join('\n'),
        },
        {
          path: 'src/api/routes/authRoute.ts',
          patch: [
            '@@ -1,25 +1,30 @@',
            ' export function registerAuthRoutes(router: any) {',
            '+  router.post("/login", (req: any, res: any) => {',
            '+    res.json({ status: "ok" });',
            '+  });',
            ...Array.from({ length: 20 }, (_, i) => `+  // route middleware setup ${i}`),
            ' }',
          ].join('\n'),
        },
      ];

      const rawDiff = smallFiles.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch}`).join('\n\n');
      const rawTokens = estimateTokenCount(rawDiff);

      const outline = generateFileTreeOutline(smallFiles);
      const outlineTokens = estimateTokenCount(outline.summaryText);
      const reductionPct = ((rawTokens - outlineTokens) / rawTokens) * 100;

      expect(outlineTokens).toBeLessThan(500);
      expect(reductionPct).toBeGreaterThan(60);
      expect(outline.totalFiles).toBe(2);
    });

    it('verifies token compaction >60% on medium PR (8 files, 400 lines)', () => {
      const mediumFiles = Array.from({ length: 8 }, (_, idx) => ({
        path: `src/services/service_${idx}.ts`,
        patch: [
          '@@ -1,50 +1,50 @@',
          ` export class Service${idx} {`,
          `+  public async executeTask${idx}(payload: Record<string, unknown>): Promise<void> {`,
          `+    console.log("processing in service ${idx}");`,
          `+    await this.persist(payload);`,
          `+  }`,
          ...Array.from({ length: 40 }, (_, i) => `+  // implementation detail line ${i} for service ${idx}`),
          ' }',
        ].join('\n'),
      }));

      const rawDiff = mediumFiles.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch}`).join('\n\n');
      const rawTokens = estimateTokenCount(rawDiff);

      const outline = generateFileTreeOutline(mediumFiles);
      const outlineTokens = estimateTokenCount(outline.summaryText);
      const reductionPct = ((rawTokens - outlineTokens) / rawTokens) * 100;

      expect(outlineTokens).toBeLessThan(500);
      expect(reductionPct).toBeGreaterThan(70);
      expect(outline.totalFiles).toBe(8);
    });

    it('verifies token compaction >60% on large PR (20 files, 1500 lines)', () => {
      const largeFiles = Array.from({ length: 20 }, (_, idx) => ({
        path: `packages/module_${idx}/src/handler.ts`,
        patch: [
          '@@ -1,75 +1,75 @@',
          ` export function handleModule${idx}() {`,
          `+  const timestamp = Date.now();`,
          `+  return { module: ${idx}, timestamp };`,
          `+}`,
          ...Array.from({ length: 65 }, (_, i) => `+  // extra logic ${i} for module ${idx}`),
        ].join('\n'),
      }));

      const rawDiff = largeFiles.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch}`).join('\n\n');
      const rawTokens = estimateTokenCount(rawDiff);

      const outline = generateFileTreeOutline(largeFiles);
      const outlineTokens = estimateTokenCount(outline.summaryText);
      const reductionPct = ((rawTokens - outlineTokens) / rawTokens) * 100;

      expect(outlineTokens).toBeLessThan(1000);
      expect(reductionPct).toBeGreaterThan(75);
      expect(outline.totalFiles).toBe(20);
    });

    it('verifies token compaction on massive 50-file monorepo PR (>80% reduction)', () => {
      const massiveFiles = Array.from({ length: 50 }, (_, idx) => ({
        path: `apps/repo/component_${idx}.tsx`,
        patch: [
          '@@ -1,60 +1,60 @@',
          ` export function Component${idx}() {`,
          `+  return <div id="comp-${idx}">Refactored</div>;`,
          `+}`,
          ...Array.from({ length: 50 }, (_, i) => `+  // jsx render child comment ${i}`),
        ].join('\n'),
      }));

      const rawDiff = massiveFiles.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch}`).join('\n\n');
      const rawTokens = estimateTokenCount(rawDiff);

      const outline = generateFileTreeOutline(massiveFiles);
      const outlineTokens = estimateTokenCount(outline.summaryText);
      const reductionPct = ((rawTokens - outlineTokens) / rawTokens) * 100;

      expect(reductionPct).toBeGreaterThan(80);
      expect(outline.totalFiles).toBe(50);
    });
  });

  // =========================================================================
  // 2. COMPLEX TYPESCRIPT AST SYMBOL INTERSECTION
  // =========================================================================
  describe('Dimension 2: Complex TypeScript Language Constructs', () => {
    it('accurately identifies modified generic interfaces and generic classes', () => {
      const content = [
        'export interface EntityRepository<T extends { id: string }, K = string> {', // line 1
        '  findById(id: K): Promise<T | null>;',                                       // line 2
        '  save(entity: T): Promise<T>;',                                              // line 3
        '}',                                                                          // line 4
        '',                                                                           // line 5
        'export class BaseService<TModel extends Record<string, any>> {',             // line 6
        '  protected items: TModel[] = [];',                                          // line 7
        '  public getAll(): TModel[] {',                                              // line 8
        '    return this.items;',                                                     // line 9
        '  }',                                                                        // line 10
        '}',                                                                          // line 11
      ].join('\n');

      // Patch modifies line 2 inside generic interface EntityRepository
      const patch = [
        '@@ -1,4 +1,5 @@',
        ' export interface EntityRepository<T extends { id: string }, K = string> {',
        '+  findByQuery(query: any): Promise<T[]>;',
        '   findById(id: K): Promise<T | null>;',
        '   save(entity: T): Promise<T>;',
        ' }',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/repo/genericRepo.ts', patch, content },
      ]);

      expect(outline.files).toHaveLength(1);
      const syms = outline.files[0].modifiedSymbols;
      expect(syms.some((s) => s.name === 'EntityRepository' && s.kind === 'interface')).toBe(true);
      expect(syms.some((s) => s.name === 'BaseService')).toBe(false);
    });

    it('accurately identifies overloaded function signatures and implementation', () => {
      const content = [
        'export function parseConfig(input: string): Record<string, string>;', // line 1
        'export function parseConfig(input: number): number;',                 // line 2
        'export function parseConfig(input: any): any {',                     // line 3
        '  if (typeof input === "string") return JSON.parse(input);',         // line 4
        '  return input;',                                                    // line 5
        '}',                                                                  // line 6
      ].join('\n');

      // Case A: Diff modifies line 4 in the implementation body
      const patchBody = [
        '@@ -3,3 +3,4 @@',
        ' export function parseConfig(input: any): any {',
        '+  if (!input) throw new Error("empty");',
        '   if (typeof input === "string") return JSON.parse(input);',
        '   return input;',
      ].join('\n');

      const outlineBody = generateFileTreeOutline([
        { path: 'src/config/parser.ts', patch: patchBody, content },
      ]);

      const symsBody = outlineBody.files[0].modifiedSymbols;
      expect(symsBody.length).toBeGreaterThanOrEqual(1);
      expect(symsBody.some((s) => s.name === 'parseConfig')).toBe(true);

      // Case B: Diff modifies line 1 (first overload signature)
      const patchOverload = [
        '@@ -1,2 +1,3 @@',
        '+export function parseConfig(input: boolean): boolean;',
        ' export function parseConfig(input: string): Record<string, string>;',
        ' export function parseConfig(input: number): number;',
      ].join('\n');

      const outlineOverload = generateFileTreeOutline([
        { path: 'src/config/parser.ts', patch: patchOverload, content },
      ]);
      expect(outlineOverload.files[0].modifiedSymbols.some((s) => s.name === 'parseConfig')).toBe(true);
    });

    it('accurately intersects exported arrow functions, async arrows, and variable declarations', () => {
      const content = [
        'export const handleAuthToken = async (req: any, res: any): Promise<boolean> => {', // line 1
        '  const token = req.headers["authorization"];',                                     // line 2
        '  return token != null;',                                                           // line 3
        '};',                                                                                // line 4
        '',                                                                                  // line 5
        'export const UNTOUCHED_VAR = 42;',                                                  // line 6
        '',                                                                                  // line 7
        'export const curriedMultiplier = (factor: number) => (val: number) => {',           // line 8
        '  return factor * val;',                                                            // line 9
        '};',                                                                                // line 10
      ].join('\n');

      const patch = [
        '@@ -1,4 +1,5 @@',
        ' export const handleAuthToken = async (req: any, res: any): Promise<boolean> => {',
        '+  if (!req) return false;',
        '   const token = req.headers["authorization"];',
        '   return token != null;',
        ' };',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/auth/handler.ts', patch, content },
      ]);

      const syms = outline.files[0].modifiedSymbols;
      expect(syms.some((s) => s.name === 'handleAuthToken')).toBe(true);
      expect(syms.some((s) => s.name === 'UNTOUCHED_VAR')).toBe(false);
      expect(syms.some((s) => s.name === 'curriedMultiplier')).toBe(false);
    });

    it('handles nested class declarations and class expressions safely without crash', () => {
      const content = [
        'export class OuterCluster {',                                  // line 1
        '  public static NodeManager = class InternalNodeManager {',    // line 2
        '    public ping(): boolean { return true; }',                  // line 3
        '  };',                                                         // line 4
        '  public start(): void {',                                     // line 5
        '    console.log("cluster started");',                          // line 6
        '  }',                                                          // line 7
        '}',                                                            // line 8
      ].join('\n');

      // Edit modifies line 6 inside OuterCluster.start()
      const patch = [
        '@@ -5,3 +5,4 @@',
        '   public start(): void {',
        '+    this.validateTopology();',
        '     console.log("cluster started");',
        '   }',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/cluster/cluster.ts', patch, content },
      ]);

      const syms = outline.files[0].modifiedSymbols;
      expect(syms.some((s) => s.name === 'OuterCluster' || s.name === 'start')).toBe(true);
    });

    it('extracts React TSX functional components and JSX element changes', () => {
      const content = [
        'import React from "react";',                                                     // line 1
        '',                                                                               // line 2
        'interface UserProps {',                                                          // line 3
        '  name: string;',                                                                // line 4
        '}',                                                                              // line 5
        '',                                                                               // line 6
        'export const UserBadge: React.FC<UserProps> = ({ name }) => {',                  // line 7
        '  return (',                                                                     // line 8
        '    <div className="badge-container">',                                          // line 9
        '      <span>{name}</span>',                                                      // line 10
        '    </div>',                                                                     // line 11
        '  );',                                                                           // line 12
        '};',                                                                             // line 13
        '',                                                                               // line 14
        'export function UnchangedAvatar() {',                                            // line 15
        '  return <img src="avatar.png" alt="avatar" />;',                                // line 16
        '}',                                                                              // line 17
      ].join('\n');

      const patch = [
        '@@ -8,4 +8,5 @@',
        '   return (',
        '     <div className="badge-container">',
        '+      <i className="badge-icon" />',
        '       <span>{name}</span>',
        '     </div>',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/components/UserBadge.tsx', patch, content },
      ]);

      expect(outline.files).toHaveLength(1);
      const file = outline.files[0];
      expect(file.domainLane).toBe('ui_frontend');
      const symNames = file.modifiedSymbols.map((s) => s.name);
      expect(symNames).toContain('UserBadge');
      expect(symNames).not.toContain('UnchangedAvatar');
    });

    it('correctly parses in-memory patch reconstruction with complex TS syntax', () => {
      // Full content omitted: tests reconstructSourceFromPatch robustness
      const patch = [
        '@@ -10,6 +10,12 @@',
        ' export interface ApiResult<T> {',
        '+  data: T;',
        '+  status: number;',
        '+  meta?: Record<string, string>;',
        '+}',
        '+',
        '+export function processApiResult<T>(result: ApiResult<T>): T {',
        '+  return result.data;',
        '   cached: boolean;',
        ' }',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/api/resultHelper.ts', patch },
      ]);

      expect(outline.files[0].modifiedSymbols.length).toBeGreaterThan(0);
      const names = outline.files[0].modifiedSymbols.map((s) => s.name);
      expect(names).toContain('processApiResult');
    });

    it('intersects method overloads inside class declarations', () => {
      const content = [
        'export class QueryDispatcher {',                                         // line 1
        '  public execute(query: string): Promise<any>;',                         // line 2
        '  public execute(queries: string[]): Promise<any[]>;',                   // line 3
        '  public execute(arg: any): any {',                                      // line 4
        '    if (Array.isArray(arg)) return Promise.all(arg.map(q => q));',       // line 5
        '    return Promise.resolve(arg);',                                       // line 6
        '  }',                                                                    // line 7
        '}',                                                                      // line 8
      ].join('\n');

      const patch = [
        '@@ -4,3 +4,4 @@',
        '   public execute(arg: any): any {',
        '+    if (!arg) throw new Error("query required");',
        '     if (Array.isArray(arg)) return Promise.all(arg.map(q => q));',
        '     return Promise.resolve(arg);',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/db/dispatcher.ts', patch, content },
      ]);

      const syms = outline.files[0].modifiedSymbols;
      expect(syms.some((s) => s.name === 'QueryDispatcher' || s.name === 'execute')).toBe(true);
    });

    it('captures object-literal holding arrow functions via enclosing variable', () => {
      const content = [
        'export const routerHandlers = {',                                        // line 1
        '  login: async (req: any, res: any) => {',                               // line 2
        '    return res.json({ token: "abc" });',                                 // line 3
        '  },',                                                                   // line 4
        '  logout: async (req: any, res: any) => {',                              // line 5
        '    return res.json({ ok: true });',                                     // line 6
        '  },',                                                                   // line 7
        '};',                                                                     // line 8
      ].join('\n');

      // Modifies line 3 inside login
      const patch = [
        '@@ -2,3 +2,4 @@',
        '   login: async (req: any, res: any) => {',
        '+    if (!req.body.user) throw new Error("bad request");',
        '     return res.json({ token: "abc" });',
        '   },',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/api/handlers.ts', patch, content },
      ]);

      const syms = outline.files[0].modifiedSymbols;
      expect(syms.some((s) => s.name === 'routerHandlers' && s.kind === 'variable')).toBe(true);
    });

    it('handles class defined inside factory function cleanly', () => {
      const content = [
        'export function createCustomEngine() {',                                 // line 1
        '  class DynamicEngine {',                                                // line 2
        '    run() { return 100; }',                                              // line 3
        '  }',                                                                    // line 4
        '  return new DynamicEngine();',                                          // line 5
        '}',                                                                      // line 6
      ].join('\n');

      const patch = [
        '@@ -2,3 +2,4 @@',
        '   class DynamicEngine {',
        '+    validate() { return true; }',
        '     run() { return 100; }',
        '   }',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/engine/factory.ts', patch, content },
      ]);

      const syms = outline.files[0].modifiedSymbols;
      expect(syms.some((s) => s.name === 'createCustomEngine' || s.name === 'DynamicEngine')).toBe(true);
    });

    it('handles complex JSX fragments and nested components in TSX', () => {
      const content = [
        'import React from "react";',                                             // line 1
        'export const Layout: React.FC<{ title: string }> = ({ title, children }) => {', // line 2
        '  return (',                                                             // line 3
        '    <>',                                                                 // line 4
        '      <header><h1>{title}</h1></header>',                                // line 5
        '      <main>{children}</main>',                                          // line 6
        '    </>',                                                                // line 7
        '  );',                                                                   // line 8
        '};',                                                                     // line 9
      ].join('\n');

      const patch = [
        '@@ -4,4 +4,5 @@',
        '     <>',
        '+      <nav><a href="/">Home</a></nav>',
        '       <header><h1>{title}</h1></header>',
        '       <main>{children}</main>',
        '     </>',
      ].join('\n');

      const outline = generateFileTreeOutline([
        { path: 'src/ui/Layout.tsx', patch, content },
      ]);

      const file = outline.files[0];
      expect(file.domainLane).toBe('ui_frontend');
      expect(file.modifiedSymbols.some((s) => s.name === 'Layout')).toBe(true);
    });
  });

  // =========================================================================
  // 3. DOMAIN PARTITIONING EDGE CASES
  // =========================================================================
  describe('Dimension 3: Domain Partitioning & Monorepo Edge Cases', () => {
    it('classifies monorepo multi-package paths into appropriate domains', () => {
      const monorepoPaths = [
        { path: 'packages/auth/src/jwtService.ts', expected: 'security_auth' },
        { path: 'packages/database/src/migrations/001_init.sql', expected: 'data_persistence' },
        { path: 'packages/api-client/src/endpoints/userApi.ts', expected: 'api_contracts' },
        { path: 'apps/web/src/views/ProfilePage.tsx', expected: 'ui_frontend' },
        { path: 'services/worker/src/runner.ts', expected: 'system_runtime' },
        { path: 'docs/architecture/monorepo.md', expected: 'docs_assets' },
      ];

      for (const item of monorepoPaths) {
        expect(classifyPathByHeuristic(item.path)).toBe(item.expected);
      }
    });

    it('enforces precedence for security tokens in docs and non-code files', () => {
      // Markdown and whitelisted images mentioning auth/session stay in docs_assets
      expect(classifyPathByHeuristic('docs/auth/session-guide.md')).toBe('docs_assets');
      expect(classifyPathByHeuristic('docs/assets/session-flow.png')).toBe('docs_assets');

      // Fail-closed security floor: non-whitelisted doc/text formats (.pdf, .txt) with security keywords route to security_auth
      expect(classifyPathByHeuristic('documentation/security-whitepaper.pdf')).toBe('security_auth');
      // Delimited security keywords (slash, dot, underscore, hyphen) map to security_auth
      expect(classifyPathByHeuristic('src/middleware/authMiddleware.ts')).toBe('security_auth');
      expect(classifyPathByHeuristic('src/guard/permission_guard.ts')).toBe('security_auth');
      expect(classifyPathByHeuristic('src/auth/permissionGuard.ts')).toBe('security_auth');

      // Boundary limitation: compound camelCase in non-domain dirs without delimiters falls back to system_runtime
      expect(classifyPathByHeuristic('src/services/authGuard.ts')).toBe('system_runtime');
      expect(classifyPathByHeuristic('src/guards/permissionGuard.ts')).toBe('system_runtime');
    });

    it('handles unusual and modern file extensions appropriately', () => {
      expect(classifyPathByHeuristic('schema/users.prisma')).toBe('data_persistence');
      expect(classifyPathByHeuristic('proto/billing.proto')).toBe('api_contracts');
      expect(classifyPathByHeuristic('api/schema.graphql')).toBe('api_contracts');
      expect(classifyPathByHeuristic('components/Widget.vue')).toBe('ui_frontend');
      expect(classifyPathByHeuristic('components/Button.svelte')).toBe('ui_frontend');
      expect(classifyPathByHeuristic('templates/index.html.heex')).toBe('ui_frontend');
      expect(classifyPathByHeuristic('certs/server.crt')).toBe('security_auth');
      expect(classifyPathByHeuristic('keys/private.pem')).toBe('security_auth');
      expect(classifyPathByHeuristic('.env.production')).toBe('security_auth');
    });

    it('normalizes Windows backslashes, mixed slashes, and leading/trailing whitespace', () => {
      expect(classifyPathByHeuristic('src\\auth\\session.ts')).toBe('security_auth');
      expect(classifyPathByHeuristic('  apps/web/ui/Button.tsx  ')).toBe('ui_frontend');
      expect(classifyPathByHeuristic('priv\\repo\\migrations\\01.sql')).toBe('data_persistence');
      expect(classifyPathByHeuristic('')).toBe('system_runtime');
    });

    it('evaluates batch classification consistency with classifyDomainLanesByHeuristic', () => {
      const files = [
        { path: 'src/auth/login.ts' },
        { path: 'src/db/repo.ts' },
        { path: 'src/api/routes.ts' },
        { path: 'src/ui/App.tsx' },
      ];

      const mapping = classifyDomainLanesByHeuristic(files);
      expect(mapping['src/auth/login.ts']).toBe('security_auth');
      expect(mapping['src/db/repo.ts']).toBe('data_persistence');
      expect(mapping['src/api/routes.ts']).toBe('api_contracts');
      expect(mapping['src/ui/App.tsx']).toBe('ui_frontend');
    });
  });

  // =========================================================================
  // 4. TASK SCOPING & CONTEXT ISOLATION INVARIANTS
  // =========================================================================
  describe('Dimension 4: Task Scoping Invariants & Context Isolation', () => {
    const mixedFiles = [
      { path: 'src/auth/login.ts', patch: '@@ -1,1 +1,2 @@\n+export function login() {}' },
      { path: 'src/db/users.ts', patch: '@@ -1,1 +1,2 @@\n+export function findUser() {}' },
      { path: 'src/api/users.ts', patch: '@@ -1,1 +1,2 @@\n+export function getUserEndpoint() {}' },
      { path: 'src/ui/Profile.tsx', patch: '@@ -1,1 +1,2 @@\n+export function Profile() {}' },
    ];

    it('strictly isolates subagent outline to assigned paths only', () => {
      const full = generateFileTreeOutline(mixedFiles);
      const task: ReviewTask = {
        id: 'task-sec',
        dimension: 'security',
        paths: ['src/auth/login.ts'],
        question: 'Any auth flaws?',
        rationale: 'Reviewing auth',
      };

      const scoped = generateTaskScopedASTOutline(full, { task });
      expect(scoped.files).toHaveLength(1);
      expect(scoped.files[0].filePath).toBe('src/auth/login.ts');
      expect(scoped.summaryText).toContain('src/auth/login.ts');
      expect(scoped.summaryText).not.toContain('src/db/users.ts');
      expect(scoped.summaryText).not.toContain('src/api/users.ts');
      expect(scoped.summaryText).not.toContain('src/ui/Profile.tsx');
    });

    it('isolates subagent outline to persona domain affinity when paths are empty', () => {
      const full = generateFileTreeOutline(mixedFiles);
      const scopedSec = generateTaskScopedASTOutline(full, {
        persona: 'sec-lane',
      });

      expect(scopedSec.files).toHaveLength(1);
      expect(scopedSec.files[0].filePath).toBe('src/auth/login.ts');

      const scopedPerf = generateTaskScopedASTOutline(full, {
        persona: 'perf-lane',
      });
      // perf-lane has affinity with data_persistence and system_runtime
      expect(scopedPerf.files.map((f) => f.filePath)).toContain('src/db/users.ts');
      expect(scopedPerf.files.map((f) => f.filePath)).not.toContain('src/auth/login.ts');
    });
  });
});
