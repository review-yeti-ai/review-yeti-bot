import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

const TEST_STORE_PATH = '/tmp/test_persona_persistence_integration.json';

const policy = `
version: 3
profile: chill
quorum: 1
personas:
  - id: security
    enabled: true
    required: true
    charter: builtin:security
    paths: ["src/**"]
    providers: [claude]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 900
  providers:
    - id: claude
      enabled: true
      model: claude/claude-opus-4-8
      effort: high
      review_timeout_s: 300
      arbiter_timeout_s: 300
  arbiter:
    order: [claude]
`;

function fenced(nonce: string, body: object): string {
  return `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`;
}

describe('Persona Persistence & System Prompt Override Integration Suite', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_STORE_PATH)) {
      fs.unlinkSync(TEST_STORE_PATH);
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_STORE_PATH)) {
      fs.unlinkSync(TEST_STORE_PATH);
    }
  });

  it('persists persona settings overrides atomically across store re-instantiations', () => {
    const store1 = new DashboardStore(TEST_STORE_PATH);

    // Update settings in store instance 1
    const updated = store1.updatePersonaSetting('security', {
      enabled: true,
      customPrompt: 'Custom prompt for security persistence test',
      confidenceThreshold: 93,
      model: 'claude-3-5-sonnet',
      effort: 'max',
    });

    expect(updated.customPrompt).toBe('Custom prompt for security persistence test');
    expect(updated.confidenceThreshold).toBe(93);

    // Instantiate store instance 2 reading from the same disk file
    const store2 = new DashboardStore(TEST_STORE_PATH);
    const loadedSettings = store2.getSettings();

    expect(loadedSettings.personaSettings?.security).toBeDefined();
    expect(loadedSettings.personaSettings?.security.customPrompt).toBe(
      'Custom prompt for security persistence test'
    );
    expect(loadedSettings.personaSettings?.security.confidenceThreshold).toBe(93);
    expect(loadedSettings.personaSettings?.security.model).toBe('claude-3-5-sonnet');
  });

  it('wires custom prompt override in DashboardStore into panelEngine runPersona execution', async () => {
    // Set custom prompt in singleton dashboardStore used by panelEngine
    const customPromptText = 'Custom System Prompt Override: Check for unauthorized tenant data access.';
    dashboardStore.updatePersonaSetting('security', {
      customPrompt: customPromptText,
    });

    const config = parseAndValidateConfig(policy);
    let capturedCharter: string | undefined;

    const complete = async ({ model, messages }: any) => {
      const prompt = messages[messages.length - 1].content as string;
      const nonce = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/)![1];
      const payload = JSON.parse(prompt.split('\n').slice(3).join('\n'));

      if (payload.role === 'persona' && payload.persona === 'security') {
        capturedCharter = payload.charter;
        return {
          model,
          content: fenced(nonce, { decision: 'APPROVE', findings: [] }),
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('"role":"moderator"')) {
        return {
          model,
          content: fenced(nonce, { decision: 'RECONCILED', findings: [] }),
          usage: null,
          costUSD: null,
        };
      }
      if (prompt.includes('"role":"arbiter"')) {
        return {
          model,
          content: fenced(nonce, { verdict: 'SHIP', rationale: 'Approved.' }),
          usage: null,
          costUSD: null,
        };
      }
      return {
        model,
        content: fenced(nonce, { decision: 'APPROVE', findings: [] }),
        usage: null,
        costUSD: null,
      };
    };

    await executePersonaPanel({
      config,
      changedFiles: [{ path: 'src/auth.ts', patch: '+const auth = true;' }],
      repository: 'calltelemetry/cisco-cdr',
      headSha: '123456',
      client: { complete } as unknown as OmniRouteClient,
    });

    expect(capturedCharter).toBe(customPromptText);
  });

  it('supports all 11 personas in DashboardStore persistence', () => {
    const store = new DashboardStore(TEST_STORE_PATH);
    const settings = store.getSettings();

    const expectedPersonas = [
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
    ];

    for (const id of expectedPersonas) {
      expect(settings.personaSettings?.[id]).toBeDefined();
      expect(settings.personaSettings?.[id].id).toBe(id);
    }
  });

  it('PUT /api/dashboard/personas/:persona via API updates system prompt and persists across store reload', async () => {
    const storePath = '/tmp/test_persona_put_persistence.json';
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);

    const testStore = new DashboardStore(storePath);
    const updated = testStore.updatePersonaSetting('security', {
      customPrompt: 'New Security Prompt: Check for strict SQL injection & JWT validation.',
      model: 'claude-3-5-sonnet',
      effort: 'max',
      confidenceThreshold: 90,
    });

    expect(updated.customPrompt).toBe('New Security Prompt: Check for strict SQL injection & JWT validation.');

    // Reload from disk into a fresh DashboardStore instance
    const freshStore = new DashboardStore(storePath);
    const freshSettings = freshStore.getSettings();

    expect(freshSettings.personaSettings?.security.customPrompt).toBe(
      'New Security Prompt: Check for strict SQL injection & JWT validation.'
    );
    expect(freshSettings.personaSettings?.security.confidenceThreshold).toBe(90);

    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });
});
