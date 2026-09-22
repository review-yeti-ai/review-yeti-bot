import { describe, expect, it, vi } from 'vitest';
import {
  fetchRunResource,
  fetchFindingsResource,
  fetchChartersResource,
  parseResourceUri,
  listResourceCatalog,
  readResourceContent,
} from '../../src/mcp/server/resources';
import {
  DEFAULT_ACTIVE_PERSONAS,
  DEFAULT_DIRECTIVES,
} from '../../src/mcp/server/resources/chartersResource';

describe('Empirical Challenger 2 Suite: Data Models, Queries & Zero-State Fallbacks (Milestone M7)', () => {
  // =========================================================================
  // Mandate 1: runResource Zero-State & State Resolution
  // =========================================================================
  describe('Mandate 1: runResource Zero-State Fallback & Exception Safety', () => {
    it('1.1: Returns valid zero-state response without throwing when db is undefined', async () => {
      const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 42, undefined);

      expect(res).toBeDefined();
      expect(res.uri).toBe('review-yeti://runs/calltelemetry/cisco-cdr/42');
      expect(res.owner).toBe('calltelemetry');
      expect(res.repo).toBe('cisco-cdr');
      expect(res.pr_number).toBe(42);
      expect(res.found).toBe(false);
      expect(res.run_id).toBeNull();
      expect(res.head_sha).toBeNull();
      expect(res.phase).toBe('queued');
      expect(res.verdict).toBe('PENDING');
      expect(res.attempt_id).toBeNull();
      expect(res.check_run).toBeNull();
      expect(res.created_at).toBeUndefined();
      expect(res.updated_at).toBeUndefined();
    });

    it('1.2: Returns valid zero-state response when db query returns empty rows (no run found)', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 999, mockDb);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(res.found).toBe(false);
      expect(res.verdict).toBe('PENDING');
      expect(res.phase).toBe('queued');
      expect(res.run_id).toBeNull();
      expect(res.head_sha).toBeNull();
      expect(res.attempt_id).toBeNull();
      expect(res.check_run).toBeNull();
    });

    it('1.3: Gracefully handles primary query error by attempting fallback query and returning zero-state', async () => {
      const mockDb = {
        query: vi
          .fn()
          // First query (joined with review_gate_attempts) throws error (e.g. relation does not exist)
          .mockRejectedValueOnce(new Error('relation "review_gate_attempts" does not exist'))
          // Fallback query (review_runs only) returns empty rows
          .mockResolvedValueOnce({ rows: [] }),
      };

      const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 500, mockDb);

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      expect(res.found).toBe(false);
      expect(res.verdict).toBe('PENDING');
      expect(res.phase).toBe('queued');
      expect(res.run_id).toBeNull();
    });

    it('1.4: Gracefully handles total database failure (both queries throwing) without unhandled exception', async () => {
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('FATAL: 57P01: terminating connection due to administrator command')),
      };

      const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 501, mockDb);

      expect(mockDb.query).toHaveBeenCalledTimes(2);
      expect(res.found).toBe(false);
      expect(res.verdict).toBe('PENDING');
      expect(res.run_id).toBeNull();
    });

    it('1.5: Correctly resolves run phases: queued, evaluating_personas, arbitration, completed', async () => {
      const testCases = [
        { status: 'queued', stage: 'init', expectedPhase: 'queued' },
        { status: 'running', stage: 'personas', expectedPhase: 'evaluating_personas' },
        { status: 'running', stage: 'arbitration', expectedPhase: 'arbitration' },
        { status: 'publishing', stage: 'publish', expectedPhase: 'arbitration' },
        { status: 'succeeded', stage: 'completed', expectedPhase: 'completed' },
        { status: 'failed', stage: 'error', expectedPhase: 'completed' },
        { status: 'complete', stage: 'done', expectedPhase: 'completed' },
      ];

      for (const tc of testCases) {
        const mockDb = {
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                run_id: 'run-phase-test',
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                pr_number: 10,
                run_status: tc.status,
                run_stage: tc.stage,
                created_at: new Date('2026-09-22T00:00:00Z'),
              },
            ],
          }),
        };

        const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 10, mockDb);
        expect(res.phase).toBe(tc.expectedPhase);
      }
    });

    it('1.6: Correctly resolves verdicts from decision JSON, desired_state, and run_status', async () => {
      // Decision JSON overrides
      const decisionCases = [
        { decision: JSON.stringify({ verdict: 'SHIP' }), expectedVerdict: 'SHIP' },
        { decision: JSON.stringify({ verdict: 'FIX_FIRST' }), expectedVerdict: 'FIX_FIRST' },
        { decision: JSON.stringify({ verdict: 'BLOCK' }), expectedVerdict: 'NACK' },
        { decision: JSON.stringify({ verdict: 'COMMENT' }), expectedVerdict: 'COMMENT' },
        { decision: JSON.stringify({ verdict: 'other' }), expectedVerdict: 'SHIP' },
      ];

      for (const dc of decisionCases) {
        const mockDb = {
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                run_id: 'run-verdict',
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                pr_number: 1,
                run_status: 'complete',
                decision: dc.decision,
              },
            ],
          }),
        };
        const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 1, mockDb);
        expect(res.verdict).toBe(dc.expectedVerdict);
      }

      // desired_state fallback
      const desiredStateCases = [
        { desired_state: 'success', expectedVerdict: 'SHIP' },
        { desired_state: 'failure', expectedVerdict: 'FIX_FIRST' },
        { desired_state: 'cancelled', expectedVerdict: 'FAILED' },
        { desired_state: 'timed_out', expectedVerdict: 'FAILED' },
        { desired_state: 'queued', expectedVerdict: 'PENDING' },
        { desired_state: 'in_progress', expectedVerdict: 'RUNNING' },
      ];

      for (const dsc of desiredStateCases) {
        const mockDb = {
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                run_id: 'run-desired',
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                pr_number: 1,
                desired_state: dsc.desired_state,
              },
            ],
          }),
        };
        const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 1, mockDb);
        expect(res.verdict).toBe(dsc.expectedVerdict);
      }

      // run_status fallback
      const statusCases = [
        { run_status: 'queued', expectedVerdict: 'PENDING' },
        { run_status: 'running', expectedVerdict: 'RUNNING' },
        { run_status: 'publishing', expectedVerdict: 'RUNNING' },
        { run_status: 'succeeded', expectedVerdict: 'SHIP' },
        { run_status: 'complete', expectedVerdict: 'SHIP' },
        { run_status: 'failed', expectedVerdict: 'FAILED' },
      ];

      for (const sc of statusCases) {
        const mockDb = {
          query: vi.fn().mockResolvedValue({
            rows: [
              {
                run_id: 'run-status',
                owner: 'calltelemetry',
                repo: 'cisco-cdr',
                pr_number: 1,
                run_status: sc.run_status,
              },
            ],
          }),
        };
        const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 1, mockDb);
        expect(res.verdict).toBe(sc.expectedVerdict);
      }
    });

    it('1.7: Generates check_run structure accurately with URL and conclusion', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-check',
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              pr_number: 77,
              check_id: '88776655',
              desired_state: 'failure',
              run_status: 'failed',
            },
          ],
        }),
      };

      const res = await fetchRunResource('calltelemetry', 'cisco-cdr', 77, mockDb);
      expect(res.check_run).toEqual({
        id: 88776655,
        url: 'https://github.com/calltelemetry/cisco-cdr/runs/88776655',
        conclusion: 'failure',
      });
    });
  });

  // =========================================================================
  // Mandate 2: findingsResource Parsing, Severities, Lines & ADRs
  // =========================================================================
  describe('Mandate 2: findingsResource Parsing, Severities, Lines & ADR Citations', () => {
    it('2.1: Returns valid zero-state response when db is undefined or returns no rows', async () => {
      const resUndef = await fetchFindingsResource('owner', 'repo', 10, undefined);
      expect(resUndef).toEqual({
        uri: 'review-yeti://findings/owner/repo/10',
        owner: 'owner',
        repo: 'repo',
        pr_number: 10,
        total_count: 0,
        unresolved_count: 0,
        findings: [],
      });

      const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const resEmpty = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(resEmpty.total_count).toBe(0);
      expect(resEmpty.unresolved_count).toBe(0);
      expect(resEmpty.findings).toEqual([]);
    });

    it('2.2: Normalizes severities P0, P1, P2 across aliases and casing', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: 'run-sev-matrix',
              payload: {
                findings: [
                  { title: 'Test 1', severity: 'P0' },
                  { title: 'Test 2', severity: 'p0' },
                  { title: 'Test 3', severity: 'CRITICAL' },
                  { title: 'Test 4', severity: 'critical' },
                  { title: 'Test 5', severity: 'P1' },
                  { title: 'Test 6', severity: 'p1' },
                  { title: 'Test 7', severity: 'HIGH' },
                  { title: 'Test 8', severity: 'high' },
                  { title: 'Test 9', severity: 'P2' },
                  { title: 'Test 10', severity: 'p2' },
                  { title: 'Test 11', severity: 'MEDIUM' },
                  { title: 'Test 12', severity: 'LOW' },
                  { title: 'Test 13', severity: 'INFO' },
                  { title: 'Test 14', severity: 'WARNING' },
                  { title: 'Test 15', severity: '' },
                  { title: 'Test 16', severity: undefined },
                ],
              },
            },
          ],
        }),
      };

      const res = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(res.findings).toHaveLength(16);

      // P0 items
      expect(res.findings[0].severity).toBe('P0');
      expect(res.findings[1].severity).toBe('P0');
      expect(res.findings[2].severity).toBe('P0');
      expect(res.findings[3].severity).toBe('P0');

      // P1 items
      expect(res.findings[4].severity).toBe('P1');
      expect(res.findings[5].severity).toBe('P1');
      expect(res.findings[6].severity).toBe('P1');
      expect(res.findings[7].severity).toBe('P1');

      // P2 items (defaults and others)
      for (let i = 8; i < 16; i++) {
        expect(res.findings[i].severity).toBe('P2');
      }
    });

    it('2.3: Extracts line_start and line_end with robust fallback chains', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              payload: {
                findings: [
                  // Full coordinates
                  { title: 'F1', line_start: 10, line_end: 20 },
                  // startLine / line
                  { title: 'F2', startLine: 30, line: 40 },
                  // only line
                  { title: 'F3', line: 50 },
                  // only line_end
                  { title: 'F4', line_end: 60 },
                  // string numbers
                  { title: 'F5', line_start: '70', line_end: '80' },
                  // missing lines completely
                  { title: 'F6' },
                ],
              },
            },
          ],
        }),
      };

      const res = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(res.findings[0].line_start).toBe(10);
      expect(res.findings[0].line_end).toBe(20);

      expect(res.findings[1].line_start).toBe(30);
      expect(res.findings[1].line_end).toBe(40);

      expect(res.findings[2].line_start).toBe(50);
      expect(res.findings[2].line_end).toBe(50);

      expect(res.findings[3].line_start).toBe(60);
      expect(res.findings[3].line_end).toBe(60);

      expect(res.findings[4].line_start).toBe(70);
      expect(res.findings[4].line_end).toBe(80);

      expect(res.findings[5].line_start).toBe(1);
      expect(res.findings[5].line_end).toBe(1);
    });

    it('2.4: Extracts and standardizes ADR citations from both array and regex across multiple findings', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              payload: {
                findings: [
                  {
                    title: 'Breaks ADR-0329 and ADR 0441',
                    body: 'Please see ADR_0512 for context',
                    recommendation: 'Refactor per ADR #594',
                  },
                  {
                    title: 'Secondary defect violating ADR 0564',
                    violated_adrs: ['ADR 0564', 'ADR 0123'],
                    body: 'Refers to ADR 99 and ADR 1000',
                  },
                  {
                    title: 'Third finding without any ADR citations',
                    body: 'Clean finding with no architecture citations',
                  },
                ],
              },
            },
          ],
        }),
      };

      const res = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(res.findings).toHaveLength(3);

      const f1Adrs = res.findings[0].violated_adrs!;
      expect(f1Adrs).toBeDefined();
      expect(f1Adrs).toContain('ADR 0329');
      expect(f1Adrs).toContain('ADR 0441');
      expect(f1Adrs).toContain('ADR 0512');
      expect(f1Adrs).toContain('ADR 0594');

      const f2Adrs = res.findings[1].violated_adrs!;
      expect(f2Adrs).toBeDefined();
      expect(f2Adrs).toContain('ADR 0564');
      expect(f2Adrs).toContain('ADR 0123');
      expect(f2Adrs).toContain('ADR 1000');
      // Note: ADR 99 has 2 digits, while regex \bADR[-_\s]?#?(\d{3,4})\b requires 3 or 4 digits
      expect(f2Adrs).not.toContain('ADR 99');

      // Third finding should have undefined violated_adrs
      expect(res.findings[2].violated_adrs).toBeUndefined();
    });

    it('2.5: Correctly maps finding categories (Architecture, Security, Testing, Dependencies, Contract)', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              payload: {
                findings: [
                  { title: 'Explicit', category: 'Compliance' },
                  { title: 'Architecture leak', persona: 'architect' },
                  { title: 'XSS Injection', persona: 'security' },
                  { title: 'Missing test assertion', persona: 'testing' },
                  { title: 'Outdated package', persona: 'dependencies' },
                  { title: 'API Schema breaking change', persona: 'contract' },
                  { title: 'Generic nit', persona: 'reviewer' },
                ],
              },
            },
          ],
        }),
      };

      const res = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(res.findings[0].category).toBe('Compliance');
      expect(res.findings[1].category).toBe('Architecture');
      expect(res.findings[2].category).toBe('Security');
      expect(res.findings[3].category).toBe('Testing');
      expect(res.findings[4].category).toBe('Dependencies');
      expect(res.findings[5].category).toBe('Contract');
      expect(res.findings[6].category).toBe('Architecture');
    });

    it('2.6: Accurately computes total_count and unresolved_count based on status and resolved flag', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              payload: {
                findings: [
                  { title: 'Open 1', status: 'OPEN' },
                  { title: 'Open 2' }, // defaults to open
                  { title: 'Resolved 1', resolved: true },
                  { title: 'Resolved 2', status: 'RESOLVED' },
                  { title: 'Overruled 1', status: 'OVERRULED' },
                  { title: 'Overruled 2', verdict: 'overruled' },
                ],
              },
            },
          ],
        }),
      };

      const res = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(res.total_count).toBe(6);
      expect(res.unresolved_count).toBe(2);

      expect(res.findings[0].unresolved).toBe(true);
      expect(res.findings[1].unresolved).toBe(true);
      expect(res.findings[2].unresolved).toBe(false);
      expect(res.findings[3].unresolved).toBe(false);
      expect(res.findings[4].unresolved).toBe(false);
      expect(res.findings[5].unresolved).toBe(false);
    });

    it('2.7: Successfully extracts findings from nested payload formats (result.personas & personas)', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              payload: {
                result: {
                  personas: [
                    {
                      id: 'sec',
                      findings: [{ title: 'Sec Issue 1', severity: 'CRITICAL', file: 'a.ts', line: 5 }],
                    },
                    {
                      id: 'perf',
                      findings: [{ title: 'Perf Issue 1', severity: 'HIGH', file: 'b.ts', line: 15 }],
                    },
                  ],
                },
              },
            },
          ],
        }),
      };

      const res = await fetchFindingsResource('owner', 'repo', 10, mockDb);
      expect(res.total_count).toBe(2);
      expect(res.findings[0].title).toBe('Sec Issue 1');
      expect(res.findings[0].severity).toBe('P0');
      expect(res.findings[0].category).toBe('Security');

      expect(res.findings[1].title).toBe('Perf Issue 1');
      expect(res.findings[1].severity).toBe('P1');
    });
  });

  // =========================================================================
  // Mandate 3: chartersResource Standard Charters & Directives
  // =========================================================================
  describe('Mandate 3: chartersResource Personas & Directives Contract', () => {
    it('3.1: Returns 4 standard charters and default directives when db is undefined', async () => {
      const res = await fetchChartersResource('calltelemetry', 'cisco-cdr', undefined);

      expect(res.uri).toBe('review-yeti://charters/calltelemetry/cisco-cdr');
      expect(res.owner).toBe('calltelemetry');
      expect(res.repo).toBe('cisco-cdr');

      expect(res.active_personas).toHaveLength(4);
      const personaIds = res.active_personas.map((p) => p.id);
      expect(personaIds).toContain('architect');
      expect(personaIds).toContain('security');
      expect(personaIds).toContain('correctness');
      expect(personaIds).toContain('performance');

      // Verify names and descriptions
      const architect = res.active_personas.find((p) => p.id === 'architect')!;
      expect(architect.name).toBe('Architect');
      expect(architect.charter).toBe('builtin:architecture');

      const security = res.active_personas.find((p) => p.id === 'security')!;
      expect(security.name).toBe('Security Auditor');
      expect(security.charter).toBe('builtin:security');

      const correctness = res.active_personas.find((p) => p.id === 'correctness')!;
      expect(correctness.name).toBe('Correctness Reviewer');
      expect(correctness.charter).toBe('builtin:correctness');

      const performance = res.active_personas.find((p) => p.id === 'performance')!;
      expect(performance.name).toBe('Performance Reviewer');
      expect(performance.charter).toBe('builtin:performance');

      // Directives
      expect(res.directives).toEqual({
        max_investigation_turns: 3,
        lane_call_budget: 5,
        zoekt_enabled: true,
      });
    });

    it('3.2: Merges custom directives and overrides personas when defined in database', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              directives: {
                max_investigation_turns: 5,
                custom_timeout_ms: 60000,
              },
              personas: [
                {
                  id: 'custom_auditor',
                  name: 'Custom Compliance Auditor',
                  charter: 'custom:compliance',
                },
              ],
            },
          ],
        }),
      };

      const res = await fetchChartersResource('calltelemetry', 'cisco-cdr', mockDb);
      expect(res.active_personas).toHaveLength(1);
      expect(res.active_personas[0].id).toBe('custom_auditor');

      // Directives merged
      expect(res.directives.max_investigation_turns).toBe(5);
      expect(res.directives.lane_call_budget).toBe(5); // default retained
      expect(res.directives.zoekt_enabled).toBe(true); // default retained
      expect(res.directives.custom_timeout_ms).toBe(60000);
    });

    it('3.3: Gracefully falls back to default personas and directives when db throws', async () => {
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('Table repo_review_policies does not exist')),
      };

      const res = await fetchChartersResource('calltelemetry', 'cisco-cdr', mockDb);
      expect(res.active_personas).toEqual(DEFAULT_ACTIVE_PERSONAS);
      expect(res.directives).toEqual(DEFAULT_DIRECTIVES);
    });
  });

  // =========================================================================
  // Mandate 4: End-to-End readResourceContent Facade
  // =========================================================================
  describe('Mandate 4: readResourceContent Integration Facade', () => {
    it('4.1: Successfully resolves runs, findings, and charters through single entry point', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const runRes = await readResourceContent('review-yeti://runs/calltelemetry/cisco-cdr/100', mockDb);
      expect(runRes.contents[0].mimeType).toBe('application/json');
      const runData = JSON.parse((runRes.contents[0] as any).text);
      expect(runData.found).toBe(false);

      const findRes = await readResourceContent('review-yeti://findings/calltelemetry/cisco-cdr/100', mockDb);
      expect(findRes.contents[0].mimeType).toBe('application/json');
      const findData = JSON.parse((findRes.contents[0] as any).text);
      expect(findData.total_count).toBe(0);

      const charterRes = await readResourceContent('review-yeti://charters/calltelemetry/cisco-cdr', mockDb);
      expect(charterRes.contents[0].mimeType).toBe('application/json');
      const charterData = JSON.parse((charterRes.contents[0] as any).text);
      expect(charterData.active_personas).toHaveLength(4);
    });

    it('4.2: Throws informative error for unsupported resource URI', async () => {
      await expect(readResourceContent('review-yeti://unsupported/repo')).rejects.toThrow(
        /Unsupported resource URI/
      );
    });
  });
});
