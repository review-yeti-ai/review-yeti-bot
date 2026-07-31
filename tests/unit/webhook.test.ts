import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import express from 'express';
import {
  verifyGitHubSignature,
  verifyGitHubSignatureDetailed,
  computeGitHubSignature,
} from '../../src/github/signature';
import { createWebhookServer, createWebhookRouter } from '../../src/github/webhookServer';
import { GitHubEventHandler } from '../../src/github/eventHandler';

describe('Milestone 4: Webhook Signature & Webhook Server Unit Tests', () => {
  const secret = 'test-secret-key-12345';

  function sign(body: string | object, sec: string = secret): string {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return 'sha256=' + crypto.createHmac('sha256', sec).update(raw).digest('hex');
  }

  describe('signature.ts — HMAC SHA-256 Signature Verification', () => {
    it('computes valid GitHub HMAC signature', () => {
      const payload = { action: 'opened' };
      const sig = computeGitHubSignature(payload, secret);
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('throws error when secret is empty or missing in computeGitHubSignature', () => {
      expect(() => computeGitHubSignature('payload', '')).toThrow(
        'Webhook secret is required to compute signature'
      );
    });

    it('verifies valid HMAC signature over string, Buffer, and object', () => {
      const payloadObj = { zen: 'Keep it simple' };
      const payloadStr = JSON.stringify(payloadObj);
      const payloadBuf = Buffer.from(payloadStr);
      const signature = sign(payloadStr);

      expect(verifyGitHubSignature(signature, payloadStr, secret)).toBe(true);
      expect(verifyGitHubSignature(signature, payloadBuf, secret)).toBe(true);
      expect(verifyGitHubSignature(signature, payloadObj, secret)).toBe(true);
    });

    it('returns missing_secret when secret is empty', () => {
      const res = verifyGitHubSignatureDetailed({
        signatureHeader: 'sha256=123',
        rawBody: 'test',
        secret: '',
      });
      expect(res.isValid).toBe(false);
      expect(res.reason).toBe('missing_secret');
    });

    it('returns missing_header when signature header is omitted or empty', () => {
      const res1 = verifyGitHubSignatureDetailed({ secret, rawBody: 'test' });
      expect(res1.isValid).toBe(false);
      expect(res1.reason).toBe('missing_header');

      const res2 = verifyGitHubSignatureDetailed({ signatureHeader: '', secret, rawBody: 'test' });
      expect(res2.isValid).toBe(false);
      expect(res2.reason).toBe('missing_header');
    });

    it('returns malformed_header when header does not start with sha256=', () => {
      const res = verifyGitHubSignatureDetailed({
        signatureHeader: 'md5=invalidprefix',
        rawBody: 'test',
        secret,
      });
      expect(res.isValid).toBe(false);
      expect(res.reason).toBe('malformed_header');
    });

    it('returns mismatch when signature hash or length does not match', () => {
      const res1 = verifyGitHubSignatureDetailed({
        signatureHeader: 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        rawBody: 'test',
        secret,
      });
      expect(res1.isValid).toBe(false);
      expect(res1.reason).toBe('mismatch');

      const res2 = verifyGitHubSignatureDetailed({
        signatureHeader: 'sha256=short',
        rawBody: 'test',
        secret,
      });
      expect(res2.isValid).toBe(false);
      expect(res2.reason).toBe('mismatch');
    });
  });

  describe('webhookServer.ts — Express GitHub Webhook Server & Router', () => {
    const app = createWebhookServer({ secret });

    it('returns HTTP 401 Unauthorized when signature is missing', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .send({ action: 'opened' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or missing signature' });
    });

    it('returns HTTP 401 Unauthorized when signature is invalid', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', 'sha256=invalid123')
        .send({ action: 'opened' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid or missing signature' });
    });

    it('returns HTTP 200 OK with status pong for ping event', async () => {
      const payload = { zen: 'Mind your design' };
      const sig = sign(payload);

      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'ping')
        .set('X-Hub-Signature-256', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'pong' });
    });

    it('mounts at both /webhook and /api/webhook/github', async () => {
      const payload = { action: 'opened' };
      const sig = sign(payload);

      const res1 = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'ping')
        .set('X-Hub-Signature-256', sig)
        .send(payload);
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .post('/api/webhook/github')
        .set('X-GitHub-Event', 'ping')
        .set('X-Hub-Signature-256', sig)
        .send(payload);
      expect(res2.status).toBe(200);
    });

    it('returns HTTP 400 Bad Request on malformed JSON body', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send('{ invalid json:');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Bad Request',
        message: 'Invalid JSON body or malformed payload',
      });
    });
  });

  describe('eventHandler.ts — Webhook Event Dispatcher & Listener', () => {
    let handler: GitHubEventHandler;

    beforeEach(() => {
      handler = new GitHubEventHandler({
        triggerLabels: ['ct-review', 'ai-review'],
      });
    });

    it('evaluates pull_request opened, synchronize, reopened as triggers', () => {
      const payloadOpened = {
        action: 'opened',
        number: 42,
        pull_request: {
          number: 42,
          head: { sha: 'head42' },
          base: { sha: 'base0' },
          title: 'feat: new feature',
        },
        repository: { name: 'ct-bot', owner: { login: 'calltelemetry' } },
        sender: { login: 'octocat' },
      };

      const evalResult = handler.evaluateTrigger('pull_request', payloadOpened, 'deliv-1');
      expect(evalResult.shouldTrigger).toBe(true);
      expect(evalResult.parsedPayload).toBeDefined();
      expect(evalResult.parsedPayload?.prNumber).toBe(42);
      expect(evalResult.parsedPayload?.headSha).toBe('head42');
      expect(evalResult.parsedPayload?.triggerSource).toBe('pr_event');
    });

    it('evaluates labeled event with matching target label as trigger', () => {
      const payloadLabeled = {
        action: 'labeled',
        number: 43,
        pull_request: {
          number: 43,
          labels: [{ name: 'ct-review' }],
        },
        repository: { name: 'ct-bot', owner: { login: 'calltelemetry' } },
        sender: { login: 'octocat' },
      };

      const evalResult = handler.evaluateTrigger('pull_request', payloadLabeled, 'deliv-2');
      expect(evalResult.shouldTrigger).toBe(true);
      expect(evalResult.parsedPayload?.triggerSource).toBe('label_trigger');
    });

    it('suppresses closed PR events', () => {
      const payloadClosed = {
        action: 'closed',
        pull_request: { state: 'closed' },
        sender: { login: 'octocat' },
      };

      const evalResult = handler.evaluateTrigger('pull_request', payloadClosed);
      expect(evalResult.shouldTrigger).toBe(false);
      expect(evalResult.reason).toContain('PR is closed');
    });

    it('suppresses bot self-loop events', () => {
      const payloadBot = {
        action: 'opened',
        pull_request: { number: 10 },
        sender: { login: 'ct-review-bot[bot]' },
      };

      const evalResult = handler.evaluateTrigger('pull_request', payloadBot);
      expect(evalResult.shouldTrigger).toBe(false);
      expect(evalResult.reason).toContain('Ignored bot action');
    });

    it('triggers on issue_comment or pull_request_review_comment with bot command', () => {
      const commentPayload = {
        action: 'created',
        issue: { number: 99, pull_request: {} },
        comment: { body: 'Please @ct-review review this change' },
        sender: { login: 'developer' },
        repository: { owner: { login: 'testorg' }, name: 'testrepo' },
      };

      const evalResult = handler.evaluateTrigger('issue_comment', commentPayload);
      expect(evalResult.shouldTrigger).toBe(true);
      expect(evalResult.parsedPayload?.triggerSource).toBe('comment_command');
      expect(evalResult.parsedPayload?.prNumber).toBe(99);
    });

  });
});
