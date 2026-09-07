import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mcpFleetManager } from '../../src/mcp/mcpFleetManager';

const require = createRequire(import.meta.url);
const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');
const { formatPRComment, initMcpFleet, setMcpFleetManager } = pipeline;

describe('ct-impact MCP Review Integration', () => {
  const ctReviewActionsPath = '/Users/jasonbarbee/Documents/ct-master/ct-review-actions';
  const mcpServerScript = path.join(ctReviewActionsPath, 'scripts/ct-impact-mcp.mjs');
  const serverExists = fs.existsSync(mcpServerScript);

  beforeEach(async () => {
    setMcpFleetManager(mcpFleetManager);
    if (mcpFleetManager.getServer('ct-impact')) {
      await mcpFleetManager.unregisterServer('ct-impact');
    }
  });

  afterEach(async () => {
    if (mcpFleetManager.getServer('ct-impact')) {
      await mcpFleetManager.unregisterServer('ct-impact');
    }
    delete process.env.MCP_CONFIG_JSON;
  });

  it('formats PR comment with cross-repository blast radius section when provided in mcpTelemetry', () => {
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
      repo: 'calltelemetry/cisco-cdr',
      prNumber: '4855',
      headSha: 'abc1234',
    };
    const blastRadiusMarkdown = '### Cross-Repository Blast Radius & Downstream Consumers\n- Upstream Phoenix: `POST /api/org/:org_id/cube-event-logs/`\n- Downstream Quasar: `src/components/cube/CubeEventLogs.vue`';

    const comment = formatPRComment(
      mockArbitration,
      mockLanes,
      prContext,
      {
        mcpStatusSummary: '1 Custom MCP Server(s) Registered & Live Execution Enabled',
        blastRadiusMarkdown,
      }
    );

    expect(comment).toContain('🌐 <b>Cross-Repository Blast Radius & Downstream Impact</b>');
    expect(comment).toContain('POST /api/org/:org_id/cube-event-logs/');
    expect(comment).toContain('src/components/cube/CubeEventLogs.vue');
    expect(comment).toContain('1 Custom MCP Server(s) Registered & Live Execution Enabled');
  });

  it('registers ct-impact stdio server and executes ct_impact tool when available', async () => {
    if (!serverExists) {
      console.warn('Skipping live ct-impact stdio test: ct-impact-mcp.mjs not found at', mcpServerScript);
      return;
    }

    const mcpConfig = {
      servers: [
        {
          id: 'ct-impact',
          name: 'CallTelemetry AST Code Mesh & Blast Radius',
          transport: 'stdio',
          command: 'node',
          args: [mcpServerScript],
          enabled: true,
        },
      ],
    };

    process.env.MCP_CONFIG_JSON = JSON.stringify(mcpConfig);

    const fleetInfo = await initMcpFleet();
    expect(fleetInfo.registeredCount).toBeGreaterThanOrEqual(1);
    expect(mcpFleetManager.getServer('ct-impact')).toBeDefined();

    // Verify tool discovery found ct_impact
    expect(mcpFleetManager.hasTool('ct_impact')).toBe(true);
    expect(mcpFleetManager.hasTool('ct_mesh_query')).toBe(true);
    expect(mcpFleetManager.hasTool('ct_mesh_stats')).toBe(true);

    // Execute ct_impact over stdio
    const result = await mcpFleetManager.executeTool('ct_impact', {
      files: ['lib/cdrcisco_web/controllers/api/cube_event_logs_controller.ex'],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output.backend_routes.length).toBeGreaterThan(0);
    expect(result.output.backend_routes[0].controller).toBe('API.CubeEventLogsController');
    expect(result.output.markdown).toContain('Cross-Repository Blast Radius');
    expect(result.output.markdown).toContain('API.CubeEventLogsController');
  });

  it('evaluates changed diff files against ct-impact and enriches session context header', async () => {
    if (!serverExists) return;

    const mcpConfig = {
      servers: [
        {
          id: 'ct-impact',
          name: 'CallTelemetry AST Code Mesh & Blast Radius',
          transport: 'stdio',
          command: 'node',
          args: [mcpServerScript],
          enabled: true,
        },
      ],
    };

    process.env.MCP_CONFIG_JSON = JSON.stringify(mcpConfig);
    const mcpFleetInfo = await initMcpFleet();

    const reviewDiffFiles = [
      { path: 'lib/cdrcisco_web/controllers/api/cube_event_logs_controller.ex', patch: '@@ -1,5 +1,5 @@' },
    ];

    let sessionContext = { previousTurn: 1, hasHistory: true, augmentedHeader: 'Prior Turn Context' };

    // Simulate the exact pipeline enrichment logic
    if (mcpFleetManager && (mcpFleetManager.getServer('ct-impact') || mcpFleetManager.hasTool('ct_impact'))) {
      const filePaths = reviewDiffFiles.map((f) => f.path);
      const impactResult = await mcpFleetManager.executeTool('ct_impact', { files: filePaths });
      if (impactResult && impactResult.success && impactResult.output) {
        const impactOutput = impactResult.output;
        const markdown = impactOutput.markdown || impactOutput.text || (typeof impactOutput === 'string' ? impactOutput : null);
        if (markdown) {
          mcpFleetInfo.blastRadiusMarkdown = markdown;
          const blastRadiusPromptSection = `### Cross-Repository Blast Radius & Downstream Impact\n${markdown}`;
          sessionContext.augmentedHeader = sessionContext.augmentedHeader
            ? `${sessionContext.augmentedHeader}\n\n${blastRadiusPromptSection}`
            : blastRadiusPromptSection;
        }
      }
    }

    expect(mcpFleetInfo.blastRadiusMarkdown).toBeDefined();
    expect(mcpFleetInfo.blastRadiusMarkdown).toContain('Cross-Repository Blast Radius');
    expect(sessionContext.augmentedHeader).toContain('Prior Turn Context');
    expect(sessionContext.augmentedHeader).toContain('### Cross-Repository Blast Radius & Downstream Impact');
    expect(sessionContext.augmentedHeader).toContain('API.CubeEventLogsController');
  });
});
