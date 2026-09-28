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
} from '../../src/infrastructure/k8sJobRunner';

const NOW = '2026-09-27T18:00:00.000Z';
const VALID_DIGEST = 'sha256:' + 'a'.repeat(64);

describe('API-3333 Task Observer Lifecycle Hooks Suite (Milestone 2)', () => {
  describe('1. Checkpoint Budget Capping & Priority Sorting', () => {
    it('sorts candidates by impact (high > medium > low), then recurrence desc, and caps at 5', () => {
      const proposals = [
        { candidate_id: 'c-low-1', impact: 'low' as const, recurrence: 10, phase: 'INTENT' as const },
        { candidate_id: 'c-med-1', impact: 'medium' as const, recurrence: 1, phase: 'INTENT' as const },
        { candidate_id: 'c-high-1', impact: 'high' as const, recurrence: 2, phase: 'INTENT' as const },
        { candidate_id: 'c-high-2', impact: 'high' as const, recurrence: 5, phase: 'INTENT' as const },
        { candidate_id: 'c-med-2', impact: 'medium' as const, recurrence: 8, phase: 'INTENT' as const },
        { candidate_id: 'c-low-2', impact: 'low' as const, recurrence: 1, phase: 'INTENT' as const },
      ];

      const cp = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-1',
        observed_at: NOW,
        proposals,
        permission_denied: false,
      });

      expect(cp.proposals.length).toBe(5);
      expect(cp.overflow_count).toBe(1);

      // Expected order:
      // 1. c-high-2 (high, 5)
      // 2. c-high-1 (high, 2)
      // 3. c-med-2 (medium, 8)
      // 4. c-med-1 (medium, 1)
      // 5. c-low-1 (low, 10)
      // Omitted (overflow): c-low-2
      expect(cp.proposals.map((p) => p.candidate_id)).toEqual([
        'c-high-2',
        'c-high-1',
        'c-med-2',
        'c-med-1',
        'c-low-1',
      ]);
    });

    it('uses candidate_id as stable tie-breaker when impact and recurrence are identical', () => {
      const proposals = [
        { candidate_id: 'c-high-z', impact: 'high' as const, recurrence: 3, phase: 'INTENT' as const },
        { candidate_id: 'c-high-a', impact: 'high' as const, recurrence: 3, phase: 'INTENT' as const },
        { candidate_id: 'c-high-m', impact: 'high' as const, recurrence: 3, phase: 'INTENT' as const },
      ];

      const cp = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-tie',
        observed_at: NOW,
        proposals,
        permission_denied: false,
      });

      expect(cp.proposals.map((p) => p.candidate_id)).toEqual([
        'c-high-a',
        'c-high-m',
        'c-high-z',
      ]);
    });

    it('computes correct overflow_count for boundary counts (0, 5, 8, 12)', () => {
      const makeProposals = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          candidate_id: `cand-${i}`,
          impact: 'medium' as const,
          recurrence: 1,
          phase: 'INTENT' as const,
        }));

      expect(
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-0',
          observed_at: NOW,
          proposals: [],
          permission_denied: false,
        }).overflow_count
      ).toBe(0);

      expect(
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-5',
          observed_at: NOW,
          proposals: makeProposals(5),
          permission_denied: false,
        }).overflow_count
      ).toBe(0);

      expect(
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-8',
          observed_at: NOW,
          proposals: makeProposals(8),
          permission_denied: false,
        }).overflow_count
      ).toBe(3);

      expect(
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-12',
          observed_at: NOW,
          proposals: makeProposals(12),
          permission_denied: false,
        }).overflow_count
      ).toBe(7);
    });
  });

  describe('2. Strict Zero-Retention Enforcement', () => {
    it('rejects checkpoint proposals containing raw diffs or patch bodies', () => {
      const proposalWithDiff: any = {
        candidate_id: 'c-leak',
        impact: 'high',
        recurrence: 1,
        phase: 'INTENT',
        diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;',
      };

      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-leak',
          observed_at: NOW,
          proposals: [proposalWithDiff],
          permission_denied: false,
        });
      }).toThrow(ContractError);
    });

    it('rejects checkpoint proposals containing raw transcripts or conversation messages', () => {
      const proposalWithTranscript: any = {
        candidate_id: 'c-transcript',
        impact: 'medium',
        recurrence: 1,
        phase: 'INTENT',
        transcript: 'User: Please review this code. Assistant: Sure, here are my findings...',
      };

      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-transcript',
          observed_at: NOW,
          proposals: [proposalWithTranscript],
          permission_denied: false,
        });
      }).toThrow(ContractError);
    });

    it('rejects checkpoint proposals containing raw code or prompt keys', () => {
      expect(() => {
        createTaskObserverCheckpoint({
          checkpoint_id: 'chk-code',
          observed_at: NOW,
          proposals: [
            {
              candidate_id: 'c-code',
              impact: 'low',
              recurrence: 1,
              phase: 'INTENT',
              code: 'SELECT * FROM users;',
            } as any,
          ],
          permission_denied: false,
        });
      }).toThrow(ContractError);
    });
  });

  describe('3. Phase Mapping onto ct-effect-intent.v1', () => {
    it('maps all CandidateEffectPhase values to AuthoritativeOwnerState accurately', () => {
      expect(mapCandidatePhaseToOwnerState('INTENT')).toBe('INTENDED');
      expect(mapCandidatePhaseToOwnerState('EXECUTING')).toBe('IN_FLIGHT');
      expect(mapCandidatePhaseToOwnerState('SUCCEEDED')).toBe('SUCCEEDED');
      expect(mapCandidatePhaseToOwnerState('FAILED')).toBe('FAILED');
      expect(mapCandidatePhaseToOwnerState('UNKNOWN')).toBe('UNKNOWN');
      expect(mapCandidatePhaseToOwnerState('RECONCILING')).toBe('UNKNOWN');
      expect(mapCandidatePhaseToOwnerState('MANUAL')).toBe('UNKNOWN');
    });

    it('maps runner method mapCandidatePhaseToOwnerState with identical results', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const phases: CandidateEffectPhase[] = [
        'INTENT',
        'EXECUTING',
        'SUCCEEDED',
        'FAILED',
        'UNKNOWN',
        'RECONCILING',
        'MANUAL',
      ];

      for (const phase of phases) {
        expect(runner.mapCandidatePhaseToOwnerState(phase)).toBe(mapCandidatePhaseToOwnerState(phase));
      }
    });
  });

  describe('4. Transition State Machine & UNKNOWN -> EXECUTING Prohibition', () => {
    it('strictly forbids UNKNOWN -> EXECUTING transition with INVALID_EFFECT_TRANSITION', () => {
      expect(() => {
        checkEffectTransition('UNKNOWN', 'EXECUTING');
      }).toThrow(ContractError);

      try {
        checkEffectTransition('UNKNOWN', 'EXECUTING');
      } catch (err: any) {
        expect(err.code).toBe('INVALID_EFFECT_TRANSITION');
      }
    });

    it('allows valid recovery path UNKNOWN -> RECONCILING -> SUCCEEDED with evidence digest', () => {
      expect(() => checkEffectTransition('UNKNOWN', 'RECONCILING')).not.toThrow();
      expect(() => checkEffectTransition('RECONCILING', 'SUCCEEDED', VALID_DIGEST)).not.toThrow();
    });

    it('rejects terminal transition to SUCCEEDED or FAILED without evidence digest', () => {
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', null)).toThrow(ContractError);
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', undefined)).toThrow(ContractError);
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', 'invalid-digest')).toThrow(ContractError);
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', VALID_DIGEST)).not.toThrow();

      expect(() => checkEffectTransition('EXECUTING', 'FAILED', null)).toThrow(ContractError);
      expect(() => checkEffectTransition('EXECUTING', 'FAILED', VALID_DIGEST)).not.toThrow();
    });

    it('rejects transition from terminal state SUCCEEDED or FAILED to any following phase', () => {
      expect(() => checkEffectTransition('SUCCEEDED', 'EXECUTING')).toThrow(ContractError);
      expect(() => checkEffectTransition('FAILED', 'EXECUTING')).toThrow(ContractError);
    });
  });

  describe('5. Classifier Permission Denial Binary Hard Stop', () => {
    it('halts execution immediately when permission_denied is true', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-test-stop';

      const result = runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-denied',
          observed_at: NOW,
          proposals: [],
          permission_denied: true,
        },
        execId
      );

      expect(result.halted).toBe(true);
      expect(result.error).toContain('PERMISSION_DENIED');
      expect(runner.isExecutionHalted(execId)).toBe(true);

      // Subsequent submissions must fail closed with AUTHORITY_DENIED
      expect(() => {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'chk-after-halt',
            observed_at: NOW,
            proposals: [],
            permission_denied: false,
          },
          execId
        );
      }).toThrow(ContractError);

      try {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'chk-after-halt',
            observed_at: NOW,
            proposals: [],
            permission_denied: false,
          },
          execId
        );
      } catch (err: any) {
        expect(err.code).toBe('AUTHORITY_DENIED');
      }
    });

    it('standalone submitTaskObserverCheckpoint operates correctly', () => {
      const execId = 'exec-standalone-1';
      const result = submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-std-1',
          observed_at: NOW,
          proposals: [
            { candidate_id: 'c-ok', impact: 'medium', recurrence: 1, phase: 'INTENT' },
          ],
          permission_denied: false,
        },
        execId
      );

      expect(result.accepted).toBe(true);
      expect(result.halted).toBe(false);
      expect(result.projectedOwnerStates[0].owner_state).toBe('INTENDED');
    });
  });

  describe('6. TaskObserverWorkerWrapper Integration', () => {
    it('aggregates recurrence, updates phases, and flushes capped checkpoints', () => {
      const mockSubmit = vi.fn();
      const wrapper = new TaskObserverWorkerWrapper({
        executionId: 'exec-worker-1',
        checkpointSubmitter: mockSubmit,
      });

      // Observe finding multiple times
      wrapper.observeCandidate({ candidateId: 'vuln-sql', impact: 'high', phase: 'INTENT' });
      wrapper.observeCandidate({ candidateId: 'vuln-sql', impact: 'high', phase: 'INTENT' });
      wrapper.updatePhase('vuln-sql', 'EXECUTING');

      wrapper.emitCheckpoint();

      expect(mockSubmit).toHaveBeenCalledTimes(1);
      const [submittedCp, submittedExecId] = mockSubmit.mock.calls[0];
      expect(submittedExecId).toBe('exec-worker-1');
      expect(submittedCp.proposals[0].candidate_id).toBe('vuln-sql');
      expect(submittedCp.proposals[0].recurrence).toBe(2);
      expect(submittedCp.proposals[0].phase).toBe('EXECUTING');
    });

    it('terminates wrapper when permissionDenied is passed to emitCheckpoint', () => {
      const mockSubmit = vi.fn();
      const wrapper = new TaskObserverWorkerWrapper({
        executionId: 'exec-worker-stop',
        checkpointSubmitter: mockSubmit,
      });

      wrapper.observeCandidate({ candidateId: 'action-1', impact: 'high', phase: 'INTENT' });
      wrapper.emitCheckpoint({ permissionDenied: true });

      expect(wrapper.isHalted()).toBe(true);

      // Subsequent actions must be ignored after termination
      wrapper.observeCandidate({ candidateId: 'action-2', impact: 'high', phase: 'INTENT' });
      wrapper.emitCheckpoint();

      // emitCheckpoint should not have been called a second time
      expect(mockSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('7. Lifecycle Event Emission', () => {
    it('emits lifecycle events: checkpoint, phaseTransition, permissionDenied, executionHalted', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-events-1';

      const checkpointSpy = vi.fn();
      const transitionSpy = vi.fn();
      const deniedSpy = vi.fn();
      const haltedSpy = vi.fn();

      runner.onTaskObserverEvent('checkpoint', checkpointSpy);
      runner.onTaskObserverEvent('phaseTransition', transitionSpy);
      runner.onTaskObserverEvent('permissionDenied', deniedSpy);
      runner.onTaskObserverEvent('executionHalted', haltedSpy);

      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-ev-1',
          observed_at: NOW,
          proposals: [
            { candidate_id: 'c-1', impact: 'high', recurrence: 1, phase: 'INTENT' },
          ],
          permission_denied: false,
        },
        execId
      );

      expect(checkpointSpy).toHaveBeenCalledTimes(1);
      expect(transitionSpy).toHaveBeenCalledTimes(1);
      expect(deniedSpy).not.toHaveBeenCalled();

      // Submit denied checkpoint
      runner.submitTaskObserverCheckpoint(
        {
          checkpoint_id: 'chk-ev-2',
          observed_at: NOW,
          proposals: [],
          permission_denied: true,
        },
        execId
      );

      expect(deniedSpy).toHaveBeenCalledTimes(1);
      expect(haltedSpy).toHaveBeenCalledTimes(1);
    });
  });
});
