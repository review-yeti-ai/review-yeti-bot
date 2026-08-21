import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { LiveStreamBus } from '../../src/live/liveStreamBus';

const TEST_STORE_PATH = '/tmp/test_challenger2_m3.json';

const ALL_11_PERSONA_IDS = [
  'security',
  'architecture',
  'performance',
  'quality',
  'database',
  'api_contract',
  'reliability',
  'devops',
  'docs_compliance',
  'finops',
  'red_team',
] as const;

function buildAll11PersonaConfig(): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'assertive',
    quorum: 1,
    personas: [
      { id: 'security', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
      { id: 'architecture', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['claude'] },
      { id: 'performance', enabled: true, required: false, charter: 'builtin:performance', paths: ['**'], providers: ['claude'] },
      { id: 'quality', enabled: true, required: false, charter: 'builtin:correctness', paths: ['**'], providers: ['claude'] },
      { id: 'database', enabled: true, required: false, charter: 'builtin:database', paths: ['**'], providers: ['claude'] },
      { id: 'api_contract', enabled: true, required: false, charter: 'builtin:contract', paths: ['**'], providers: ['claude'] },
      { id: 'reliability', enabled: true, required: false, charter: 'builtin:policy-compliance', paths: ['**'], providers: ['claude'] },
      { id: 'devops', enabled: true, required: false, charter: 'builtin:devops', paths: ['**'], providers: ['claude'] },
      { id: 'docs_compliance', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['claude'] },
      { id: 'finops', enabled: true, required: false, charter: 'builtin:finops', paths: ['**'], providers: ['claude'] },
      { id: 'red_team', enabled: true, required: false, charter: 'builtin:red-team', paths: ['**'], providers: ['claude'] },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 900,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['claude'],
      },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
  };
}

function fenced(nonce: string, body: object): string {
  return `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`;
}

describe('Challenger 2 Empirical Verification: System Prompt Override Resolution Across All 11 Personas', () => {
  let envBackup: string | undefined;

  beforeEach(() => {
    envBackup = process.env.CT_DASHBOARD_STORE;
    process.env.CT_DASHBOARD_STORE = TEST_STORE_PATH;
    dashboardStore.filePath = TEST_STORE_PATH;
    dashboardStore.reset();
    if (fs.existsSync(TEST_STORE_PATH)) {
      fs.unlinkSync(TEST_STORE_PATH);
    }
  });

  afterEach(() => {
    if (envBackup !== undefined) {
      process.env.CT_DASHBOARD_STORE = envBackup;
    } else {
      delete process.env.CT_DASHBOARD_STORE;
    }
    dashboardStore.reset();
    if (fs.existsSync(TEST_STORE_PATH)) {
      fs.unlinkSync(TEST_STORE_PATH);
    }
  });

  it('verifies custom prompt overrides take precedence over built-in charters for ALL 11 personas in panelEngine', async () => {
    const customPrompts: Record<string, string> = {};

    ALL_11_PERSONA_IDS.forEach((id, idx) => {
      const prompt = `OVERRIDE PROMPT FOR PERSONA #${idx + 1} (${id}): Strictly analyze logic for bugs and security risks.`;
      customPrompts[id] = prompt;
      dashboardStore.updatePersonaSetting(id, { customPrompt: prompt, model: 'claude-3-5-sonnet' });
    });

    const capturedPersonaCharters: Record<string, string> = {};
    const bus = LiveStreamBus.getInstance();
    const jobId = 'job_calltelemetry_cisco-cdr_abc1234';
    bus.clearHistory(jobId);

    const mockComplete = async ({ model, messages }: any) => {
      const prompt = messages[messages.length - 1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'test-nonce';
      const allMsg = JSON.stringify(messages);
      
      const personaMatch = prompt.match(/\("persona":"([^"]+)"\)/);
      const persona = personaMatch ? personaMatch[1] : undefined;
      const charterMatch = prompt.match(/Charter:\s*(.+)$/m);
      const charter = charterMatch ? charterMatch[1].trim() : undefined;
      if (persona && charter && !['moderator', 'arbiter'].includes(persona)) {
        capturedPersonaCharters[persona] = charter;
      }

      if (allMsg.includes('arbiter')) {
        return {
          model,
          content: fenced(nonce, { verdict: 'SHIP', rationale: 'Approved.' }),
          usage: { prompt: 100, completion: 50, total: 150 },
          costUSD: 0.001,
        };
      }

      if (allMsg.includes('moderator')) {
        return {
          model,
          content: fenced(nonce, { decision: 'RECONCILED', findings: [] }),
          usage: { prompt: 100, completion: 50, total: 150 },
          costUSD: 0.001,
        };
      }

      return {
        model,
        content: fenced(nonce, { decision: 'APPROVE', findings: [] }),
        usage: { prompt: 100, completion: 50, total: 150 },
        costUSD: 0.001,
      };
    };

    const config = buildAll11PersonaConfig();
    const result = await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/main.ts', patch: '+console.log("test");' }],
      repository: 'calltelemetry/cisco-cdr',
      headSha: 'abc1234',
      client: { complete: mockComplete } as unknown as OmniRouteClient,
      jobId,
    });

    const busEvents = bus.getHistory(jobId);

    expect(result).toBeDefined();
    expect(Object.keys(capturedPersonaCharters).length).toBe(11);

    for (const id of ALL_11_PERSONA_IDS) {
      expect(capturedPersonaCharters[id]).toBe(customPrompts[id]);
      
      const startEvent = busEvents.find((e) => e.type === 'persona:start' && e.persona === id);
      expect(startEvent).toBeDefined();
      expect(startEvent?.data?.charter).toBe(customPrompts[id]);
    }
  });

  it('validates precedence: DashboardStore customPrompt > YAML persona.customPrompt > Built-in charter', async () => {
    dashboardStore.updatePersonaSetting('security', {
      customPrompt: 'DashboardStore Security Prompt Override',
      model: 'claude-3-5-sonnet',
    });

    const config = buildAll11PersonaConfig();
    (config.personas[0] as any).customPrompt = 'YAML Security Prompt Override';

    const capturedPersonaCharters: Record<string, string> = {};

    const mockComplete = async ({ model, messages }: any) => {
      const prompt = messages[messages.length - 1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'test-nonce';
      
      const personaMatch = prompt.match(/\("persona":"([^"]+)"\)/);
      const persona = personaMatch ? personaMatch[1] : undefined;
      const charterMatch = prompt.match(/Charter:\s*(.+)$/m);
      const charter = charterMatch ? charterMatch[1].trim() : undefined;
      if (persona && charter) {
        capturedPersonaCharters[persona] = charter;
      }

      const allMsg = JSON.stringify(messages);
      if (allMsg.includes('arbiter')) {
        return { model, content: fenced(nonce, { verdict: 'SHIP', rationale: 'OK' }), usage: null, costUSD: null };
      }
      if (allMsg.includes('moderator')) {
        return { model, content: fenced(nonce, { decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null };
      }
      return { model, content: fenced(nonce, { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    };

    await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/main.ts', patch: '+const x = 1;' }],
      repository: 'calltelemetry/cisco-cdr',
      headSha: 'abc1234',
      client: { complete: mockComplete } as unknown as OmniRouteClient,
    });

    expect(capturedPersonaCharters['security']).toBe('DashboardStore Security Prompt Override');

    dashboardStore.updatePersonaSetting('security', { customPrompt: '' });

    const capturedChartersPhase2: Record<string, string> = {};
    const mockCompletePhase2 = async ({ model, messages }: any) => {
      const prompt = messages[messages.length - 1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'test-nonce';
      
      const personaMatch = prompt.match(/\("persona":"([^"]+)"\)/);
      const persona = personaMatch ? personaMatch[1] : undefined;
      const charterMatch = prompt.match(/Charter:\s*(.+)$/m);
      const charter = charterMatch ? charterMatch[1].trim() : undefined;
      if (persona && charter) {
        capturedChartersPhase2[persona] = charter;
      }

      const allMsg2 = JSON.stringify(messages);
      if (allMsg2.includes('arbiter')) {
        return { model, content: fenced(nonce, { verdict: 'SHIP', rationale: 'OK' }), usage: null, costUSD: null };
      }
      if (allMsg2.includes('moderator')) {
        return { model, content: fenced(nonce, { decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null };
      }
      return { model, content: fenced(nonce, { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    };

    await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/main.ts', patch: '+const x = 1;' }],
      repository: 'calltelemetry/cisco-cdr',
      headSha: 'abc1234',
      client: { complete: mockCompletePhase2 } as unknown as OmniRouteClient,
    });

    expect(capturedChartersPhase2['security']).toBe('YAML Security Prompt Override');
  });

  it('handles whitespace-only custom prompts gracefully by falling back to built-in charter', async () => {
    dashboardStore.updatePersonaSetting('performance', {
      customPrompt: '   \n\t   ',
      model: 'claude-3-5-sonnet',
    });

    const capturedPersonaCharters: Record<string, string> = {};

    const mockComplete = async ({ model, messages }: any) => {
      const prompt = messages[messages.length - 1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'test-nonce';
      
      const personaMatch = prompt.match(/\("persona":"([^"]+)"\)/);
      const persona = personaMatch ? personaMatch[1] : undefined;
      const charterMatch = prompt.match(/Charter:\s*(.+)$/m);
      const charter = charterMatch ? charterMatch[1].trim() : undefined;
      if (persona && charter) {
        capturedPersonaCharters[persona] = charter;
      }

      const allMsg3 = JSON.stringify(messages);
      if (allMsg3.includes('arbiter')) {
        return { model, content: fenced(nonce, { verdict: 'SHIP', rationale: 'OK' }), usage: null, costUSD: null };
      }
      if (allMsg3.includes('moderator')) {
        return { model, content: fenced(nonce, { decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null };
      }
      return { model, content: fenced(nonce, { decision: 'APPROVE', findings: [] }), usage: null, costUSD: null };
    };

    const config = buildAll11PersonaConfig();
    await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/main.ts', patch: '+const x = 1;' }],
      repository: 'calltelemetry/cisco-cdr',
      headSha: 'abc1234',
      client: { complete: mockComplete } as unknown as OmniRouteClient,
    });

    expect(
      capturedPersonaCharters['performance'].startsWith(
        'Identify CPU/memory bottlenecks, N+1 queries, unindexed queries, blocking loops, and memory leaks.'
      )
    ).toBe(true);
  });
});
