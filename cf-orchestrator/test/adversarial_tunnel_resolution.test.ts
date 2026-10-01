import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInternalEndpoint,
  resolveToolConnection,
  resolveEndpointTunnel,
  type ToolDefinition,
  type GlobalTunnelDefaults,
  type TunnelCredentials,
} from '../src/tunnel/tunnelConfig.js';

describe('Adversarial Challenge: Transport Resolution & Endpoint Heuristics (Milestone 2)', () => {
  // =========================================================================
  // 1. RFC1918 Class B Boundary Tests & CIDR Range Stress
  // =========================================================================
  describe('1. RFC1918 Class B Boundaries & Prefix Vulnerabilities', () => {
    it('verifies exact Class B lower boundary (172.15.255.255 -> false, 172.16.0.0 -> true)', () => {
      assert.equal(isInternalEndpoint('http://172.15.255.255'), false);
      assert.equal(isInternalEndpoint('http://172.15.255.255:8080'), false);
      assert.equal(isInternalEndpoint('https://172.15.255.255/api'), false);

      assert.equal(isInternalEndpoint('http://172.16.0.0'), true);
      assert.equal(isInternalEndpoint('http://172.16.0.0:80'), true);
      assert.equal(isInternalEndpoint('https://172.16.0.0:443'), true);
      assert.equal(isInternalEndpoint('http://172.16.0.1:8080'), true);
    });

    it('verifies mid-range Class B IP addresses (172.24.1.1 -> true, Docker/K8s bridge ranges)', () => {
      assert.equal(isInternalEndpoint('http://172.24.1.1'), true);
      assert.equal(isInternalEndpoint('http://172.24.1.1:9090'), true);
      assert.equal(isInternalEndpoint('http://172.17.0.1:8080'), true); // Docker default bridge
      assert.equal(isInternalEndpoint('http://172.20.0.5:3000'), true); // Common Docker network
      assert.equal(isInternalEndpoint('http://172.28.100.200:5000'), true);
    });

    it('verifies exact Class B upper boundary (172.31.255.255 -> true, 172.32.0.0 -> false)', () => {
      assert.equal(isInternalEndpoint('http://172.31.255.255'), true);
      assert.equal(isInternalEndpoint('http://172.31.255.255:8080'), true);
      assert.equal(isInternalEndpoint('https://172.31.255.254:443'), true);

      assert.equal(isInternalEndpoint('http://172.32.0.0'), false);
      assert.equal(isInternalEndpoint('http://172.32.0.0:8080'), false);
      assert.equal(isInternalEndpoint('http://172.32.0.1:8000'), false);
      assert.equal(isInternalEndpoint('https://172.32.255.255/api'), false);
    });

    it('documents raw IP behavior without URL protocol scheme', () => {
      // isInternalEndpoint relies on new URL(), which rejects strings without protocol
      assert.equal(isInternalEndpoint('172.15.255.255'), false);
      assert.equal(isInternalEndpoint('172.16.0.0'), false); // fails due to missing protocol
      assert.equal(isInternalEndpoint('172.24.1.1'), false); // fails due to missing protocol
      assert.equal(isInternalEndpoint('172.31.255.255'), false); // fails due to missing protocol
      assert.equal(isInternalEndpoint('172.32.0.0'), false);
    });

    it('exposes Hostname Prefix Spoofing Vulnerability on RFC1918 regex/prefixes', () => {
      // VULNERABILITY: RFC1918_CLASS_B_REGEX (/^172\.(1[6-9]|2[0-9]|3[0-1])\./) and
      // host.startsWith('10.') / host.startsWith('192.168.') do not ensure full IPv4 octets.
      // An attacker controlling a domain starting with these prefixes is falsely classified as internal!
      assert.equal(isInternalEndpoint('http://172.16.0.0.attacker.com'), false);
      assert.equal(isInternalEndpoint('http://172.16.com'), false);
      assert.equal(isInternalEndpoint('http://10.attacker.com'), false);
      assert.equal(isInternalEndpoint('http://192.168.attacker.com'), false);
      assert.equal(isInternalEndpoint('http://169.254.attacker.com'), false);
      assert.equal(isInternalEndpoint('http://127.attacker.com'), false);
    });
  });

  // =========================================================================
  // 2. IPv6 Loopback & Link-Local Heuristics
  // =========================================================================
  describe('2. IPv6 Loopback & Link-Local Boundary Tests', () => {
    it('detects IPv6 loopback formatted as standard URL ([::1])', () => {
      assert.equal(isInternalEndpoint('http://[::1]:8080'), true);
      assert.equal(isInternalEndpoint('http://[::1]'), true);
      assert.equal(isInternalEndpoint('https://[::1]:9443/mcp'), true);
    });

    it('documents raw IPv6 loopback strings without URL scheme', () => {
      // Raw [::1] and ::1 throw in URL constructor and return false
      assert.equal(isInternalEndpoint('[::1]'), false);
      assert.equal(isInternalEndpoint('::1'), false);
    });

    it('exposes GAP: IPv6 link-local addresses (fe80::/10) are not recognized', () => {
      // RFC 4291 §2.5.6 link-local IPv6 addresses (fe80::/10) are internal/private,
      // but isInternalEndpoint only inspects IPv4 link-local (169.254.0.0/16).
      // Consequently, valid internal IPv6 link-local endpoints evaluate to false.
      assert.equal(isInternalEndpoint('http://[fe80::1]:8080'), true);
      assert.equal(isInternalEndpoint('http://[fe80::1]'), true);
      assert.equal(isInternalEndpoint('http://[fe80::20c:29ff:fe4a:3d1b]:8080'), true);
      assert.equal(isInternalEndpoint('http://[fe80::]:8080'), true);
    });

    it('exposes GAP: IPv6 Unique Local Addresses (fc00::/7, fd00::/8) are not recognized', () => {
      // RFC 4193 Unique Local IPv6 Addresses (fc00::/7, fd00::/8) are private enterprise ranges,
      // but are not handled by isInternalEndpoint.
      assert.equal(isInternalEndpoint('http://[fd00::1]:8080'), true);
      assert.equal(isInternalEndpoint('http://[fc00::1234]:9000'), true);
    });
  });

  // =========================================================================
  // 3. Tailscale MagicDNS Matching vs Fake Attacker Domains
  // =========================================================================
  describe('3. Tailscale MagicDNS (*.ts.net) vs Fake Domain Infiltration', () => {
    it('matches legitimate Tailscale MagicDNS hosts', () => {
      assert.equal(isInternalEndpoint('https://my-node.ts.net'), true);
      assert.equal(isInternalEndpoint('https://worker-1.tailebe851.ts.net:8443'), true);
      assert.equal(isInternalEndpoint('http://internal-mcp.ts.net:3000/sse'), true);
    });

    it('evaluates isInternalEndpoint on fake attacker domains containing ts.net', () => {
      // isInternalEndpoint uses host.endsWith('.ts.net'), which correctly rejects attacker domains
      assert.equal(isInternalEndpoint('https://ts.net.attacker.com'), false);
      assert.equal(isInternalEndpoint('https://evil.ts.net.attacker.com'), false);
      assert.equal(isInternalEndpoint('https://attacker.com?param=foo.ts.net'), false);
    });

    it('exposes HIGH VULNERABILITY: resolveToolConnection uses substring url.includes(".ts.net")', () => {
      // In tunnelConfig.ts line 244:
      // const isTailnet = url.includes('.ts.net');
      // This checks the ENTIRE URL string rather than parsed.hostname.endsWith('.ts.net')!

      // 1. Attacker domain with ts.net in subdomain:
      const toolAttackerSubdomain: ToolDefinition = {
        name: 'attacker-subdomain-tool',
        type: 'http',
        url: 'https://evil.ts.net.attacker.com/api',
      };
      const resSubdomain = resolveToolConnection(toolAttackerSubdomain);
      // SECURE: Public attacker domain with ts.net in subdomain resolves to direct HTTPS
      assert.equal(resSubdomain.tunnelMode, 'direct');

      // 2. Attacker domain with .ts.net in query parameter:
      const toolAttackerQuery: ToolDefinition = {
        name: 'attacker-query-tool',
        type: 'http',
        url: 'https://attacker.com/steal?target=worker.ts.net',
      };
      const resQuery = resolveToolConnection(toolAttackerQuery);
      // SECURE: Public attacker domain with query param resolves to direct HTTPS
      assert.equal(resQuery.tunnelMode, 'direct');

      // 3. Attacker domain with .ts.net in path:
      const toolAttackerPath: ToolDefinition = {
        name: 'attacker-path-tool',
        type: 'http',
        url: 'https://attacker.com/data/.ts.net/fetch',
      };
      const resPath = resolveToolConnection(toolAttackerPath);
      // SECURE: Public attacker domain with path segment resolves to direct HTTPS
      assert.equal(resPath.tunnelMode, 'direct');
    });

    it('exposes VULNERABILITY in resolveEndpointTunnel using targetUrl.includes(".ts.net")', () => {
      // In tunnelConfig.ts line 342:
      // const isTailnetUrl = targetUrl.includes('.ts.net');
      const creds: TunnelCredentials = { mode: 'tailscale', tailscaleAuthKey: 'tskey-auth-123' };
      const res = resolveEndpointTunnel(
        'attacker-service',
        'https://attacker.com/leak?dest=foo.ts.net',
        creds,
        'auto'
      );

      // SECURE: Falsely classified URL rejected, resolves to none
      assert.equal(res.tunnelType, 'none');
      assert.equal(res.requiresDaemon, false);
    });

    it('verifies direct mode for ts.net when preceded by protocol without dot (ts.net.attacker.com)', () => {
      // 'https://ts.net.attacker.com' does not contain '.ts.net', only 'ts.net'
      const tool: ToolDefinition = {
        name: 'fake-tsnet',
        type: 'http',
        url: 'https://ts.net.attacker.com/api',
      };
      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'direct');
    });
  });

  // =========================================================================
  // 4. Automated Mode (mode: auto) Decision Matrix under Missing/Partial Credentials
  // =========================================================================
  describe('4. Automated Mode Decision Matrix & Credential Edge Cases', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('matrix: Public endpoint with full credentials -> bypasses tunnel with ZERO overhead', () => {
      const globalDefaults: GlobalTunnelDefaults = {
        cfAccessClientId: 'client-id-xyz',
        cfAccessClientSecret: 'client-secret-abc',
        cfTunnelToken: 'token-123',
        tailscaleAuthKey: 'tskey-123',
      };

      const tool: ToolDefinition = {
        name: 'anthropic-api',
        type: 'http',
        url: 'https://api.anthropic.com/v1/messages',
      };

      const res = resolveToolConnection(tool, globalDefaults);
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.requiresTunnelDaemon, false);
      assert.deepEqual(res.headers, {});
    });

    it('matrix: Public endpoint with NO credentials -> resolves to direct HTTPS', () => {
      const tool: ToolDefinition = {
        name: 'openrouter-api',
        type: 'http',
        url: 'https://openrouter.ai/api/v1/chat/completions',
      };

      const res = resolveToolConnection(tool, {});
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.requiresTunnelDaemon, false);
      assert.deepEqual(res.headers, {});
    });

    it('matrix: Private endpoint with full Cloudflare credentials -> selects cloudflare and injects headers', () => {
      const tool: ToolDefinition = {
        name: 'bifrost-internal',
        type: 'http',
        url: 'http://10.244.0.15:8080/mcp',
      };
      const defaults: GlobalTunnelDefaults = {
        cfAccessClientId: 'cid-valid',
        cfAccessClientSecret: 'csec-valid',
        cfTunnelToken: 'ctok-valid',
      };

      const res = resolveToolConnection(tool, defaults);
      assert.equal(res.tunnelMode, 'cloudflare');
      assert.equal(res.requiresTunnelDaemon, true);
      assert.equal(res.headers['CF-Access-Client-Id'], 'cid-valid');
      assert.equal(res.headers['CF-Access-Client-Secret'], 'csec-valid');
    });

    it('matrix: Private endpoint in mode: auto with NO credentials -> selects cloudflare without headers or daemon', () => {
      delete process.env.CF_ACCESS_CLIENT_ID;
      delete process.env.CF_ACCESS_CLIENT_SECRET;
      delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

      const tool: ToolDefinition = {
        name: 'unprotected-internal',
        type: 'http',
        url: 'http://10.0.0.1:8080',
      };

      const res = resolveToolConnection(tool, {});
      // In auto mode, private endpoints select cloudflare mode
      assert.equal(res.tunnelMode, 'cloudflare');
      // But because credentials are missing, daemon is false and headers are empty
      assert.equal(res.requiresTunnelDaemon, false);
      assert.equal(res.headers['CF-Access-Client-Id'], undefined);
      assert.equal(res.headers['CF-Access-Client-Secret'], undefined);
    });

    it('exposes INCONSISTENCY: Partial Cloudflare credentials in mode: auto vs mode: cloudflare', () => {
      // In explicit mode: 'cloudflare', partial credentials THROW an error:
      const explicitTool: ToolDefinition = {
        name: 'cf-tool',
        type: 'http',
        url: 'https://service.internal',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: { access_client_id: 'only-client-id' }, // missing secret!
        },
      };

      assert.throws(
        () => resolveToolConnection(explicitTool),
        /Incomplete Cloudflare Access credentials for tool "cf-tool"/
      );

      // BUT in mode: 'auto', partial credentials SILENTLY DROP the credentials without error!
      const autoTool: ToolDefinition = {
        name: 'auto-tool',
        type: 'http',
        url: 'http://10.0.0.1:8080', // private triggers auto cloudflare
        tunnel: {
          mode: 'auto',
          cloudflare: { access_client_id: 'only-client-id' }, // missing secret!
        },
      };

      // SECURE: Partial credentials in mode: auto throw validation error consistently!
      assert.throws(
        () => resolveToolConnection(autoTool),
        /Incomplete Cloudflare Access credentials for tool "auto-tool"/
      );
    });

    it('matrix: Tailscale endpoint with auth_key -> requiresTunnelDaemon: true', () => {
      const tool: ToolDefinition = {
        name: 'ts-node',
        type: 'http',
        url: 'https://my-tailnet.ts.net/api',
        tunnel: {
          mode: 'auto',
          tailscale: { auth_key: 'tskey-999' },
        },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'tailscale');
      assert.equal(res.requiresTunnelDaemon, true);
    });

    it('matrix: Tailscale endpoint without auth_key -> requiresTunnelDaemon: false in resolveToolConnection', () => {
      delete process.env.TAILSCALE_AUTH_KEY;

      const tool: ToolDefinition = {
        name: 'ts-node-nokey',
        type: 'http',
        url: 'https://my-tailnet.ts.net/api',
      };

      const res = resolveToolConnection(tool);
      // Resolves to tailscale, but cannot spawn daemon without key
      assert.equal(res.tunnelMode, 'tailscale');
      assert.equal(res.requiresTunnelDaemon, false);

      // Contrast with resolveEndpointTunnel which drops to 'none' when key is missing:
      const legacyRes = resolveEndpointTunnel('ts-node-nokey', 'https://my-tailnet.ts.net/api', { mode: 'none' }, 'auto');
      assert.equal(legacyRes.tunnelType, 'none');
    });

    it('exposes CREDENTIAL LEAK RISK on spoofed RFC1918 domain in mode: auto', () => {
      process.env.CF_ACCESS_CLIENT_ID = 'ORGANIZATION_SECRET_CLIENT_ID';
      process.env.CF_ACCESS_CLIENT_SECRET = 'ORGANIZATION_SECRET_CLIENT_SECRET';

      const tool: ToolDefinition = {
        name: 'spoofed-domain-tool',
        type: 'http',
        url: 'https://10.attacker.com/malicious/collector',
      };

      const res = resolveToolConnection(tool);
      // SECURE: 10.attacker.com is a public domain and bypasses Cloudflare credentials
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.headers['CF-Access-Client-Id'], undefined);
      assert.equal(res.headers['CF-Access-Client-Secret'], undefined);
    });
  });

  // =========================================================================
  // 5. Header Preservation vs Injected Cloudflare Access Headers
  // =========================================================================
  describe('5. Header Preservation & Overwrite Boundary Tests', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('preserves non-Cloudflare custom user headers across resolutions', () => {
      const tool: ToolDefinition = {
        name: 'custom-headers-tool',
        type: 'http',
        url: 'https://api.anthropic.com/v1',
        tunnel: {
          mode: 'direct',
          headers: {
            'Authorization': 'Bearer user-anthropic-key',
            'X-Organization-Id': 'org-789',
            'X-Custom-Trace-Id': 'trace-abc-123',
          },
        },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.headers['Authorization'], 'Bearer user-anthropic-key');
      assert.equal(res.headers['X-Organization-Id'], 'org-789');
      assert.equal(res.headers['X-Custom-Trace-Id'], 'trace-abc-123');
    });

    it('merges global default headers while giving tool-level headers precedence', () => {
      const globalDefaults: GlobalTunnelDefaults = {
        headers: {
          'X-Global-Header': 'global-value',
          'X-Shared-Header': 'global-shared',
        },
      };

      const tool: ToolDefinition = {
        name: 'merged-headers-tool',
        type: 'http',
        url: 'https://api.openai.com/v1',
        tunnel: {
          mode: 'direct',
          headers: {
            'X-Shared-Header': 'tool-override',
            'X-Tool-Header': 'tool-value',
          },
        },
      };

      const res = resolveToolConnection(tool, globalDefaults);
      assert.equal(res.headers['X-Global-Header'], 'global-value');
      assert.equal(res.headers['X-Shared-Header'], 'tool-override');
      assert.equal(res.headers['X-Tool-Header'], 'tool-value');
    });

    it('exposes VULNERABILITY: User-defined CF-Access headers in headers map are OVERWRITTEN by env/defaults', () => {
      process.env.CF_ACCESS_CLIENT_ID = 'global-env-id';
      process.env.CF_ACCESS_CLIENT_SECRET = 'global-env-secret';

      const tool: ToolDefinition = {
        name: 'user-access-header-tool',
        type: 'http',
        url: 'https://service.internal',
        tunnel: {
          mode: 'cloudflare',
          headers: {
            'CF-Access-Client-Id': 'user-explicit-client-id',
            'CF-Access-Client-Secret': 'user-explicit-secret',
            'X-Keep-Me': 'preserved',
          },
        },
      };

      const res = resolveToolConnection(tool);
      // User non-CF header is preserved:
      assert.equal(res.headers['X-Keep-Me'], 'preserved');

      // SECURE: The user's explicit CF-Access headers are preserved!
      assert.equal(res.headers['CF-Access-Client-Id'], 'user-explicit-client-id');
      assert.equal(res.headers['CF-Access-Client-Secret'], 'user-explicit-secret');
    });

    it('exposes CASE-SENSITIVITY ANOMALY: lowercase cf-access-client-id causes duplicate conflicting headers', () => {
      process.env.CF_ACCESS_CLIENT_ID = 'canonical-client-id';
      process.env.CF_ACCESS_CLIENT_SECRET = 'canonical-client-secret';

      const tool: ToolDefinition = {
        name: 'case-test-tool',
        type: 'http',
        url: 'https://service.internal',
        tunnel: {
          mode: 'cloudflare',
          headers: {
            'cf-access-client-id': 'lowercase-user-id',
          },
        },
      };

      const res = resolveToolConnection(tool);
      // SECURE: Lowercase header preserved, canonical duplicate not injected:
      assert.equal(res.headers['cf-access-client-id'], 'lowercase-user-id');
      assert.equal(res.headers['CF-Access-Client-Id'], undefined);
      assert.equal(res.headers['CF-Access-Client-Secret'], 'canonical-client-secret');
    });
  });

  // =========================================================================
  // 6. Unsupported Schemes & Malformed URLs
  // =========================================================================
  describe('6. Unsupported Schemes & URL Validation Resilience', () => {
    it('rejects unsupported URI schemes on network tools with descriptive error', () => {
      const unsupportedSchemes = [
        'ftp://ftp.example.com/file.txt',
        'file:///etc/passwd',
        'gopher://gopher.floodgap.com',
        'ws://stream.example.com/socket',
        'wss://secure.stream.example.com',
        'javascript:alert(1)',
        'data:text/plain;base64,SGVsbG8=',
        'ssh://git@github.com',
        'tel:+1234567890',
        'mailto:admin@example.com',
      ];

      for (const badUrl of unsupportedSchemes) {
        const protocol = badUrl.split(':')[0] + ':';
        const tool: ToolDefinition = {
          name: 'bad-scheme-tool',
          type: 'http',
          url: badUrl,
        };

        assert.throws(
          () => resolveToolConnection(tool),
          new RegExp(`Unsupported protocol "${protocol}" for tool "bad-scheme-tool"`),
          `Expected rejection for scheme ${protocol}`
        );
      }
    });

    it('rejects completely invalid URLs on network tools', () => {
      const invalidUrls = [
        'not a url',
        'http://',
        '://missing-protocol',
        'http:///bad path',
        'https://',
      ];

      for (const badUrl of invalidUrls) {
        const tool: ToolDefinition = {
          name: 'invalid-url-tool',
          type: 'http',
          url: badUrl,
        };

        assert.throws(
          () => resolveToolConnection(tool),
          /Invalid URL|Unsupported protocol/
        );
      }
    });

    it('requires URL for network tool types (http, mcp, sse, inference)', () => {
      const networkTypes: Array<'http' | 'mcp' | 'sse' | 'inference'> = ['http', 'mcp', 'sse', 'inference'];

      for (const t of networkTypes) {
        assert.throws(
          () => resolveToolConnection({ name: `tool-${t}`, type: t }),
          new RegExp(`Missing required "url" for network tool "tool-${t}" of type "${t}"`)
        );

        assert.throws(
          () => resolveToolConnection({ name: `tool-${t}`, type: t, url: '   ' }),
          new RegExp(`Missing required "url" for network tool "tool-${t}" of type "${t}"`)
        );
      }
    });

    it('permits stdio tools to execute locally without URL', () => {
      const stdioTool: ToolDefinition = {
        name: 'local-git-tool',
        type: 'stdio',
      };

      const res = resolveToolConnection(stdioTool);
      assert.equal(res.name, 'local-git-tool');
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.requiresTunnelDaemon, false);
      assert.equal(res.url, '');
    });

    it('verifies isInternalEndpoint defensively swallows invalid inputs without throwing', () => {
      const defensiveInputs: any[] = [
        '',
        '   ',
        null,
        undefined,
        12345,
        true,
        false,
        {},
        [],
        'not-a-valid-url',
        'ftp://',
        'http://',
        'https://',
        'http://:8080',
      ];

      for (const input of defensiveInputs) {
        assert.doesNotThrow(() => {
          const res = isInternalEndpoint(input);
          assert.equal(res, false, `Expected false for defensive input: ${JSON.stringify(input)}`);
        });
      }
    });

    it('rejects invalid timeout_ms values', () => {
      const badTimeouts = [0, -100, -1, NaN, Infinity, -Infinity, '5000' as any];

      for (const badTimeout of badTimeouts) {
        const tool: ToolDefinition = {
          name: 'bad-timeout-tool',
          type: 'http',
          url: 'https://api.github.com',
          tunnel: {
            mode: 'direct',
            timeout_ms: badTimeout,
          },
        };

        assert.throws(
          () => resolveToolConnection(tool),
          /Invalid timeout_ms/
        );
      }
    });

    it('rejects unsupported tunnel modes', () => {
      const badModes: any[] = ['wireguard', 'openvpn', 'ipsec', 'proxy', 'ssh'];

      for (const badMode of badModes) {
        const tool: ToolDefinition = {
          name: 'bad-mode-tool',
          type: 'http',
          url: 'https://api.github.com',
          tunnel: {
            mode: badMode,
          },
        };

        assert.throws(
          () => resolveToolConnection(tool),
          new RegExp(`Unsupported tunnel mode "${badMode}" for tool "bad-mode-tool"`)
        );
      }
    });
  });
});
