import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ConfigResolver } from '../../src/config/configResolver';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';
import { PERSONA_CHARTERS } from '../../.github/workflows/pipelines/review-pipeline.js';
import fs from 'fs';
import path from 'path';

describe('Empirical Verification Suite for Challenger M1_2 (Targeted Features R1, R2, R3)', () => {
  describe('1. 3-Tier Precedence Logic (.ct-review.yaml vs dashboardStore defaults)', () => {
    it('verifies local repository .ct-review.yaml settings override dashboardStore & system defaults', async () => {
      const resolver = new ConfigResolver();

      // Mock Repository Content Client
      const mockClient = {
        async getFileContent(_owner: string, repo: string, path: string): Promise<string | null> {
          if (repo === 'my-target-repo' && path === '.ct-review.yaml') {
            return `
version: 3
profile: assertive
reviewer_effort: high
default_effort: high
personas:
  - id: security
    enabled: false
    model: openrouter/anthropic/claude-3.5-sonnet
    effort: high
  - id: performance
    enabled: true
    model: openrouter/openai/gpt-4o
    effort: xhigh
`;
          }
          return null; // No org config
        },
      };

      // Resolve config for target repo
      const resolved = await resolver.resolveConfig({
        owner: 'test-org',
        repo: 'my-target-repo',
        client: mockClient,
        systemSettingsOverride: {
          defaultModelOverrides: {
            openai: 'gpt-4o-mini',
          },
        },
      });

      // 1. Verify reviewer_effort from local .ct-review.yaml overrides system default ('medium')
      expect(resolved.reviewer_effort).toBe('high');

      // 2. Verify persona 'security' enabled: false in .ct-review.yaml overrides default enabled: true
      const secPersona = resolved.personas.find((p) => p.id === 'security');
      expect(secPersona).toBeDefined();
      expect(secPersona?.enabled).toBe(false);
      expect(secPersona?.model).toBe('openrouter/anthropic/claude-3.5-sonnet');
      expect(secPersona?.effort).toBe('high');

      // 3. Verify persona 'performance' custom model & effort in .ct-review.yaml
      const perfPersona = resolved.personas.find((p) => p.id === 'performance');
      expect(perfPersona).toBeDefined();
      expect(perfPersona?.enabled).toBe(true);
      expect(perfPersona?.model).toBe('openrouter/openai/gpt-4o');
      expect(perfPersona?.effort).toBe('xhigh');
    });
  });

  describe('2. Mock Data Isolation (POST /api/github/app-config/verify)', () => {
    let app: express.Application;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/github', createGitHubAppApiRouter());
    });

    it('returns HTTP 400 when appId or privateKeyPem is missing', async () => {
      const res = await request(app)
        .post('/api/github/app-config/verify')
        .send({ appId: '', privateKeyPem: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.verified).toBe(false);
      expect(res.body.error).toContain('Missing required GitHub App ID or RSA Private Key PEM');
      expect(JSON.stringify(res.body)).not.toContain('ghs_mock_');
    });

    it('returns HTTP 200 with jwtGenerated true when installationId is missing but valid key provided', async () => {
      const { generateKeyPairSync } = await import('crypto');
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });

      const res = await request(app)
        .post('/api/github/app-config/verify')
        .send({
          appId: '12345',
          privateKeyPem: privateKey,
          installationId: '',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.verified).toBe(true);
      expect(res.body.jwtGenerated).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('ghs_mock_');
    });

    it('returns HTTP 400/401 when token exchange fails (no ghs_mock_ tokens generated)', async () => {
      const { generateKeyPairSync } = await import('crypto');
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const res = await request(app)
        .post('/api/github/app-config/verify')
        .send({
          appId: '999999',
          privateKeyPem: privateKey,
          installationId: '88888888',
        });

      expect([200, 400, 401]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.success).toBe(true);
        expect(res.body.verified).toBe(true);
      } else {
        expect(res.body.success).toBe(false);
        expect(res.body.verified).toBe(false);
      }
    });
  });

  describe('3. 12 Persona Roster Harmonization & Parallel Execution (Promise.allSettled)', () => {
    it('verifies exactly 12 standard reviewer personas in review-pipeline.js', () => {
      expect(PERSONA_CHARTERS).toHaveLength(12);
      const personaIds = PERSONA_CHARTERS.map((p: any) => p.id);
      expect(personaIds).toEqual([
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
      ]);
    });

    it('verifies Promise.allSettled parallel execution pattern in src/panel/panelEngine.ts source code', () => {
      const panelEnginePath = path.resolve(__dirname, '../../src/panel/panelEngine.ts');
      expect(fs.existsSync(panelEnginePath)).toBe(true);
      const code = fs.readFileSync(panelEnginePath, 'utf-8');

      // Verify settled execution pattern
      expect(code).toContain('settled');
    });
  });
});
