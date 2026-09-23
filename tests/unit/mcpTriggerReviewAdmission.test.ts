import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';
import { AuthoritativePublishingResolver } from '../../src/review/authoritativePublishingResolver';

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

  it('admits review request with explicit review_engine: composed', async () => {
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 5135,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = {
      policy: {
        effectivePolicyDigest: POLICY_DIGEST,
        effectiveConfigDigest: 'd'.repeat(64),
      },
      config: { review_engine: 'composed' },
    };
    const admit = vi.fn(async (input: any) => {
      expect(input).toMatchObject({
        eventName: 'mcp.trigger_review',
        identity,
        reviewEngine: 'composed',
      });
      expect(input.authoritativeGate?.prepared.config.review_engine).toBe('composed');
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
      review_engine: 'composed',
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 190468701,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 5135,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data).toMatchObject({
      dispatched: true,
      job_crd_created: false,
    });
    expect(data.message).toContain('engine: composed');
  });

  it('admits review request with explicit review_engine: panel', async () => {
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 5135,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = {
      policy: {
        effectivePolicyDigest: POLICY_DIGEST,
        effectiveConfigDigest: 'd'.repeat(64),
      },
      config: { review_engine: 'panel' },
    };
    const admit = vi.fn(async (input: any) => {
      expect(input).toMatchObject({
        eventName: 'mcp.trigger_review',
        identity,
        reviewEngine: 'panel',
      });
      expect(input.authoritativeGate?.prepared.config.review_engine).toBe('panel');
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
      review_engine: 'panel',
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 190468701,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 5135,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data).toMatchObject({
      dispatched: true,
      job_crd_created: false,
    });
    expect(data.message).toContain('engine: panel');
  });

  it('preserves backward compatibility when review_engine is omitted', async () => {
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 5135,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = {
      policy: {
        effectivePolicyDigest: POLICY_DIGEST,
        effectiveConfigDigest: 'd'.repeat(64),
      },
      config: {},
    };
    const admit = vi.fn(async (input: any) => {
      expect(input).toMatchObject({
        eventName: 'mcp.trigger_review',
        identity,
      });
      expect(input.reviewEngine).toBeUndefined();
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
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 190468701,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 5135,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data).toMatchObject({
      dispatched: true,
      job_crd_created: false,
    });
    expect(data.message).not.toContain('engine:');
  });

  it('admits review request when wired with real AuthoritativePublishingResolver and review_engine', async () => {
    const policyContent = JSON.stringify({
      schema: 'calltelemetry.review-policy.v1',
      review_yeti: {
        personas: 'security,architecture',
        budget: { max_investigation_turns: 5 },
      },
    });
    const policyFile = {
      source: {
        repositoryId: 190468701,
        repository: 'calltelemetry/cisco-cdr',
        sha: HEAD_SHA,
        path: '.calltelemetry/review-policy.json',
        contentDigest: createHash('sha256').update(policyContent).digest('hex'),
      },
      content: policyContent,
    };

    const resolver = new AuthoritativePublishingResolver({
      policyRepository: { repositoryId: 190468701, owner: 'calltelemetry', repo: 'cisco-cdr' },
      policyRef: 'refs/heads/main',
      policyPath: '.calltelemetry/review-policy.json',
      transport: { baseUrl: 'https://bifrost.internal.calltelemetry.com', model: 'deepseek/deepseek-v4-flash-0731' },
      candidateReaderFactory: async () => ({
        currentCandidate: async () => ({
          open: true,
          draft: false,
          repositoryId: 190468701,
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          prNumber: 5135,
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
        }),
      }),
      policyReaderFactory: async () => ({
        resolvePolicyRevision: async () => HEAD_SHA,
        immutablePolicyFile: async () => policyFile,
      }),
    });

    const admit = vi.fn(async () => ({ run: { runId: `run_${'e'.repeat(32)}` } }));

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
        resolver,
      } as any,
      now: () => 1_790_060_000_000,
    });

    const result = await tool.execute({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 5135,
      head_sha: HEAD_SHA,
      review_engine: 'composed',
    });

    expect(admit).toHaveBeenCalledOnce();
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.dispatched).toBe(true);
    expect(data.message).toContain('engine: composed');
  });

  it('rejects review request with invalid review_engine', async () => {
    const tool = createTriggerReviewTool({
      admissionRepository: { admit: vi.fn() } as any,
      resolveGitHubPullRequest: vi.fn() as any,
    });

    await expect(tool.execute({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 5135,
      head_sha: HEAD_SHA,
      review_engine: 'invalid_engine' as any,
    })).rejects.toThrow(/Invalid arguments/);
  });
});
