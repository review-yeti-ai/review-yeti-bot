import { describe, it, expect } from 'vitest';
import {
  assertLinearApiKeyOnly,
  assertLinearIntegrationApiKeyOnly,
  isLinearMcpCandidate,
  LINEAR_APPROVED_PACKAGE,
} from '../../src/mcp/linearPolicy';

describe('Linear MCP policy (API key only, reject OAuth)', () => {
  it('identifies Linear candidates', () => {
    expect(isLinearMcpCandidate({ name: 'Linear Issue MCP' })).toBe(true);
    expect(isLinearMcpCandidate({ id: 'builtin-linear' })).toBe(true);
    expect(isLinearMcpCandidate({ url: 'https://mcp.linear.app/sse' })).toBe(true);
    expect(isLinearMcpCandidate({ name: 'Context7' })).toBe(false);
  });

  it('rejects official remote OAuth Linear MCP (mcp.linear.app)', () => {
    const res = assertLinearApiKeyOnly({
      name: 'Linear Remote',
      transport: 'http',
      url: 'https://mcp.linear.app/sse',
    });
    expect(res.ok).toBe(false);
    expect(res.isLinear).toBe(true);
    expect(res.error).toMatch(/OAuth|LINEAR_API_KEY/i);
    expect(res.error).toContain(LINEAR_APPROVED_PACKAGE);
  });

  it('rejects mcp-remote + linear args (OAuth bridge)', () => {
    const res = assertLinearApiKeyOnly({
      name: 'linear',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/OAuth|mcp-remote|mcp\.linear\.app/i);
  });

  it('rejects OAuth client env on Linear MCP', () => {
    const res = assertLinearApiKeyOnly({
      name: 'cline linear-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['build/index.js'],
      env: {
        LINEAR_CLIENT_ID: 'abc',
        LINEAR_CLIENT_SECRET: 'def',
        LINEAR_REDIRECT_URI: 'http://localhost:3000/callback',
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/OAuth|LINEAR_API_KEY/i);
  });

  it('allows cline/linear-mcp style stdio with LINEAR_API_KEY only', () => {
    const res = assertLinearApiKeyOnly({
      name: 'cline/linear-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['build/index.js'],
      env: { LINEAR_API_KEY: 'lin_api_test_key' },
    });
    expect(res.ok).toBe(true);
    expect(res.isLinear).toBe(true);
  });

  it('allows builtin adapter without URL (API key from process env)', () => {
    const res = assertLinearApiKeyOnly({
      id: 'builtin-linear',
      name: 'Linear Issue MCP',
      transport: 'adapter',
    });
    expect(res.ok).toBe(true);
    expect(res.isLinear).toBe(true);
  });

  it('passes through non-Linear MCP candidates', () => {
    const res = assertLinearApiKeyOnly({
      name: 'Context7 Documentation MCP',
      transport: 'adapter',
    });
    expect(res.ok).toBe(true);
    expect(res.isLinear).toBe(false);
  });

  it('rejects Linear integration OAuth client fields', () => {
    const res = assertLinearIntegrationApiKeyOnly({
      oauthClientId: 'client',
      oauthClientSecret: 'secret',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/OAuth|apiKey/i);
  });

  it('allows Linear integration apiKey-only updates', () => {
    const res = assertLinearIntegrationApiKeyOnly({
      apiKey: 'lin_api_test_key',
    });
    expect(res.ok).toBe(true);
  });
});
