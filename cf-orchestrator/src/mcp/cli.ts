#!/usr/bin/env node
/**
 * Review Yeti MCP Server Stdio Transport
 * Enables direct invocation by Antigravity, Claude Code, or any stdio-compatible MCP client.
 */

import readline from 'node:readline';
import { defaultMcpRouter } from './mcpRouter.js';
import type { JsonRpcRequest } from './types.js';

export async function runStdioServer(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch (err: any) {
      const errResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      };
      process.stdout.write(JSON.stringify(errResponse) + '\n');
      continue;
    }

    try {
      const res = await defaultMcpRouter.handleRpc(req, {});
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err: any) {
      const fatalRes = {
        jsonrpc: '2.0',
        id: req?.id ?? null,
        error: { code: -32603, message: `Internal error: ${err.message}` },
      };
      process.stdout.write(JSON.stringify(fatalRes) + '\n');
    }
  }
}

// Auto-run if executed directly as script
if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  runStdioServer().catch((err) => {
    console.error('Fatal MCP stdio runner error:', err);
    process.exit(1);
  });
}
