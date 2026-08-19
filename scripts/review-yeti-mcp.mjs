import { readFileSync } from 'node:fs';
import net from 'node:net';

const MAX_SERVERS = 16;
const MAX_CONFIG_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const OAUTH_ENV_KEYS = new Set([
  'LINEAR_CLIENT_ID',
  'LINEAR_CLIENT_SECRET',
  'LINEAR_OAUTH_CLIENT_ID',
  'LINEAR_OAUTH_CLIENT_SECRET',
  'LINEAR_REDIRECT_URI',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
]);
const OAUTH_URL_MARKERS = ['mcp.linear.app', 'linear.app/oauth', 'api.linear.app/oauth', 'linear.app/authorize'];

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function localHost(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '::1' || net.isIPv4(normalized) && normalized.startsWith('127.');
}

function validateUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`${label} must use https:// or http://`);
  if (parsed.protocol === 'http:' && !localHost(parsed.hostname)) {
    throw new Error(`${label} must use https:// unless it targets localhost`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain URL credentials`);
  return parsed;
}

function validateLinearPolicy(server) {
  const blob = [
    server.id,
    server.name,
    server.transport,
    server.url,
    server.command,
    ...(server.args || []),
    ...Object.keys(server.env || {}),
  ].filter(Boolean).join(' ').toLowerCase();
  if (!blob.includes('linear')) return;

  const url = String(server.url || '').toLowerCase();
  if (OAUTH_URL_MARKERS.some((marker) => url.includes(marker))) {
    throw new Error(`MCP server ${server.id} uses a rejected OAuth Linear endpoint`);
  }
  if (Object.keys(server.env || {}).some((key) => OAUTH_ENV_KEYS.has(key.toUpperCase()))) {
    throw new Error(`MCP server ${server.id} uses rejected Linear OAuth environment keys`);
  }
  const args = (server.args || []).join(' ').toLowerCase();
  if (args.includes('mcp-remote') && args.includes('linear')) {
    throw new Error(`MCP server ${server.id} uses rejected remote Linear OAuth tooling`);
  }
  if (server.transport === 'http' && url.includes('linear') && !server.env?.LINEAR_API_KEY && !server.env?.linear_api_key) {
    throw new Error(`MCP server ${server.id} requires LINEAR_API_KEY for HTTP Linear access`);
  }
}

function normalizeServer(raw, index) {
  const server = asObject(raw, `servers[${index}]`);
  const id = String(server.id || '').trim();
  if (!ID_PATTERN.test(id)) throw new Error(`servers[${index}].id must be 1-100 safe characters`);
  const name = String(server.name || id).trim();
  if (!name || name.length > 200) throw new Error(`servers[${index}].name must be 1-200 characters`);
  const transport = String(server.transport || '').trim().toLowerCase();
  if (!['http', 'stdio', 'adapter'].includes(transport)) throw new Error(`servers[${index}].transport must be http, stdio, or adapter`);
  if (server.enabled !== undefined && typeof server.enabled !== 'boolean') throw new Error(`servers[${index}].enabled must be boolean`);

  const normalized = {
    ...server,
    id,
    name,
    transport,
    enabled: server.enabled !== false,
  };

  if (transport === 'http') {
    if (!server.url) throw new Error(`servers[${index}].url is required for http transport`);
    validateUrl(String(server.url), `servers[${index}].url`);
  }
  if (transport === 'stdio') {
    const command = String(server.command || '').trim();
    if (!command) throw new Error(`servers[${index}].command is required for stdio transport`);
    if (/[\s`;$|&<>\r\n]/u.test(command)) throw new Error(`servers[${index}].command must be an executable, not a shell expression`);
    normalized.command = command;
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) {
      throw new Error(`servers[${index}].args must be an array of strings`);
    }
  }
  if (server.env !== undefined) {
    const env = asObject(server.env, `servers[${index}].env`);
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY_PATTERN.test(key)) throw new Error(`servers[${index}].env key ${key} is invalid`);
      if (typeof value !== 'string') throw new Error(`servers[${index}].env.${key} must be a string`);
    }
  }

  validateLinearPolicy(normalized);
  return normalized;
}

export function validateMcpConfig(value) {
  const parsed = Array.isArray(value) ? { servers: value } : asObject(value, 'MCP config');
  const servers = parsed.servers;
  if (!Array.isArray(servers)) throw new Error('MCP config must contain a servers array');
  if (servers.length > MAX_SERVERS) throw new Error(`MCP config supports at most ${MAX_SERVERS} servers`);
  const seen = new Set();
  const normalized = servers.map((server, index) => {
    const result = normalizeServer(server, index);
    if (seen.has(result.id)) throw new Error(`MCP server id ${result.id} is duplicated`);
    seen.add(result.id);
    return result;
  });
  return { ...parsed, servers: normalized };
}

export function loadMcpConfig(configPath) {
  if (!configPath) throw new Error('MCP config path is required');
  let parsed;
  try {
    const raw = readFileSync(configPath);
    if (raw.byteLength > MAX_CONFIG_BYTES) throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`could not read MCP config ${configPath}: ${error.message}`);
  }
  return validateMcpConfig(parsed);
}

export function summarizeMcpConfig(config, source = undefined) {
  const validated = validateMcpConfig(config);
  return {
    schema: 'exampleorg.review-yeti-mcp-v1',
    source,
    server_count: validated.servers.length,
    servers: validated.servers.map((server) => ({
      id: server.id,
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      url_present: Boolean(server.url),
      command_present: Boolean(server.command),
      env_keys: Object.keys(server.env || {}).sort(),
    })),
    network_policy: 'https-only except localhost HTTP',
    execution_policy: 'configuration validation only; no MCP tools are called',
  };
}
