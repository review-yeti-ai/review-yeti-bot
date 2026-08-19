import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeMcpConfig, validateMcpConfig } from './review-yeti-mcp.mjs';

function validConfig() {
  return {
    servers: [
      {
        id: 'context7-local',
        name: 'Context7 local proxy',
        transport: 'http',
        url: 'http://127.0.0.1:4318/mcp',
        enabled: true,
      },
      {
        id: 'linear-stdio',
        name: 'Linear API-key MCP',
        transport: 'stdio',
        command: 'linear-mcp',
        args: ['--workspace', 'exampleorg'],
        env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' },
      },
    ],
  };
}

test('validates read-only MCP registration shape without exposing env values', () => {
  const config = validConfig();
  config.servers[0].env = { CONTEXT7_API_KEY: 'secret-value' };
  const validated = validateMcpConfig(config);
  const summary = summarizeMcpConfig(validated, './mcp.json');

  assert.deepEqual(validated.servers.map((server) => server.id), ['context7-local', 'linear-stdio']);
  assert.equal(summary.schema, 'exampleorg.review-yeti-mcp-v1');
  assert.equal(summary.server_count, 2);
  assert.deepEqual(summary.servers[0].env_keys, ['CONTEXT7_API_KEY']);
  assert.equal(JSON.stringify(summary).includes('secret-value'), false);
  assert.equal(summary.execution_policy, 'configuration validation only; no MCP tools are called');
});

test('fails closed on unsafe or ambiguous MCP registrations', () => {
  assert.throws(
    () => validateMcpConfig({ servers: [{ id: 'remote', name: 'remote', transport: 'http', url: 'http://10.0.0.4:8080/mcp' }] }),
    /https:\/\/ unless it targets localhost/,
  );
  assert.throws(
    () => validateMcpConfig({ servers: [{ id: 'duplicate', transport: 'adapter' }, { id: 'duplicate', transport: 'adapter' }] }),
    /duplicated/,
  );
  assert.throws(
    () => validateMcpConfig({ servers: [{ id: 'shell', transport: 'stdio', command: 'sh -c "touch /tmp/x"' }] }),
    /must be an executable/,
  );
  assert.throws(
    () => validateMcpConfig({ servers: [{ id: 'linear-oauth', name: 'Linear', transport: 'http', url: 'https://mcp.linear.app/sse' }] }),
    /rejected OAuth Linear endpoint/,
  );
  assert.throws(
    () => validateMcpConfig({ servers: [{ id: 'linear-http', name: 'Linear', transport: 'http', url: 'https://linear.example/mcp' }] }),
    /requires LINEAR_API_KEY/,
  );
  assert.throws(
    () => validateMcpConfig({ servers: Array.from({ length: 17 }, (_, index) => ({ id: `adapter-${index}`, transport: 'adapter' })) }),
    /at most 16 servers/,
  );
});

test('the launcher exposes MCP validation as a credential-safe JSON CLI command', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'ct-review-yeti-mcp-cli-test-'));
  const configPath = path.join(tempRoot, 'mcp.json');
  writeFileSync(configPath, JSON.stringify(validConfig()));
  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'review-yeti-local');

  try {
    const output = execFileSync(launcher, ['mcp', 'validate', '--config', configPath, '--json'], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.schema, 'exampleorg.review-yeti-mcp-v1');
    assert.equal(result.server_count, 2);
    assert.equal(result.execution_policy.includes('no MCP tools'), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
