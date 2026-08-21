import { describe, expect, it } from 'vitest';
import {
  handleCallTool,
  sessionAnalyticsMcpServer,
  MCP_TOOLS,
} from '../sessionAnalyticsMcpServer';
import { runCLI } from '../../analytics/cliParser';

describe('sessionAnalyticsMcpServer Unit & Integration Tests', () => {
  it('registers both MCP tools with valid descriptions and inputSchemas', () => {
    const tools = sessionAnalyticsMcpServer.getTools();
    expect(tools).toHaveLength(2);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('query_openrouter_models');
    expect(toolNames).toContain('get_model_benchmark_matrix');

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
    }
  });

  it('handles query_openrouter_models tool invocation with filters', async () => {
    const result = await handleCallTool('query_openrouter_models', {
      sortBy: 'swe-score',
      minScore: 40,
      maxCostPer1M: 10,
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('entries');
    expect(parsed).toHaveProperty('summary');
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBeLessThanOrEqual(3);

    for (const entry of parsed.entries) {
      expect(entry.activeSweScore).toBeGreaterThanOrEqual(40);
      expect(entry.blendedCostPer1M).toBeLessThanOrEqual(10);
    }
  });

  it('handles get_model_benchmark_matrix tool invocation with benchmarkType', async () => {
    const result = await sessionAnalyticsMcpServer.callTool('get_model_benchmark_matrix', {
      benchmarkType: 'lite',
      limit: 5,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.benchmarkType).toBe('lite');
    expect(parsed.entries.length).toBeLessThanOrEqual(5);
    expect(parsed.summary).toHaveProperty('avgScore');
    expect(parsed.summary).toHaveProperty('avgBlendedCostPer1M');
  });

  it('returns structured error content object for unknown tool name', async () => {
    const result = await handleCallTool('non_existent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toContain('Unknown MCP tool');
  });

  it('executes CLI models command with various sort and format parameters', async () => {
    // 1. Table format (default)
    const resTable = await runCLI(['models', '--sort', 'swe-score', '--limit', '2']);
    expect(resTable.exitCode).toBe(0);
    expect(resTable.output).toContain('SWE-BENCH PERFORMANCE MATRIX');

    // 2. JSON format
    const resJson = await runCLI(['models', '--sort', 'cost', '--format', 'json']);
    expect(resJson.exitCode).toBe(0);
    const parsedJson = JSON.parse(resJson.output);
    expect(parsedJson).toHaveProperty('entries');

    // 3. Markdown format
    const resMd = await runCLI(['models', '--sort', 'efficiency', '--format', 'markdown']);
    expect(resMd.exitCode).toBe(0);
    expect(resMd.output).toContain('# SWE-bench Performance & Cost Efficiency Matrix');
  });
});
