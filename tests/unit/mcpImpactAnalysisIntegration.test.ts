import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mcpFleetManager } from '../../src/mcp/mcpFleetManager';

const require = createRequire(import.meta.url);
const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');
const { formatPRComment, initMcpFleet, setMcpFleetManager, selectImpactTool, evaluateDownstreamImpact } = pipeline;

describe('Generic MCP Impact Analysis Review Integration', () => {
  const mockServerId = 'custom-impact-server';
  const mockServerScript = `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        if (req.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              tools: [
                {
                  name: 'impact_analysis',
                  description: 'Analyze downstream blast radius of changed files across repositories or modules',
                  inputSchema: { type: 'object', properties: { files: { type: 'array' } } },
                },
              ],
            },
          }) + '\\n');
        } else if (req.method === 'tools/call') {
          const files = req.params?.arguments?.files || [];
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    markdown: '### Downstream Impact & Blast Radius\\n- Modified: \`' + files.join(', ') + '\`\\n- Affected Consumer: \`src/components/UserProfile.tsx\`',
                    impacted_files: ['src/components/UserProfile.tsx'],
                  }),
                },
              ],
            },
          }) + '\\n');
        }
      } catch (err) {
        process.stderr.write(String(err) + '\\n');
      }
    }
  `;

  beforeEach(async () => {
    setMcpFleetManager(mcpFleetManager);
    if (mcpFleetManager.getServer(mockServerId)) {
      await mcpFleetManager.unregisterServer(mockServerId);
    }
  });

  afterEach(async () => {
    if (mcpFleetManager.getServer(mockServerId)) {
      await mcpFleetManager.unregisterServer(mockServerId);
    }
    delete process.env.MCP_CONFIG_JSON;
    delete process.env.MCP_IMPACT_TOOL_NAME;
  });

  it('formats PR comment with downstream impact analysis section when provided in mcpTelemetry', () => {
    const mockArbitration = {
      totalPersonas: 3,
      completedPersonas: 3,
      quorumSatisfied: true,
      verdict: 'SHIP',
      rationale: 'All checks passed cleanly.',
      metrics: { p0Count: 0, p1Count: 0, p2Count: 0, totalFindings: 0 },
    };
    const mockLanes = [
      {
        personaId: 'architecture',
        displayName: 'Architecture',
        decision: 'APPROVE',
        findings: [],
        cost: 0,
      },
    ];
    const prContext = {
      repo: 'acme-corp/user-service',
      prNumber: '108',
      headSha: 'abc1234',
    };
    const impactAnalysisMarkdown = '### Downstream Impact & Affected Consumers\n- API: `POST /api/v1/users`\n- Consumer: `src/components/UserProfile.tsx`';

    const comment = formatPRComment(
      mockArbitration,
      mockLanes,
      prContext,
      {
        mcpStatusSummary: '1 Custom MCP Server(s) Registered & Live Execution Enabled',
        impactAnalysisMarkdown,
      }
    );

    expect(comment).toContain('🌐 <b>Downstream Impact & Blast Radius Analysis</b>');
    expect(comment).toContain('POST /api/v1/users');
    expect(comment).toContain('src/components/UserProfile.tsx');
    expect(comment).toContain('1 Custom MCP Server(s) Registered & Live Execution Enabled');
  });

  it('registers stdio MCP server, discovers impact_analysis tool dynamically, and executes it', async () => {
    const mcpConfig = {
      servers: [
        {
          id: mockServerId,
          name: 'Workspace Impact & Blast Radius MCP Server',
          transport: 'stdio',
          command: 'node',
          args: ['--input-type=module', '-e', mockServerScript],
          enabled: true,
        },
      ],
    };

    process.env.MCP_CONFIG_JSON = JSON.stringify(mcpConfig);

    const fleetInfo = await initMcpFleet();
    expect(fleetInfo.registeredCount).toBeGreaterThanOrEqual(1);
    expect(mcpFleetManager.getServer(mockServerId)).toBeDefined();

    // Verify tool discovery found impact_analysis
    expect(mcpFleetManager.hasTool('impact_analysis')).toBe(true);

    // Execute impact_analysis over stdio
    const result = await mcpFleetManager.executeTool('impact_analysis', {
      files: ['src/api/auth.ts'],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output.markdown).toContain('Downstream Impact');
    expect(result.output.markdown).toContain('src/api/auth.ts');
    expect(result.output.impacted_files).toContain('src/components/UserProfile.tsx');
  });

  it('evaluates changed diff files against auto-discovered impact tool and enriches session context header', async () => {
    const mcpConfig = {
      servers: [
        {
          id: mockServerId,
          name: 'Workspace Impact & Blast Radius MCP Server',
          transport: 'stdio',
          command: 'node',
          args: ['--input-type=module', '-e', mockServerScript],
          enabled: true,
        },
      ],
    };

    process.env.MCP_CONFIG_JSON = JSON.stringify(mcpConfig);
    const mcpFleetInfo = await initMcpFleet();

    const reviewDiffFiles = [
      { path: 'src/api/auth.ts', patch: '@@ -1,5 +1,5 @@' },
    ];

    let sessionContext = { previousTurn: 1, hasHistory: true, augmentedHeader: 'Prior Turn Context' };

    // Verify pipeline tool selector finds the tool dynamically
    const detectedTool = selectImpactTool(mcpFleetManager);
    expect(detectedTool).toBe('impact_analysis');

    // Evaluate downstream impact using the exported pipeline function
    const result = await evaluateDownstreamImpact({
      reviewDiffFiles,
      mcpFleetManager,
      sessionContext,
      mcpFleetInfo,
    });

    expect(result.evaluated).toBe(true);
    expect(result.toolName).toBe('impact_analysis');
    expect(result.markdown).toContain('Downstream Impact');
    expect(mcpFleetInfo.impactAnalysisMarkdown).toContain('Downstream Impact');
    expect(sessionContext.augmentedHeader).toContain('Prior Turn Context');
    expect(sessionContext.augmentedHeader).toContain('### Downstream Impact & Blast Radius Analysis');
    expect(sessionContext.augmentedHeader).toContain('src/components/UserProfile.tsx');
  });
});
