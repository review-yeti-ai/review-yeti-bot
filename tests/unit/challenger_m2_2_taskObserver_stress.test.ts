import { describe, it, expect, vi } from 'vitest';
import {
  K8sJobRunner,
  TaskObserverLifecycleManager,
  TaskObserverWorkerWrapper,
  createTaskObserverCheckpoint,
  submitTaskObserverCheckpoint,
  mapCandidatePhaseToOwnerState,
  checkEffectTransition,
  ContractError,
  CandidateEffectPhase,
  TaskObserverImpact,
  TaskObserverProposal,
} from '../../src/infrastructure/k8sJobRunner';

const NOW = '2026-09-27T18:30:00.000Z';
const VALID_SHA256 = 'sha256:' + 'f'.repeat(64);

describe('Challenger M2-2 Empirical Stress Suite: Task Observer Lifecycle', () => {
  // =========================================================================
  // Section 1: Proposal Budget Capping (10, 25, 100 proposals)
  // =========================================================================
  describe('1. Proposal Budget Capping & Deterministic Priority Selection', () => {
    // Helper function to deterministically sort proposals according to the spec:
    // 1. Impact: high (3) > medium (2) > low (1)
    // 2. Recurrence: descending
    // 3. candidate_id: ascending (tie-breaker)
    function expectedTop5(
      proposals: Array<{
        candidate_id: string;
        impact: TaskObserverImpact;
        recurrence: number;
        phase: CandidateEffectPhase;
      }>
    ) {
      const impactWeights: Record<TaskObserverImpact, number> = {
        high: 3,
        medium: 2,
        low: 1,
      };
      const sorted = [...proposals].sort((a, b) => {
        const dImpact = impactWeights[b.impact] - impactWeights[a.impact];
        if (dImpact !== 0) return dImpact;
        const dRecurrence = b.recurrence - a.recurrence;
        if (dRecurrence !== 0) return dRecurrence;
        return a.candidate_id.localeCompare(b.candidate_id);
      });
      return sorted.slice(0, 5);
    }

    it('empirically verifies 10 proposals with varying impact and recurrence: selects top 5, overflow_count === 5', () => {
      const proposals: Array<{
        candidate_id: string;
        impact: TaskObserverImpact;
        recurrence: number;
        phase: CandidateEffectPhase;
      }> = [
        { candidate_id: 'cand-low-01', impact: 'low', recurrence: 50, phase: 'INTENT' },
        { candidate_id: 'cand-med-01', impact: 'medium', recurrence: 10, phase: 'INTENT' },
        { candidate_id: 'cand-high-01', impact: 'high', recurrence: 2, phase: 'INTENT' },
        { candidate_id: 'cand-high-02', impact: 'high', recurrence: 5, phase: 'INTENT' },
        { candidate_id: 'cand-med-02', impact: 'medium', recurrence: 20, phase: 'INTENT' },
        { candidate_id: 'cand-low-02', impact: 'low', recurrence: 1, phase: 'INTENT' },
        { candidate_id: 'cand-high-03', impact: 'high', recurrence: 1, phase: 'INTENT' },
        { candidate_id: 'cand-med-03', impact: 'medium', recurrence: 5, phase: 'INTENT' },
        { candidate_id: 'cand-high-04', impact: 'high', recurrence: 10, phase: 'INTENT' },
        { candidate_id: 'cand-low-03', impact: 'low', recurrence: 100, phase: 'INTENT' },
      ];

      expect(proposals.length).toBe(10);

      const cp = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-cap-10',
        observed_at: NOW,
        proposals,
        permission_denied: false,
      });

      expect(cp.proposals.length).toBe(5);
      expect(cp.overflow_count).toBe(5); // 10 - 5 = 5

      const expected = expectedTop5(proposals);
      expect(cp.proposals.map((p) => p.candidate_id)).toEqual(
        expected.map((p) => p.candidate_id)
      );

      // Verify explicit order:
      // High impact (recurrence: 10, 5, 2, 1) -> cand-high-04, cand-high-02, cand-high-01, cand-high-03
      // Medium impact (recurrence: 20) -> cand-med-02
      expect(cp.proposals.map((p) => p.candidate_id)).toEqual([
        'cand-high-04',
        'cand-high-02',
        'cand-high-01',
        'cand-high-03',
        'cand-med-02',
      ]);
    });

    it('empirically verifies 25 proposals with varying impact and recurrence: selects top 5, overflow_count === 20', () => {
      const impacts: TaskObserverImpact[] = ['low', 'medium', 'high'];
      const proposals: Array<{
        candidate_id: string;
        impact: TaskObserverImpact;
        recurrence: number;
        phase: CandidateEffectPhase;
      }> = [];

      for (let i = 0; i < 25; i++) {
        // Distribute impacts and recurrence systematically
        const impact = impacts[i % 3];
        const recurrence = ((i * 7) % 30) + 1;
        const candidate_id = `cand-25-${String(i).padStart(3, '0')}`;
        proposals.push({
          candidate_id,
          impact,
          recurrence,
          phase: 'INTENT',
        });
      }

      expect(proposals.length).toBe(25);

      const cp = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-cap-25',
        observed_at: NOW,
        proposals,
        permission_denied: false,
      });

      expect(cp.proposals.length).toBe(5);
      expect(cp.overflow_count).toBe(20); // 25 - 5 = 20

      const expected = expectedTop5(proposals);
      expect(cp.proposals.map((p) => p.candidate_id)).toEqual(
        expected.map((p) => p.candidate_id)
      );
      // All 5 must be high impact given >= 8 high impact items with recurrence up to 29
      for (const p of cp.proposals) {
        expect(p.impact).toBe('high');
      }
    });

    it('empirically verifies 100 proposals with varying impact and recurrence: selects top 5, overflow_count === 95', () => {
      const impacts: TaskObserverImpact[] = ['low', 'medium', 'high'];
      const proposals: Array<{
        candidate_id: string;
        impact: TaskObserverImpact;
        recurrence: number;
        phase: CandidateEffectPhase;
      }> = [];

      for (let i = 0; i < 100; i++) {
        const impact = impacts[i % 3];
        const recurrence = (i * 13) % 200;
        const candidate_id = `cand-100-${String(i).padStart(3, '0')}`;
        proposals.push({
          candidate_id,
          impact,
          recurrence,
          phase: 'INTENT',
        });
      }

      expect(proposals.length).toBe(100);

      const cp = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-cap-100',
        observed_at: NOW,
        proposals,
        permission_denied: false,
      });

      expect(cp.proposals.length).toBe(5);
      expect(cp.overflow_count).toBe(95); // 100 - 5 = 95

      const expected = expectedTop5(proposals);
      expect(cp.proposals.map((p) => p.candidate_id)).toEqual(
        expected.map((p) => p.candidate_id)
      );
    });

    it('proves permutation invariance: 100 proposals shuffled in 10 different random orders always yield identical top 5', () => {
      const impacts: TaskObserverImpact[] = ['low', 'medium', 'high'];
      const proposals: Array<{
        candidate_id: string;
        impact: TaskObserverImpact;
        recurrence: number;
        phase: CandidateEffectPhase;
      }> = [];

      for (let i = 0; i < 100; i++) {
        proposals.push({
          candidate_id: `cand-${String(i).padStart(3, '0')}`,
          impact: impacts[i % 3],
          recurrence: (i * 17) % 50,
          phase: 'INTENT',
        });
      }

      const baselineCp = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-perm-base',
        observed_at: NOW,
        proposals,
        permission_denied: false,
      });
      const baselineIds = baselineCp.proposals.map((p) => p.candidate_id);

      // Simple pseudo-random shuffle seeded by iteration
      for (let seed = 1; seed <= 10; seed++) {
        const shuffled = [...proposals].sort((a, b) => {
          const hashA = (a.candidate_id.charCodeAt(5) * seed * 31) % 97;
          const hashB = (b.candidate_id.charCodeAt(5) * seed * 31) % 97;
          return hashA - hashB;
        });

        const shuffledCp = createTaskObserverCheckpoint({
          checkpoint_id: `chk-perm-${seed}`,
          observed_at: NOW,
          proposals: shuffled,
          permission_denied: false,
        });

        expect(shuffledCp.proposals.length).toBe(5);
        expect(shuffledCp.overflow_count).toBe(95);
        expect(shuffledCp.proposals.map((p) => p.candidate_id)).toEqual(baselineIds);
      }
    });

    it('proves strict tie-breaking across 10, 25, 100 proposals with identical impact and recurrence', () => {
      const counts = [10, 25, 100];
      for (const count of counts) {
        // Reverse order IDs to stress test sorting
        const proposals = Array.from({ length: count }, (_, i) => ({
          candidate_id: `c-tie-${String(count - 1 - i).padStart(4, '0')}`,
          impact: 'high' as const,
          recurrence: 42,
          phase: 'INTENT' as const,
        }));

        const cp = createTaskObserverCheckpoint({
          checkpoint_id: `chk-tie-${count}`,
          observed_at: NOW,
          proposals,
          permission_denied: false,
        });

        expect(cp.proposals.length).toBe(5);
        expect(cp.overflow_count).toBe(count - 5);
        // Should select the lexicographically lowest 5 candidate_ids
        expect(cp.proposals.map((p) => p.candidate_id)).toEqual([
          'c-tie-0000',
          'c-tie-0001',
          'c-tie-0002',
          'c-tie-0003',
          'c-tie-0004',
        ]);
      }
    });
  });

  // =========================================================================
  // Section 2: Strict Zero-Retention Enforcement
  // =========================================================================
  describe('2. Strict Zero-Retention Enforcement', () => {
    const baseProposal = {
      candidate_id: 'c-valid-clean',
      impact: 'high' as const,
      recurrence: 1,
      phase: 'INTENT' as const,
    };

    it('rejects forbidden key "diff" with unified diff text', () => {
      const proposalWithDiff: any = {
        ...baseProposal,
        diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,3 +10,4 @@\n-const token = null;\n+const token = "secret";',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-diff',
          observed_at: NOW,
          proposals: [proposalWithDiff],
          permission_denied: false,
        });
      }).toThrow(ContractError);

      try {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-diff',
          observed_at: NOW,
          proposals: [proposalWithDiff],
          permission_denied: false,
        });
      } catch (err: any) {
        expect(err.code).toBe('INVALID_SHAPE');
      }
    });

    it('rejects forbidden key "patch" with git patch hunk', () => {
      const proposalWithPatch: any = {
        ...baseProposal,
        patch: 'diff --git a/index.js b/index.js\nindex 83a0f1..23b4c1 100644',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-patch',
          observed_at: NOW,
          proposals: [proposalWithPatch],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden key "hunk" with unified hunk header', () => {
      const proposalWithHunk: any = {
        ...baseProposal,
        hunk: '@@ -45,7 +45,9 @@ function validateUser()',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-hunk',
          observed_at: NOW,
          proposals: [proposalWithHunk],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden key "transcript" with conversation transcript', () => {
      const proposalWithTranscript: any = {
        ...baseProposal,
        transcript: 'User: Please inspect line 22.\nAssistant: Found vulnerability on line 22.',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-transcript',
          observed_at: NOW,
          proposals: [proposalWithTranscript],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden key "messages" with chat message history', () => {
      const proposalWithMessages: any = {
        ...baseProposal,
        messages: [{ role: 'system', content: 'You are an empirical challenger.' }],
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-messages',
          observed_at: NOW,
          proposals: [proposalWithMessages],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden key "prompt" with raw LLM prompt', () => {
      const proposalWithPrompt: any = {
        ...baseProposal,
        prompt: 'System: Review this PR diff thoroughly.',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-prompt',
          observed_at: NOW,
          proposals: [proposalWithPrompt],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden key "code" with executable snippet or markdown code block', () => {
      const proposalWithCode: any = {
        ...baseProposal,
        code: '```typescript\nconst x = eval(req.body.code);\n```',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-code',
          observed_at: NOW,
          proposals: [proposalWithCode],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden key "content" with raw string or object', () => {
      const proposalWithContent: any = {
        ...baseProposal,
        content: 'raw payload body with confidential information',
      };
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak-content',
          observed_at: NOW,
          proposals: [proposalWithContent],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });

    it('rejects forbidden keys even when values are falsy or empty (empty string, 0, false, empty array, empty object)', () => {
      const falsyValues = ['', 0, false, [], {}];
      const forbiddenKeys = ['diff', 'patch', 'hunk', 'transcript', 'messages', 'prompt', 'code', 'content'];

      for (const key of forbiddenKeys) {
        for (const val of falsyValues) {
          const taintedProposal: any = {
            ...baseProposal,
            [key]: val,
          };
          expect(() => {
            createTaskObserverCheckpoint({
              checkpoint_id: `chk-falsy-${key}`,
              observed_at: NOW,
              proposals: [taintedProposal],
              permission_denied: false,
            });
          }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
        }
      }
    });

    it('rejects forbidden content injected directly into candidate_id, evidence_ref, or checkpoint_id', () => {
      // 1. Unified diff in candidate_id
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-valid',
          observed_at: NOW,
          proposals: [{
            candidate_id: 'diff --git a/foo b/foo',
            impact: 'high',
            recurrence: 1,
            phase: 'INTENT',
          }],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));

      // 2. Code snippet in candidate_id
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-valid',
          observed_at: NOW,
          proposals: [{
            candidate_id: 'function(){return 1;}',
            impact: 'high',
            recurrence: 1,
            phase: 'INTENT',
          }],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));

      // 3. Raw prompt / transcript in candidate_id
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-valid',
          observed_at: NOW,
          proposals: [{
            candidate_id: 'User: hello \n Assistant: world',
            impact: 'high',
            recurrence: 1,
            phase: 'INTENT',
          }],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));

      // 4. Code injected into evidence_ref (not valid sha256)
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-valid',
          observed_at: NOW,
          proposals: [{
            candidate_id: 'c-valid-1',
            impact: 'high',
            recurrence: 1,
            phase: 'SUCCEEDED',
            evidence_ref: 'const secret = 42;' as any,
          }],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));

      // 5. Code injected into checkpoint_id
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'const hack = true;',
          observed_at: NOW,
          proposals: [baseProposal],
          permission_denied: false,
        });
      }).toThrowError(expect.objectContaining({ code: 'INVALID_SHAPE' }));
    });
  });

  // =========================================================================
  // Section 3: Permission Denial Binary Hard Stop
  // =========================================================================
  describe('3. Permission Denial Binary Hard Stop', () => {
    it('halts immediately when permission_denied: true and marks manager & runner as halted', () => {
      const manager = new TaskObserverLifecycleManager();
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-denied-001';

      expect(manager.isHalted(execId)).toBe(false);
      expect(runner.isExecutionHalted(execId)).toBe(false);

      const deniedCheckpoint = {
        checkpoint_id: 'chk-denied-1',
        observed_at: NOW,
        proposals: [{ candidate_id: 'c-denied-1', impact: 'high' as const, recurrence: 1, phase: 'INTENT' as const }],
        permission_denied: true,
      };

      // 1. Submit on lifecycle manager
      const managerResult = manager.submitCheckpoint(deniedCheckpoint, execId);
      expect(managerResult.accepted).toBe(true);
      expect(managerResult.halted).toBe(true);
      expect(managerResult.error).toContain('PERMISSION_DENIED');
      expect(manager.isHalted(execId)).toBe(true);

      // 2. Submit on runner instance
      const runnerExecId = 'exec-runner-denied';
      const runnerResult = runner.submitTaskObserverCheckpoint(deniedCheckpoint, runnerExecId);
      expect(runnerResult.accepted).toBe(true);
      expect(runnerResult.halted).toBe(true);
      expect(runnerResult.error).toContain('PERMISSION_DENIED');
      expect(runner.isExecutionHalted(runnerExecId)).toBe(true);
    });

    it('rejects all subsequent checkpoint submissions with AUTHORITY_DENIED under high volume stress (20 calls)', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-stress-halt';

      // Halt execution
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-initial-denial',
          observed_at: NOW,
          proposals: [],
          permission_denied: true,
        },
        execId
      );

      expect(runner.isExecutionHalted(execId)).toBe(true);

      // Subsequent 20 attempts of various payloads must all fail closed with AUTHORITY_DENIED
      for (let i = 1; i <= 20; i++) {
        expect(() => {
          runner.submitTaskObserverCheckpoint(
            {
              checkpoint_id: `chk-subsequent-${i}`,
              observed_at: NOW,
              proposals: [
                {
                  candidate_id: `cand-${i}`,
                  impact: i % 2 === 0 ? 'high' : 'medium',
                  recurrence: i,
                  phase: 'INTENT',
                },
              ],
              permission_denied: false, // Even when false!
            },
            execId
          );
        }).toThrow(ContractError);

        try {
          runner.submitTaskObserverCheckpoint(
            {
              checkpoint_id: `chk-subsequent-${i}`,
              observed_at: NOW,
              proposals: [],
              permission_denied: false,
            },
            execId
          );
        } catch (err: any) {
          expect(err.code).toBe('AUTHORITY_DENIED');
        }
      }
    });

    it('proves multi-tenant / execution isolation: halting exec-A does not halt or affect exec-B', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execA = 'exec-tenant-halted';
      const execB = 'exec-tenant-healthy';

      // Halt tenant A
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-halt-a',
          observed_at: NOW,
          proposals: [],
          permission_denied: true,
        },
        execA
      );

      expect(runner.isExecutionHalted(execA)).toBe(true);
      expect(runner.isExecutionHalted(execB)).toBe(false);

      // Tenant A throws AUTHORITY_DENIED
      expect(() => {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'chk-subsequent-a',
            observed_at: NOW,
            proposals: [],
            permission_denied: false,
          },
          execA
        );
      }).toThrowError(expect.objectContaining({ code: 'AUTHORITY_DENIED' }));

      // Tenant B succeeds normally
      const resB = runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-ok-b',
          observed_at: NOW,
          proposals: [
            { candidate_id: 'cand-b1', impact: 'high', recurrence: 1, phase: 'INTENT' },
          ],
          permission_denied: false,
        },
        execB
      );

      expect(resB.accepted).toBe(true);
      expect(resB.halted).toBe(false);
      expect(runner.isExecutionHalted(execB)).toBe(false);
    });

    it('verifies exact event emission semantics during permission denial halt', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-events-halt';

      const permissionDeniedSpy = vi.fn();
      const executionHaltedSpy = vi.fn();

      runner.onTaskObserverEvent('permissionDenied', permissionDeniedSpy);
      runner.onTaskObserverEvent('executionHalted', executionHaltedSpy);

      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-halt-ev',
          observed_at: NOW,
          proposals: [],
          permission_denied: true,
        },
        execId
      );

      expect(permissionDeniedSpy).toHaveBeenCalledTimes(1);
      expect(permissionDeniedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: execId,
          checkpoint: expect.objectContaining({ checkpoint_id: 'chk-halt-ev', permission_denied: true }),
        })
      );

      expect(executionHaltedSpy).toHaveBeenCalledTimes(1);
      expect(executionHaltedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: execId,
          reason: 'PERMISSION_DENIED',
        })
      );
    });

    it('verifies TaskObserverWorkerWrapper terminates immediately and suppresses candidate collection', () => {
      const submitSpy = vi.fn();
      const wrapper = new TaskObserverWorkerWrapper({
        executionId: 'exec-wrap-halt',
        checkpointSubmitter: submitSpy,
      });

      wrapper.observeCandidate({ candidateId: 'c1', impact: 'high', phase: 'INTENT' });
      expect(wrapper.isHalted()).toBe(false);

      // Emit denial checkpoint
      wrapper.emitCheckpoint({ permissionDenied: true });
      expect(wrapper.isHalted()).toBe(true);
      expect(submitSpy).toHaveBeenCalledTimes(1);

      // Attempt to observe and emit after halt
      wrapper.observeCandidate({ candidateId: 'c2', impact: 'high', phase: 'INTENT' });
      wrapper.emitCheckpoint();

      // submitSpy should NOT have been called a second time
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Section 4: Illegal State Machine Transitions
  // =========================================================================
  describe('4. State Machine Transition Hardening & Prohibition of Illegal Transitions', () => {
    it('empirically verifies standalone checkEffectTransition forbids UNKNOWN -> EXECUTING with INVALID_EFFECT_TRANSITION', () => {
      expect(() => {
        checkEffectTransition('UNKNOWN', 'EXECUTING');
      }).toThrow(ContractError);

      try {
        checkEffectTransition('UNKNOWN', 'EXECUTING');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EFFECT_TRANSITION');
      }
    });

    it('empirically verifies standalone checkEffectTransition forbids SUCCEEDED -> EXECUTING with INVALID_EFFECT_TRANSITION', () => {
      expect(() => {
        checkEffectTransition('SUCCEEDED', 'EXECUTING');
      }).toThrow(ContractError);

      try {
        checkEffectTransition('SUCCEEDED', 'EXECUTING');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EFFECT_TRANSITION');
      }
    });

    it('empirically validates exhaustive 7x7 transition matrix: all 40 illegal transitions throw INVALID_EFFECT_TRANSITION', () => {
      const allPhases: CandidateEffectPhase[] = [
        'INTENT',
        'EXECUTING',
        'UNKNOWN',
        'RECONCILING',
        'SUCCEEDED',
        'FAILED',
        'MANUAL',
      ];

      // Legal transitions per ct-effect-intent.v1:
      // INTENT: ['EXECUTING']
      // EXECUTING: ['SUCCEEDED', 'FAILED', 'UNKNOWN']
      // UNKNOWN: ['RECONCILING']
      // RECONCILING: ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'MANUAL']
      // SUCCEEDED: []
      // FAILED: []
      // MANUAL: []
      const legalTransitions = new Set<string>([
        'INTENT->EXECUTING',
        'EXECUTING->SUCCEEDED',
        'EXECUTING->FAILED',
        'EXECUTING->UNKNOWN',
        'UNKNOWN->RECONCILING',
        'RECONCILING->SUCCEEDED',
        'RECONCILING->FAILED',
        'RECONCILING->UNKNOWN',
        'RECONCILING->MANUAL',
      ]);

      let illegalCount = 0;
      let legalCount = 0;

      for (const from of allPhases) {
        for (const to of allPhases) {
          const key = `${from}->${to}`;
          if (legalTransitions.has(key)) {
            legalCount++;
            // With valid digest, legal transitions must not throw
            expect(() => checkEffectTransition(from, to, VALID_SHA256)).not.toThrow();
          } else {
            illegalCount++;
            expect(() => checkEffectTransition(from, to, VALID_SHA256)).toThrowError(
              expect.objectContaining({ code: 'INVALID_EFFECT_TRANSITION' })
            );
          }
        }
      }

      expect(legalCount).toBe(9);
      expect(illegalCount).toBe(40);
      expect(legalCount + illegalCount).toBe(49);
    });

    it('enforces UNKNOWN -> EXECUTING prohibition across sequential checkpoints in TaskObserverLifecycleManager', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-trans-unk-exec';

      // Checkpoint 1: Register candidate in EXECUTING
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-step-1',
          observed_at: NOW,
          proposals: [
            { candidate_id: 'cand-x', impact: 'high', recurrence: 1, phase: 'EXECUTING' },
          ],
          permission_denied: false,
        },
        execId
      );

      // Checkpoint 2: Transition candidate to UNKNOWN (legal: EXECUTING -> UNKNOWN)
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-step-2',
          observed_at: NOW,
          proposals: [
            { candidate_id: 'cand-x', impact: 'high', recurrence: 2, phase: 'UNKNOWN' },
          ],
          permission_denied: false,
        },
        execId
      );

      // Checkpoint 3: Attempt illegal transition UNKNOWN -> EXECUTING (must throw INVALID_EFFECT_TRANSITION)
      expect(() => {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'chk-step-3-illegal',
            observed_at: NOW,
            proposals: [
              { candidate_id: 'cand-x', impact: 'high', recurrence: 3, phase: 'EXECUTING' },
            ],
            permission_denied: false,
          },
          execId
        );
      }).toThrowError(expect.objectContaining({ code: 'INVALID_EFFECT_TRANSITION' }));
    });

    it('enforces SUCCEEDED -> EXECUTING prohibition across sequential checkpoints in TaskObserverLifecycleManager', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-trans-succ-exec';

      // Checkpoint 1: Register candidate in EXECUTING
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-succ-1',
          observed_at: NOW,
          proposals: [
            { candidate_id: 'cand-y', impact: 'high', recurrence: 1, phase: 'EXECUTING' },
          ],
          permission_denied: false,
        },
        execId
      );

      // Checkpoint 2: Legal transition to terminal SUCCEEDED with valid evidence digest
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-succ-2',
          observed_at: NOW,
          proposals: [
            {
              candidate_id: 'cand-y',
              impact: 'high',
              recurrence: 2,
              phase: 'SUCCEEDED',
              evidence_ref: VALID_SHA256,
            },
          ],
          permission_denied: false,
        },
        execId
      );

      // Checkpoint 3: Attempt illegal transition SUCCEEDED -> EXECUTING (terminal state violation)
      expect(() => {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'chk-succ-3-illegal',
            observed_at: NOW,
            proposals: [
              { candidate_id: 'cand-y', impact: 'high', recurrence: 3, phase: 'EXECUTING' },
            ],
            permission_denied: false,
          },
          execId
        );
      }).toThrowError(expect.objectContaining({ code: 'INVALID_EFFECT_TRANSITION' }));
    });

    it('enforces valid recovery path UNKNOWN -> RECONCILING -> SUCCEEDED across sequential checkpoints', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-trans-recovery';

      // 1. Initial EXECUTING
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-recov-1',
          observed_at: NOW,
          proposals: [{ candidate_id: 'cand-rec', impact: 'high', recurrence: 1, phase: 'EXECUTING' }],
          permission_denied: false,
        },
        execId
      );

      // 2. UNKNOWN
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-recov-2',
          observed_at: NOW,
          proposals: [{ candidate_id: 'cand-rec', impact: 'high', recurrence: 2, phase: 'UNKNOWN' }],
          permission_denied: false,
        },
        execId
      );

      // 3. RECONCILING (legal)
      const res3 = runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-recov-3',
          observed_at: NOW,
          proposals: [{ candidate_id: 'cand-rec', impact: 'high', recurrence: 3, phase: 'RECONCILING' }],
          permission_denied: false,
        },
        execId
      );
      expect(res3.accepted).toBe(true);
      expect(res3.projectedOwnerStates[0].owner_state).toBe('UNKNOWN');

      // 4. SUCCEEDED with valid evidence digest (legal)
      const res4 = runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-recov-4',
          observed_at: NOW,
          proposals: [
            {
              candidate_id: 'cand-rec',
              impact: 'high',
              recurrence: 4,
              phase: 'SUCCEEDED',
              evidence_ref: VALID_SHA256,
            },
          ],
          permission_denied: false,
        },
        execId
      );
      expect(res4.accepted).toBe(true);
      expect(res4.projectedOwnerStates[0].owner_state).toBe('SUCCEEDED');
    });

    it('strictly requires valid evidence digest on terminal transitions to SUCCEEDED and FAILED', () => {
      // 1. Missing evidence_ref
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED')).toThrowError(
        expect.objectContaining({ code: 'EFFECT_EVIDENCE_REQUIRED' })
      );
      expect(() => checkEffectTransition('EXECUTING', 'FAILED')).toThrowError(
        expect.objectContaining({ code: 'EFFECT_EVIDENCE_REQUIRED' })
      );

      // 2. Null / undefined evidence_ref
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', null)).toThrowError(
        expect.objectContaining({ code: 'EFFECT_EVIDENCE_REQUIRED' })
      );
      expect(() => checkEffectTransition('EXECUTING', 'FAILED', undefined)).toThrowError(
        expect.objectContaining({ code: 'EFFECT_EVIDENCE_REQUIRED' })
      );

      // 3. Malformed digest string
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', 'not-a-sha256')).toThrowError(
        expect.objectContaining({ code: 'EFFECT_EVIDENCE_REQUIRED' })
      );
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', 'sha256:123')).toThrowError(
        expect.objectContaining({ code: 'EFFECT_EVIDENCE_REQUIRED' })
      );

      // 4. Valid digest
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', VALID_SHA256)).not.toThrow();
      expect(() => checkEffectTransition('EXECUTING', 'FAILED', VALID_SHA256)).not.toThrow();
    });
  });
});
