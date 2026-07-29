import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from '../../src/app';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { R4_ALLOWED_MODELS } from '../../src/config/schema';

const TEMP_STORE_PATH = path.join('/tmp', 'ct-review-bot', `persona_challenger_m3_${Date.now()}.json`);

describe('Milestone 3 Empirical Challenge: Persona Settings API & Persistence Backend', () => {
  let app: any;
  let validApiKey: string;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-secret';
    process.env.CT_DASHBOARD_STORE = TEMP_STORE_PATH;
    if (fs.existsSync(TEMP_STORE_PATH)) {
      fs.unlinkSync(TEMP_STORE_PATH);
    }
    app = createApp();
    const createdKey = dashboardStore.createApiKey('challenger-m3-key');
    validApiKey = createdKey.rawKey;
  });

  afterEach(() => {
    if (fs.existsSync(TEMP_STORE_PATH)) {
      fs.unlinkSync(TEMP_STORE_PATH);
    }
    delete process.env.CT_DASHBOARD_STORE;
  });

  describe('1. Baseline & Authentication Checks', () => {
    it('rejects GET /api/dashboard/personas without API key or invalid API key', async () => {
      const res1 = await request(app).get('/api/dashboard/personas');
      expect(res1.status).toBe(401);

      const res2 = await request(app)
        .get('/api/dashboard/personas')
        .set('x-api-key', 'invalid_key_123');
      expect(res2.status).toBe(401);
    });

    it('returns 200 and all 11 personas for valid GET /api/dashboard/personas', async () => {
      const res = await request(app)
        .get('/api/dashboard/personas')
        .set('x-api-key', validApiKey);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Object.keys(res.body.personas)).toHaveLength(12);
    });
  });

  describe('2. Boundary & Stress Testing for PUT /api/dashboard/personas/:persona', () => {
    it('validates model string against R4_ALLOWED_MODELS', async () => {
      // Test invalid model string
      const invalidRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ model: 'unsupported-model-x99' });

      expect(invalidRes.status).toBe(400);
      expect(invalidRes.body.success).toBe(false);
      expect(invalidRes.body.error).toContain('unsupported-model-x99');

      // Test non-string model (number)
      const numberRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ model: 12345 });

      expect(numberRes.status).toBe(400);
      expect(numberRes.body.success).toBe(false);

      // Test empty string model
      const emptyRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ model: '   ' });

      expect(emptyRes.status).toBe(400);
      expect(emptyRes.body.success).toBe(false);

      // Test all allowed models from R4_ALLOWED_MODELS
      for (const allowedModel of R4_ALLOWED_MODELS) {
        const validRes = await request(app)
          .put('/api/dashboard/personas/security')
          .set('x-api-key', validApiKey)
          .send({ model: allowedModel });

        expect(validRes.status).toBe(200);
        expect(validRes.body.persona.model).toBe(allowedModel);
      }
    });

    it('validates confidenceThreshold range and numeric types strictly', async () => {
      // Negative confidence threshold
      const negRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: -0.01 });

      expect(negRes.status).toBe(400);
      expect(negRes.body.error).toContain('confidenceThreshold');

      // Greater than 100 confidence threshold
      const highRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 100.1 });

      expect(highRes.status).toBe(400);
      expect(highRes.body.error).toContain('confidenceThreshold');

      // String representation of number (e.g. "85")
      const stringNumRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: '85' });

      expect(stringNumRes.status).toBe(400);

      // NaN and Infinity
      const nanRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: NaN });

      expect(nanRes.status).toBe(400);

      // Valid boundary values (0 and 100)
      const zeroRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 0 });
      expect(zeroRes.status).toBe(200);
      expect(zeroRes.body.persona.confidenceThreshold).toBe(0);

      const hundredRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 100 });
      expect(hundredRes.status).toBe(200);
      expect(hundredRes.body.persona.confidenceThreshold).toBe(100);
    });

    it('validates effort levels strictly', async () => {
      const invalidEfforts = ['MIN', 'MEDIUM', 'ultra', 'max_extreme', 1, null, true];
      for (const effort of invalidEfforts) {
        const res = await request(app)
          .put('/api/dashboard/personas/security')
          .set('x-api-key', validApiKey)
          .send({ effort });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
      }

      const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      for (const effort of validEfforts) {
        const res = await request(app)
          .put('/api/dashboard/personas/security')
          .set('x-api-key', validApiKey)
          .send({ effort });

        expect(res.status).toBe(200);
        expect(res.body.persona.effort).toBe(effort);
      }
    });

    it('handles custom prompt edge cases (empty, whitespace, 50KB, huge 1MB strings [413], non-string)', async () => {
      // Empty string custom prompt
      const emptyPromptRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ customPrompt: '' });

      expect(emptyPromptRes.status).toBe(200);
      expect(emptyPromptRes.body.persona.customPrompt).toBe('');

      // Whitespace custom prompt
      const wsPromptRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ customPrompt: '   \n\t   ' });

      expect(wsPromptRes.status).toBe(200);
      expect(wsPromptRes.body.persona.customPrompt).toBe('   \n\t   ');

      // 50KB custom prompt string (within body parser 100KB limit)
      const largePrompt = 'B'.repeat(50 * 1024);
      const largeRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ customPrompt: largePrompt });

      expect(largeRes.status).toBe(200);
      expect(largeRes.body.persona.customPrompt).toBe(largePrompt);

      // Huge 1MB custom prompt string (exceeds default Express 100KB limit)
      const hugePrompt = 'A'.repeat(1024 * 1024);
      const hugeRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ customPrompt: hugePrompt });

      expect(hugeRes.status).toBe(413);

      // Non-string custom prompt (number or null)
      const nullPromptRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ customPrompt: 12345 });

      expect(nullPromptRes.status).toBe(400);
    });

    it('handles persona ID route parameters (case-sensitivity and unknown IDs)', async () => {
      // Upper case persona ID
      const upperRes = await request(app)
        .put('/api/dashboard/personas/SECURITY')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 88 });

      expect(upperRes.status).toBe(404);

      // Unknown persona ID
      const unknownRes = await request(app)
        .put('/api/dashboard/personas/unknown_persona')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 88 });

      expect(unknownRes.status).toBe(404);
      expect(unknownRes.body.error).toContain('unknown_persona');
    });

    it('validates other fields (enabled, required, charter, paths, providers)', async () => {
      // Non-boolean enabled
      const enabledRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ enabled: 'true' });
      expect(enabledRes.status).toBe(400);

      // Non-boolean required
      const reqRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ required: 1 });
      expect(reqRes.status).toBe(400);

      // Non-string charter
      const charterRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ charter: 123 });
      expect(charterRes.status).toBe(400);

      // Non-array paths
      const pathsRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ paths: 'src/**' });
      expect(pathsRes.status).toBe(400);

      // Invalid element in paths array
      const pathsElemRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ paths: ['src/**', 123] });
      expect(pathsElemRes.status).toBe(400);

      // Non-array providers
      const providersRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ providers: 'claude' });
      expect(providersRes.status).toBe(400);

      // Invalid element in providers array
      const providersElemRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({ providers: ['claude', null] });
      expect(providersElemRes.status).toBe(400);
    });

    it('handles empty update body safely without modifying unchanged fields', async () => {
      const origRes = await request(app)
        .get('/api/dashboard/personas')
        .set('x-api-key', validApiKey);
      const originalSec = origRes.body.personas.security;

      const emptyRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({});

      expect(emptyRes.status).toBe(200);
      expect(emptyRes.body.persona.model).toBe(originalSec.model);
      expect(emptyRes.body.persona.confidenceThreshold).toBe(originalSec.confidenceThreshold);
      expect(emptyRes.body.persona.effort).toBe(originalSec.effort);
    });
  });

  describe('3. Persistence Survival Across Store Re-instantiations & Server Restarts', () => {
    it('persists all 11 persona updates atomically across store re-instantiations', async () => {
      const store1 = new DashboardStore(TEMP_STORE_PATH);

      // Update all 11 personas in store instance 1
      const personasToUpdate = [
        { id: 'security', model: 'claude-3-5-sonnet', confidenceThreshold: 91, effort: 'max', customPrompt: 'Security rule 1' },
        { id: 'architecture', model: 'gpt-4o', confidenceThreshold: 82, effort: 'high', customPrompt: 'Arch rule 2' },
        { id: 'performance', model: 'deepseek-v3', confidenceThreshold: 73, effort: 'medium', customPrompt: 'Perf rule 3' },
        { id: 'quality', model: 'claude-3-5-sonnet', confidenceThreshold: 64, effort: 'low', customPrompt: 'Quality rule 4' },
        { id: 'database', model: 'gpt-4o', confidenceThreshold: 85, effort: 'high', customPrompt: 'DB rule 5' },
        { id: 'api_contract', model: 'claude-3-5-sonnet', confidenceThreshold: 76, effort: 'medium', customPrompt: 'API rule 6' },
        { id: 'reliability', model: 'deepseek-v3', confidenceThreshold: 87, effort: 'high', customPrompt: 'Reliability rule 7' },
        { id: 'devops', model: 'glm-5.2', confidenceThreshold: 78, effort: 'medium', customPrompt: 'DevOps rule 8' },
        { id: 'docs_compliance', model: 'claude-3-5-sonnet', confidenceThreshold: 69, effort: 'low', customPrompt: 'Docs rule 9' },
        { id: 'finops', model: 'glm-5.2', confidenceThreshold: 71, effort: 'medium', customPrompt: 'FinOps rule 10' },
        { id: 'red_team', model: 'claude-3-5-sonnet', confidenceThreshold: 83, effort: 'high', customPrompt: 'RedTeam rule 11' },
      ] as const;

      for (const p of personasToUpdate) {
        store1.updatePersonaSetting(p.id, {
          model: p.model,
          confidenceThreshold: p.confidenceThreshold,
          effort: p.effort,
          customPrompt: p.customPrompt,
        });
      }

      // Instantiate store instance 2 reading from the exact same disk file
      const store2 = new DashboardStore(TEMP_STORE_PATH);
      const settings2 = store2.getSettings();

      for (const p of personasToUpdate) {
        const loaded = settings2.personaSettings?.[p.id];
        expect(loaded).toBeDefined();
        expect(loaded?.model).toBe(p.model);
        expect(loaded?.confidenceThreshold).toBe(p.confidenceThreshold);
        expect(loaded?.effort).toBe(p.effort);
        expect(loaded?.customPrompt).toBe(p.customPrompt);
      }
    });

    it('recovers gracefully from corrupted JSON file on disk', () => {
      // Write corrupted JSON to store file
      fs.mkdirSync(path.dirname(TEMP_STORE_PATH), { recursive: true });
      fs.writeFileSync(TEMP_STORE_PATH, 'CORRUPTED_JSON_DATA_{{{{', 'utf8');

      // Instantiating store should not throw, should fallback to defaults
      const store = new DashboardStore(TEMP_STORE_PATH);
      const settings = store.getSettings();

      expect(settings.personaSettings).toBeDefined();
      expect(Object.keys(settings.personaSettings!)).toHaveLength(12);
      expect(settings.personaSettings?.security.id).toBe('security');
    });

    it('merges stored persona overrides with default persona attributes correctly', () => {
      // Save partial JSON to disk where a persona only has customPrompt and model saved
      const partialData = {
        settings: {
          personaSettings: {
            security: {
              customPrompt: 'Partial override custom prompt',
              confidenceThreshold: 99,
            },
          },
        },
      };
      fs.mkdirSync(path.dirname(TEMP_STORE_PATH), { recursive: true });
      fs.writeFileSync(TEMP_STORE_PATH, JSON.stringify(partialData), 'utf8');

      const store = new DashboardStore(TEMP_STORE_PATH);
      const settings = store.getSettings();
      const sec = settings.personaSettings?.security;

      // Overrides from file should take effect
      expect(sec?.customPrompt).toBe('Partial override custom prompt');
      expect(sec?.confidenceThreshold).toBe(99);

      // Default attributes should be merged and present
      expect(sec?.id).toBe('security');
      expect(sec?.displayName).toBeDefined();
      expect(sec?.model).toBe('claude-3-5-sonnet');
      expect(sec?.charter).toBe('builtin:security');
    });

    it('supports PATCH /api/dashboard/settings/personas/:personaId route alias', async () => {
      const res = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({
          customPrompt: 'Updated via PATCH settings alias',
          confidenceThreshold: 92,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.persona.customPrompt).toBe('Updated via PATCH settings alias');
      expect(res.body.persona.confidenceThreshold).toBe(92);
    });
  });
});
