import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mcpFleetManager } from '../../src/mcp/mcpFleetManager';
import { piWorkflowRegistry } from '../../src/mcp/piWorkflowRegistry';

describe('Linear MCP Adapter & Tool Integration Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('discovers linear_get_issue and linear_close_issue in builtin-linear adapter', async () => {
    const tools = await mcpFleetManager.discoverTools('builtin-linear');
    expect(tools).toContain('linear_get_issue');
    expect(tools).toContain('linear_close_issue');
  });

  it('includes linear_get_issue in piWorkflowRegistry available MCP tools', () => {
    const tools = piWorkflowRegistry.getAvailableMcpTools();
    const linearTool = tools.find((t) => t.name === 'linear_get_issue');
    expect(linearTool).toBeDefined();
    expect(linearTool?.serverId).toBe('builtin-linear');
    expect(linearTool?.description).toContain('Linear issue details');
  });

  it('executes linear_get_issue with offline fallback when LINEAR_API_KEY is not set', async () => {
    const result = await mcpFleetManager.executeTool('linear_get_issue', { issueId: 'API-155' });
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
    expect(result.output.identifier).toBe('API-155');
    expect(result.output.title).toContain('API-155');
    expect(result.output.description).toContain('Acceptance criteria');
    expect(result.output.state.name).toBe('In Progress');
    expect(result.output.source).toBe('offline_fallback');
  });

  it('executes linear_get_issue with GraphQL API request when LINEAR_API_KEY is provided', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_mock_test_key_12345';

    const mockResponse = {
      data: {
        issue: {
          id: 'issue_abc123',
          identifier: 'API-197',
          title: 'G.729 Audio Transcoding via Rustler NIF',
          description: 'Implement pure Rustler NIF for G.729 ITU codec transcoding in Elixir.',
          priority: 1,
          state: { name: 'Todo', type: 'unstarted' },
          assignee: { name: 'Jason Barbee', email: 'jason@calltelemetry.com' },
          project: { name: 'Audio Engine' },
          labels: { nodes: [{ name: 'audio' }, { name: 'roadmap' }] },
        },
      },
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    globalThis.fetch = fetchMock;

    const result = await mcpFleetManager.executeTool('linear_get_issue', { issueId: 'API-197' });
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const [fetchUrl, fetchOptions] = fetchMock.mock.calls[0];
    expect(fetchUrl).toBe('https://api.linear.app/graphql');
    expect(fetchOptions.headers.Authorization).toBe('lin_api_mock_test_key_12345');
    expect(result.output.identifier).toBe('API-197');
    expect(result.output.title).toBe('G.729 Audio Transcoding via Rustler NIF');
  });

  it('executes linear_close_issue successfully', async () => {
    const result = await mcpFleetManager.executeTool('linear_close_issue', {
      issueId: 'API-155',
      targetStatus: 'Done',
    });
    expect(result.success).toBe(true);
    expect(result.output.issueId).toBe('API-155');
    expect(result.output.status).toBe('Done');
    expect(result.output.updated).toBe(true);
  });
});
