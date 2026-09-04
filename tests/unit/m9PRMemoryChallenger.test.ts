import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PRMemoryStore, ReviewerLearning, ResolvedNitPattern, ADRConstraint } from '../../src/memory/prMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import { GraphLearningEngine } from '../../src/memory/graphLearningEngine';
import { PanelFinding } from '../../src/panel/panelEngine';

const TEST_DIR = path.join(process.cwd(), '.tmp_m9_challenger_test');
const DISK_DB_PATH = path.join(TEST_DIR, 'nested', 'deep', 'pr_memory_stress.db');

describe('Milestone 9: PR Memory & Graph Learning Engine Stress & Oracle Verification', () => {
  beforeAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_) {}
    }
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (_) {}
    }
  });

  describe('1. High-Volume Concurrent Insertions & SQLite Operations', () => {
    let memoryStore: PRMemoryStore;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
    });

    afterEach(() => {
      memoryStore.close();
    });

    it('handles 200 concurrent learning, 200 nit, and 50 ADR insertions into in-memory store', async () => {
      const repo = 'calltelemetry/cisco-cdr';

      const learningPromises = Array.from({ length: 200 }, (_, i) =>
        memoryStore.recordLearning(repo, 100 + i, {
          category: (['convention', 'architecture', 'security', 'performance', 'style', 'adr'] as const)[i % 6],
          title: `Concurrent Learning ${i}`,
          description: `Description for learning ${i} with code ref`,
          filePath: `src/module_${i % 10}/file_${i}.ts`,
          confidence: 0.8 + (i % 20) * 0.01,
        })
      );

      const nitPromises = Array.from({ length: 200 }, (_, i) =>
        memoryStore.recordResolvedNit(repo, 200 + i, {
          pattern: `pattern_nit_${i}`,
          filePath: `src/module_${i % 10}/file_${i}.ts`,
          reason: `Resolved nit ${i}`,
          headSha: `sha_${i}`,
        })
      );

      const adrPromises = Array.from({ length: 50 }, (_, i) =>
        memoryStore.recordADRConstraint(repo, {
          adrNumber: i + 1,
          title: `ADR ${i + 1} Constraint`,
          status: i % 5 === 0 ? 'draft' : 'accepted',
          rule: `Rule enforcement for ADR ${i + 1}`,
          targetPaths: [`src/module_${i % 10}/**`, `tests/module_${i % 10}/**`],
        })
      );

      await Promise.all([...learningPromises, ...nitPromises, ...adrPromises]);

      const queried = await memoryStore.queryLearnings(repo);
      expect(queried.learnings.length).toBe(200);
      expect(queried.resolvedNits.length).toBe(200);
      // Only status='accepted' ADRs are returned by queryLearnings
      const expectedAcceptedADRs = Array.from({ length: 50 }).filter((_, i) => i % 5 !== 0).length;
      expect(queried.adrConstraints.length).toBe(expectedAcceptedADRs);
    });

    it('handles high-volume concurrent insertions into disk-backed SQLite database file', async () => {
      const diskStore = new PRMemoryStore(DISK_DB_PATH);
      const repo = 'calltelemetry/disk-stress-repo';

      const insertPromises = Array.from({ length: 150 }, (_, i) =>
        diskStore.recordLearning(repo, i, {
          category: 'security',
          title: `Disk Security Finding ${i}`,
          description: `Sanitize input for query ${i}`,
          filePath: `src/api/endpoint_${i}.ts`,
        })
      );

      await Promise.all(insertPromises);

      const result = await diskStore.queryLearnings(repo);
      expect(result.learnings.length).toBe(150);

      diskStore.close();
    });

    it('supports interleaved concurrent reads and writes without lock contention failures', async () => {
      const repo = 'calltelemetry/interleaved-repo';

      // Seed initial learnings
      for (let i = 0; i < 20; i++) {
        await memoryStore.recordLearning(repo, i, {
          category: 'performance',
          title: `Initial Performance ${i}`,
          description: `Optimize loop ${i}`,
        });
      }

      const operations: Promise<any>[] = [];

      // 50 writes
      for (let i = 20; i < 70; i++) {
        operations.push(
          memoryStore.recordLearning(repo, i, {
            category: 'architecture',
            title: `Interleaved Learning ${i}`,
            description: `Decouple module ${i}`,
          })
        );
      }

      // 50 concurrent queries
      for (let i = 0; i < 50; i++) {
        operations.push(memoryStore.queryLearnings(repo, { category: 'architecture' }));
      }

      const results = await Promise.all(operations);
      expect(results.length).toBe(100);

      const finalState = await memoryStore.queryLearnings(repo);
      expect(finalState.learnings.length).toBe(70);
    });

    it('correctly increments nit suppression count under 50 concurrent parallel calls', async () => {
      const repo = 'calltelemetry/nit-concurrency';
      const nit = await memoryStore.recordResolvedNit(repo, 1, {
        pattern: 'avoid-any-type',
        filePath: 'src/types.ts',
        reason: 'Strict TypeScript typing enforced',
      });

      const nitId = nit.id!;
      const incrementPromises = Array.from({ length: 50 }, () =>
        memoryStore.incrementNitSuppression(nitId)
      );

      await Promise.all(incrementPromises);

      const queried = await memoryStore.queryLearnings(repo, { filePath: 'src/types.ts' });
      expect(queried.resolvedNits.length).toBe(1);
      expect(queried.resolvedNits[0].suppressionCount).toBe(50);
    });

    it('isolates repo memory when clearing specific repository', async () => {
      const repoA = 'org/repo-a';
      const repoB = 'org/repo-b';

      await memoryStore.recordLearning(repoA, 1, {
        category: 'style',
        title: 'Repo A learning',
        description: 'Repo A desc',
      });
      await memoryStore.recordLearning(repoB, 1, {
        category: 'style',
        title: 'Repo B learning',
        description: 'Repo B desc',
      });

      await memoryStore.clearRepoMemory(repoA);

      const resA = await memoryStore.queryLearnings(repoA);
      const resB = await memoryStore.queryLearnings(repoB);

      expect(resA.learnings.length).toBe(0);
      expect(resB.learnings.length).toBe(1);
      expect(resB.learnings[0].title).toBe('Repo B learning');
    });
  });

  describe('2. Complex Regex & Invalid Regex Nit Pattern Handling', () => {
    let memoryStore: PRMemoryStore;
    let symbolStore: SymbolGraphStore;
    let engine: GraphLearningEngine;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
      symbolStore = new SymbolGraphStore(':memory:');
      engine = new GraphLearningEngine(memoryStore, symbolStore);
    });

    afterEach(() => {
      memoryStore.close();
      symbolStore.close();
    });

    it('handles invalid regex nit patterns gracefully without throwing uncaught exceptions', async () => {
      const repo = 'calltelemetry/invalid-regex';

      // Insert invalid regexes that fail RegExp constructor
      const invalidPatterns = [
        '[unclosed-character-class',
        '(unclosed group',
        '*startsWithQuantifier',
        '\\',
        '(?<invalid-group-name',
      ];

      for (let i = 0; i < invalidPatterns.length; i++) {
        await memoryStore.recordResolvedNit(repo, i + 1, {
          pattern: invalidPatterns[i],
          filePath: '',
          reason: `Invalid regex pattern ${i}`,
        });
      }

      const findings: PanelFinding[] = [
        {
          severity: 'P2',
          path: 'src/file.ts',
          line: 10,
          title: 'Contains [unclosed-character-class in text',
          body: 'This finding title contains exact substring match of invalid regex',
        },
        {
          severity: 'P1',
          path: 'src/file.ts',
          line: 20,
          title: 'Normal finding',
          body: 'Does not match any pattern',
        },
      ];

      // Should not throw exception; invalid regex should fall back to includes() substring match
      const result = await engine.analyzeAndFilterFindings(repo, findings);

      expect(result.suppressedNits.length).toBe(1);
      expect(result.suppressedNits[0].finding.title).toContain('[unclosed-character-class');
      expect(result.filteredFindings.length).toBe(1);
      expect(result.filteredFindings[0].title).toBe('Normal finding');
    });

    it('matches complex valid regex patterns case-insensitively across title and body', async () => {
      const repo = 'calltelemetry/regex-repo';

      await memoryStore.recordResolvedNit(repo, 1, {
        pattern: 'console\\.(log|warn|error)\\(.*\\)',
        filePath: 'src/app.ts',
        reason: 'Use logger instance',
      });

      await memoryStore.recordResolvedNit(repo, 2, {
        pattern: '(TODO|FIXME):\\s+[A-Za-z0-9_]+',
        filePath: '',
        reason: 'Track technical debt in Jira',
      });

      const findings: PanelFinding[] = [
        {
          severity: 'P2',
          path: 'src/app.ts',
          line: 15,
          title: 'Found CONSOLE.LOG("debug")',
          body: 'Line contains console.log statement',
        },
        {
          severity: 'P2',
          path: 'src/utils/helper.ts',
          line: 42,
          title: 'Unresolved technical debt',
          body: 'Comment says todo: refactorThisFunction later',
        },
        {
          severity: 'P0',
          path: 'src/app.ts',
          line: 99,
          title: 'SQL Injection vulnerability',
          body: 'Raw string concatenation in query',
        },
      ];

      const result = await engine.analyzeAndFilterFindings(repo, findings);

      expect(result.suppressedNits.length).toBe(2);
      expect(result.filteredFindings.length).toBe(1);
      expect(result.filteredFindings[0].title).toBe('SQL Injection vulnerability');
    });

    it('respects file path specificity for resolved nit suppression', async () => {
      const repo = 'calltelemetry/path-repo';

      await memoryStore.recordResolvedNit(repo, 1, {
        pattern: 'unused variable',
        filePath: 'src/legacy/oldCode.ts',
        reason: 'Allowed in legacy package',
      });

      const findings: PanelFinding[] = [
        {
          severity: 'P2',
          path: 'src/legacy/oldCode.ts',
          line: 5,
          title: 'Unused variable detected',
          body: 'Variable x is never read',
        },
        {
          severity: 'P2',
          path: 'src/new/freshCode.ts',
          line: 10,
          title: 'Unused variable detected',
          body: 'Variable y is never read',
        },
      ];

      const result = await engine.analyzeAndFilterFindings(repo, findings);

      // Only the legacy file finding should be suppressed
      expect(result.suppressedNits.length).toBe(1);
      expect(result.suppressedNits[0].finding.path).toBe('src/legacy/oldCode.ts');
      expect(result.filteredFindings.length).toBe(1);
      expect(result.filteredFindings[0].path).toBe('src/new/freshCode.ts');
    });
  });

  describe('3. Glob Matching Edge Cases for ADR Constraints', () => {
    let memoryStore: PRMemoryStore;
    let symbolStore: SymbolGraphStore;
    let engine: GraphLearningEngine;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
      symbolStore = new SymbolGraphStore(':memory:');
      engine = new GraphLearningEngine(memoryStore, symbolStore);
    });

    afterEach(() => {
      memoryStore.close();
      symbolStore.close();
    });

    it('correctly matches wildcards, nested paths, and root path edge cases', async () => {
      const repo = 'calltelemetry/adr-globs';

      await memoryStore.recordADRConstraint(repo, {
        adrNumber: 10,
        title: 'Global Wildcard ADR',
        status: 'accepted',
        rule: 'Applies to all files',
        targetPaths: ['**'],
      });

      await memoryStore.recordADRConstraint(repo, {
        adrNumber: 11,
        title: 'Nested Directory ADR',
        status: 'accepted',
        rule: 'Applies to deep utils',
        targetPaths: ['src/**/utils/*.ts', 'docs/**/*.md'],
      });

      await memoryStore.recordADRConstraint(repo, {
        adrNumber: 12,
        title: 'Root Path ADR',
        status: 'accepted',
        rule: 'Applies to root level files',
        targetPaths: ['*.ts', 'src/github/**'],
      });

      const findings1: PanelFinding[] = [
        {
          severity: 'P1',
          path: 'src/deep/nested/utils/stringHelper.ts',
          line: 10,
          title: 'Helper issue',
          body: 'Detail',
        },
      ];

      const res1 = await engine.analyzeAndFilterFindings(repo, findings1);
      const applied1 = res1.appliedADRs.map((a) => a.adrNumber).sort((a, b) => a - b);
      expect(applied1).toEqual([10, 11]);

      const findings2: PanelFinding[] = [
        {
          severity: 'P1',
          path: 'src/github/webhookServer.ts',
          line: 15,
          title: 'Webhook issue',
          body: 'Detail',
        },
      ];

      const res2 = await engine.analyzeAndFilterFindings(repo, findings2);
      const applied2 = res2.appliedADRs.map((a) => a.adrNumber).sort((a, b) => a - b);
      expect(applied2).toEqual([10, 12]);
    });

    it('does not apply ADR constraints when changed file paths do not match globs', async () => {
      const repo = 'calltelemetry/adr-no-match';

      await memoryStore.recordADRConstraint(repo, {
        adrNumber: 20,
        title: 'Security Boundary ADR',
        status: 'accepted',
        rule: 'Security checks on auth module',
        targetPaths: ['src/auth/**', 'src/security/**'],
      });

      const findings: PanelFinding[] = [
        {
          severity: 'P2',
          path: 'src/ui/components/button.tsx',
          line: 30,
          title: 'UI styling flaw',
          body: 'Button color mismatch',
        },
      ];

      const result = await engine.analyzeAndFilterFindings(repo, findings);
      expect(result.appliedADRs.length).toBe(0);
    });

    it('handles glob patterns containing special regex characters without throwing errors', async () => {
      const repo = 'calltelemetry/adr-special-chars';

      await memoryStore.recordADRConstraint(repo, {
        adrNumber: 30,
        title: 'Special Pattern ADR',
        status: 'accepted',
        rule: 'Check versioned files',
        targetPaths: ['src/v1.0(beta)/*', 'src/app[v2]/**'],
      });

      const findings: PanelFinding[] = [
        {
          severity: 'P1',
          path: 'src/v1.0(beta)/index.ts',
          line: 1,
          title: 'Version finding',
          body: 'Check version',
        },
      ];

      // Should run safely without uncaught regex syntax errors
      const result = await engine.analyzeAndFilterFindings(repo, findings);
      expect(result.appliedADRs).toBeDefined();
    });
  });

  describe('4. Symbol Risk Score Under Extreme Caller & Learning Counts', () => {
    let memoryStore: PRMemoryStore;
    let symbolStore: SymbolGraphStore;
    let engine: GraphLearningEngine;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
      symbolStore = new SymbolGraphStore(':memory:');
      engine = new GraphLearningEngine(memoryStore, symbolStore);
    });

    afterEach(() => {
      memoryStore.close();
      symbolStore.close();
    });

    it('calculates default base risk score (0.1) when callers and learnings are zero', async () => {
      const repo = 'calltelemetry/cisco-cdr';
      const risk = await engine.calculateSymbolRisk(repo, 'UnknownSymbol');

      expect(risk.symbolName).toBe('UnknownSymbol');
      expect(risk.callersCount).toBe(0);
      expect(risk.pastLearningsCount).toBe(0);
      expect(risk.riskScore).toBe(0.1);
    });

    it('calculates score accurately for moderate callers and learnings count', async () => {
      const repo = 'calltelemetry/cisco-cdr';
      const symbolName = 'ModerateSymbol';

      // Insert callers directly into SQLite store
      const db = (symbolStore as any).db;
      db.exec(`
        INSERT INTO files (file_path, language, hash, line_count) VALUES ('src/test.ts', 'typescript', 'hash', 100);
        INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, start_column, end_column)
        VALUES ('sym_target', 'src/test.ts', '${symbolName}', 'function', 1, 10, 0, 0);
      `);

      for (let i = 0; i < 4; i++) {
        db.exec(`
          INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, start_column, end_column)
          VALUES ('caller_${i}', 'src/test.ts', 'Caller${i}', 'function', 1, 10, 0, 0);
          INSERT INTO call_graph (caller_symbol_id, callee_symbol_name, file_path, line)
          VALUES ('caller_${i}', '${symbolName}', 'src/test.ts', ${i + 1});
        `);
      }

      // Record 2 past learnings
      for (let i = 0; i < 2; i++) {
        await memoryStore.recordLearning(repo, i + 1, {
          category: 'architecture',
          title: `Learning referencing ${symbolName}`,
          description: `Fix issue in ${symbolName}`,
        });
      }

      const risk = await engine.calculateSymbolRisk(repo, symbolName);

      expect(risk.callersCount).toBe(4);
      expect(risk.pastLearningsCount).toBe(2);
      // Base (0.1) + Callers (4 * 0.05 = 0.2) + Learnings (2 * 0.15 = 0.3) = 0.6
      expect(risk.riskScore).toBe(0.6);
    });

    it('caps risk score at 1.0 when caller count is extremely high (150 callers)', async () => {
      const repo = 'calltelemetry/cisco-cdr';
      const symbolName = 'HighCallerSymbol';

      const db = (symbolStore as any).db;
      db.exec(`
        INSERT INTO files (file_path, language, hash, line_count) VALUES ('src/hub.ts', 'typescript', 'hash', 500);
      `);

      for (let i = 0; i < 150; i++) {
        db.exec(`
          INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, start_column, end_column)
          VALUES ('caller_sym_${i}', 'src/hub.ts', 'CallerSym${i}', 'function', 1, 10, 0, 0);
          INSERT INTO call_graph (caller_symbol_id, callee_symbol_name, file_path, line)
          VALUES ('caller_sym_${i}', '${symbolName}', 'src/hub.ts', ${i + 1});
        `);
      }

      const risk = await engine.calculateSymbolRisk(repo, symbolName);

      expect(risk.callersCount).toBe(150);
      expect(risk.pastLearningsCount).toBe(0);
      // Raw score: 0.1 + (150 * 0.05) = 7.6 -> should cap at 1.0
      expect(risk.riskScore).toBe(1.0);
    });

    it('caps risk score at 1.0 when past learnings count is extremely high (150 learnings)', async () => {
      const repo = 'calltelemetry/cisco-cdr';
      const symbolName = 'BuggySymbol';

      for (let i = 0; i < 150; i++) {
        await memoryStore.recordLearning(repo, i + 1, {
          category: 'security',
          title: `Bug in ${symbolName} #${i}`,
          description: `Vulnerability found in ${symbolName}`,
        });
      }

      const risk = await engine.calculateSymbolRisk(repo, symbolName);

      expect(risk.callersCount).toBe(0);
      expect(risk.pastLearningsCount).toBe(150);
      // Raw score: 0.1 + (150 * 0.15) = 22.6 -> should cap at 1.0
      expect(risk.riskScore).toBe(1.0);
    });

    it('maintains 2 decimal precision without floating point representation issues', async () => {
      const repo = 'calltelemetry/cisco-cdr';
      const symbolName = 'PrecisionSymbol';

      // 1 caller (0.05), 1 learning (0.15) -> 0.1 + 0.05 + 0.15 = 0.3
      const db = (symbolStore as any).db;
      db.exec(`
        INSERT INTO files (file_path, language, hash, line_count) VALUES ('src/p.ts', 'typescript', 'h', 10);
        INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, start_column, end_column)
        VALUES ('c1', 'src/p.ts', 'C1', 'function', 1, 5, 0, 0);
        INSERT INTO call_graph (caller_symbol_id, callee_symbol_name, file_path, line)
        VALUES ('c1', '${symbolName}', 'src/p.ts', 2);
      `);

      await memoryStore.recordLearning(repo, 1, {
        category: 'style',
        title: `Ref ${symbolName}`,
        description: 'desc',
      });

      const risk = await engine.calculateSymbolRisk(repo, symbolName);
      expect(risk.riskScore).toBe(0.3);
      expect(typeof risk.riskScore).toBe('number');
      expect(Number.isFinite(risk.riskScore)).toBe(true);
    });
  });

  describe('5. In-Memory vs Disk-Backed Database Initialization & Persistence', () => {
    it('creates nested directories automatically when initialized with disk path', () => {
      const customDbPath = path.join(TEST_DIR, 'auto_create', 'deep', 'store.db');
      const store = new PRMemoryStore(customDbPath);

      expect(fs.existsSync(customDbPath)).toBe(true);

      store.close();
    });

    it('persists learnings, nits, and ADR constraints across database re-instantiations', async () => {
      const dbPath = path.join(TEST_DIR, 'persistence', 'memory.db');
      if (fs.existsSync(dbPath)) {
        try {
          fs.unlinkSync(dbPath);
        } catch {}
      }
      const repo = 'calltelemetry/persistent-repo';

      // Phase 1: Write data and close store
      const store1 = new PRMemoryStore(dbPath);
      await store1.recordLearning(repo, 42, {
        category: 'architecture',
        title: 'Persistent Learning',
        description: 'Should survive close and reopen',
      });
      await store1.recordResolvedNit(repo, 42, {
        pattern: 'no-eval',
        filePath: 'src/eval.ts',
        reason: 'Security policy',
      });
      await store1.recordADRConstraint(repo, {
        adrNumber: 99,
        title: 'Persistent ADR',
        status: 'accepted',
        rule: 'No eval allowed',
        targetPaths: ['src/**'],
      });
      store1.close();

      // Phase 2: Open new store instance pointing to same file
      const store2 = new PRMemoryStore(dbPath);
      const data = await store2.queryLearnings(repo);

      expect(data.learnings.length).toBe(1);
      expect(data.learnings[0].title).toBe('Persistent Learning');

      expect(data.resolvedNits.length).toBe(1);
      expect(data.resolvedNits[0].pattern).toBe('no-eval');

      expect(data.adrConstraints.length).toBe(1);
      expect(data.adrConstraints[0].title).toBe('Persistent ADR');

      store2.close();
    });

    it('initializes sqlite database schema tables and indexes properly', () => {
      const store = new PRMemoryStore(':memory:');
      const db = (store as any).db;

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain('learnings');
      expect(tables).toContain('resolved_nits');
      expect(tables).toContain('adr_constraints');

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((r: any) => r.name);

      expect(indexes).toContain('idx_learnings_repo');
      expect(indexes).toContain('idx_nits_repo');
      expect(indexes).toContain('idx_adr_repo');

      store.close();
    });

    it('allows graceful closing and handles double close without throwing', () => {
      const store = new PRMemoryStore(':memory:');
      expect(() => {
        store.close();
        store.close();
      }).not.toThrow();
    });
  });
});
