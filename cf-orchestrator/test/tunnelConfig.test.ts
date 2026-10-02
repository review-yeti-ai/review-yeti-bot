import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInternalEndpoint,
  isIPv4Address,
  isTailscaleUrl,
  hasHeaderCaseInsensitive,
  resolveEndpointTunnel,
  resolveToolConnection,
  type ToolDefinition,
  type TunnelCredentials,
} from '../src/tunnel/tunnelConfig.js';

describe('Multi-Transport Tooling & Tunneling Resolution (Milestone 2)', () => {
  // =========================================================================
  // 1. isInternalEndpoint Heuristics & CIDR Boundaries
  // =========================================================================
  describe('isInternalEndpoint Heuristics & CIDR Boundaries', () => {
    it('detects IPv4 and IPv6 loopback addresses', () => {
      assert.equal(isInternalEndpoint('http://localhost:3000'), true);
      assert.equal(isInternalEndpoint('http://localhost'), true);
      assert.equal(isInternalEndpoint('http://127.0.0.1:8080'), true);
      assert.equal(isInternalEndpoint('http://127.0.10.20:8000'), true);
      assert.equal(isInternalEndpoint('http://[::1]:9000'), true);
      assert.equal(isInternalEndpoint('http://[::1]'), true);
    });

    it('detects RFC1918 Class A (10.0.0.0/8)', () => {
      assert.equal(isInternalEndpoint('http://10.0.0.1:8000'), true);
      assert.equal(isInternalEndpoint('http://10.244.5.12:9090'), true);
      assert.equal(isInternalEndpoint('http://10.255.255.255:80'), true);
    });

    it('detects RFC1918 Class B (172.16.0.0/12: 172.16 to 172.31)', () => {
      assert.equal(isInternalEndpoint('http://172.15.255.255:8000'), false);
      assert.equal(isInternalEndpoint('http://172.16.0.1:8080'), true);
      assert.equal(isInternalEndpoint('http://172.17.0.2:8080'), true); // Docker default bridge
      assert.equal(isInternalEndpoint('http://172.24.10.5:8080'), true);
      assert.equal(isInternalEndpoint('http://172.31.255.254:8080'), true);
      assert.equal(isInternalEndpoint('http://172.32.0.1:8080'), false);
    });

    it('detects RFC1918 Class C (192.168.0.0/16)', () => {
      assert.equal(isInternalEndpoint('http://192.168.1.1:8000'), true);
      assert.equal(isInternalEndpoint('http://192.168.100.50:8000'), true);
      assert.equal(isInternalEndpoint('http://192.169.1.1:8000'), false);
    });

    it('detects Link-Local addresses (169.254.0.0/16)', () => {
      assert.equal(isInternalEndpoint('http://169.254.169.254/latest/meta-data'), true);
      assert.equal(isInternalEndpoint('http://169.254.1.1:8080'), true);
    });

    it('detects internal cluster, enterprise and tailnet domain suffixes', () => {
      assert.equal(isInternalEndpoint('http://service.svc.cluster.local'), true);
      assert.equal(isInternalEndpoint('http://service.cluster.local'), true);
      assert.equal(isInternalEndpoint('http://node.local'), true);
      assert.equal(isInternalEndpoint('http://backend.internal'), true);
      assert.equal(isInternalEndpoint('http://vault.corp'), true);
      assert.equal(isInternalEndpoint('http://router.lan'), true);
      assert.equal(isInternalEndpoint('http://nas.home'), true);
      assert.equal(isInternalEndpoint('http://secure.private'), true);
      assert.equal(isInternalEndpoint('https://honcho.node.ts.net'), true);
      assert.equal(isInternalEndpoint('https://honcho.tailebe851.ts.net'), true);
    });

    it('returns false cleanly on public hostnames', () => {
      assert.equal(isInternalEndpoint('https://openrouter.ai/api/v1'), false);
      assert.equal(isInternalEndpoint('https://api.anthropic.com/v1'), false);
      assert.equal(isInternalEndpoint('https://api.github.com'), false);
      assert.equal(isInternalEndpoint('https://honcho.cloud.example.com'), false);
    });

    it('handles invalid inputs and malformed URLs without throwing', () => {
      assert.equal(isInternalEndpoint(''), false);
      assert.equal(isInternalEndpoint(null as any), false);
      assert.equal(isInternalEndpoint(undefined as any), false);
      assert.equal(isInternalEndpoint(123 as any), false);
      assert.equal(isInternalEndpoint('not-a-valid-url'), false);
      assert.equal(isInternalEndpoint('http://'), false);
    });
  });

  // =========================================================================
  // 2. resolveEndpointTunnel (Legacy Support)
  // =========================================================================
  describe('resolveEndpointTunnel', () => {
    it('defaults to direct public connection (no tunnel) for public APIs', () => {
      const creds: TunnelCredentials = { mode: 'none' };
      const res = resolveEndpointTunnel('llm-gateway', 'https://openrouter.ai/api/v1', creds, 'auto');

      assert.equal(res.tunnelType, 'none');
      assert.equal(res.requiresDaemon, false);
      assert.deepEqual(res.headers, {});
    });

    it('resolves Cloudflare Tunnel & Access headers for private endpoints', () => {
      const creds: TunnelCredentials = {
        mode: 'cloudflare',
        cfAccessClientId: 'client-id-123',
        cfAccessClientSecret: 'client-secret-456',
        cfTunnelToken: 'token-xyz',
      };
      const res = resolveEndpointTunnel(
        'bifrost-gateway',
        'https://gateway-internal.example.com/v1',
        creds,
        'auto'
      );

      assert.equal(res.tunnelType, 'cloudflare');
      assert.equal(res.headers['CF-Access-Client-Id'], 'client-id-123');
      assert.equal(res.headers['CF-Access-Client-Secret'], 'client-secret-456');
      assert.equal(res.requiresDaemon, false); // URL not internal IP, requiresDaemon check
    });

    it('sets requiresDaemon = true for Cloudflare when tunnelToken on internal IP', () => {
      const creds: TunnelCredentials = {
        mode: 'cloudflare',
        cfAccessClientId: 'client-id-123',
        cfAccessClientSecret: 'client-secret-456',
        cfTunnelToken: 'token-xyz',
      };
      const res = resolveEndpointTunnel(
        'bifrost-private',
        'http://10.244.0.15:8080',
        creds,
        'auto'
      );

      assert.equal(res.tunnelType, 'cloudflare');
      assert.equal(res.requiresDaemon, true);
    });

    it('resolves Tailscale tunnel for *.ts.net endpoints when auth key is present', () => {
      const creds: TunnelCredentials = {
        mode: 'tailscale',
        tailscaleAuthKey: 'tskey-auth-mock-123',
      };
      const res = resolveEndpointTunnel(
        'honcho-memory',
        'https://honcho.tailebe851.ts.net',
        creds,
        'auto'
      );

      assert.equal(res.tunnelType, 'tailscale');
      assert.equal(res.requiresDaemon, true);
    });

    it('falls back to none when Tailscale mode configured but auth key is missing', () => {
      const creds: TunnelCredentials = { mode: 'tailscale' };
      const res = resolveEndpointTunnel('honcho-memory', 'https://honcho.tailebe851.ts.net', creds, 'tailscale');
      assert.equal(res.tunnelType, 'none');
      assert.equal(res.requiresDaemon, false);
    });

    it('honors mode=none explicitly overriding private detection', () => {
      const creds: TunnelCredentials = {
        mode: 'cloudflare',
        cfAccessClientId: 'client-id-123',
      };
      const res = resolveEndpointTunnel('local-test', 'http://127.0.0.1:8000', creds, 'none');

      assert.equal(res.tunnelType, 'none');
      assert.equal(res.requiresDaemon, false);
    });

    it('handles empty targetUrl and omitted credentials gracefully', () => {
      const resEmpty = resolveEndpointTunnel('empty', '');
      assert.equal(resEmpty.tunnelType, 'none');

      const resNoCreds = resolveEndpointTunnel('public', 'https://openrouter.ai/api');
      assert.equal(resNoCreds.tunnelType, 'none');
    });
  });

  // =========================================================================
  // 3. resolveToolConnection: Direct HTTPS Transport
  // =========================================================================
  describe('resolveToolConnection: Direct HTTPS Transport', () => {
    it('resolves standard public HTTPS URLs with zero tunnel headers and daemon false', () => {
      const tool: ToolDefinition = {
        name: 'openrouter-inference',
        type: 'inference',
        url: 'https://openrouter.ai/api/v1',
        tunnel: { mode: 'direct', timeout_ms: 60000, headers: { 'X-Custom-Client': 'yeti' } },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.name, 'openrouter-inference');
      assert.equal(resolved.tunnelMode, 'direct');
      assert.equal(resolved.requiresTunnelDaemon, false);
      assert.equal(resolved.timeoutMs, 60000);
      assert.equal(resolved.headers['X-Custom-Client'], 'yeti');
      assert.equal(resolved.headers['CF-Access-Client-Id'], undefined);
    });

    it('resolves mode: none to direct transport', () => {
      const tool: ToolDefinition = {
        name: 'anthropic-api',
        type: 'inference',
        url: 'https://api.anthropic.com/v1',
        tunnel: { mode: 'none' },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'direct');
      assert.equal(resolved.requiresTunnelDaemon, false);
    });

    it('handles stdio tool definitions without URLs cleanly', () => {
      const tool: ToolDefinition = {
        name: 'local-linter',
        type: 'stdio',
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'direct');
      assert.equal(resolved.requiresTunnelDaemon, false);
      assert.equal(resolved.url, '');
    });
  });

  // =========================================================================
  // 4. resolveToolConnection: Cloudflare Access Service Token Injection
  // =========================================================================
  describe('resolveToolConnection: Cloudflare Access Service Token Injection', () => {
    it('injects CF-Access-Client-Id and CF-Access-Client-Secret headers', () => {
      const tool: ToolDefinition = {
        name: 'bifrost-gateway',
        type: 'http',
        url: 'https://gateway-internal.example.com/v1',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: {
            access_client_id: 'cf-id-test-123',
            access_client_secret: 'cf-secret-test-456',
          },
          headers: { 'X-Namespace': 'production' },
        },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'cloudflare');
      assert.equal(resolved.requiresTunnelDaemon, false); // No tunnel_token -> direct Access proxy
      assert.equal(resolved.headers['CF-Access-Client-Id'], 'cf-id-test-123');
      assert.equal(resolved.headers['CF-Access-Client-Secret'], 'cf-secret-test-456');
      assert.equal(resolved.headers['X-Namespace'], 'production');
    });

    it('sets requiresTunnelDaemon = true when tunnel_token is configured', () => {
      const tool: ToolDefinition = {
        name: 'private-axl',
        type: 'mcp',
        url: 'https://axl-daemon.internal.example.com',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: {
            access_client_id: 'id',
            access_client_secret: 'secret',
            tunnel_token: 'cloudflared-token-xyz',
          },
        },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'cloudflare');
      assert.equal(resolved.requiresTunnelDaemon, true);
    });

    it('inherits Cloudflare Access credentials from globalDefaults (flat and structured)', () => {
      const tool: ToolDefinition = {
        name: 'bifrost-default-creds',
        type: 'http',
        url: 'https://gateway.internal.example.com',
        tunnel: { mode: 'cloudflare' },
      };

      // Test flat defaults
      const resFlat = resolveToolConnection(tool, {
        cfAccessClientId: 'global-id-flat',
        cfAccessClientSecret: 'global-secret-flat',
      });
      assert.equal(resFlat.headers['CF-Access-Client-Id'], 'global-id-flat');
      assert.equal(resFlat.headers['CF-Access-Client-Secret'], 'global-secret-flat');

      // Test structured defaults
      const resStructured = resolveToolConnection(tool, {
        cloudflare: {
          access_client_id: 'global-id-struct',
          access_client_secret: 'global-secret-struct',
        },
      });
      assert.equal(resStructured.headers['CF-Access-Client-Id'], 'global-id-struct');
      assert.equal(resStructured.headers['CF-Access-Client-Secret'], 'global-secret-struct');
    });

    it('inherits credentials and tokens from process.env when not in tool or defaults', () => {
      const origTsKey = process.env.TAILSCALE_AUTH_KEY;
      const origCfId = process.env.CF_ACCESS_CLIENT_ID;
      const origCfSec = process.env.CF_ACCESS_CLIENT_SECRET;
      const origCfTok = process.env.CLOUDFLARE_TUNNEL_TOKEN;

      try {
        process.env.TAILSCALE_AUTH_KEY = 'env-ts-key';
        process.env.CF_ACCESS_CLIENT_ID = 'env-cf-id';
        process.env.CF_ACCESS_CLIENT_SECRET = 'env-cf-sec';
        process.env.CLOUDFLARE_TUNNEL_TOKEN = 'env-cf-tok';

        // Test Tailscale from process.env
        const resTs = resolveToolConnection({
          name: 'ts-env',
          type: 'mcp',
          url: 'https://env.ts.net',
          tunnel: { mode: 'tailscale' },
        });
        assert.equal(resTs.requiresTunnelDaemon, true);

        // Test Cloudflare from process.env
        const resCf = resolveToolConnection({
          name: 'cf-env',
          type: 'http',
          url: 'https://env.internal',
          tunnel: { mode: 'cloudflare' },
        });
        assert.equal(resCf.headers['CF-Access-Client-Id'], 'env-cf-id');
        assert.equal(resCf.requiresTunnelDaemon, true);
      } finally {
        if (origTsKey !== undefined) process.env.TAILSCALE_AUTH_KEY = origTsKey;
        else delete process.env.TAILSCALE_AUTH_KEY;
        if (origCfId !== undefined) process.env.CF_ACCESS_CLIENT_ID = origCfId;
        else delete process.env.CF_ACCESS_CLIENT_ID;
        if (origCfSec !== undefined) process.env.CF_ACCESS_CLIENT_SECRET = origCfSec;
        else delete process.env.CF_ACCESS_CLIENT_SECRET;
        if (origCfTok !== undefined) process.env.CLOUDFLARE_TUNNEL_TOKEN = origCfTok;
        else delete process.env.CLOUDFLARE_TUNNEL_TOKEN;
      }
    });

    it('inherits structured defaults for tailscale auth_key, cloudflare tunnel_token, and timeout_ms', () => {
      const res = resolveToolConnection(
        {
          name: 'struct-tool',
          type: 'http',
          url: 'https://test.ts.net',
        },
        {
          timeout_ms: 15000,
          tailscale: { auth_key: 'struct-key' },
          cloudflare: { tunnel_token: 'struct-tok' },
          headers: { 'X-Struct': 'true' },
        }
      );
      assert.equal(res.timeoutMs, 15000);
      assert.equal(res.requiresTunnelDaemon, true);
      assert.equal(res.headers['X-Struct'], 'true');
    });

    it('inherits flat defaults for cfTunnelToken and timeout_ms', () => {
      const res = resolveToolConnection(
        {
          name: 'flat-tool',
          type: 'http',
          url: 'https://test.internal',
          tunnel: { mode: 'cloudflare' },
        },
        {
          timeout_ms: 22000,
          cfAccessClientId: 'id',
          cfAccessClientSecret: 'sec',
          cfTunnelToken: 'flat-tok',
          headers: { 'X-Flat': 'true' },
        }
      );
      assert.equal(res.timeoutMs, 22000);
      assert.equal(res.requiresTunnelDaemon, true);
      assert.equal(res.headers['X-Flat'], 'true');
    });

    it('resolves explicit cloudflare mode without credentials cleanly', () => {
      const tool: ToolDefinition = {
        name: 'cf-no-creds',
        type: 'http',
        url: 'https://gateway.internal.corp',
        tunnel: { mode: 'cloudflare' },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'cloudflare');
      assert.equal(res.requiresTunnelDaemon, false);
      assert.equal(res.headers['CF-Access-Client-Id'], undefined);
    });
  });

  // =========================================================================
  // 5. resolveToolConnection: Tailscale MagicDNS Transport
  // =========================================================================
  describe('resolveToolConnection: Tailscale MagicDNS Transport', () => {
    it('detects *.ts.net endpoint and marks requiresTunnelDaemon = true when auth_key is provided', () => {
      const tool: ToolDefinition = {
        name: 'honcho-memory',
        type: 'mcp',
        url: 'https://honcho.tailebe851.ts.net/sse',
        tunnel: {
          mode: 'auto',
          tailscale: { auth_key: 'tskey-auth-mock' },
        },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'tailscale');
      assert.equal(resolved.requiresTunnelDaemon, true);
    });

    it('resolves explicit mode: tailscale with inherited global auth key', () => {
      const tool: ToolDefinition = {
        name: 'custom-tailnet-tool',
        type: 'http',
        url: 'https://internal-worker.tailnet:8080',
        tunnel: { mode: 'tailscale' },
      };

      const resolved = resolveToolConnection(tool, { tailscaleAuthKey: 'tskey-global-auth' });
      assert.equal(resolved.tunnelMode, 'tailscale');
      assert.equal(resolved.requiresTunnelDaemon, true);
    });

    it('sets requiresTunnelDaemon = false when no Tailscale auth key is present', () => {
      const tool: ToolDefinition = {
        name: 'tailnet-no-key',
        type: 'mcp',
        url: 'https://node.corp.ts.net/mcp',
        tunnel: { mode: 'tailscale' },
      };

      const resolved = resolveToolConnection(tool);
      assert.equal(resolved.tunnelMode, 'tailscale');
      assert.equal(resolved.requiresTunnelDaemon, false);
    });
  });

  // =========================================================================
  // 6. resolveToolConnection: Automated Mode Detection (mode: auto)
  // =========================================================================
  describe('resolveToolConnection: Automated Mode Detection (mode: auto)', () => {
    it('auto-selects tailscale for *.ts.net domains', () => {
      const tool: ToolDefinition = {
        name: 'ts-auto',
        type: 'mcp',
        url: 'https://service.domain.ts.net',
      };
      const res = resolveToolConnection(tool, { tailscaleAuthKey: 'ts-key' });
      assert.equal(res.tunnelMode, 'tailscale');
      assert.equal(res.requiresTunnelDaemon, true);
    });

    it('auto-selects cloudflare for internal IP addresses and attaches available credentials', () => {
      const tool: ToolDefinition = {
        name: 'internal-ip-tool',
        type: 'http',
        url: 'http://10.244.10.15:8080/mcp',
      };
      const res = resolveToolConnection(tool, {
        cfAccessClientId: 'cf-auto-id',
        cfAccessClientSecret: 'cf-auto-secret',
      });
      assert.equal(res.tunnelMode, 'cloudflare');
      assert.equal(res.headers['CF-Access-Client-Id'], 'cf-auto-id');
      assert.equal(res.headers['CF-Access-Client-Secret'], 'cf-auto-secret');
    });

    it('auto-selects cloudflare for internal endpoints even without credentials (tier3 test X4 requirement)', () => {
      const tool: ToolDefinition = {
        name: 'unconfigured-internal',
        type: 'http',
        url: 'https://service.internal.corp/sse',
      };
      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'cloudflare');
      assert.equal(res.requiresTunnelDaemon, false);
      assert.equal(Object.keys(res.headers).length, 0);
    });

    it('auto-selects direct HTTPS for public domains bypassing global Cloudflare credentials', () => {
      const tool: ToolDefinition = {
        name: 'public-openrouter',
        type: 'inference',
        url: 'https://openrouter.ai/api/v1',
      };
      const res = resolveToolConnection(tool, {
        cfAccessClientId: 'global-id',
        cfAccessClientSecret: 'global-secret',
      });
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.requiresTunnelDaemon, false);
      assert.equal(res.headers['CF-Access-Client-Id'], undefined);
    });

    it('auto-selects cloudflare for public endpoints when tool-level cloudflare is defined', () => {
      const tool: ToolDefinition = {
        name: 'cname-protected-tool',
        type: 'http',
        url: 'https://cname-proxy.example.com/api',
        tunnel: {
          mode: 'auto',
          cloudflare: {
            access_client_id: 'tool-level-id',
            access_client_secret: 'tool-level-secret',
          },
        },
      };
      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'cloudflare');
      assert.equal(res.headers['CF-Access-Client-Id'], 'tool-level-id');
      assert.equal(res.headers['CF-Access-Client-Secret'], 'tool-level-secret');
    });
  });

  // =========================================================================
  // 7. Defensive Error Handling & Input Validation
  // =========================================================================
  describe('Defensive Error Handling & Input Validation', () => {
    it('throws when tool definition is null, non-object, or array', () => {
      assert.throws(() => resolveToolConnection(null as any), /Invalid tool definition/);
      assert.throws(() => resolveToolConnection('string' as any), /Invalid tool definition/);
      assert.throws(() => resolveToolConnection([] as any), /Invalid tool definition/);
    });

    it('throws when tool name is missing or whitespace', () => {
      assert.throws(
        () => resolveToolConnection({ name: '', type: 'http', url: 'https://api.com' } as any),
        /missing or empty "name"/
      );
      assert.throws(
        () => resolveToolConnection({ name: '   ', type: 'http', url: 'https://api.com' } as any),
        /missing or empty "name"/
      );
      assert.throws(
        () => resolveToolConnection({ type: 'http', url: 'https://api.com' } as any),
        /missing or empty "name"/
      );
    });

    it('throws when tool type is unsupported', () => {
      assert.throws(
        () => resolveToolConnection({ name: 'bad-type', type: 'websocket' as any, url: 'https://api.com' }),
        /Invalid tool type "websocket"/
      );
    });

    it('throws when network tool is missing url', () => {
      assert.throws(
        () => resolveToolConnection({ name: 'no-url', type: 'mcp' }),
        /Missing required "url"/
      );
      assert.throws(
        () => resolveToolConnection({ name: 'empty-url', type: 'http', url: '   ' }),
        /Missing required "url"/
      );
    });

    it('throws when protocol is unsupported (e.g. ftp:// or file://)', () => {
      assert.throws(
        () => resolveToolConnection({ name: 'ftp-tool', type: 'http', url: 'ftp://files.corp/sse' }),
        /Unsupported protocol "ftp:"/
      );
      assert.throws(
        () => resolveToolConnection({ name: 'file-tool', type: 'http', url: 'file:///etc/passwd' }),
        /Unsupported protocol "file:"/
      );
    });

    it('throws when url is malformed in resolveToolConnection', () => {
      assert.throws(
        () => resolveToolConnection({ name: 'bad-url-tool', type: 'http', url: 'http://' }),
        /Invalid URL/
      );
    });

    it('throws when tunnel mode is unsupported', () => {
      const tool: ToolDefinition = {
        name: 'wireguard-tool',
        type: 'http',
        url: 'https://api.internal',
        tunnel: { mode: 'wireguard' as any },
      };
      assert.throws(() => resolveToolConnection(tool), /Unsupported tunnel mode "wireguard"/);
    });

    it('throws when timeout_ms is negative, zero, or non-finite', () => {
      const toolBadNegative: ToolDefinition = {
        name: 'bad-timeout',
        type: 'http',
        url: 'https://api.com',
        tunnel: { mode: 'direct', timeout_ms: -500 },
      };
      assert.throws(() => resolveToolConnection(toolBadNegative), /Invalid timeout_ms "-500"/);

      const toolBadZero: ToolDefinition = {
        name: 'bad-timeout-zero',
        type: 'http',
        url: 'https://api.com',
        tunnel: { mode: 'direct', timeout_ms: 0 },
      };
      assert.throws(() => resolveToolConnection(toolBadZero), /Invalid timeout_ms "0"/);

      const toolBadNaN: ToolDefinition = {
        name: 'bad-nan',
        type: 'http',
        url: 'https://api.com',
        tunnel: { mode: 'direct', timeout_ms: NaN },
      };
      assert.throws(() => resolveToolConnection(toolBadNaN), /Invalid timeout_ms "NaN"/);
    });

    it('throws when explicit cloudflare mode has incomplete credentials (client ID without secret or vice versa)', () => {
      const toolIdOnly: ToolDefinition = {
        name: 'partial-cf-id',
        type: 'http',
        url: 'https://gateway.internal',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: { access_client_id: 'client-id-only' },
        },
      };
      assert.throws(
        () => resolveToolConnection(toolIdOnly),
        /Incomplete Cloudflare Access credentials for tool "partial-cf-id"/
      );

      const toolSecretOnly: ToolDefinition = {
        name: 'partial-cf-secret',
        type: 'http',
        url: 'https://gateway.internal',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: { access_client_secret: 'client-secret-only' },
        },
      };
      assert.throws(
        () => resolveToolConnection(toolSecretOnly),
        /Incomplete Cloudflare Access credentials for tool "partial-cf-secret"/
      );
    });
  });

  // =========================================================================
  // 8. Security & Boundary Hardening (Iteration 2 Enhancements)
  // =========================================================================
  describe('Security & Boundary Hardening (Iteration 2 Enhancements)', () => {
    it('isIPv4Address correctly validates genuine IPv4 addresses and rejects hostnames/spoofs', () => {
      assert.equal(isIPv4Address('10.0.0.1'), true);
      assert.equal(isIPv4Address('172.16.0.1'), true);
      assert.equal(isIPv4Address('192.168.1.1'), true);
      assert.equal(isIPv4Address('127.0.0.1'), true);
      assert.equal(isIPv4Address('0.0.0.0'), true);
      assert.equal(isIPv4Address('255.255.255.255'), true);

      // Rejections
      assert.equal(isIPv4Address('10.attacker.com'), false);
      assert.equal(isIPv4Address('172.16.0.0.attacker.com'), false);
      assert.equal(isIPv4Address('192.168.attacker.com'), false);
      assert.equal(isIPv4Address('256.0.0.1'), false);
      assert.equal(isIPv4Address('1.2.3.4.5'), false);
      assert.equal(isIPv4Address('1.2.3'), false);
      assert.equal(isIPv4Address(''), false);
      assert.equal(isIPv4Address(null as any), false);
      assert.equal(isIPv4Address(undefined as any), false);
    });

    it('isTailscaleUrl verifies hostname and rejects subdomain, path, or query spoofing', () => {
      assert.equal(isTailscaleUrl('https://my-node.ts.net'), true);
      assert.equal(isTailscaleUrl('https://node.tailebe851.ts.net:8443'), true);
      assert.equal(isTailscaleUrl('http://ts.net'), true);

      // Rejections
      assert.equal(isTailscaleUrl('https://evil.ts.net.attacker.com'), false);
      assert.equal(isTailscaleUrl('https://attacker.com/steal?target=foo.ts.net'), false);
      assert.equal(isTailscaleUrl('https://attacker.com/.ts.net/data'), false);
      assert.equal(isTailscaleUrl('https://ts.net.evil.org'), false);
      assert.equal(isTailscaleUrl(''), false);
      assert.equal(isTailscaleUrl(null as any), false);
    });

    it('hasHeaderCaseInsensitive performs RFC-compliant case-insensitive lookup', () => {
      const headers = { 'CF-Access-Client-Id': 'id-123', 'authorization': 'Bearer token' };
      assert.equal(hasHeaderCaseInsensitive(headers, 'CF-Access-Client-Id'), true);
      assert.equal(hasHeaderCaseInsensitive(headers, 'cf-access-client-id'), true);
      assert.equal(hasHeaderCaseInsensitive(headers, 'CF-ACCESS-CLIENT-ID'), true);
      assert.equal(hasHeaderCaseInsensitive(headers, 'Authorization'), true);
      assert.equal(hasHeaderCaseInsensitive(headers, 'X-Missing-Header'), false);
    });

    it('isInternalEndpoint recognizes IPv6 link-local and ULA addresses', () => {
      assert.equal(isInternalEndpoint('http://[fe80::1]:8080'), true);
      assert.equal(isInternalEndpoint('http://[fe80::20c:29ff:fe4a:3d1b]:8080'), true);
      assert.equal(isInternalEndpoint('http://[fd00::1]:8080'), true);
      assert.equal(isInternalEndpoint('http://[fc00::1234]:9000'), true);
    });

    it('validates partial Cloudflare credentials in mode: auto for private endpoints and tool CF config', () => {
      const privatePartial: ToolDefinition = {
        name: 'private-partial',
        type: 'http',
        url: 'http://10.10.10.10:8080',
        tunnel: {
          mode: 'auto',
          cloudflare: { access_client_id: 'some-id' },
        },
      };
      assert.throws(
        () => resolveToolConnection(privatePartial),
        /Incomplete Cloudflare Access credentials for tool "private-partial"/
      );

      const publicToolWithPartialCf: ToolDefinition = {
        name: 'public-partial-cf',
        type: 'http',
        url: 'https://api.external.com/api',
        tunnel: {
          mode: 'auto',
          cloudflare: { access_client_secret: 'some-secret' },
        },
      };
      assert.throws(
        () => resolveToolConnection(publicToolWithPartialCf),
        /Incomplete Cloudflare Access credentials for tool "public-partial-cf"/
      );
    });

    it('preserves user explicit CF-Access headers case-insensitively without overwriting from defaults', () => {
      const tool: ToolDefinition = {
        name: 'explicit-headers-tool',
        type: 'http',
        url: 'https://service.internal',
        tunnel: {
          mode: 'cloudflare',
          headers: {
            'cf-access-client-id': 'my-custom-id',
            'cf-access-client-secret': 'my-custom-secret',
          },
        },
      };
      const res = resolveToolConnection(tool, {
        cfAccessClientId: 'default-id',
        cfAccessClientSecret: 'default-secret',
      });
      assert.equal(res.headers['cf-access-client-id'], 'my-custom-id');
      assert.equal(res.headers['cf-access-client-secret'], 'my-custom-secret');
      assert.equal(res.headers['CF-Access-Client-Id'], undefined);
      assert.equal(res.headers['CF-Access-Client-Secret'], undefined);
    });
  });
});
