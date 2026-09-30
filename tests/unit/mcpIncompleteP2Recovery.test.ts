import express, { type Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteMcpRouter, DefaultMcpToolRegistry, type RemoteMcpRouter } from '../../src/mcp/server/remoteMcpRouter';
import { McpAuthenticator, type McpAuthenticatedCaller } from '../../src/mcp/server/mcpAuthenticator';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import type { McpExecutionContext } from '../../src/mcp/server/mcpTypes';

const token = 'recovery-admin-secret';
const tokenDigest = 'a'.repeat(12);
const headSha = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const repositoryId = 321;
const identity = {
  owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42, headSha, baseSha,
};
const prepared = { policy: { effectivePolicyDigest: 'd'.repeat(64), effectiveConfigDigest: 'e'.repeat(64) } };
const context: McpExecutionContext = {
  authenticatedByConfiguredAuthenticator: true,
  caller: {
    authType: 'static_token', tokenDigest, isAdmin: true, allowedRepositories: null,
    callerId: `admin:${tokenDigest}`,
  },
  authorizedRepository: { owner: identity.owner, repo: identity.repo },
};

const routers: RemoteMcpRouter[] = [];
afterEach(() => {
  for (const router of routers.splice(0)) router.destroy();
});

function toolSetup(options: { admission?: boolean } = {}) {
  const admit = vi.fn(async () => ({ run: { runId: `run_${'f'.repeat(32)}` } }));
  const tool = createTriggerReviewTool({
    ...(options.admission === false ? {} : { admissionRepository: { admit } as any }),
    resolveGitHubPullRequest: async () => ({ headSha, baseSha, repositoryId, installationId: 654 }),
    authoritativePublishing: {
      expectedAppId: 4_385_771,
      repositoryIds: [repositoryId],
      acceptNewRequests: true,
      resolver: { resolve: async () => ({ identity, prepared }) },
    },
  } as any);
  return { tool, admit };
}

const recoveryArgs = {
  owner: identity.owner, repo: identity.repo, pull_number: identity.prNumber,
  head_sha: headSha, incomplete_p2_recovery: true,
};

describe('MCP retained-P2 recovery admission', () => {
  it('requires verified static admin context and exact router-authorized coordinates', async () => {
    const invalidContexts: Array<[string, McpExecutionContext]> = [
      ['missing configured-authenticator proof', { ...context, authenticatedByConfiguredAuthenticator: false }],
      ['OIDC caller', { ...context, caller: { ...context.caller!, authType: 'oidc', isAdmin: false } as McpAuthenticatedCaller }],
      ['non-admin static caller', { ...context, caller: { ...context.caller!, isAdmin: false } }],
      ['caller ID not bound to token digest', { ...context, caller: { ...context.caller!, callerId: 'admin:forged' } }],
      ['repository mismatch', { ...context, authorizedRepository: { owner: 'other', repo: 'repo' } }],
    ];

    for (const [label, invalid] of invalidContexts) {
      const { tool, admit } = toolSetup();
      await expect(tool.execute(recoveryArgs, invalid), label).rejects.toThrow(/verified static-token admin|exact repository authorization/);
      expect(admit, label).not.toHaveBeenCalled();
    }
  });

  it('fails closed without durable admission or when caller arguments try to widen recovery', async () => {
    const missingRepository = toolSetup({ admission: false });
    await expect(missingRepository.tool.execute(recoveryArgs, context)).rejects.toThrow(/requires durable authoritative admission/);

    const { tool, admit } = toolSetup();
    await expect(tool.execute({ ...recoveryArgs, force: true }, context)).rejects.toThrow(/does not accept force/);
    await expect(tool.execute({ ...recoveryArgs, review_engine: 'panel' }, context)).rejects.toThrow(/does not accept force or review_engine/);
    await expect(tool.execute({ ...recoveryArgs, expected_generation: 2 }, context)).rejects.toThrow(/Invalid arguments/);
    await expect(tool.execute({ ...recoveryArgs, centralActionDispatch: false }, context)).rejects.toThrow(/Invalid arguments/);
    expect(admit).not.toHaveBeenCalled();
  });

  it('passes a verified router-produced origin and no caller-selected attempt to durable admission', async () => {
    const { tool, admit } = toolSetup();
    await tool.execute(recoveryArgs, context);
    expect(admit).toHaveBeenCalledOnce();
    const [input] = admit.mock.calls[0] as any[];
    expect(input).toMatchObject({
      eventName: 'mcp.trigger_review',
      centralActionDispatch: false,
      retryRequested: true,
      incompleteP2Recovery: true,
      incompleteP2RecoveryOrigin: {
        kind: 'mcp_static_admin',
        callerId: `admin:${tokenDigest}`,
        authorizedOwner: identity.owner,
        authorizedRepo: identity.repo,
      },
    });
    expect(input.expectedGeneration).toBeUndefined();
    expect(input.retryAfterExecutionAttempt).toBeUndefined();
  });

  it('uses the configured authenticator result and router RBAC, not mutable req.mcpCaller', async () => {
    const { tool, admit } = toolSetup();
    const registry = new DefaultMcpToolRegistry();
    registry.registerTool(tool as any);
    const router = createRemoteMcpRouter({
      authenticator: new McpAuthenticator({ staticAuthToken: token }),
      toolRegistry: registry,
    });
    routers.push(router);

    const app = express();
    app.use(express.json());
    app.use('/mcp', router);
    const response = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'trigger_review', arguments: recoveryArgs } });

    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    expect(admit).toHaveBeenCalledOnce();
    expect((admit.mock.calls[0] as any[])[0].incompleteP2RecoveryOrigin.authorizedRepo).toBe(identity.repo);
  });

  it('does not trust a pre-populated Express caller when configured authentication rejects the bearer', async () => {
    const { tool, admit } = toolSetup();
    const registry = new DefaultMcpToolRegistry();
    registry.registerTool(tool as any);
    const router = createRemoteMcpRouter({
      authenticator: new McpAuthenticator({ staticAuthToken: token }),
      toolRegistry: registry,
    });
    routers.push(router);

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res, next) => {
      req.mcpCaller = context.caller;
      next();
    });
    app.use('/mcp', router);
    const response = await request(app).post('/mcp')
      .set('Authorization', 'Bearer forged-token')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trigger_review', arguments: recoveryArgs } });

    expect(response.status).toBe(401);
    expect(admit).not.toHaveBeenCalled();
  });
});
