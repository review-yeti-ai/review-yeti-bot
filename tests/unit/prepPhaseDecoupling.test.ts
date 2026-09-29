import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPrepPhase,
  shallowFetchHead,
  extractDiffAndTriage,
  assemblePrepPrompt,
  persistPrepState,
  dispatchMultiplexerTrigger,
  runPrepPhase,
  MAX_PREPARED_REVIEW_BYTES,
  type PrepPayload,
} from '../../src/review/prepPhase';
import { K8sJobRunner } from '../../src/infrastructure/k8sJobRunner';

describe('Milestone 2: Prep Pod Decoupling & State Storage (Requirement R3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Phase Dispatching Detection (isPrepPhase)', () => {
    it('detects prep phase via environment variable CT_PHASE=prep', () => {
      expect(isPrepPhase({ CT_PHASE: 'prep' }, [])).toBe(true);
      expect(isPrepPhase({ CT_PHASE: 'continuation' }, [])).toBe(false);
      expect(isPrepPhase({}, [])).toBe(false);
    });

    it('detects prep phase via command line argument --phase=prep', () => {
      expect(isPrepPhase({}, ['node', 'cli.js', '--phase=prep'])).toBe(true);
      expect(isPrepPhase({}, ['node', 'cli.js', '--phase=continuation'])).toBe(false);
    });

    it('detects prep phase via split command line argument --phase prep', () => {
      expect(isPrepPhase({}, ['node', 'cli.js', '--phase', 'prep'])).toBe(true);
      expect(isPrepPhase({}, ['node', 'cli.js', '--phase', 'continuation'])).toBe(false);
    });
  });

  describe('2. Git Shallow Fetch (<800ms) directly into /workspace', () => {
    it('verifies shallow fetch stub contract in test mode (< 1500ms)', async () => {
      const result = await shallowFetchHead({
        workspacePath: '/tmp/test-workspace',
        repo: 'calltelemetry/review-yeti-bot',
        headSha: '0123456789abcdef0123456789abcdef01234567',
      });
      expect(result.sha).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.durationMs).toBeLessThan(1500);
      expect(result.success).toBe(true);
    });
  });

  describe('3. Diff Extraction & AST Symbol Triage', () => {
    const sampleDiff = `diff --git a/src/gateway/routeHandler.ts b/src/gateway/routeHandler.ts
index 1234567..89abcde 100644
--- a/src/gateway/routeHandler.ts
+++ b/src/gateway/routeHandler.ts
@@ -10,6 +10,12 @@ export class RouteHandler {
   handleIncomingCall(invite: SipInvite) {
+    const validatedRoute = evaluateRoutePolicy(invite);
+    if (!validatedRoute) {
+      return rejectCallWithStatus(403);
+    }
+    return dispatchToAgent(validatedRoute);
   }
 }`;

    it('extracts changed files, counts hunks, and extracts AST symbols', async () => {
      const triage = await extractDiffAndTriage({ diff: sampleDiff });
      expect(triage.changedFiles.length).toBe(1);
      expect(triage.changedFiles[0].path).toBe('src/gateway/routeHandler.ts');
      expect(triage.triageSummary.filesCount).toBe(1);
      expect(triage.triageSummary.hunksCount).toBe(1);
      expect(triage.astSymbols).toContain('evaluateRoutePolicy');
      expect(triage.astSymbols).toContain('rejectCallWithStatus');
      expect(triage.astSymbols).toContain('dispatchToAgent');
      expect(triage.triageSummary.truncated).toBe(false);
    });
  });

  describe('4. Prompt Assembly & 256KB Boundary Truncation', () => {
    it('assembles OpenAI-compatible persona prompt messages', () => {
      const { messages, truncated } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 42,
        headSha: 'a1b2c3d4e5f6',
        astSymbols: ['handleIncomingCall', 'evaluateRoutePolicy'],
        changedFiles: [
          {
            path: 'src/main.ts',
            patch: '@@ -1,1 +1,2 @@\n+const x = 1;',
          },
        ],
      });

      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Review Yeti');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('Repository: calltelemetry/review-yeti-bot');
      expect(messages[1].content).toContain('handleIncomingCall');
      expect(truncated).toBe(false);
    });

    it('truncates prompt context when exceeding 256KB boundary', () => {
      const hugePatch = '+\n'.repeat(150_000); // Exceeds 256KB
      const { messages, truncated } = assemblePrepPrompt({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 99,
        headSha: 'deadbeef',
        astSymbols: ['testSymbol'],
        changedFiles: [{ path: 'huge.txt', patch: hugePatch }],
      });

      expect(truncated).toBe(true);
      expect(messages[1].content).toContain('[TRUNCATED: MaxPreparedReviewBytes exceeded]');
      expect(messages[1].content.length).toBeLessThanOrEqual(MAX_PREPARED_REVIEW_BYTES + 100);
    });
  });

  describe('5. PostgreSQL State Persistence (review_runs & review_run_artifacts)', () => {
    it('persists prep state to PostgreSQL review_runs and review_run_artifacts', async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };

      const payload: PrepPayload = {
        runId: 'run-m2-001',
        headSha: '1111222233334444555566667777888899990000',
        baseSha: '0000999988887777666655554444333322221111',
        repository: 'calltelemetry/review-yeti-bot',
        prNumber: 101,
        triageSummary: { filesCount: 3, hunksCount: 7, astSymbols: ['authCheck'], truncated: false },
        promptMessages: [{ role: 'user', content: 'Review diff' }],
        createdAt: new Date().toISOString(),
      };

      await persistPrepState(mockDb, payload);

      // Verify review_runs was updated with awaiting_inference status and prep_payload
      const updateRunQuery = queries.find((q) => q.sql.includes('UPDATE review_runs'));
      expect(updateRunQuery).toBeDefined();
      expect(updateRunQuery?.sql).toContain("status = 'awaiting_inference'");
      expect(updateRunQuery?.params?.[1]).toBe('run-m2-001');

      // Verify review_run_artifacts was inserted with stage 'prep_state'
      const insertArtifactQuery = queries.find((q) => q.sql.includes('INSERT INTO review_run_artifacts'));
      expect(insertArtifactQuery).toBeDefined();
      expect(insertArtifactQuery?.params?.[0]).toBe('run-m2-001');
      expect(insertArtifactQuery?.params?.[1]).toBeDefined(); // digest
      expect(typeof insertArtifactQuery?.params?.[3]).toBe('number'); // byte_length
    });
  });

  describe('6. Multiplexer Dispatch & Outbox', () => {
    it('dispatches async completion request via custom dispatcher or HTTP', async () => {
      let triggered = false;
      const dispatcher = async (payload: PrepPayload) => {
        triggered = payload.runId === 'run-mux-1';
        return true;
      };

      const payload: PrepPayload = {
        runId: 'run-mux-1',
        headSha: 'sha1',
        baseSha: 'sha2',
        repository: 'calltelemetry/review-yeti-bot',
        prNumber: 5,
        triageSummary: { filesCount: 1, hunksCount: 1, astSymbols: [], truncated: false },
        promptMessages: [{ role: 'user', content: 'Diff' }],
        createdAt: new Date().toISOString(),
      };

      const result = await dispatchMultiplexerTrigger({
        payload,
        dispatcher,
      });

      expect(result.triggered).toBe(true);
      expect(triggered).toBe(true);
    });
  });

  describe('7. End-to-End runPrepPhase Orchestration & Exit 0', () => {
    it('executes full prep phase lifecycle cleanly and returns exit code 0', async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };

      const sampleDiff = `diff --git a/lib/test.ts b/lib/test.ts
index 0000000..1111111 100644
--- a/lib/test.ts
+++ b/lib/test.ts
@@ -0,0 +1,5 @@
+export function calculateFee(cents: number): number {
+  return Math.round(cents * 0.05);
+}
`;

      const result = await runPrepPhase({
        runId: 'run-prep-e2e',
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 77,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        baseSha: 'abcdef0123456789abcdef0123456789abcdef01',
        diff: sampleDiff,
        db: mockDb,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.triageSummary.filesCount).toBe(1);
      expect(result.triageSummary.astSymbols).toContain('calculateFee');
      expect(result.promptMessages.length).toBe(2);
      expect(queries.length).toBeGreaterThan(0);
    });
  });

  describe('8. K8sJobRunner Prep Phase Manifest Generation', () => {
    it('generates Kubernetes Job manifest with CT_PHASE=prep and review-yeti.ai/job-phase: prep label', () => {
      const runner = new K8sJobRunner();
      const manifest = (runner as any).generateJobManifest({
        jobName: 'worker-prep-test',
        namespace: 'ct-review-system',
        persona: 'code-quality',
        repoUrl: 'https://github.com/calltelemetry/review-yeti-bot.git',
        prNumber: 42,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        phase: 'prep',
      });

      // 1. Verify Job labels
      expect(manifest.metadata.labels['review-yeti.ai/job-phase']).toBe('prep');
      expect(manifest.spec.template.metadata.labels['review-yeti.ai/job-phase']).toBe('prep');

      // 2. Verify Container env CT_PHASE=prep
      const container = manifest.spec.template.spec.containers[0];
      const phaseEnv = container.env.find((e: any) => e.name === 'CT_PHASE');
      expect(phaseEnv).toBeDefined();
      expect(phaseEnv.value).toBe('prep');
    });
  });
});
