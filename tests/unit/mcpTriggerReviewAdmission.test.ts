import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import { AUTHORITATIVE_REVIEW_APP_ID } from '../../src/auth/authoritativeServiceIdentity';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';
import { AuthoritativePublishingResolver } from '../../src/review/authoritativePublishingResolver';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const POLICY_DIGEST = 'c'.repeat(64);

describe('trigger_review governed admission', () => {
  const request = {
    owner: 'exampleorg', repo: 'example-api', pull_number: 73,
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
        repositoryId: 101, installationId: 22,
      }),
    });

    await expect(tool.execute(request)).rejects.toThrow(
      /requires authoritative publishing admission/,
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'repository is not enrolled', repositoryIds: [] as number[], acceptNewRequests: true },
    { label: 'authoritative admission is paused', repositoryIds: [101], acceptNewRequests: false },
  ])('rejects before policy resolution when $label', async ({ repositoryIds, acceptNewRequests }) => {
    const admit = vi.fn();
    const resolve = vi.fn();
    const tool = createTriggerReviewTool({
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 101, installationId: 22,
      }),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
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
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
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
        repositoryId: 101,
        installationId: 22,
        publicationMode: 'app-gate',
        centralActionDispatch: false,
        debounce: false,
        dispatchPriority: 'expedited',
        effectivePolicyDigest: POLICY_DIGEST,
        identity,
        authoritativeGate: { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, prepared },
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
        repositoryId: 101,
        installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve },
      },
      now: () => 1_790_060_000_000,
    } as any);

    const result = await tool.execute({
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
      head_sha: HEAD_SHA,
      priority: 'expedited',
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 101,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 73,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    });
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({
      dispatched: true,
      job_crd_created: false,
    });
  });

  it('publishes an exact-candidate MCP SHIP without admitting a review or mutating generation state', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = { policy: { effectivePolicyDigest: POLICY_DIGEST } };
    const query = vi.fn(async () => ({ rows: [] }));
    const admit = vi.fn(async () => { throw new Error('passthrough must not admit'); });
    const resolvePullRequest = vi.fn(async () => ({
      headSha: HEAD_SHA, baseSha: BASE_SHA, repositoryId: 101, installationId: 22,
    }));
    const resolvePolicy = vi.fn(async () => ({ identity, prepared }));
    const recordOperatorPassthrough = vi.fn(async (_input: any) => ({
      status: 'accepted' as const, verdict: 'SHIP' as const, expectedLanes: 0 as const, completedLanes: 0 as const,
      publicationId: 'f'.repeat(64), auditDigest: 'e'.repeat(64), publicationState: 'published' as const,
      reviewCheckId: 5001, gateCheckId: 5002, mergeEligible: true,
    }));
    const tool = createTriggerReviewTool({
      passthroughEnabled: true,
      queryableDatabase: { query },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: resolvePullRequest,
      authoritativePublishing: {
        expectedAppId: 42,
        repositoryIds: [101],
        acceptNewRequests: false,
        resolver: { resolve: resolvePolicy },
        recordOperatorPassthrough,
      },
    } as any);

    const result = await tool.execute(request);
    const output = JSON.parse((result.content[0] as any).text);
    expect(output).toMatchObject({
      dispatched: false,
      job_crd_created: false,
      status: 'passthrough',
      reason: 'operator_global_passthrough',
      review_started: false,
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
      head_sha: HEAD_SHA,
      verdict: 'SHIP',
      expected_lanes: 0,
      completed_lanes: 0,
      publication_id: 'f'.repeat(64),
      audit_digest: 'e'.repeat(64),
      publication_state: 'published',
      review_check_id: 5001,
      gate_check_id: 5002,
      merge_eligible: true,
      message: expect.stringContaining('0 review lanes ran'),
    });
    expect(output).not.toHaveProperty('attempt_id');
    expect(resolvePullRequest).toHaveBeenCalledOnce();
    expect(resolvePolicy).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(recordOperatorPassthrough).toHaveBeenCalledOnce();
    expect(recordOperatorPassthrough.mock.calls[0]?.[0]).toMatchObject({
      requested: { repositoryId: 101, owner: 'exampleorg', repo: 'example-api', prNumber: 73,
        headSha: HEAD_SHA, baseSha: BASE_SHA },
      event: { transport: 'mcp', eventName: 'trigger_review',
        deliveryId: expect.stringMatching(/^mcp:/u), deliveryDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    });
  });

  it('does not let MCP passthrough bypass incomplete-P2 recovery authorization', async () => {
    const admit = vi.fn();
    const tool = createTriggerReviewTool({
      passthroughEnabled: true,
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: vi.fn(),
      authoritativePublishing: { expectedAppId: 42, repositoryIds: [101], acceptNewRequests: true,
        resolver: { resolve: vi.fn() } },
    } as any);

    await expect(tool.execute({ ...request, incomplete_p2_recovery: true })).rejects.toThrow(
      /requires verified static-token admin authentication and exact repository authorization/,
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it('allows an authorized incomplete-P2 recovery request to receive paused SHIP without ordinary recovery admission', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const caller = { authType: 'static_token' as const, isAdmin: true as const,
      tokenDigest: 'a'.repeat(12), callerId: `admin:${'a'.repeat(12)}`, allowedRepositories: null };
    const query = vi.fn(async () => ({ rows: [] }));
    const admit = vi.fn(async () => { throw new Error('paused recovery must not create a normal attempt'); });
    const resolve = vi.fn(async () => ({ identity, prepared: { policy: { effectivePolicyDigest: POLICY_DIGEST } } }));
    const recordOperatorPassthrough = vi.fn(async () => ({
      status: 'accepted' as const, verdict: 'SHIP' as const, expectedLanes: 0 as const, completedLanes: 0 as const,
      publicationId: 'f'.repeat(64), auditDigest: 'e'.repeat(64), publicationState: 'pending' as const,
      reviewCheckId: null, gateCheckId: null, mergeEligible: false,
    }));
    const tool = createTriggerReviewTool({
      passthroughEnabled: true,
      queryableDatabase: { query },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: vi.fn(async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA, repositoryId: 101, installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: 42,
        repositoryIds: [101],
        acceptNewRequests: false,
        resolver: { resolve },
        recordOperatorPassthrough,
      },
    } as any);

    const result = await tool.execute({ ...request, incomplete_p2_recovery: true }, {
      caller,
      authenticatedByConfiguredAuthenticator: true,
      authorizedRepository: { owner: 'exampleorg', repo: 'example-api' },
    });
    const output = JSON.parse((result.content[0] as any).text);

    expect(output).toMatchObject({
      status: 'passthrough', reason: 'operator_global_passthrough', verdict: 'SHIP',
      expected_lanes: 0, completed_lanes: 0, publication_state: 'pending', merge_eligible: false,
      review_check_id: null, gate_check_id: null, review_started: false,
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(recordOperatorPassthrough).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('does not pre-cancel an active same-identity review when force is requested', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
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
        repositoryId: 101, installationId: 22,
      }),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve: async () => ({ identity, prepared }) },
      },
    } as any);

    await expect(tool.execute({
      owner: 'exampleorg', repo: 'example-api', pull_number: 73,
      head_sha: HEAD_SHA, force: true,
    })).rejects.toThrow(/Conflict.*currently running for this review identity/);
    expect(admit).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });

  it('leaves the active run untouched when replacement admission rejects', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
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
        repositoryId: 101, installationId: 22,
      }),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve: async () => ({ identity, prepared }) },
      },
    } as any);

    await expect(tool.execute({
      owner: 'exampleorg', repo: 'example-api', pull_number: 73,
      head_sha: HEAD_SHA, force: true,
    })).rejects.toThrow(/authoritative admission no longer matches current policy/);
    expect(query).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
  });

  it('admits review request with explicit review_engine: composed', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
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
        repositoryId: 101,
        installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve },
      },
      now: () => 1_790_060_000_000,
    } as any);

    const result = await tool.execute({
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
      head_sha: HEAD_SHA,
      review_engine: 'composed',
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 101,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 73,
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
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
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
        repositoryId: 101,
        installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve },
      },
      now: () => 1_790_060_000_000,
    } as any);

    const result = await tool.execute({
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
      head_sha: HEAD_SHA,
      review_engine: 'panel',
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 101,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 73,
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

  it('preserves the complete authoritative policy for an idempotent engine request', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = {
      version: 'PreparedPublishingPolicy.v1',
      policy: {
        effectivePolicyDigest: POLICY_DIGEST,
        effectiveConfigDigest: 'd'.repeat(64),
        sources: [{
          repositoryId: 101,
          repository: 'exampleorg/example-api',
          sha: HEAD_SHA,
          path: '.exampleorg/review-policy.json',
          contentDigest: 'e'.repeat(64),
        }],
      },
      config: {
        review_engine: 'composed',
        default_max_turns: 7,
        composed: { max_tasks: 4, max_turns_total: 12 },
      },
      expectedPersonaIds: ['sec-lane', 'arch-lane'],
      transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'service-selected-model' },
    };
    const original = structuredClone(prepared);
    const admit = vi.fn(async (input: any) => {
      expect(input.authoritativeGate.prepared).toEqual(original);
      return { run: { runId: `run_${'e'.repeat(32)}` } };
    });
    const resolve = vi.fn(async () => ({ identity, prepared }));
    const tool = createTriggerReviewTool({
      queryableDatabase: { query: vi.fn(async () => ({ rows: [] })) },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: vi.fn(async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 101, installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve },
      },
    } as any);

    await tool.execute({ ...request, review_engine: 'composed' });

    expect(admit).toHaveBeenCalledOnce();
    expect(prepared).toEqual(original);
  });

  it('refuses an engine that differs from the authoritative effective engine', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
      headSha: HEAD_SHA, baseSha: BASE_SHA,
    };
    const prepared = {
      policy: {
        effectivePolicyDigest: POLICY_DIGEST,
        effectiveConfigDigest: 'd'.repeat(64),
        sources: [{
          repositoryId: 101,
          repository: 'exampleorg/example-api',
          sha: HEAD_SHA,
          path: '.exampleorg/review-policy.json',
          contentDigest: 'e'.repeat(64),
        }],
      },
      config: { review_engine: 'panel' },
      transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'service-selected-model' },
      expectedPersonaIds: ['sec-lane'],
    };
    const admit = vi.fn();
    const tool = createTriggerReviewTool({
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: vi.fn(async () => ({
        headSha: HEAD_SHA, baseSha: BASE_SHA,
        repositoryId: 101, installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve: vi.fn(async () => ({ identity, prepared })) },
      },
    } as any);

    await expect(tool.execute({ ...request, review_engine: 'composed' })).rejects.toThrow(
      'Requested review_engine is not permitted by the authoritative policy',
    );
    expect(prepared.config.review_engine).toBe('panel');
    expect(admit).not.toHaveBeenCalled();
  });

  it('preserves backward compatibility when review_engine is omitted', async () => {
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 73,
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
        repositoryId: 101,
        installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver: { resolve },
      },
      now: () => 1_790_060_000_000,
    } as any);

    const result = await tool.execute({
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
      head_sha: HEAD_SHA,
    });

    expect(admit).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({
      repositoryId: 101,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 73,
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
      schema: 'exampleorg.review-policy.v1',
      review_yeti: {
        personas: 'security,architecture',
        budget: { max_investigation_turns: 5 },
        review_engine: 'composed',
        composed: { max_tasks: 4, max_turns_total: 12 },
      },
    });
    const policyFile = {
      source: {
        repositoryId: 101,
        repository: 'exampleorg/example-api',
        sha: HEAD_SHA,
        path: '.exampleorg/review-policy.json',
        contentDigest: createHash('sha256').update(policyContent).digest('hex'),
      },
      content: policyContent,
    };

    const resolver = new AuthoritativePublishingResolver({
      policyRepository: { repositoryId: 101, owner: 'exampleorg', repo: 'example-api' },
      policyRef: 'refs/heads/main',
      policyPath: '.exampleorg/review-policy.json',
      transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'fixture-model' },
      candidateReaderFactory: async () => ({
        currentCandidate: async () => ({
          open: true,
          draft: false,
          repositoryId: 101,
          owner: 'exampleorg',
          repo: 'example-api',
          prNumber: 73,
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
        }),
      }),
      policyReaderFactory: async () => ({
        resolvePolicyRevision: async () => HEAD_SHA,
        immutablePolicyFile: async () => policyFile,
      }),
    });

    const expected = await resolver.resolve({
      repositoryId: 101,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 73,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    });
    const admit = vi.fn(async (input: any) => {
      expect(input.authoritativeGate.prepared).toEqual(expected.prepared);
      return { run: { runId: `run_${'e'.repeat(32)}` } };
    });

    const tool = createTriggerReviewTool({
      queryableDatabase: { query: vi.fn(async () => ({ rows: [] })) },
      admissionRepository: { admit } as any,
      resolveGitHubPullRequest: vi.fn(async () => ({
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        repositoryId: 101,
        installationId: 22,
      })),
      authoritativePublishing: {
        expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
        repositoryIds: [101],
        resolver,
      } as any,
      now: () => 1_790_060_000_000,
    });

    const result = await tool.execute({
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
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
      owner: 'exampleorg',
      repo: 'example-api',
      pull_number: 73,
      head_sha: HEAD_SHA,
      review_engine: 'invalid_engine' as any,
    })).rejects.toThrow(/Invalid arguments/);
  });
});


describe('repository-bound public MCP admission', () => {
  const requested = { owner: 'review-yeti-ai', repo: 'review-yeti-bot', pull_number: 1, head_sha: HEAD_SHA };
  function toolFixture(repositoryId = 1326169548, appId = 4552718) {
    const admit = vi.fn(async () => ({ run: { runId: `run_${'e'.repeat(32)}` } }));
    const candidate = { repositoryId, owner: requested.owner, repo: requested.repo,
      prNumber: 1, headSha: HEAD_SHA, baseSha: BASE_SHA };
    const current = { ...candidate, open: true, draft: false, private: false };
    const content = JSON.stringify({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 3 },
    } });
    const prepared = preparePublishingPolicy({ content, source: {
      repositoryId: 987654, repository: 'exampleorg/review-policy', sha: 'f'.repeat(40),
      path: 'review-policy.json', contentDigest: createHash('sha256').update(content).digest('hex'),
    } }, { baseUrl: 'https://gateway.example.invalid/v1', model: 'test-review-model' });
    const resolve = vi.fn(async () => ({ current, prepared,
      identity: buildAuthoritativeReviewIdentity({ requested: candidate, current, policy: prepared.policy }) }));
    const tool = createTriggerReviewTool({ admissionRepository: { admit } as any,
      resolveGitHubPullRequest: async () => ({ repositoryId, installationId: 2, headSha: HEAD_SHA, baseSha: BASE_SHA }),
      authoritativePublishing: { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, expectedAppIdFor: () => appId, repositoryIds: [1326169548], resolver: { resolve } },
    });
    return { tool, admit, resolve };
  }
  it('records the dedicated App on governed public admission', async () => {
    const f = toolFixture();
    await f.tool.execute(requested);
    expect(f.admit).toHaveBeenCalledWith(expect.objectContaining({ authoritativeGate: expect.objectContaining({ expectedAppId: 4552718 }) }));
  });
  it.each([123, 1326169549])('rejects wrong live repository ID %s before policy/admission', async id => {
    const f = toolFixture(id);
    await expect(f.tool.execute(requested)).rejects.toThrow('outside authoritative admission');
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });
  it.each([AUTHORITATIVE_REVIEW_APP_ID, 4552719])('rejects a foreign public App %s before durable writes', async appId => {
    const f = toolFixture(1326169548, appId);
    await expect(f.tool.execute(requested)).rejects.toThrow();
    expect(f.admit).not.toHaveBeenCalled();
  });
});
