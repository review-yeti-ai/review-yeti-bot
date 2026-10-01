/**
 * tunnelConfig.ts
 *
 * Automated multi-transport tooling and tunneling configuration for Review Yeti.
 * Implements Milestone 2 (R2): Features 17-21.
 * Supports:
 *  - Direct HTTPS (Default for public APIs: OpenRouter, OpenAI, Anthropic, GitHub)
 *  - Cloudflare Access / Tunnel (Zero-trust edge routing via cloudflared or CF Access service tokens)
 *  - Tailscale MagicDNS (*.ts.net)
 *  - Automated mode detection (mode: auto)
 */

import type {
  ToolDefinition,
  ToolTunnelConfig,
  ResolvedToolConnection,
  ToolTunnelMode,
  ToolType,
} from './toolTunnelDefinition.js';

export type {
  ToolDefinition,
  ToolTunnelConfig,
  ResolvedToolConnection,
  ToolTunnelMode,
  ToolType,
};

export type TunnelMode = 'auto' | 'cloudflare' | 'tailscale' | 'none';

export interface TunnelCredentials {
  mode: 'cloudflare' | 'tailscale' | 'none';
  // Cloudflare Tunnel & Access
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  cfTunnelToken?: string;
  // Tailscale
  tailscaleAuthKey?: string;
  tailscaleHostname?: string;
}

export interface EndpointTunnelResolution {
  serviceName: string;
  url: string;
  tunnelType: 'none' | 'cloudflare' | 'tailscale';
  headers: Record<string, string>;
  requiresDaemon: boolean;
}

export interface GlobalTunnelDefaultsFlat {
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  cfTunnelToken?: string;
  tailscaleAuthKey?: string;
  tailscaleHostname?: string;
  timeout_ms?: number;
  headers?: Record<string, string>;
}

export type GlobalTunnelDefaults =
  | Partial<ToolTunnelConfig>
  | GlobalTunnelDefaultsFlat
  | (Partial<ToolTunnelConfig> & GlobalTunnelDefaultsFlat);

const RFC1918_CLASS_B_REGEX = /^172\.(1[6-9]|2[0-9]|3[0-1])\./;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const VALID_MODES = new Set(['auto', 'direct', 'none', 'cloudflare', 'tailscale']);
const VALID_TOOL_TYPES = new Set(['mcp', 'http', 'sse', 'stdio', 'inference']);

/**
 * Strictly validates whether a hostname string is a valid IPv4 dotted-decimal address.
 * Validates that the input consists of exactly 4 octets, all numeric characters,
 * each with integer value between 0 and 255.
 */
export function isIPv4Address(host: string): boolean {
  if (!host || typeof host !== 'string') {
    return false;
  }
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const num = Number(part);
    if (num < 0 || num > 255) {
      return false;
    }
  }
  return true;
}

/**
 * Safely checks whether a URL points to a Tailscale MagicDNS host (*.ts.net or ts.net).
 * Defensively extracts the hostname using URL parsing to prevent substring,
 * path, and query parameter spoofing. Returns false for invalid or non-URL inputs.
 */
export function isTailscaleUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host.endsWith('.ts.net') || host === 'ts.net';
  } catch {
    return false;
  }
}

/**
 * Checks whether an HTTP header is already defined in a headers dictionary,
 * performing a case-insensitive lookup per RFC 7230 / RFC 9110.
 */
export function hasHeaderCaseInsensitive(
  headers: Record<string, string>,
  targetName: string
): boolean {
  const targetLower = targetName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetLower && headers[key] !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Detects whether a URL points to private/internal infrastructure.
 * Evaluates RFC1918 CIDRs, loopbacks (IPv4 & IPv6), internal cluster domains,
 * Tailscale MagicDNS, IPv6 Link-Local (fe80::/10), and IPv6 Unique Local Addresses (fc00::/7 & fd00::/8).
 * Defensive against invalid URLs: returns false without throwing.
 */
export function isInternalEndpoint(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const cleanHost = (host.startsWith('[') && host.endsWith(']'))
      ? host.slice(1, -1)
      : host;

    // 1. Localhost and Loopback (IPv4 & IPv6)
    if (
      host === 'localhost' ||
      cleanHost === '::1' ||
      host === '[::1]'
    ) {
      return true;
    }

    // 2. IPv6 Link-Local (fe80::/10, RFC 4291) & Unique Local Addresses (fc00::/7 & fd00::/8, RFC 4193)
    if (
      cleanHost.startsWith('fe80:') ||
      /^fe[89ab][0-9a-f]?:/i.test(cleanHost) ||
      cleanHost.startsWith('fc00:') ||
      cleanHost.startsWith('fd00:') ||
      /^f[cd][0-9a-f]{2}:/i.test(cleanHost)
    ) {
      return true;
    }

    // 3. Internal / Cluster / Corporate Domain Suffixes
    if (
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.svc.cluster.local') ||
      host.endsWith('.cluster.local') ||
      host.endsWith('.corp') ||
      host.endsWith('.lan') ||
      host.endsWith('.home') ||
      host.endsWith('.private')
    ) {
      return true;
    }

    // 4. Tailscale MagicDNS
    if (host.endsWith('.ts.net') || host === 'ts.net') {
      return true;
    }

    // Normalize bracketed IPv6 and IPv4-mapped IPv6 prefixes (e.g. [::ffff:10.0.0.1])
    let normalizedHost = host;
    if (normalizedHost.startsWith('[') && normalizedHost.endsWith(']')) {
      normalizedHost = normalizedHost.slice(1, -1);
    }
    if (normalizedHost.toLowerCase().startsWith('::ffff:')) {
      normalizedHost = normalizedHost.slice(7);
    }

    // 5. RFC 1918 Private IPv4 Ranges, Link-Local, and Loopback
    if (isIPv4Address(normalizedHost)) {
      // IPv4 Loopback: 127.0.0.0/8
      if (normalizedHost.startsWith('127.')) {
        return true;
      }
      // Class A: 10.0.0.0/8
      if (normalizedHost.startsWith('10.')) {
        return true;
      }
      // Class B: 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
      if (RFC1918_CLASS_B_REGEX.test(normalizedHost)) {
        return true;
      }
      // Class C: 192.168.0.0/16
      if (normalizedHost.startsWith('192.168.')) {
        return true;
      }
      // Link-Local: 169.254.0.0/16
      if (normalizedHost.startsWith('169.254.')) {
        return true;
      }
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Resolves the effective network connection parameters for a specific tool definition.
 * Implements declarative multi-transport resolution, Access token injection,
 * Tailscale daemon requirements, and automated endpoint detection.
 */
export function resolveToolConnection(
  tool: ToolDefinition,
  globalDefaults?: GlobalTunnelDefaults
): ResolvedToolConnection {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new Error('Invalid tool definition: expected object');
  }

  if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
    throw new Error('Invalid tool definition: missing or empty "name" property');
  }

  if (tool.type && !VALID_TOOL_TYPES.has(tool.type)) {
    throw new Error(
      `Invalid tool type "${tool.type}" for tool "${tool.name}". Supported types: mcp, http, sse, stdio, inference.`
    );
  }

  const url = tool.url ? tool.url.trim() : '';
  const isStdio = tool.type === 'stdio';

  // Protocol validation for network-based tools
  if (!isStdio) {
    if (!url) {
      throw new Error(`Missing required "url" for network tool "${tool.name}" of type "${tool.type}".`);
    }

    try {
      const parsedUrl = new URL(url);
      if (!SUPPORTED_PROTOCOLS.has(parsedUrl.protocol)) {
        throw new Error(
          `Unsupported protocol "${parsedUrl.protocol}" for tool "${tool.name}". Only http: and https: protocols are supported.`
        );
      }
    } catch (err: any) {
      if (err.message?.includes('Unsupported protocol')) {
        throw err;
      }
      throw new Error(`Invalid URL "${url}" for tool "${tool.name}".`);
    }
  }

  // Extract global defaults (handling both Partial<ToolTunnelConfig> and flat structure)
  const flatDefaults = (globalDefaults || {}) as GlobalTunnelDefaultsFlat;
  const structuredDefaults = (globalDefaults || {}) as Partial<ToolTunnelConfig>;

  const defaultMode = structuredDefaults.mode || 'auto';
  const toolTunnel = tool.tunnel;
  const effectiveMode = (toolTunnel?.mode || (tool as any).transport || defaultMode) as ToolTunnelMode;

  if (!VALID_MODES.has(effectiveMode)) {
    throw new Error(
      `Unsupported tunnel mode "${effectiveMode}" for tool "${tool.name}". Supported modes: auto, direct, none, cloudflare, tailscale.`
    );
  }

  // Timeout resolution & validation
  const timeoutMs =
    toolTunnel?.timeout_ms ??
    structuredDefaults.timeout_ms ??
    flatDefaults.timeout_ms ??
    30_000;

  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid timeout_ms "${timeoutMs}" for tool "${tool.name}". Timeout must be a positive integer.`
    );
  }

  // Header merging: global headers first, tool-level headers take precedence
  const headers: Record<string, string> = {
    ...(flatDefaults.headers || {}),
    ...(structuredDefaults.headers || {}),
    ...(toolTunnel?.headers || {}),
  };

  // Stdio tools execute locally
  if (isStdio) {
    return {
      name: tool.name,
      url,
      tunnelMode: 'direct',
      headers,
      timeoutMs,
      requiresTunnelDaemon: false,
    };
  }

  // Explicit 'none' or 'direct'
  if (effectiveMode === 'none' || effectiveMode === 'direct') {
    return {
      name: tool.name,
      url,
      tunnelMode: 'direct',
      headers,
      timeoutMs,
      requiresTunnelDaemon: false,
    };
  }

  // Tailscale resolution
  const isTailnet = isTailscaleUrl(url);
  const tailscaleAuthKey =
    toolTunnel?.tailscale?.auth_key ||
    structuredDefaults.tailscale?.auth_key ||
    flatDefaults.tailscaleAuthKey ||
    process.env.TAILSCALE_AUTH_KEY;

  if (effectiveMode === 'tailscale' || (effectiveMode === 'auto' && isTailnet)) {
    return {
      name: tool.name,
      url,
      tunnelMode: 'tailscale',
      headers,
      timeoutMs,
      requiresTunnelDaemon: Boolean(tailscaleAuthKey),
    };
  }

  // Cloudflare Access / Tunnel resolution
  const cfClientId =
    toolTunnel?.cloudflare?.access_client_id ||
    structuredDefaults.cloudflare?.access_client_id ||
    flatDefaults.cfAccessClientId ||
    process.env.CF_ACCESS_CLIENT_ID;

  const cfClientSecret =
    toolTunnel?.cloudflare?.access_client_secret ||
    structuredDefaults.cloudflare?.access_client_secret ||
    flatDefaults.cfAccessClientSecret ||
    process.env.CF_ACCESS_CLIENT_SECRET;

  const cfTunnelToken =
    toolTunnel?.cloudflare?.tunnel_token ||
    structuredDefaults.cloudflare?.tunnel_token ||
    flatDefaults.cfTunnelToken ||
    process.env.CLOUDFLARE_TUNNEL_TOKEN;

  const isPrivate = isInternalEndpoint(url);
  const hasToolCf = Boolean(toolTunnel?.cloudflare);

  // Cloudflare mode is resolved when either explicitly requested or auto-detected on private/tool CF
  const resolvesToCloudflare =
    effectiveMode === 'cloudflare' ||
    (effectiveMode === 'auto' && (hasToolCf || isPrivate));

  // Credential completeness validation for Cloudflare mode (Finding 5)
  if (resolvesToCloudflare) {
    if ((cfClientId && !cfClientSecret) || (!cfClientId && cfClientSecret)) {
      throw new Error(
        `Incomplete Cloudflare Access credentials for tool "${tool.name}": both access_client_id and access_client_secret must be provided.`
      );
    }
  }

  // In auto mode:
  // - If tool has explicit cloudflare config or endpoint is private: select cloudflare.
  // - Public endpoints without tool-level CF credentials bypass tunneling and resolve to direct HTTPS.
  if (resolvesToCloudflare) {
    // Finding 3: Header preservation without clobbering user explicit headers
    if (cfClientId && cfClientSecret) {
      if (!hasHeaderCaseInsensitive(headers, 'CF-Access-Client-Id')) {
        headers['CF-Access-Client-Id'] = cfClientId;
      }
      if (!hasHeaderCaseInsensitive(headers, 'CF-Access-Client-Secret')) {
        headers['CF-Access-Client-Secret'] = cfClientSecret;
      }
    }

    return {
      name: tool.name,
      url,
      tunnelMode: 'cloudflare',
      headers,
      timeoutMs,
      requiresTunnelDaemon: Boolean(cfTunnelToken),
    };
  }

  // Default: Direct HTTPS for standard public internet APIs
  return {
    name: tool.name,
    url,
    tunnelMode: 'direct',
    headers,
    timeoutMs,
    requiresTunnelDaemon: false,
  };
}

/**
 * Legacy endpoint tunnel resolver maintained for backward compatibility.
 */
export function resolveEndpointTunnel(
  serviceName: string,
  targetUrl: string,
  credentials?: TunnelCredentials,
  configuredMode: TunnelMode = 'auto'
): EndpointTunnelResolution {
  const headers: Record<string, string> = {};
  const creds = credentials || { mode: 'none' };

  if (!targetUrl || configuredMode === 'none') {
    return { serviceName, url: targetUrl, tunnelType: 'none', headers, requiresDaemon: false };
  }

  const isTailnetUrl = isTailscaleUrl(targetUrl);
  const isPrivate = isInternalEndpoint(targetUrl);

  // Tailscale
  if (configuredMode === 'tailscale' || (configuredMode === 'auto' && isTailnetUrl)) {
    if (creds.tailscaleAuthKey) {
      return {
        serviceName,
        url: targetUrl,
        tunnelType: 'tailscale',
        headers,
        requiresDaemon: true,
      };
    }
    if (configuredMode === 'tailscale') {
      return {
        serviceName,
        url: targetUrl,
        tunnelType: 'none',
        headers,
        requiresDaemon: false,
      };
    }
  }

  // Cloudflare
  if (
    configuredMode === 'cloudflare' ||
    (configuredMode === 'auto' && (creds.cfAccessClientId || creds.cfTunnelToken))
  ) {
    if (creds.cfAccessClientId && creds.cfAccessClientSecret) {
      headers['CF-Access-Client-Id'] = creds.cfAccessClientId;
      headers['CF-Access-Client-Secret'] = creds.cfAccessClientSecret;
    }

    return {
      serviceName,
      url: targetUrl,
      tunnelType: 'cloudflare',
      headers,
      requiresDaemon: Boolean(creds.cfTunnelToken && isPrivate),
    };
  }

  // Direct HTTPS
  return {
    serviceName,
    url: targetUrl,
    tunnelType: 'none',
    headers,
    requiresDaemon: false,
  };
}
