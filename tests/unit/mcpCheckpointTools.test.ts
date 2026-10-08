import { describe, it, expect } from 'vitest';
import { createGetCheckpointMetricsTool } from '../../src/mcp/server/tools/getCheckpointMetrics';
import { createGetCompactionAnalyticsTool } from '../../src/mcp/server/tools/getCompactionAnalytics';
import { createQueryActiveJobsTool } from '../../src/mcp/server/tools/queryActiveJobs';

describe('Next-Gen MCP Tools: Checkpoints, Compaction, and Job Telemetry', () => {
  describe('get_checkpoint_metrics', () => {
    const tool = createGetCheckpointMetricsTool();

    it('has valid definition and inputSchema', () => {
      expect(tool.definition.name).toBe('get_checkpoint_metrics');
      expect(tool.definition.description).toContain('content-addressed checkpoint cache');
      expect(tool.definition.inputSchema.properties).toHaveProperty('repo');
      expect(tool.definition.inputSchema.properties).toHaveProperty('window_hours');
    });

    it('executes cleanly and returns checkpoint cache statistics', async () => {
      const result = await tool.execute({});
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');

      const data = JSON.parse((result.content[0] as any).text);
      expect(data).toHaveProperty('data_source', 'content_addressed_checkpoint_engine');
      expect(data).toHaveProperty('total_subtasks_evaluated');
      expect(data).toHaveProperty('cache_hits');
      expect(data).toHaveProperty('cache_misses');
      expect(data).toHaveProperty('hit_rate_percent');
      expect(data).toHaveProperty('zero_token_replays_count');
      expect(data).toHaveProperty('tokens_saved_total');
      expect(data).toHaveProperty('by_lane');
      expect(data.by_lane).toHaveProperty('security');
    });

    it('filters by repo and window_hours', async () => {
      const result = await tool.execute({ repo: 'acme/core', window_hours: 24 });
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.repo).toBe('acme/core');
      expect(data.window_hours).toBe(24);
    });

    it('rejects invalid argument types', async () => {
      await expect(tool.execute({ window_hours: -5 })).rejects.toThrow();
    });
  });

  describe('get_compaction_analytics', () => {
    const tool = createGetCompactionAnalyticsTool();

    it('has valid definition and inputSchema', () => {
      expect(tool.definition.name).toBe('get_compaction_analytics');
      expect(tool.definition.description).toContain('unbounded AST streaming');
      expect(tool.definition.inputSchema.properties).toHaveProperty('repo');
      expect(tool.definition.inputSchema.properties).toHaveProperty('window_hours');
    });

    it('executes cleanly and verifies abolition of 25k context cap', async () => {
      const result = await tool.execute({});
      expect(result.isError).toBeFalsy();
      const data = JSON.parse((result.content[0] as any).text);

      expect(data).toHaveProperty('data_source', 'ast_outline_diff_compaction_engine');
      expect(data).toHaveProperty('compaction_ratio');
      expect(data).toHaveProperty('raw_diff_tokens_avg');
      expect(data).toHaveProperty('compacted_tokens_avg');
      expect(data).toHaveProperty('diff_eviction_receipts_count');
      expect(data).toHaveProperty('flat_context_slope_confirmed', true);
      expect(data).toHaveProperty('hard_context_limit_abolished', true);
      expect(data.max_pr_tokens_handled).toBeGreaterThan(25000);
    });
  });

  describe('query_active_jobs enrichment', () => {
    it('returns enriched jobs with next-gen review telemetry', async () => {
      const mockDb = {
        query: async () => ({
          rows: [
            {
              run_id: 'run-nextgen-1',
              owner: 'acme',
              repo: 'core',
              pr_number: 42,
              head_sha: 'abc12345',
              status: 'running',
              created_at: new Date().toISOString(),
              burst_started_at: new Date().toISOString(),
              terminal_deadline: new Date(Date.now() + 60000).toISOString(),
              is_incremental: true,
              recheck_lane: true,
              file_coverage_percent: 85,
              checkpoint_hit_count: 3,
              blocker_fast_path_triggered: false,
            },
          ],
        }),
      };

      const tool = createQueryActiveJobsTool(mockDb as any);
      const res = await tool.execute({});
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.active_jobs).toHaveLength(1);
      const job = data.active_jobs[0];
      expect(job.is_incremental).toBe(true);
      expect(job.recheck_lane).toBe(true);
      expect(job.file_coverage_percent).toBe(85);
      expect(job.checkpoint_hit_count).toBe(3);
      expect(job.blocker_fast_path_triggered).toBe(false);
    });
  });
});
