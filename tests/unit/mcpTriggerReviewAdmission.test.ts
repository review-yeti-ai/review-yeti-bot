import { describe, expect, it, vi } from 'vitest';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const POLICY_DIGEST = 'c'.repeat(64);

describe('trigger_review governed admission', () => {
  const request = {
    owner: 'calltelemetry', repo: 'cisco-cdr', pull_number: 5135,
    head_sha: HEAD_SHA,
  };

  it('fails closed when durable admission has no exact GitHub resolver', async () => {
    const admit = vi.fn();
    const tool = createTriggerReviewTool({
      admissionRepository: { admit } as any,
    });

    await expect(tool.execute(request)).rejects.toThrow(
      /requires exact GitHub pull request resolution/,
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it('fails closed when durable admission has no authoritative publisher', async () => {
    const admit = vi.fn();
    const tool = createTriggerReviewTool({
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 190468701, installationId: 2222,
      }),
    });

    await expect(tool.execute(request)).rejects.toThrow(
      /requires authoritative publishing admission/,
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'repository is not enrolled', repositoryIds: [] as number[], acceptNewRequests: true },
    { label: 'authoritative admission is paused', repositoryIds: [190468701], acceptNewRequests: false },
  ])('rejects before policy resolution when $label', async ({ repositoryIds, acceptNewRequests }) => {
    const admit = vi.fn();
    const resolve = vi.fn();
    const tool = createTriggerReviewTool({
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 190468701, installationId: 2222,
      }),
      authoritativePublishing: {
        expectedAppId: 4385771,
        repositoryIds,
        acceptNewRequests,
        resolver: { resolve },
      },
    } as any);

    await expect(tool.execute(request)).rejects.toThrow(/outside authoritative admission/);
    expect(resolve).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('admits the exact GitHub head as a non-central authoritative request', async () => {
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 5135,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = {
      policy: {
        effectivePolicyDigest: POLICY_DIGEST,
        effectiveConfigDigest: 'd'.repeat(64),
      },
    };
    const admit = vi.fn(async (input: any) => {
      expect(input).toMatchObject({
        eventName: 'mcp.trigger_review',
        repositoryId: 190468701,
        installationId: 2222,
        publicationMode: 'app-gate',
        centralActionDispatch: false,
        debounce: false,
        effectivePolicyDigest: POLICY_DIGEST,
        identity,
        authoritativeGate: { expectedAppId: 4385771, prepared },
      });
      return { run: { runId: `run_${'e'.repeat(32)}` } };
    });
    const resolve = vi.fn(async () => ({ identity, prepared }));

    const tool = createTriggerReviewTool({
      queryableDatabase: { query: vi.fn(async () => ({ rows: [] })) },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: vi.fn(async () => ({
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        repositoryId: 190468701,
        installationId: 2222,
      })),
      authoritativePublishing: {
        expectedAppId: 4385771,
        repositoryIds: [190468701],
        resolver: { resolve },
      },
      now: () => 1_790_060_000_000,
    } as any);

    const result = await tool.execute({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 5135,
      head_sha: HEAD_SHA,
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 190468701,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 5135,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    });
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({
      dispatched: true,
      job_crd_created: false,
    });
  });

  it('does not pre-cancel an active same-identity review when force is requested', async () => {
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 5135,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
      snapshotDigest: 'e'.repeat(64), configDigest: 'f'.repeat(64),
    };
    const prepared = { policy: {
      effectivePolicyDigest: POLICY_DIGEST,
      effectiveConfigDigest: 'd'.repeat(64),
    } };
    const runId = deriveReviewRunId(identity as any);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT run_id')) {
        return { rows: [{ run_id: runId, status: 'running', head_sha: HEAD_SHA }] };
      }
      throw new Error('trigger_review must not mutate an active run before admission');
    });
    const admit = vi.fn();
    const tool = createTriggerReviewTool({
      queryableDatabase: { query },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 190468701, installationId: 2222,
      }),
      authoritativePublishing: {
        expectedAppId: 4385771,
        repositoryIds: [190468701],
        resolver: { resolve: async () => ({ identity, prepared }) },
      },
    } as any);

    await expect(tool.execute({
      owner: 'calltelemetry', repo: 'cisco-cdr', pull_number: 5135,
      head_sha: HEAD_SHA, force: true,
    })).rejects.toThrow(/Conflict.*currently running for this review identity/);
    expect(admit).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it('leaves the active run untouched when replacement admission rejects', async () => {
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 5135,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = { policy: {
      effectivePolicyDigest: POLICY_DIGEST,
      effectiveConfigDigest: 'd'.repeat(64),
    } };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT run_id')) {
        return { rows: [{ run_id: `run_${'9'.repeat(32)}`, status: 'running' }] };
      }
      throw new Error('trigger_review must not mutate the prior run');
    });
    const admit = vi.fn(async () => {
      throw new Error('authoritative admission no longer matches current policy');
    });
    const tool = createTriggerReviewTool({
      queryableDatabase: { query },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 190468701, installationId: 2222,
      }),
      authoritativePublishing: {
        expectedAppId: 4385771,
        repositoryIds: [190468701],
        resolver: { resolve: async () => ({ identity, prepared }) },
      },
    } as any);

    await expect(tool.execute({
      owner: 'calltelemetry', repo: 'cisco-cdr', pull_number: 5135,
      head_sha: HEAD_SHA, force: true,
    })).rejects.toThrow(/authoritative admission no longer matches current policy/);
    expect(query).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
  });
});
