import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createReviewExecutionCheckpointHandler } from '../../src/api/reviewExecutionCheckpointRoute';
import { parseReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';
import { HttpReviewExecutionCheckpointAdapter } from '../../src/review/reviewExecutionCheckpointHttp';
import { sha256 } from '../../src/review/reviewCore';

const token = 'ghs_checkpoint_fixture';
const checkpoint = {
  version: 'ReviewExecutionCheckpoint.v1' as const,
  runId: `run_${'1'.repeat(32)}`,
  repositoryId: 123,
  owner: 'calltelemetry',
  repo: 'ct-meta',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  executionAttempt: 2,
  revision: 3,
  plan: [{ id: 'security-auth', dimension: 'security' as const, paths: ['src/auth.ts'],
    question: 'Can authentication fail open?', rationale: 'Authentication path changed.' }],
  completedTasks: [{ id: 'security-auth', findings: [] }],
};
const readRequest = {
  version: 'ReviewExecutionCheckpointRead.v1' as const,
  runId: checkpoint.runId,
  executionAttempt: checkpoint.executionAttempt,
};

function checkpointApp(query: Parameters<typeof createReviewExecutionCheckpointHandler>[0]['query']) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.post('/checkpoint', createReviewExecutionCheckpointHandler({ query }));
  return app;
}

describe('ReviewExecutionCheckpoint.v1', () => {
  it('rejects duplicate or out-of-plan completed task identities', () => {
    expect(() => parseReviewExecutionCheckpoint({ ...checkpoint, completedTasks: [
      checkpoint.completedTasks[0], checkpoint.completedTasks[0],
    ] })).toThrow();
    expect(() => parseReviewExecutionCheckpoint({ ...checkpoint,
      completedTasks: [{ id: 'not-planned', findings: [] }] })).toThrow();
  });

  it('authenticates, binds, records, and reads the latest exact-head snapshot', async () => {
    let stored: unknown = null;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT runs.status, outbox.worker_token_digest')) {
        return { rows: [{ status: 'running', worker_token_digest: sha256(token) }] };
      }
      if (sql.includes('effective_policy_digest')) return { rows: [{
        repository_id: checkpoint.repositoryId, owner: checkpoint.owner, repo: checkpoint.repo,
        pr_number: checkpoint.prNumber, head_sha: checkpoint.headSha, base_sha: checkpoint.baseSha,
        effective_policy_digest: checkpoint.policyDigest, effective_config_digest: checkpoint.configDigest,
      }] };
      if (sql.includes('INSERT INTO review_execution_checkpoints')) {
        stored = JSON.parse(String(values?.[5]));
        return { rows: [{ revision: checkpoint.revision }] };
      }
      if (sql.includes('SELECT payload FROM review_execution_checkpoints')) return { rows: stored ? [{ payload: stored }] : [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const app = checkpointApp(query);

    const written = await request(app).post('/checkpoint').set('Authorization', `Bearer ${token}`).send(checkpoint);
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ version: 'ReviewExecutionCheckpointAccepted.v1', status: 'recorded' });

    const read = await request(app).post('/checkpoint').set('Authorization', `Bearer ${token}`).send({
      ...readRequest,
    });
    expect(read.status).toBe(200);
    expect(read.body.checkpoint).toEqual(checkpoint);
  });

  it.each([
    ['write', checkpoint],
    ['read', readRequest],
  ])('rejects a %s request without a worker installation bearer before storage access', async (_kind, body) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const response = await request(checkpointApp(query)).post('/checkpoint').send(body);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Worker installation bearer token is required' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['write with the wrong token', checkpoint, 'ghs_wrong_checkpoint_fixture', 'running'],
    ['read with the wrong token', readRequest, 'ghs_wrong_checkpoint_fixture', 'running'],
    ['write after the run completed', checkpoint, token, 'completed'],
    ['read after the run completed', readRequest, token, 'completed'],
  ])('rejects %s before checkpoint storage access', async (_name, body, bearer, status) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT runs.status, outbox.worker_token_digest')) {
        return { rows: [{ status, worker_token_digest: sha256(token) }] };
      }
      throw new Error(`unauthorized request reached checkpoint storage: ${sql}`);
    });
    const response = await request(checkpointApp(query)).post('/checkpoint')
      .set('Authorization', `Bearer ${bearer}`).send(body);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Worker is not authorized for this execution' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another run', { ...checkpoint, runId: `run_${'2'.repeat(32)}` }],
    ['another execution attempt', { ...checkpoint, executionAttempt: checkpoint.executionAttempt + 1 }],
  ])('rejects a checkpoint bound to %s', async (_name, body) => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT runs.status, outbox.worker_token_digest')) {
        const exactExecution = values?.[0] === checkpoint.runId && values?.[1] === checkpoint.executionAttempt;
        return { rows: exactExecution
          ? [{ status: 'running', worker_token_digest: sha256(token) }]
          : [] };
      }
      throw new Error(`unauthorized request reached checkpoint storage: ${sql}`);
    });
    const response = await request(checkpointApp(query)).post('/checkpoint')
      .set('Authorization', `Bearer ${token}`).send(body);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Worker is not authorized for this execution' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a checkpoint whose exact-head identity differs from the admitted run', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT runs.status, outbox.worker_token_digest')) {
        return { rows: [{ status: 'running', worker_token_digest: sha256(token) }] };
      }
      if (sql.includes('effective_policy_digest')) return { rows: [{
        repository_id: checkpoint.repositoryId, owner: checkpoint.owner, repo: checkpoint.repo,
        pr_number: checkpoint.prNumber, head_sha: checkpoint.headSha, base_sha: checkpoint.baseSha,
        effective_policy_digest: checkpoint.policyDigest, effective_config_digest: checkpoint.configDigest,
      }] };
      throw new Error(`mismatched checkpoint reached storage: ${sql}`);
    });
    const response = await request(checkpointApp(query)).post('/checkpoint')
      .set('Authorization', `Bearer ${token}`).send({ ...checkpoint, headSha: 'e'.repeat(40) });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Review checkpoint does not match the admitted review' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns the authoritative revision for a stale write', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT runs.status, outbox.worker_token_digest')) {
        return { rows: [{ status: 'running', worker_token_digest: sha256(token) }] };
      }
      if (sql.includes('effective_policy_digest')) return { rows: [{
        repository_id: checkpoint.repositoryId, owner: checkpoint.owner, repo: checkpoint.repo,
        pr_number: checkpoint.prNumber, head_sha: checkpoint.headSha, base_sha: checkpoint.baseSha,
        effective_policy_digest: checkpoint.policyDigest, effective_config_digest: checkpoint.configDigest,
      }] };
      if (sql.includes('INSERT INTO review_execution_checkpoints')) return { rows: [] };
      if (sql.includes('SELECT revision FROM review_execution_checkpoints')) return { rows: [{ revision: 7 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const app = checkpointApp(query);

    const written = await request(app).post('/checkpoint').set('Authorization', `Bearer ${token}`).send(checkpoint);
    expect(written.status).toBe(200);
    expect(written.body).toEqual({ version: 'ReviewExecutionCheckpointAccepted.v1',
      runId: checkpoint.runId, status: 'stale', revision: 7 });
  });

  it('rebases a write after a failed read left the worker behind the durable revision', async () => {
    const revisions: number[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      revisions.push(body.revision);
      if (revisions.length === 1) return new Response(JSON.stringify({
        version: 'ReviewExecutionCheckpointAccepted.v1', runId: checkpoint.runId, status: 'stale', revision: 7,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        version: 'ReviewExecutionCheckpointAccepted.v1', runId: checkpoint.runId,
        status: 'recorded', revision: body.revision,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const adapter = new HttpReviewExecutionCheckpointAdapter({ token,
      completionEndpoint: 'https://review.example.test/api/dispatch/completion', runId: checkpoint.runId,
      executionAttempt: checkpoint.executionAttempt, fetchImplementation });

    await expect(adapter.write({ ...checkpoint, revision: 1 })).resolves.toBe(8);
    await expect(adapter.write({ ...checkpoint, revision: 2 })).resolves.toBe(9);
    expect(revisions).toEqual([1, 8, 9]);
  });
});
