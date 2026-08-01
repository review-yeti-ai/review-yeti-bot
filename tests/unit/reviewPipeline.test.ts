import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

// Resolve path to root repository .github/workflows/pipelines/review-pipeline.js
const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipelinePath = path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js');
const pipeline = require(pipelinePath);

describe('PI.dev Review Workflow Pipeline Script (.github/workflows/pipelines/review-pipeline.js)', () => {
  it('1. Script file exists and is executable', () => {
    expect(fs.existsSync(pipelinePath)).toBe(true);
    const content = fs.readFileSync(pipelinePath, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
  });

  it('2. Loads 12 persona charters with default model openrouter/auto', () => {
    const { PERSONA_CHARTERS, DEFAULT_MODEL } = pipeline;
    expect(DEFAULT_MODEL).toBe('openrouter/auto');
    expect(PERSONA_CHARTERS).toHaveLength(12);

    const expectedPersonas = [
      'security',
      'performance',
      'architecture',
      'style',
      'testing',
      'documentation',
      'accessibility',
      'database',
      'devops',
      'i18n',
      'dependencies',
      'licensing',
    ];

    const actualPersonas = PERSONA_CHARTERS.map((p: any) => p.id);
    expect(actualPersonas).toEqual(expectedPersonas);

    PERSONA_CHARTERS.forEach((persona: any) => {
      expect(persona.model).toBe('openrouter/auto');
      expect(persona.charter).toBeDefined();
      expect(persona.charter.length).toBeGreaterThan(10);
    });
  });

  it('3. Parses diff payload correctly', () => {
    const rawDiff = `diff --git a/src/server.ts b/src/server.ts
index 123456..789abc 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,3 +1,5 @@
 import express from 'express';
+const apiKey = "sk-proj-1234567890abcdef12345678";
`;
    const parsed = pipeline.parseDiff(rawDiff);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/server.ts');
    expect(parsed[0].addedLines.some((l: any) => l.text.includes('sk-proj'))).toBe(true);
  });

  it('4. Evaluates 12 personas in parallel and computes binding arbitration quorum', async () => {
    const { PERSONA_CHARTERS, evaluatePersonaLane, computeArbitrationQuorum } = pipeline;
    const diffFiles = [
      {
        path: 'db/migrations/001_init.sql',
        patch: 'DROP TABLE users;',
        addedLines: [{ text: 'DROP TABLE users;' }],
        deletedLines: [],
      },
    ];

    const prContext = {
      prNumber: '99',
      repo: 'calltelemetry/ct-review-bot',
      headSha: 'abc1234def',
      title: 'Destructive DB Migration PR',
    };

    const results = await Promise.all(
      PERSONA_CHARTERS.map((p: any) => evaluatePersonaLane(p, diffFiles, prContext))
    );

    expect(results).toHaveLength(12);
    const dbResult = results.find((r: any) => r.personaId === 'database');
    expect(dbResult.decision).toBe('FINDINGS');
    expect(dbResult.findings[0].severity).toBe('P0');

    const arbitration = computeArbitrationQuorum(results);
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.quorumSatisfied).toBe(true);
    expect(arbitration.completedPersonas).toBe(12);
  });

  it('5. Formats GitHub PR comment output containing Mermaid diagram and persona roster breakdown', () => {
    const { PERSONA_CHARTERS, formatPRComment } = pipeline;
    const mockResults = PERSONA_CHARTERS.map((p: any) => ({
      personaId: p.id,
      displayName: p.name,
      model: p.model,
      decision: 'APPROVE',
      findings: [],
    }));

    const mockArbitration = {
      totalPersonas: 12,
      completedPersonas: 12,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'All 12 persona evaluations passed.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    };

    const prContext = {
      prNumber: '101',
      repo: 'calltelemetry/ct-review-bot',
      headSha: '1a2b3c4d5e',
    };

    const formattedComment = formatPRComment(mockArbitration, mockResults, prContext);

    expect(formattedComment).toContain('## 🟢 **Verdict: SHIP**');
    expect(formattedComment).toContain('```mermaid');
    expect(formattedComment).toContain('flowchart TD');
    expect(formattedComment).toContain('openrouter/auto');
    expect(formattedComment).toContain('🛡️ Security & Tenancy Guardian');
    expect(formattedComment).toContain('📄 License & IP Compliance');
  });

  it('6. Executes main pipeline cleanly without unhandled exceptions', async () => {
    // Set environment variables for test execution
    process.env.PR_NUMBER = '777';
    process.env.PR_DIFF = `diff --git a/README.md b/README.md
+ ## Documentation update
`;
    await expect(pipeline.main()).resolves.not.toThrow();
  });

  // =========================================================================
  // EDGE CASE & RESILIENCE STRESS TESTS
  // =========================================================================

  describe('Edge Cases: Diff Parsing & Environment Context', () => {
    it('7. Handles empty, null, undefined, and non-git diff inputs safely', () => {
      expect(pipeline.parseDiff('')).toEqual([]);
      expect(pipeline.parseDiff(null)).toEqual([]);
      expect(pipeline.parseDiff(undefined)).toEqual([]);

      // Raw unformatted diff fallback to src/index.ts
      const rawText = '+ console.log("hello world");';
      const parsedRaw = pipeline.parseDiff(rawText);
      expect(parsedRaw).toHaveLength(1);
      expect(parsedRaw[0].path).toBe('src/index.ts');
      expect(parsedRaw[0].addedLines[0].text).toBe(' console.log("hello world");');
    });

    it('8. Handles JSON payload in PR_DIFF environment variable correctly', () => {
      const originalEnv = process.env.PR_DIFF;
      try {
        process.env.PR_DIFF = JSON.stringify({
          diff: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+ const x = 1;\n',
          prNumber: 42,
          repo: 'custom/repo',
          headSha: 'cafebabe1234',
          title: 'Custom JSON Title',
        });
        const ctx = pipeline.getPRDiffAndContext();
        expect(ctx.prNumber).toBe('42');
        expect(ctx.repo).toBe('custom/repo');
        expect(ctx.headSha).toBe('cafebabe1234');
        expect(ctx.title).toBe('Custom JSON Title');
        expect(ctx.diffText).toContain('src/api/user.ts');
      } finally {
        process.env.PR_DIFF = originalEnv;
      }
    });

    it('9. Handles invalid JSON in PR_DIFF cleanly as raw diff text fallback', () => {
      const originalEnv = process.env.PR_DIFF;
      try {
        process.env.PR_DIFF = '{ invalid json payload... diff --git a/foo.ts b/foo.ts';
        const ctx = pipeline.getPRDiffAndContext();
        expect(ctx.diffText).toContain('{ invalid json payload');
      } finally {
        process.env.PR_DIFF = originalEnv;
      }
    });
  });

  describe('Edge Cases: Persona Evaluation Rules across all 12 Personas', () => {
    const { PERSONA_CHARTERS, evaluatePersonaLane } = pipeline;
    const findPersona = (id: string) => PERSONA_CHARTERS.find((p: any) => p.id === id);

    it('10. Security persona flags hardcoded secrets and missing tenancy checks', async () => {
      const secPersona = findPersona('security');

      // Secret detection (P0) - alphanumeric token
      const diffSecret = [{
        path: 'src/config.ts',
        patch: '+ const token = "sk-0123456789abcdef0123456789";\n',
        addedLines: [{ text: ' const token = "sk-0123456789abcdef0123456789";' }],
      }];
      const resSecret = await evaluatePersonaLane(secPersona, diffSecret, {});
      expect(resSecret.decision).toBe('FINDINGS');
      expect(resSecret.findings[0].severity).toBe('P0');
      expect(resSecret.findings[0].title).toBe('Hardcoded Secret Detected');

      // Tenancy check (P1)
      const diffApiNoAuth = [{
        path: 'src/api/users.ts',
        patch: '+ app.get("/api/users", (req, res) => { const id = req.query.id; });\n',
        addedLines: [{ text: ' app.get("/api/users", (req, res) => { const id = req.query.id; });' }],
      }];
      const resTenancy = await evaluatePersonaLane(secPersona, diffApiNoAuth, {});
      expect(resTenancy.decision).toBe('FINDINGS');
      expect(resTenancy.findings.some((f: any) => f.severity === 'P1')).toBe(true);
    });

    it('11. Performance persona flags async sequential loops and sync I/O in API hot path', async () => {
      const perfPersona = findPersona('performance');

      // Async loop (P1)
      const diffLoop = [{
        path: 'src/services/fetcher.ts',
        patch: '+ for (const id of ids) { await fetch(id); }\n',
        addedLines: [{ text: ' for (const id of ids) { await fetch(id); }' }],
      }];
      const resLoop = await evaluatePersonaLane(perfPersona, diffLoop, {});
      expect(resLoop.decision).toBe('FINDINGS');
      expect(resLoop.findings[0].severity).toBe('P1');
      expect(resLoop.findings[0].title).toBe('N+1 Query / Async Sequential Loop');

      // Sync I/O in API hot path (P2)
      const diffSync = [{
        path: 'src/server/api/handler.ts',
        patch: '+ const data = fs.readFileSync("/tmp/data");\n',
        addedLines: [{ text: ' const data = fs.readFileSync("/tmp/data");' }],
      }];
      const resSync = await evaluatePersonaLane(perfPersona, diffSync, {});
      expect(resSync.decision).toBe('FINDINGS');
      expect(resSync.findings[0].severity).toBe('P2');
      expect(resSync.findings[0].title).toBe('Synchronous Blocking I/O in API Hot Path');
    });

    it('12. Architecture persona flags deep cross-layer coupling', async () => {
      const archPersona = findPersona('architecture');
      const diffArch = [{
        path: 'src/domain/userEntity.ts',
        patch: '+ import { UserView } from "../../../presentation/views";\n',
        addedLines: [{ text: ' import { UserView } from "../../../presentation/views";' }],
      }];
      const resArch = await evaluatePersonaLane(archPersona, diffArch, {});
      expect(resArch.decision).toBe('FINDINGS');
      expect(resArch.findings[0].severity).toBe('P2');
      expect(resArch.findings[0].title).toBe('Layer Boundary Coupling Hazard');
    });

    it('13. Style persona flags console.log debug statements', async () => {
      const stylePersona = findPersona('style');
      const diffStyle = [{
        path: 'src/utils/math.ts',
        patch: '+ console.log("debug math");\n',
        addedLines: [{ text: ' console.log("debug math");' }],
      }];
      const resStyle = await evaluatePersonaLane(stylePersona, diffStyle, {});
      expect(resStyle.decision).toBe('FINDINGS');
      expect(resStyle.findings[0].severity).toBe('P2');
      expect(resStyle.findings[0].title).toBe('Leftover Debug Statement');
    });

    it('14. Testing persona flags active .only() markers', async () => {
      const testPersona = findPersona('testing');
      const diffTest = [{
        path: 'tests/unit/app.test.ts',
        patch: '+ describe.only("focused suite", () => {});\n',
        addedLines: [{ text: ' describe.only("focused suite", () => {});' }],
      }];
      const resTest = await evaluatePersonaLane(testPersona, diffTest, {});
      expect(resTest.decision).toBe('FINDINGS');
      expect(resTest.findings[0].severity).toBe('P1');
      expect(resTest.findings[0].title).toBe('Exclusive Test Marker Left Active');
    });

    it('15. Documentation persona flags exported functions without JSDoc', async () => {
      const docPersona = findPersona('documentation');
      const diffDoc = [{
        path: 'src/lib/calculator.ts',
        patch: '+ export function add(a: number, b: number) { return a + b; }\n',
        addedLines: [{ text: ' export function add(a: number, b: number) { return a + b; }' }],
      }];
      const resDoc = await evaluatePersonaLane(docPersona, diffDoc, {});
      expect(resDoc.decision).toBe('FINDINGS');
      expect(resDoc.findings[0].severity).toBe('P2');
      expect(resDoc.findings[0].title).toBe('Missing Docstring / JSDoc Annotation');
    });

    it('16. Accessibility persona flags img elements missing alt attribute', async () => {
      const a11yPersona = findPersona('accessibility');
      const diffA11y = [{
        path: 'src/components/Avatar.tsx',
        patch: '+ return <img src="/logo.png" />;\n',
        addedLines: [{ text: ' return <img src="/logo.png" />;' }],
      }];
      const resA11y = await evaluatePersonaLane(a11yPersona, diffA11y, {});
      expect(resA11y.decision).toBe('FINDINGS');
      expect(resA11y.findings[0].severity).toBe('P2');
      expect(resA11y.findings[0].title).toBe('Image Missing Alt Text (WCAG 2.1)');
    });

    it('17. Database persona flags DROP COLUMN destructive migrations', async () => {
      const dbPersona = findPersona('database');
      const diffDb = [{
        path: 'db/migrations/002_drop.sql',
        patch: '+ ALTER TABLE users DROP COLUMN phone;\n',
        addedLines: [{ text: ' ALTER TABLE users DROP COLUMN phone;' }],
      }];
      const resDb = await evaluatePersonaLane(dbPersona, diffDb, {});
      expect(resDb.decision).toBe('FINDINGS');
      expect(resDb.findings[0].severity).toBe('P0');
      expect(resDb.findings[0].title).toBe('Destructive DDL Schema Migration Hazard');
    });

    it('18. DevOps persona flags Dockerfile missing non-root USER directive', async () => {
      const devopsPersona = findPersona('devops');
      const diffDevops = [{
        path: 'Dockerfile',
        patch: '+ ENTRYPOINT ["node", "dist/index.js"]\n',
        addedLines: [{ text: ' ENTRYPOINT ["node", "dist/index.js"]' }],
      }];
      const resDevops = await evaluatePersonaLane(devopsPersona, diffDevops, {});
      expect(resDevops.decision).toBe('FINDINGS');
      expect(resDevops.findings[0].severity).toBe('P1');
      expect(resDevops.findings[0].title).toBe('Container Non-Root User Missing');
    });

    it('19. i18n persona flags hardcoded string in UI components', async () => {
      const i18nPersona = findPersona('i18n');
      const diffI18n = [{
        path: 'src/components/Header.tsx',
        patch: '+ return <h1>Welcome User</h1>;\n',
        addedLines: [{ text: ' return <h1>Welcome User</h1>;' }],
      }];
      const resI18n = await evaluatePersonaLane(i18nPersona, diffI18n, {});
      expect(resI18n.decision).toBe('FINDINGS');
      expect(resI18n.findings[0].severity).toBe('P2');
      expect(resI18n.findings[0].title).toBe('Hardcoded User Interface Text String');
    });

    it('20. Dependencies persona flags unpinned wildcard dependencies', async () => {
      const depPersona = findPersona('dependencies');
      const diffDep = [{
        path: 'package.json',
        patch: '+ "express": "*"\n',
        addedLines: [{ text: ' "express": "*"' }],
      }];
      const resDep = await evaluatePersonaLane(depPersona, diffDep, {});
      expect(resDep.decision).toBe('FINDINGS');
      expect(resDep.findings[0].severity).toBe('P1');
      expect(resDep.findings[0].title).toBe('Unpinned Wildcard Dependency Version');
    });

    it('21. Licensing persona flags missing headers in large source files', async () => {
      const licPersona = findPersona('licensing');
      const addedLines = Array(60).fill({ text: 'const line = 1;' });
      const diffLic = [{
        path: 'src/largeModule.ts',
        patch: addedLines.map(l => '+' + l.text).join('\n'),
        addedLines,
      }];
      const resLic = await evaluatePersonaLane(licPersona, diffLic, {});
      expect(resLic.decision).toBe('FINDINGS');
      expect(resLic.findings[0].severity).toBe('P2');
      expect(resLic.findings[0].title).toBe('Missing License Header Notice');
    });
  });

  describe('Edge Cases & Quorum Thresholds: computeArbitrationQuorum', () => {
    const { computeArbitrationQuorum } = pipeline;

    it('22. Computes FIX_FIRST for 1 P1 finding or 5+ P2 findings', () => {
      const resultsP1 = [{ findings: [{ severity: 'P1' }] }];
      const quorumP1 = computeArbitrationQuorum(resultsP1 as any);
      expect(quorumP1.verdict).toBe('FIX_FIRST');

      const resultsP2 = [{
        findings: [
          { severity: 'P2' },
          { severity: 'P2' },
          { severity: 'P2' },
          { severity: 'P2' },
          { severity: 'P2' },
        ],
      }];
      const quorumP2 = computeArbitrationQuorum(resultsP2 as any);
      expect(quorumP2.verdict).toBe('FIX_FIRST');
    });

    it('23. Computes BLOCK for 3+ P1 findings or 1 P0 finding', () => {
      const resultsP1s = [
        { findings: [{ severity: 'P1' }, { severity: 'P1' }, { severity: 'P1' }] },
      ];
      const quorumP1s = computeArbitrationQuorum(resultsP1s as any);
      expect(quorumP1s.verdict).toBe('BLOCK');
    });
  });

  describe('Stress & Performance Testing', () => {
    it('24. Stress test: Evaluates 50 files and 2,000 diff lines across all 12 personas in parallel (<1000ms)', async () => {
      const { PERSONA_CHARTERS, evaluatePersonaLane, computeArbitrationQuorum } = pipeline;

      // Generate 50 simulated file diffs with mixed content
      const diffFiles = [];
      for (let i = 0; i < 50; i++) {
        diffFiles.push({
          path: `src/module_${i}/service_${i}.ts`,
          patch: `+ export function handle_${i}() {\n+   console.log("processing ${i}");\n+   return ${i};\n+ }\n`,
          addedLines: [
            { text: ` export function handle_${i}() {` },
            { text: `   console.log("processing ${i}");` },
            { text: `   return ${i};` },
            { text: ` }` },
          ],
        });
      }

      const startTime = Date.now();
      const results = await Promise.all(
        PERSONA_CHARTERS.map((persona: any) => evaluatePersonaLane(persona, diffFiles, {}))
      );
      const durationMs = Date.now() - startTime;

      expect(results).toHaveLength(12);
      expect(durationMs).toBeLessThan(1000); // Expect sub-second parallel execution

      const arbitration = computeArbitrationQuorum(results);
      expect(arbitration.completedPersonas).toBe(12);
      expect(arbitration.quorumSatisfied).toBe(true);
      expect(['FIX_FIRST', 'BLOCK']).toContain(arbitration.verdict);
    });
  });
});
