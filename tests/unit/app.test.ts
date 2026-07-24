import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../src/app';

describe('Express App & Health Endpoint', () => {
  const app = createApp();

  it('GET /health returns status 200 with service metadata', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('service', 'ct-review-bot');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptimeSeconds');
  });

  it('preserves raw request body buffer on JSON post', async () => {
    let capturedRawBody: Buffer | undefined;

    // Temporary test route to verify rawBody preservation
    app.post('/test-raw-body', (req: any, res) => {
      capturedRawBody = req.rawBody;
      res.status(200).json({ received: req.body });
    });

    const payload = { action: 'opened', number: 42 };
    const res = await request(app)
      .post('/test-raw-body')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(capturedRawBody).toBeDefined();
    expect(Buffer.isBuffer(capturedRawBody)).toBe(true);
    expect(JSON.parse(capturedRawBody!.toString())).toEqual(payload);
  });

  describe('Webhook Endpoint & HMAC Verification', () => {
    const secret = 'development-webhook-secret-key-12345';

    function signPayload(bodyObj: object): { bodyStr: string; sig: string } {
      const bodyStr = JSON.stringify(bodyObj);
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
      return { bodyStr, sig };
    }

    it('rejects POST /webhook with missing or invalid signature header', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('x-github-event', 'ping')
        .send({ zen: 'test' });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error', 'Invalid or missing signature');
    });

    it('accepts POST /webhook with valid HMAC signature for ping event', async () => {
      const payload = { zen: 'Responsive is better than fast.' };
      const { bodyStr, sig } = signPayload(payload);

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'ping')
        .send(bodyStr);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pong' });
    });

    it('processes pull_request event payload with ticket validation and diff state tracking', async () => {
      const prPayload = {
        action: 'opened',
        number: 101,
        pull_request: {
          number: 101,
          title: 'feat: implement authentication [PROJ-101]',
          body: 'Detailed testing steps included in PR.',
          head: { sha: 'sha111' },
          base: { sha: 'sha000' },
        },
        repository: {
          name: 'ai-workspace',
          owner: { login: 'calltelemetry' },
        },
      };

      const { bodyStr, sig } = signPayload(prPayload);

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'pull_request')
        .send(bodyStr);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'processed');
      expect(res.body).toHaveProperty('event', 'pull_request');
      expect(res.body).toHaveProperty('prNumber', 101);
      expect(res.body).toHaveProperty('ticketValid', true);
    });

    it('handles issue_comment event payload with bot review command', async () => {
      const commentPayload = {
        action: 'created',
        issue: { number: 101 },
        comment: { body: '@ct-review review please' },
        repository: { name: 'ai-workspace', owner: { login: 'calltelemetry' } },
      };

      const { bodyStr, sig } = signPayload(commentPayload);

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'issue_comment')
        .send(bodyStr);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'triggered');
      expect(res.body).toHaveProperty('event', 'issue_comment');
      expect(res.body).toHaveProperty('prNumber', 101);
    });

    it('returns HTTP 500 JSON error payload when an exception occurs in handler', async () => {
      const ticketValidatorModule = await import('../../src/ticket/ticketValidator');
      const spy = vi.spyOn(ticketValidatorModule, 'validateTicketLinkage').mockImplementation(() => {
        throw new Error('Simulated webhook processing error');
      });

      const prPayload = {
        action: 'opened',
        number: 101,
        pull_request: {
          number: 101,
          title: 'feat: test exception',
          body: 'body',
        },
      };

      const { bodyStr, sig } = signPayload(prPayload);

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', sig)
        .set('x-github-event', 'pull_request')
        .send(bodyStr);

      spy.mockRestore();

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error', 'Internal Server Error');
      expect(res.body).toHaveProperty('message', 'Simulated webhook processing error');
    });

    it('dynamically registers a new provider/model without redeployment', async () => {
      const res = await request(app)
        .post('/api/router/providers')
        .send({
          id: 'custom-openrouter-model',
          name: 'OpenRouter Dynamic Model',
          priority: 2,
          apiKey: 'test-dynamic-key',
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        status: 'registered',
        id: 'custom-openrouter-model',
        name: 'OpenRouter Dynamic Model',
        priority: 2,
      });

      const statusRes = await request(app).get('/api/router/status');
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.providers).toHaveProperty('custom-openrouter-model');
    });
  });
});

