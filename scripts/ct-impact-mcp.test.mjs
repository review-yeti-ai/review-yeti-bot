import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { loadMesh, analyzeImpact, analyzeDiffFiles, formatImpactMarkdown } from './ct-impact.mjs';
import { runServer } from './ct-impact-mcp.mjs';

test('loadMesh loads and decompresses the AST mesh from knowledge/mesh/cross-repo-mesh.json.gz', () => {
  const mesh = loadMesh();
  assert.ok(mesh);
  assert.ok(Array.isArray(mesh.mesh));
  assert.ok(mesh.mesh.length > 100);
  assert.ok(mesh.stats);
  assert.ok(mesh.stats.total_routes > 0);
});

test('analyzeImpact finds backend routes, ADRs, and verification commands for a known route', () => {
  const impact = analyzeImpact('/api/org/:org_id/cube-event-logs/');
  assert.ok(impact);
  assert.equal(impact.matched_kind, 'http_route');
  assert.ok(impact.backend_routes.length > 0);
  assert.equal(impact.backend_routes[0].controller, 'API.CubeEventLogsController');
  assert.ok(impact.governing_adrs.some((a) => a.number === '0066'));
  assert.ok(impact.verification_commands.some((cmd) => cmd.includes('cube_event_logs_controller_test.exs')));
});

test('analyzeDiffFiles evaluates an array of PR changed files in a single pass', () => {
  const diffFiles = [
    { path: 'lib/cdrcisco_web/controllers/api/cube_event_logs_controller.ex', patch: '@@ -1,5 +1,5 @@' },
    { path: 'src/components/cube/CubeEventLogs.vue', patch: '@@ -1,5 +1,5 @@' },
  ];
  const impact = analyzeDiffFiles(diffFiles);
  assert.ok(impact);
  assert.equal(impact.files_count, 2);
  assert.ok(impact.backend_routes.length > 0);
  assert.ok(impact.governing_adrs.length > 0);

  const md = formatImpactMarkdown(impact);
  assert.ok(md.includes('Cross-Repository Blast Radius & Downstream Consumers'));
  assert.ok(md.includes('API.CubeEventLogsController'));
});

test('runServer processes stdio JSON-RPC MCP requests (initialize, tools/list, tools/call)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const serverPromise = runServer(input, output);

  let outputBuffer = '';
  output.on('data', (chunk) => {
    outputBuffer += chunk.toString('utf8');
  });

  // 1. Initialize
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  // 2. Tools list
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  // 3. Tools call ct_mesh_stats
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ct_mesh_stats' } }) + '\n');
  // 4. Tools call ct_impact
  input.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'ct_impact', arguments: { target: '/api/org/:org_id/cube-event-logs/' } },
  }) + '\n');

  input.end();
  await serverPromise;

  const responses = outputBuffer.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 4);

  // Assert initialize response
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 'ct-impact');

  // Assert tools/list response
  assert.equal(responses[1].id, 2);
  const toolNames = responses[1].result.tools.map((t) => t.name);
  assert.ok(toolNames.includes('ct_impact'));
  assert.ok(toolNames.includes('ct_mesh_query'));
  assert.ok(toolNames.includes('ct_mesh_stats'));

  // Assert tools/call ct_mesh_stats
  assert.equal(responses[2].id, 3);
  assert.equal(responses[2].result.isError, false);
  const stats = JSON.parse(responses[2].result.content[0].text);
  assert.ok(stats.stats.total_routes > 0);

  // Assert tools/call ct_impact
  assert.equal(responses[3].id, 4);
  assert.equal(responses[3].result.isError, false);
  const impactData = JSON.parse(responses[3].result.content[0].text);
  assert.equal(impactData.matched_kind, 'http_route');
});

test('runServer processes ct_mesh_query tools/call with matching and empty queries', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const serverPromise = runServer(input, output);

  let outputBuffer = '';
  output.on('data', (chunk) => {
    outputBuffer += chunk.toString('utf8');
  });

  // 1. Query with keyword
  input.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'ct_mesh_query', arguments: { query: 'cube-event-logs', kind: 'http_route' } },
  }) + '\n');

  // 2. Query with empty string
  input.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'ct_mesh_query', arguments: { query: '' } },
  }) + '\n');

  input.end();
  await serverPromise;

  const responses = outputBuffer.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);

  // Assert successful query
  assert.equal(responses[0].id, 10);
  assert.equal(responses[0].result.isError, false);
  const queryResult = JSON.parse(responses[0].result.content[0].text);
  assert.ok(queryResult.total_matches > 0);
  assert.equal(queryResult.kind, 'http_route');

  // Assert empty query returns error
  assert.equal(responses[1].id, 11);
  assert.equal(responses[1].result.isError, true);
  assert.match(responses[1].result.content[0].text, /Query parameter is required/);
});

test('runServer handles JSON-RPC error paths (-32601, -32602, and invalid tool arguments)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const serverPromise = runServer(input, output);

  let outputBuffer = '';
  output.on('data', (chunk) => {
    outputBuffer += chunk.toString('utf8');
  });

  // 1. Method not found (-32601)
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'non_existent_method' }) + '\n');
  // 2. Unknown tool name (-32602)
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'unknown_tool' } }) + '\n');
  // 3. Missing target/files in ct_impact
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'ct_impact', arguments: {} } }) + '\n');

  input.end();
  await serverPromise;

  const responses = outputBuffer.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);

  assert.equal(responses[0].id, 20);
  assert.equal(responses[0].error.code, -32601);

  assert.equal(responses[1].id, 21);
  assert.equal(responses[1].error.code, -32602);

  assert.equal(responses[2].id, 22);
  assert.equal(responses[2].result.isError, true);
  assert.ok(responses[2].result.content[0].text.includes('Either'));
});

test('analyzeImpact finds NATS topics and verification commands for a known NATS target', () => {
  const impact = analyzeImpact('jtapi.cti_port');
  assert.ok(impact);
  assert.ok(impact.nats_topics.length > 0);
  assert.ok(impact.verification_commands.length > 0);
  assert.ok(impact.verification_commands.some((cmd) => cmd.includes('test')));
});

test('validateMcpServers accepts valid trusted configurations and rejects unsafe ones', async () => {
  const { validateMcpServers } = await import('./emit-policy.mjs');
  
  // Valid config
  const valid = validateMcpServers([
    {
      id: 'ct-impact',
      name: 'exampleorg AST Code Mesh',
      transport: 'stdio',
      command: 'node',
      args: ['.exampleorg-review-actions/scripts/ct-impact-mcp.mjs'],
      enabled: true,
    },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].id, 'ct-impact');

  // Disallowed command
  const unsafeCommand = validateMcpServers([
    {
      id: 'evil',
      transport: 'stdio',
      command: 'bash',
      args: ['-c', 'id'],
    },
  ]);
  assert.equal(unsafeCommand.length, 0);

  // Untrusted script path or traversal
  const unsafePath = validateMcpServers([
    {
      id: 'traversal',
      transport: 'stdio',
      command: 'node',
      args: ['.exampleorg-review-actions/scripts/../../etc/passwd'],
    },
  ]);
  assert.equal(unsafePath.length, 0);
});
