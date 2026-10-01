import YAML from 'yaml';
import {
  resolveToolConnection as internalResolveToolConnection,
  type GlobalTunnelDefaults,
  type GlobalTunnelDefaultsFlat,
} from './tunnelConfig.js';

export type ToolTunnelMode = 'auto' | 'cloudflare' | 'tailscale' | 'none' | 'direct';
export type ToolType = 'mcp' | 'http' | 'sse' | 'stdio' | 'inference';

export interface CloudflareTunnelToolConfig {
  access_client_id?: string;
  access_client_secret?: string;
  tunnel_token?: string;
  tunnel_hostname?: string;
}

export interface TailscaleTunnelToolConfig {
  auth_key?: string;
  hostname?: string;
  accept_routes?: boolean;
}

export interface ToolTunnelConfig {
  mode: ToolTunnelMode;
  cloudflare?: CloudflareTunnelToolConfig;
  tailscale?: TailscaleTunnelToolConfig;
  timeout_ms?: number;
  headers?: Record<string, string>;
}

export interface ToolDefinition {
  name: string;
  type: ToolType;
  url?: string;
  enabled?: boolean;
  tunnel?: ToolTunnelConfig;
  options?: Record<string, any>;
}

export interface ToolingConfigFile {
  version?: number | string;
  tools: ToolDefinition[];
}

export interface ResolvedToolConnection {
  name: string;
  url: string;
  tunnelMode: 'direct' | 'cloudflare' | 'tailscale';
  headers: Record<string, string>;
  timeoutMs: number;
  requiresTunnelDaemon: boolean;
}

export type { GlobalTunnelDefaults, GlobalTunnelDefaultsFlat };

export interface InterpolationOptions {
  strictEnv?: boolean;
  onMissingEnv?: 'empty' | 'preserve' | 'throw' | ((varName: string) => string);
  maxInterpolationDepth?: number;
}

export interface ParseToolingConfigOptions extends InterpolationOptions {
  validateSchema?: boolean;
}

const VALID_TOOL_TYPES = new Set<ToolType>(['mcp', 'http', 'sse', 'stdio', 'inference']);
const VALID_TUNNEL_MODES = new Set<ToolTunnelMode>(['auto', 'cloudflare', 'tailscale', 'none', 'direct']);

/**
 * Expands environment variables matching ${VAR_NAME}, ${VAR_NAME:-default}, ${VAR_NAME:default}, or $VAR_NAME
 * Supports escaping: \${VAR} -> ${VAR}, $$VAR -> $VAR
 * Supports recursive expansion up to maxInterpolationDepth
 */
export function interpolateEnvVars(
  val: string,
  env: Record<string, string | undefined>,
  options: InterpolationOptions = {}
): string {
  if (typeof val !== 'string' || !val) {
    return val;
  }

  const maxDepth = options.maxInterpolationDepth ?? 5;
  const onMissing = options.strictEnv ? 'throw' : (options.onMissingEnv ?? 'empty');

  let current = val;
  let depth = 0;

  // Protect escaped sequences: \${...} and $$...
  const ESCAPED_BRACED = '\u0001ESCAPED_BRACED\u0001';
  const ESCAPED_UNBRACED = '\u0001ESCAPED_UNBRACED\u0001';

  current = current.replace(/\\\$\{([a-zA-Z0-9_]+(?::[^}]*)?)\}/g, `${ESCAPED_BRACED}$1}`);
  current = current.replace(/\$\$([a-zA-Z0-9_]+)/g, `${ESCAPED_UNBRACED}$1`);

  while (depth < maxDepth) {
    let replaced = false;

    // 1. Match braced ${VAR_NAME} or ${VAR_NAME:-default} or ${VAR_NAME:default}
    const nextBraced = current.replace(
      /\$\{([a-zA-Z0-9_]+)(?::-([^}]*)|:([^}]*))?\}/g,
      (match, varName, fallbackDash, fallbackColon) => {
        replaced = true;
        const fallback = fallbackDash !== undefined ? fallbackDash : fallbackColon;
        const envVal = env[varName];

        if (fallback !== undefined) {
          return envVal !== undefined && envVal !== '' ? envVal : fallback;
        }
        if (envVal !== undefined) {
          return envVal;
        }
        if (typeof onMissing === 'function') {
          return onMissing(varName);
        }
        if (onMissing === 'throw') {
          throw new Error(`Missing required environment variable: ${varName}`);
        }
        if (onMissing === 'preserve') {
          return match;
        }
        return '';
      }
    );

    // 2. Match unbraced $VAR_NAME
    const nextUnbraced = nextBraced.replace(
      /(?<!\$)\$([a-zA-Z0-9_]+)\b/g,
      (match, varName) => {
        replaced = true;
        const envVal = env[varName];
        if (envVal !== undefined) {
          return envVal;
        }
        if (typeof onMissing === 'function') {
          return onMissing(varName);
        }
        if (onMissing === 'throw') {
          throw new Error(`Missing required environment variable: ${varName}`);
        }
        if (onMissing === 'preserve') {
          return match;
        }
        return '';
      }
    );

    current = nextUnbraced;
    depth++;

    if (!replaced || (!current.includes('$') && !current.includes('${'))) {
      break;
    }
  }

  // Restore escaped sequences
  current = current.replace(new RegExp(ESCAPED_BRACED, 'g'), '${');
  current = current.replace(new RegExp(ESCAPED_UNBRACED, 'g'), '$');

  return current;
}

/**
 * Deep recursive interpolation across objects, arrays, and primitive fields
 */
export function interpolateObject<T>(
  obj: T,
  env: Record<string, string | undefined>,
  options: InterpolationOptions = {},
  visited = new WeakSet<object>()
): T {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj, env, options) as unknown as T;
  }
  if (Array.isArray(obj)) {
    if (visited.has(obj)) {
      return obj;
    }
    visited.add(obj);
    return obj.map((item) => interpolateObject(item, env, options, visited)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    if (visited.has(obj)) {
      return obj;
    }
    visited.add(obj);

    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      const interpolatedKey = k.includes('$') ? interpolateEnvVars(k, env, options) : k;
      res[interpolatedKey] = interpolateObject(v, env, options, visited);
    }
    return res as unknown as T;
  }
  return obj;
}

/**
 * Validates the parsed tooling config structure against schema rules
 */
export function validateToolingConfig(config: unknown): asserts config is ToolingConfigFile {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid tooling YAML: expected root object');
  }

  const obj = config as Record<string, any>;

  if (!Array.isArray(obj.tools)) {
    throw new Error("Invalid tooling YAML: missing or invalid 'tools' array");
  }

  const seenNames = new Set<string>();

  for (let i = 0; i < obj.tools.length; i++) {
    const tool = obj.tools[i];
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw new Error(`Invalid tool definition at index ${i}: expected tool object`);
    }

    if (typeof tool.name !== 'string' || tool.name.trim() === '') {
      throw new Error(`Invalid tool definition at index ${i}: missing or empty 'name'`);
    }

    if (seenNames.has(tool.name)) {
      throw new Error(`Invalid tooling YAML: duplicate tool name '${tool.name}' at index ${i}`);
    }
    seenNames.add(tool.name);

    if (typeof tool.type !== 'string' || !VALID_TOOL_TYPES.has(tool.type as ToolType)) {
      throw new Error(
        `Invalid tool definition '${tool.name}': invalid type '${tool.type}'. Expected one of: mcp, http, sse, stdio, inference`
      );
    }

    if (tool.url !== undefined && typeof tool.url !== 'string') {
      throw new Error(`Invalid tool definition '${tool.name}': 'url' must be a string`);
    }

    if (tool.enabled !== undefined && typeof tool.enabled !== 'boolean') {
      throw new Error(`Invalid tool definition '${tool.name}': 'enabled' must be a boolean`);
    }

    if (tool.tunnel !== undefined) {
      if (!tool.tunnel || typeof tool.tunnel !== 'object' || Array.isArray(tool.tunnel)) {
        throw new Error(`Invalid tool definition '${tool.name}': 'tunnel' must be an object`);
      }

      if (tool.tunnel.mode !== undefined && !VALID_TUNNEL_MODES.has(tool.tunnel.mode as ToolTunnelMode)) {
        throw new Error(
          `Invalid tunnel mode '${tool.tunnel.mode}' for tool '${tool.name}'. Expected: auto, cloudflare, tailscale, none, direct`
        );
      }

      if (tool.tunnel.timeout_ms !== undefined) {
        if (
          typeof tool.tunnel.timeout_ms !== 'number' ||
          isNaN(tool.tunnel.timeout_ms) ||
          tool.tunnel.timeout_ms < 0
        ) {
          throw new Error(
            `Invalid timeout_ms '${tool.tunnel.timeout_ms}' for tool '${tool.name}': must be a non-negative number`
          );
        }
      }

      if (tool.tunnel.headers !== undefined) {
        if (!tool.tunnel.headers || typeof tool.tunnel.headers !== 'object' || Array.isArray(tool.tunnel.headers)) {
          throw new Error(`Invalid headers for tool '${tool.name}': must be an object map`);
        }
        for (const [hk, hv] of Object.entries(tool.tunnel.headers)) {
          if (typeof hv !== 'string') {
            throw new Error(`Invalid header value for '${hk}' in tool '${tool.name}': expected string, got ${typeof hv}`);
          }
        }
      }

      if (tool.tunnel.cloudflare !== undefined) {
        if (!tool.tunnel.cloudflare || typeof tool.tunnel.cloudflare !== 'object' || Array.isArray(tool.tunnel.cloudflare)) {
          throw new Error(`Invalid cloudflare config for tool '${tool.name}': must be an object`);
        }
      }

      if (tool.tunnel.tailscale !== undefined) {
        if (!tool.tunnel.tailscale || typeof tool.tunnel.tailscale !== 'object' || Array.isArray(tool.tunnel.tailscale)) {
          throw new Error(`Invalid tailscale config for tool '${tool.name}': must be an object`);
        }
      }
    }
  }
}

/**
 * Parses and validates a YAML tooling config string with environment variable expansion
 */
export function parseToolingConfigYaml(
  yamlContent: string,
  env: Record<string, string | undefined> = process.env,
  options: ParseToolingConfigOptions = {}
): ToolingConfigFile {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (err: any) {
    throw new Error(`Invalid tooling YAML syntax: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid tooling YAML: expected root object');
  }

  // Pre-validate tools property exists before interpolation to ensure exact error messages
  const rawObj = parsed as Record<string, any>;
  if (!Array.isArray(rawObj.tools)) {
    throw new Error("Invalid tooling YAML: missing or invalid 'tools' array");
  }

  const interpolated = interpolateObject(parsed, env, options);

  if (options.validateSchema !== false) {
    validateToolingConfig(interpolated);
  }

  return interpolated as ToolingConfigFile;
}

/**
 * Scans a YAML string or config object and extracts all referenced environment variable names
 */
export function extractReferencedEnvVars(input: string | unknown): string[] {
  const vars = new Set<string>();

  const scanString = (str: string) => {
    // Remove escaped tokens so they are not treated as referenced env vars
    const cleaned = str
      .replace(/\\\$\{([a-zA-Z0-9_]+(?::[^}]*)?)\}/g, '')
      .replace(/\$\$([a-zA-Z0-9_]+)/g, '');
    const bracedMatches = Array.from(cleaned.matchAll(/\$\{([a-zA-Z0-9_]+)(?::-([^}]*)|:([^}]*))?\}/g));
    for (const match of bracedMatches) {
      vars.add(match[1]);
    }
    const unbracedMatches = Array.from(cleaned.matchAll(/(?<!\$)\$([a-zA-Z0-9_]+)\b/g));
    for (const match of unbracedMatches) {
      vars.add(match[1]);
    }
  };

  const scanRecursive = (node: unknown, visited = new WeakSet<object>()) => {
    if (typeof node === 'string') {
      scanString(node);
    } else if (Array.isArray(node)) {
      if (visited.has(node)) return;
      visited.add(node);
      for (const item of node) scanRecursive(item, visited);
    } else if (node !== null && typeof node === 'object') {
      if (visited.has(node)) return;
      visited.add(node);
      for (const val of Object.values(node)) {
        scanRecursive(val, visited);
      }
    }
  };

  if (typeof input === 'string') {
    scanString(input);
  } else {
    scanRecursive(input);
  }

  return Array.from(vars).sort();
}

/**
 * Re-exported connection builder referencing canonical implementation in tunnelConfig.ts
 */
export const resolveToolConnection = internalResolveToolConnection;
