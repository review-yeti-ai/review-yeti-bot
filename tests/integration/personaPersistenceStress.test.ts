import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { createDashboardRouter } from '../../src/api/dashboardApi';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

const STRESS_STORE_PATH = '/tmp/test_persona_persistence_stress.json';

const samplePolicy = `
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
  - id: architecture
    enabled: true
    required: true
    charter: builtin:consistency
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

describe('Adversarial & Stress Verification for Persona Prompt Persistence', () => {
  beforeEach(() => {
    if (fs.existsSync(STRESS_STORE_PATH)) fs.unlinkSync(STRESS_STORE_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(STRESS_STORE_PATH)) fs.unlinkSync(STRESS_STORE_PATH);
  });

  it('persists complex multiline prompts with markdown, quotes, emojis, and special chars across store re-instantiations', () => {
    const store1 = new DashboardStore(STRESS_STORE_PATH);

    const complexPrompt = `
# SYSTEM OVERRIDE: Security Persona
- Check for SQLi: "SELECT * FROM users WHERE id = '" + input + "'";
- Check for XSS: <script>alert('xss')</script> & unicode: 🔒 \u0000 \n\r\t
- Ensure multi-tenant isolation key \`tenant_id\` is present on ALL queries.
    `.trim();

    store1.updatePersonaSetting('security', {
      customPrompt: complexPrompt,
    });

    // Simulate process restart by instantiating new DashboardStore from same path
    const store2 = new DashboardStore(STRESS_STORE_PATH);
    const loaded = store2.getSettings();

    expect(loaded.personaSettings?.security.customPrompt).toBe(complexPrompt);
  });

  it('persists large custom prompts (50KB+) without data corruption', () => {
    const store1 = new DashboardStore(STRESS_STORE_PATH);
    const largePrompt = 'Rule: Check security boundaries thoroughly. '.repeat(1500); // ~70KB

    store1.updatePersonaSetting('architecture', {
      customPrompt: largePrompt,
    });

    const store2 = new DashboardStore(STRESS_STORE_PATH);
    const loaded = store2.getSettings();

    expect(loaded.personaSettings?.architecture.customPrompt?.length).toBe(largePrompt.length);
    expect(loaded.personaSettings?.architecture.customPrompt).toBe(largePrompt);
  });

  it('handles HTTP PUT /api/dashboard/personas/:persona and verifies disk file persistence across restart', async () => {
    // Set environment variable CT_DASHBOARD_STORE for test app router
    process.env.CT_DASHBOARD_STORE = STRESS_STORE_PATH;
    
    // Instantiate store with process env path
    const testStore = new DashboardStore(STRESS_STORE_PATH);
    (dashboardStore as any).filePath = STRESS_STORE_PATH;
    (dashboardStore as any).data = (testStore as any).data;
    testStore.saveData((testStore as any).data);

    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', createDashboardRouter());

    const updateRes = await request(app)
      .put('/api/dashboard/personas/red_team')
      .send({
        customPrompt: 'Red Team Prompt: Actively search for auth bypass vulnerabilities.',
        confidenceThreshold: 88,
        model: 'claude-haiku-4.5',
        effort: 'max',
      });

    if (updateRes.status !== 200) {
      console.error('PUT /api/dashboard/personas/red_team error:', updateRes.body);
    }
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
    expect(updateRes.body.persona.customPrompt).toBe('Red Team Prompt: Actively search for auth bypass vulnerabilities.');

    // Read directly from raw JSON file on disk to guarantee disk write happened
    const rawFileContent = fs.readFileSync(STRESS_STORE_PATH, 'utf8');
    const parsedData = JSON.parse(rawFileContent);
    expect(parsedData.settings.personaSettings.red_team.customPrompt).toBe(
      'Red Team Prompt: Actively search for auth bypass vulnerabilities.'
    );
    expect(parsedData.settings.personaSettings.red_team.confidenceThreshold).toBe(88);

    // Re-read with a completely clean store instance
    const store3 = new DashboardStore(STRESS_STORE_PATH);
    expect(store3.getSettings().personaSettings?.red_team.customPrompt).toBe(
      'Red Team Prompt: Actively search for auth bypass vulnerabilities.'
    );
  });

  it('rejects invalid persona updates gracefully without corrupting disk store', async () => {
    const store1 = new DashboardStore(STRESS_STORE_PATH);
    store1.updatePersonaSetting('devops', {
      customPrompt: 'Valid initial DevOps prompt',
    });

    // Try setting invalid confidence threshold (> 100)
    expect(() => {
      store1.updatePersonaSetting('devops', {
        confidenceThreshold: 150,
      });
    }).toThrow(/confidenceThreshold/);

    // Ensure store file was not corrupted and previous valid state is preserved
    const store2 = new DashboardStore(STRESS_STORE_PATH);
    expect(store2.getSettings().personaSettings?.devops.customPrompt).toBe('Valid initial DevOps prompt');
  });

  it('preserves persona prompt updates across multiple consecutive updates to different personas', () => {
    const store1 = new DashboardStore(STRESS_STORE_PATH);

    const standardIds = [
      'security', 'architecture', 'performance', 'quality',
      'database', 'api_contract', 'reliability', 'devops',
      'docs_compliance', 'finops', 'red_team'
    ];

    standardIds.forEach((id, idx) => {
      store1.updatePersonaSetting(id, {
        customPrompt: `Custom prompt for persona ${id} - iteration ${idx}`,
      });
    });

    const store2 = new DashboardStore(STRESS_STORE_PATH);
    const settings = store2.getSettings();

    standardIds.forEach((id, idx) => {
      expect(settings.personaSettings?.[id].customPrompt).toBe(
        `Custom prompt for persona ${id} - iteration ${idx}`
      );
    });
  });
});
