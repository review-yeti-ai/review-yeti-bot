import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore, maskSecretKey } from '../../src/persistence/dashboardStore';
import { generateGitHubAppJwt } from '../../src/github/appAuth';
import { checkTicketLink, evaluateEnforcementPolicy } from '../../src/review/policyEngine';

describe('Empirical Stress & Verification Test Suite for Milestone 41 & Milestone 42', () => {
  let app: any;
  let authToken = '';
  let sampleRsaPrivateKeyPem: string;
  const origAdminPassword = process.env.ADMIN_PASSWORD;

  beforeAll(async () => {
    const tmpStorePath = path.join(path.resolve(__dirname, '../../node_modules/.tmp'), `dashboard-m41m42-${Date.now()}-${Math.random().toString(36).substring(2)}.json`);
    dashboardStore.filePath = tmpStorePath;

    // Generate a real 2048-bit RSA private key in PEM format for cryptographic testing
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem',
      },
    });
    sampleRsaPrivateKeyPem = privateKey;

    process.env.WEBHOOK_SECRET = 'test_webhook_secret_value_123';
    process.env.ADMIN_PASSWORD = 'admin_stress_test_pass';

    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin_stress_test_pass' });
    authToken = loginRes.body.token || '';
  });

  afterAll(() => {
    if (origAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD;
    } else {
      process.env.ADMIN_PASSWORD = origAdminPassword;
    }
  });

  // ==========================================
  // MILESTONE 41 EMPIRICAL STRESS TESTS
  // ==========================================
  describe('M41: GitHub App Onboarding & Monitored Repos', () => {
    describe('1. PEM Key Format Normalization', () => {
      it('should successfully normalize standard LF PEM and generate valid JWT', () => {
        const updated = dashboardStore.updateGitHubAppConfig({
          appId: '10001',
          privateKeyPem: sampleRsaPrivateKeyPem,
        });

        expect(updated.privateKeyConfigured).toBe(true);
        const jwt = generateGitHubAppJwt('10001', updated.privateKeyPemRaw!);
        expect(jwt).toBeDefined();
        expect(jwt.split('.')).toHaveLength(3);
      });

      it('should normalize escaped \\n string PEM and generate valid JWT', () => {
        const escapedPem = sampleRsaPrivateKeyPem.replace(/\n/g, '\\n');
        const updated = dashboardStore.updateGitHubAppConfig({
          appId: '10002',
          privateKeyPem: escapedPem,
        });

        expect(updated.privateKeyConfigured).toBe(true);
        expect(updated.privateKeyPemRaw).not.toContain('\\n');
        const jwt = generateGitHubAppJwt('10002', updated.privateKeyPemRaw!);
        expect(jwt.split('.')).toHaveLength(3);
      });

      it('should handle CRLF (\\r\\n) line endings in PEM strings', () => {
        const crlfPem = sampleRsaPrivateKeyPem.replace(/\n/g, '\r\n');
        const updated = dashboardStore.updateGitHubAppConfig({
          appId: '10003',
          privateKeyPem: crlfPem,
        });

        expect(updated.privateKeyConfigured).toBe(true);
        const jwt = generateGitHubAppJwt('10003', updated.privateKeyPemRaw!);
        expect(jwt.split('.')).toHaveLength(3);
      });

      it('should handle PEM strings with leading/trailing whitespace and surrounding empty lines', () => {
        const paddedPem = `  \n\n  ${sampleRsaPrivateKeyPem}  \n\n  `;
        const updated = dashboardStore.updateGitHubAppConfig({
          appId: '10004',
          privateKeyPem: paddedPem,
        });

        expect(updated.privateKeyConfigured).toBe(true);
        const jwt = generateGitHubAppJwt('10004', updated.privateKeyPemRaw!);
        expect(jwt.split('.')).toHaveLength(3);
      });

      it('should handle reading PEM key content from temp file', () => {
        const tmpFilePath = path.join(__dirname, 'temp_test_key.pem');
        fs.writeFileSync(tmpFilePath, sampleRsaPrivateKeyPem, 'utf8');

        try {
          const fileContent = fs.readFileSync(tmpFilePath, 'utf8');
          const updated = dashboardStore.updateGitHubAppConfig({
            appId: '10005',
            privateKeyPem: fileContent,
          });

          expect(updated.privateKeyConfigured).toBe(true);
          const jwt = generateGitHubAppJwt('10005', updated.privateKeyPemRaw!);
          expect(jwt.split('.')).toHaveLength(3);
        } finally {
          if (fs.existsSync(tmpFilePath)) {
            fs.unlinkSync(tmpFilePath);
          }
        }
      });

      it('should verify PEM via POST /api/github/app-config/verify', async () => {
        const res = await request(app)
          .post('/api/github/app-config/verify')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            appId: '10006',
            privateKeyPem: sampleRsaPrivateKeyPem,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.verified).toBe(true);
        expect(res.body.jwtGenerated).toBe(true);
      });

      it('should fail verification for invalid/corrupt PEM string', async () => {
        const res = await request(app)
          .post('/api/github/app-config/verify')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            appId: '10007',
            privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nINVALID_DATA_XYZ\n-----END RSA PRIVATE KEY-----',
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.verified).toBe(false);
      });
    });

    describe('2. Secret Masking (clientSecretMasked, webhookSecretConfigured)', () => {
      it('should correctly mask secrets longer than 8 characters', () => {
        const masked = maskSecretKey('ghp_1234567890abcdef');
        expect(masked).toBe('ghp_1234...cdef');
      });

      it('should mask short secrets (<= 8 chars) as ****', () => {
        expect(maskSecretKey('secret1')).toBe('****');
        expect(maskSecretKey('12345678')).toBe('****');
      });

      it('should return undefined for undefined/empty key', () => {
        expect(maskSecretKey(undefined)).toBeUndefined();
        expect(maskSecretKey('')).toBeUndefined();
      });

      it('should update and mask OAuth client secret & webhook secret status in app-config', async () => {
        const res = await request(app)
          .post('/api/github/app-config')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            appId: '20001',
            webhookSecret: 'my_super_secret_webhook_key_99',
            oauthClientId: 'client_id_abc',
            oauthClientSecret: 'secret_val_1234567890123456',
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.appConfig.webhookSecretConfigured).toBe(true);
        expect(res.body.appConfig.oauthClientSecretMasked).toBe('secret_v...3456');

        // Confirm GET endpoint also reflects masked values without leaking raw secret
        const getRes = await request(app)
          .get('/api/github/app-config')
          .set('Authorization', `Bearer ${authToken}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.appConfig.webhookSecretConfigured).toBe(true);
        expect(getRes.body.appConfig.oauthClientSecretMasked).toBe('secret_v...3456');
      });

      it('should reset secrets configuration cleanly via DELETE /api/github/app-config', async () => {
        const delRes = await request(app)
          .delete('/api/github/app-config')
          .set('Authorization', `Bearer ${authToken}`);
        expect(delRes.status).toBe(200);
        expect(delRes.body.appConfig.webhookSecretConfigured).toBe(false);
        expect(delRes.body.appConfig.privateKeyConfigured).toBe(false);
        expect(delRes.body.appConfig.oauthClientSecretMasked).toBe('');
      });
    });

    describe('3. Monitored Repo 1-Click Toggling API State Persistence (automationEnabled)', () => {
      it('should toggle automationEnabled via PATCH and persist state across queries', async () => {
        // Toggle automationEnabled to false for calltelemetry/cisco-cdr
        const patchRes1 = await request(app)
          .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ automationEnabled: false });

        expect(patchRes1.status).toBe(200);
        expect(patchRes1.body.success).toBe(true);
        expect(patchRes1.body.repository.automationEnabled).toBe(false);

        // Verify state persistence via GET monitored-repos
        const getReposRes1 = await request(app)
          .get('/api/github/app-config/monitored-repos')
          .set('Authorization', `Bearer ${authToken}`);
        expect(getReposRes1.status).toBe(200);
        const repo1 = getReposRes1.body.repositories.find(
          (r: any) => r.owner === 'calltelemetry' && r.repo === 'cisco-cdr'
        );
        expect(repo1).toBeDefined();
        expect(repo1.automationEnabled).toBe(false);

        // Toggle back to true via PATCH /api/github/app-config/monitored-repos (body parameters)
        const patchRes2 = await request(app)
          .patch('/api/github/app-config/monitored-repos')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ owner: 'calltelemetry', repo: 'cisco-cdr', automationEnabled: true });

        expect(patchRes2.status).toBe(200);
        expect(patchRes2.body.repository.automationEnabled).toBe(true);

        const getReposFresh = await request(app)
          .get('/api/github/app-config/monitored-repos')
          .set('Authorization', `Bearer ${authToken}`);
        const reposList = (getReposFresh.body && Array.isArray(getReposFresh.body.repositories)) ? getReposFresh.body.repositories : [];
        const activeCount = reposList.filter((r: any) => r.automationEnabled).length;
        const appCfgRes = await request(app)
          .get('/api/github/app-config')
          .set('Authorization', `Bearer ${authToken}`);
        expect(appCfgRes.body.appConfig.monitoredReposCount).toBe(activeCount);
      });
    });
  });

  // ==========================================
  // MILESTONE 42 EMPIRICAL STRESS TESTS
  // ==========================================
  describe('M42: Enforcement & Custom LLM Overrides', () => {
    describe('1. checkTicketLink Regex Validation', () => {
      it('should validate valid JIRA, Feature, and GitHub Issue ticket formats', () => {
        expect(checkTicketLink('fix(core): JIRA-1234 fix memory leak', '')).toBe(true);
        expect(checkTicketLink('feat(ui): FEAT-99 add dashboard toggle', '')).toBe(true);
        expect(checkTicketLink('fix: resolve bug', 'Closes #42')).toBe(true);
        expect(checkTicketLink({ title: 'refactor: ABC-123 update types', body: '' })).toBe(true);
        expect(checkTicketLink('PROJ-001 initial commit', '')).toBe(true);
        expect(checkTicketLink('docs: update build guide', 'See CORE-777 for context')).toBe(true);
      });

      it('should fail ticket link check for PRs missing valid ticket references', () => {
        expect(checkTicketLink('fix typo in README', '')).toBe(false);
        expect(checkTicketLink('update dependencies', 'No ticket reference')).toBe(false);
        expect(checkTicketLink('FEAT without numbers', '')).toBe(false);
        expect(checkTicketLink('1234 without prefix', '')).toBe(false);
        expect(checkTicketLink({ title: '', body: '' })).toBe(false);
        expect(checkTicketLink('#abc non-numeric issue', '')).toBe(false);
      });

      it('should support custom ticket regex pattern string or RegExp', () => {
        const customPatternStr = 'PROJ-\\d+';
        expect(checkTicketLink('PROJ-456', '', customPatternStr)).toBe(true);
        expect(checkTicketLink('JIRA-1234', '', customPatternStr)).toBe(false);

        const customRegExp = /TICKET-\d{4}/i;
        expect(checkTicketLink({ title: 'TICKET-9999 custom key', pattern: customRegExp })).toBe(true);
        expect(checkTicketLink({ title: 'TICKET-99 short key', pattern: customRegExp })).toBe(false);
      });
    });

    describe('2. failure_action Policy Behavior (fail_closed, fail_open, quarantine)', () => {
      it('should evaluate enforcement policy correctly for fail_closed when ticket is missing', () => {
        const evaluation = evaluateEnforcementPolicy({
          title: 'Unreferenced PR Title',
          body: 'No ticket link here',
          requireTicketLink: true,
          requireAllReviews: false,
          activePersonasApprovedCount: 0,
          totalActivePersonasCount: 0,
          failureAction: 'fail_closed',
        });

        expect(evaluation.passed).toBe(false);
        expect(evaluation.ticketLinkValid).toBe(false);
        expect(evaluation.failureAction).toBe('fail_closed');
        expect(evaluation.violations).toHaveLength(1);
      });

      it('should evaluate enforcement policy for quarantine and quorum unsatisfied', () => {
        const evaluation = evaluateEnforcementPolicy({
          title: 'PR with JIRA-555',
          body: 'Description',
          requireTicketLink: true,
          requireAllReviews: true,
          activePersonasApprovedCount: 1,
          totalActivePersonasCount: 3,
          failureAction: 'quarantine',
        });

        expect(evaluation.passed).toBe(false);
        expect(evaluation.ticketLinkValid).toBe(true);
        expect(evaluation.quorumSatisfied).toBe(false);
        expect(evaluation.failureAction).toBe('quarantine');
        expect(evaluation.violations).toHaveLength(1);
      });

      it('should evaluate enforcement policy as passed when all criteria are satisfied', () => {
        const evaluation = evaluateEnforcementPolicy({
          title: 'FEAT-100 Add awesome feature',
          body: '',
          requireTicketLink: true,
          requireAllReviews: true,
          activePersonasApprovedCount: 2,
          totalActivePersonasCount: 2,
          failureAction: 'fail_open',
        });

        expect(evaluation.passed).toBe(true);
        expect(evaluation.violations).toHaveLength(0);
        expect(evaluation.failureAction).toBe('fail_open');
      });

      it('should persist enforcement policy changes (failure_action) via API', async () => {
        const updateRes = await request(app)
          .put('/api/github/enforcement-policy')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            require_all_reviews: true,
            failure_action: 'quarantine',
            require_ticket_link: true,
          });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.success).toBe(true);
        expect(updateRes.body.policy.failure_action).toBe('quarantine');

        const getRes = await request(app)
          .get('/api/github/enforcement-policy')
          .set('Authorization', `Bearer ${authToken}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.policy.failure_action).toBe('quarantine');
        expect(getRes.body.policy.require_ticket_link).toBe(true);
      });
    });

    describe('3. Custom LLM API Base Overrides (OmniRoute, OpenAI, Anthropic, DeepSeek, Ollama/vLLM)', () => {
      it('should update and retrieve custom API bases for all 5 providers via PUT /api/dashboard/settings', async () => {
        const customBasesPayload = {
          customApiBases: {
            omniroute_base_url: 'http://omniroute.enterprise.local:8000',
            openai_base_url: 'http://openai-proxy.internal:8080/v1',
            anthropic_base_url: 'http://anthropic-proxy.internal:8080/v1',
            deepseek_base_url: 'http://deepseek-cluster.internal:9000/v1',
            ollama_base_url: 'http://ollama-vllm.local:11434',
          },
        };

        const updateRes = await request(app)
          .put('/api/dashboard/settings')
          .set('Authorization', `Bearer ${authToken}`)
          .send(customBasesPayload);

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.success).toBe(true);
        expect(updateRes.body.settings.customApiBases).toEqual(customBasesPayload.customApiBases);

        // Verify retrieval via GET /api/dashboard/settings
        const getRes = await request(app)
          .get('/api/dashboard/settings')
          .set('Authorization', `Bearer ${authToken}`);

        expect(getRes.status).toBe(200);
        expect(getRes.body.settings.customApiBases.omniroute_base_url).toBe('http://omniroute.enterprise.local:8000');
        expect(getRes.body.settings.customApiBases.openai_base_url).toBe('http://openai-proxy.internal:8080/v1');
        expect(getRes.body.settings.customApiBases.anthropic_base_url).toBe('http://anthropic-proxy.internal:8080/v1');
        expect(getRes.body.settings.customApiBases.deepseek_base_url).toBe('http://deepseek-cluster.internal:9000/v1');
        expect(getRes.body.settings.customApiBases.ollama_base_url).toBe('http://ollama-vllm.local:11434');
      });

      it('should preserve previously configured custom API base URLs during partial updates', async () => {
        // Set initial omniroute_base_url first to make test self-contained
        await request(app)
          .put('/api/dashboard/settings')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            customApiBases: {
              omniroute_base_url: 'http://omniroute.enterprise.local:8000',
            },
          });

        const partialPayload = {
          customApiBases: {
            deepseek_base_url: 'http://updated-deepseek.internal:9000/v1',
          },
        };

        const updateRes = await request(app)
          .put('/api/dashboard/settings')
          .set('Authorization', `Bearer ${authToken}`)
          .send(partialPayload);

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.settings.customApiBases.deepseek_base_url).toBe('http://updated-deepseek.internal:9000/v1');
        // Check that omniroute_base_url set previously remains preserved
        expect(updateRes.body.settings.customApiBases.omniroute_base_url).toBe('http://omniroute.enterprise.local:8000');
      });
    });
  });
});
