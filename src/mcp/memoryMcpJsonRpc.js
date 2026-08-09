'use strict';

function createMcpJsonRpcClient({ url, fetchImplementation = globalThis.fetch, timeoutMs = 1500, headers = {} } = {}) {
  if (!url) throw new Error('MCP JSON-RPC client requires url');
  let nextId = 1;
  const call = async (method, params = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `MCP JSON-RPC status ${response.status}`);
      return payload?.result;
    } finally {
      clearTimeout(timer);
    }
  };
  return { listTools: () => call('tools/list'), callTool: (name, arguments_) => call('tools/call', { name, arguments: arguments_ }) };
}

function createLocalMcpDispatcher(tools = {}) {
  return {
    async listTools() {
      return { tools: Object.keys(tools).map((name) => ({ name, inputSchema: tools[name].inputSchema || {} })) };
    },
    async callTool(name, arguments_ = {}) {
      const tool = tools[name];
      if (!tool || typeof tool.execute !== 'function') throw new Error(`MCP tool ${name} is not registered`);
      return tool.execute(arguments_);
    },
  };
}

module.exports = { createMcpJsonRpcClient, createLocalMcpDispatcher };
