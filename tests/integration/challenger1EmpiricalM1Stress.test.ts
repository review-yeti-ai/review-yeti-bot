import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createApp } from '../../src/app';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';

describe('Milestone 1 Stress & Edge Case Challenge Suite', () => {
  const tempTestDir = path.join(process.cwd(), 'data', 'test-challenger-m1');
  const app = createApp();
  const authHeader = ['Authorization', 'Bearer demo_token_public'] as const;

  beforeEach(() => {
    if (!fs.existsSync(tempTestDir)) {
      fs.mkdirSync(tempTestDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tempTestDir)) {
      try {
        fs.rmSync(tempTestDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('1. DashboardStore Persistence, Atomic Writes & Concurrency', () => {
    it('verifies atomic writes clean up temp files and persist valid JSON', () => {
      const storeFile = path.join(tempTestDir, 'atomic-store.json');
      const store = new DashboardStore(storeFile);

      // Perform rapid updates
      for (let i = 0; i < 20; i++) {
        store.updateRepository('calltelemetry', 'cisco-cdr', {
          automationEnabled: i % 2 === 0,
          strictnessProfile: i % 2 === 0 ? 'chill' : 'assertive',
        });
      }

      // Check main file exists and is valid JSON
      expect(fs.existsSync(storeFile)).toBe(true);
      const content = fs.readFileSync(storeFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed).toHaveProperty('repositories');

      // Check no leftover .tmp files exist in directory
      const files = fs.readdirSync(tempTestDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles.length).toBe(0);
    });

    it('handles 50 concurrent in-memory updates safely without JSON corruption', async () => {
      const storeFile = path.join(tempTestDir, 'concurrent-store.json');
      const store = new DashboardStore(storeFile);

      const updatePromises = Array.from({ length: 50 }, (_, i) => {
        return Promise.resolve().then(() => {
          return store.updateRepository('calltelemetry', `repo-${i}`, {
            automationEnabled: true,
            strictnessProfile: 'balanced',
          });
        });
      });

      await Promise.all(updatePromises);

      // Verify file integrity
      const content = fs.readFileSync(storeFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.repositories.length).toBeGreaterThanOrEqual(50);
    });

    it('demonstrates lost update race condition when two store instances write concurrently', async () => {
      const storeFile = path.join(tempTestDir, 'shared-store.json');
      const storeA = new DashboardStore(storeFile);
      const storeB = new DashboardStore(storeFile);

      // Store A updates repo A
      storeA.updateRepository('calltelemetry', 'repo-instance-a', { automationEnabled: false });

      // Store B (which hasn't reloaded storeA's write) updates repo B
      storeB.updateRepository('calltelemetry', 'repo-instance-b', { automationEnabled: false });

      // Reload store from disk to see what was written last
      const reloadedStore = new DashboardStore(storeFile);
      const repoA = reloadedStore.getRepository('calltelemetry', 'repo-instance-a');
      const repoB = reloadedStore.getRepository('calltelemetry', 'repo-instance-b');

      // Document whether storeB overwrote storeA's state (Lost Update)
      // Since Store B's in-memory data did not include repo-instance-a when it saved, repo-instance-a will be missing from the file!
      const storeALostUpdateDetected = repoA === undefined;
      expect(repoB).toBeDefined(); // repoB was saved by storeB
      // Document finding: Store B overwrites Store A because in-memory state is not synchronized across instances watching the same file.
      expect(storeALostUpdateDetected).toBe(true);
    });

    it('falls back gracefully to /tmp when target file path directory is invalid', () => {
      const invalidPath = '/non_existent_root_dir_12345/sub/dashboard.json';
      const store = new DashboardStore(invalidPath);
      
      // Updating repo should trigger fallback without throwing uncaught filesystem error
      expect(() => {
        store.updateRepository('calltelemetry', 'cisco-cdr', { automationEnabled: false });
      }).not.toThrow();

      expect(store.getFilePath()).toContain('/tmp');
    });
  });

  describe('2. PATCH /api/github/app-config/monitored-repos Edge Cases', () => {
    it('returns 400 when owner and repo are missing', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set(...authHeader)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('owner and repo parameters are required');
    });

    it('returns 400 when only owner is provided without repo', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set(...authHeader)
        .send({ owner: 'calltelemetry' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('owner and repo parameters are required');
    });

    it('returns 400 when full_name is malformed without a slash', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set(...authHeader)
        .send({ full_name: 'noslashname' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('dynamically auto-onboards non-existent repository IDs on PATCH', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set(...authHeader)
        .send({
          owner: 'new-org',
          repo: 'brand-new-repo',
          automationEnabled: true,
          strictnessProfile: 'assertive',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.repository.owner).toBe('new-org');
      expect(res.body.repository.repo).toBe('brand-new-repo');
      expect(res.body.repository.strictnessProfile).toBe('assertive');
    });

    it('resolves repository from id parameter', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set(...authHeader)
        .send({
          id: 'repo-cisco-cdr',
          automationEnabled: true,
          strictnessProfile: 'chill',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.repository.full_name).toBe('calltelemetry/cisco-cdr');
      expect(res.body.repository.strictnessProfile).toBe('chill');
    });

    it('handles modelOverrides validation and throws 500/400 if invalid model entry', async () => {
      const res = await request(app)
        .patch('/api/github/app-config/monitored-repos')
        .set(...authHeader)
        .send({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          modelOverrides: { security: '' }, // Empty string model override
        });

      // Express handler catches error or returns 500 / error response
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('3. POST /api/dashboard/providers/:id/test Edge Cases', () => {
    it('returns 400 status when baseUrl is missing or empty', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/openai/test')
        .set(...authHeader)
        .send({ baseUrl: '' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.status).toBe('disconnected');
      expect(res.body.error).toContain('Invalid or missing base URL');
    });

    it('returns 400 status when baseUrl has an invalid non-http/https protocol', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/openai/test')
        .set(...authHeader)
        .send({ baseUrl: 'ftp://api.openai.com/v1' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('URL must start with http:// or https://');
    });

    it('dynamically registers non-existent provider ID when tested with a valid URL', async () => {
      const res = await request(app)
        .post('/api/dashboard/providers/non-existent-provider-999/test')
        .set(...authHeader)
        .send({ baseUrl: 'https://api.omniroute.internal/v1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('connected');

      // Check if store recorded this provider
      const provider = dashboardStore.getProviderConfig('non-existent-provider-999');
      expect(provider).toBeDefined();
      expect(provider?.id).toBe('non-existent-provider-999');
    });

    it('documents behavior: provider health check GET request does not attach API Key headers', async () => {
      let receivedHeaders: http.IncomingHttpHeaders | null = null;

      const server = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const localUrl = `http://127.0.0.1:${port}/v1`;

      try {
        const res = await request(app)
          .post('/api/dashboard/providers/anthropic/test')
          .set(...authHeader)
          .send({ baseUrl: localUrl });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(receivedHeaders).toBeDefined();
        // Empirical observation: Authorization header is NOT passed to provider endpoint!
        expect(receivedHeaders!['authorization']).toBeUndefined();
        expect(receivedHeaders!['x-api-key']).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => server.close(resolve));
      }
    });

    it('handles connection timeout correctly when provider endpoint hangs beyond 5000ms', async () => {
      // Create a server that delays response past 5000ms
      const server = http.createServer((_req, _res) => {
        // Do not respond, let timeout trigger
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const slowUrl = `http://127.0.0.1:${port}/v1`;

      try {
        const startMs = Date.now();
        const res = await request(app)
          .post('/api/dashboard/providers/openai/test')
          .set(...authHeader)
          .send({ baseUrl: slowUrl });

        const duration = Date.now() - startMs;
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.status).toBe('disconnected');
        expect(res.body.message).toMatch(/Connection timed out|ECONNRESET|ETIMEDOUT|timeout/i);
        expect(duration).toBeGreaterThanOrEqual(1000);
      } finally {
        await new Promise<void>((resolve) => server.close(resolve));
      }
    }, 12000);
  });
});
