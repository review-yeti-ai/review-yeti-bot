import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolingConfigYaml,
  validateToolingConfig,
  interpolateEnvVars,
  interpolateObject,
  extractReferencedEnvVars,
  resolveToolConnection,
  type ToolingConfigFile,
} from '../src/tunnel/toolTunnelDefinition.js';
import {
  isInternalEndpoint,
  isIPv4Address,
  isTailscaleUrl,
  hasHeaderCaseInsensitive,
} from '../src/tunnel/tunnelConfig.js';

describe('Adversarial Stress Harness: M2 Iteration 2 (YAML + Tunnel Integration)', () => {
  // =========================================================================
  // 1. Cross-Module YAML Parsing, Interpolation & Transport Resolution
  // =========================================================================
  describe('1. Cross-Module Manifest Resolution & Spoofing Defense', () => {
    it('parses and resolves heterogeneous tool manifest with spoofed vs authentic endpoints', () => {
      const manifestYaml = `
version: 1
tools:
  - name: spoofed-10-attacker
    type: http
    url: https://10.attacker.com:8443/mcp
    tunnel:
      mode: auto

  - name: spoofed-192-attacker
    type: http
    url: https://192.168.evil.org/api
    tunnel:
      mode: auto

  - name: spoofed-172-attacker
    type: http
    url: https://172.16.fake.net/v1
    tunnel:
      mode: auto

  - name: authentic-10-private
    type: http
    url: https://10.0.1.5:8080/mcp
    tunnel:
      mode: auto

  - name: authentic-172-private
    type: http
    url: https://172.16.1.1:8080/v1
    tunnel:
      mode: auto

  - name: authentic-192-private
    type: http
    url: https://192.168.1.10:8000/api
    tunnel:
      mode: auto

  - name: authentic-ipv6-loopback
    type: http
    url: http://[::1]:8080/mcp
    tunnel:
      mode: auto

  - name: authentic-ipv6-link-local
    type: http
    url: http://[fe80::1]:8080/mcp
    tunnel:
      mode: auto

  - name: authentic-ipv6-ula-fd
    type: http
    url: http://[fd00::1]:8080/mcp
    tunnel:
      mode: auto

  - name: authentic-ipv6-ula-fc
    type: http
    url: http://[fc00::abcd]:8080/mcp
    tunnel:
      mode: auto

  - name: public-ipv6-endpoint
    type: http
    url: http://[2001:db8::1]:8080/mcp
    tunnel:
      mode: auto

  - name: authentic-tailscale-node
    type: http
    url: https://worker-node.corp.ts.net:8443/mcp
    tunnel:
      mode: auto

  - name: spoofed-tailscale-subdomain
    type: http
    url: https://ts.net.attacker.com/mcp
    tunnel:
      mode: auto

  - name: spoofed-tailscale-path
    type: http
    url: https://attacker.com/ts.net/endpoint
    tunnel:
      mode: auto

  - name: public-openrouter-inference
    type: inference
    url: https://openrouter.ai/api/v1
    tunnel:
      mode: auto
`;

      const parsed = parseToolingConfigYaml(manifestYaml, {});
      assert.equal(parsed.tools.length, 15);

      const toolMap = new Map(parsed.tools.map((t) => [t.name, resolveToolConnection(t)]));

      // Assert spoofed domains resolve to direct HTTPS (Finding 1 & 2 fixes)
      assert.equal(toolMap.get('spoofed-10-attacker')?.tunnelMode, 'direct');
      assert.equal(toolMap.get('spoofed-192-attacker')?.tunnelMode, 'direct');
      assert.equal(toolMap.get('spoofed-172-attacker')?.tunnelMode, 'direct');
      assert.equal(toolMap.get('spoofed-tailscale-subdomain')?.tunnelMode, 'direct');
      assert.equal(toolMap.get('spoofed-tailscale-path')?.tunnelMode, 'direct');
      assert.equal(toolMap.get('public-ipv6-endpoint')?.tunnelMode, 'direct');
      assert.equal(toolMap.get('public-openrouter-inference')?.tunnelMode, 'direct');

      // Assert authentic private endpoints resolve to cloudflare or tailscale
      assert.equal(toolMap.get('authentic-10-private')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-172-private')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-192-private')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-ipv6-loopback')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-ipv6-link-local')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-ipv6-ula-fd')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-ipv6-ula-fc')?.tunnelMode, 'cloudflare');
      assert.equal(toolMap.get('authentic-tailscale-node')?.tunnelMode, 'tailscale');
    });
  });

  // =========================================================================
  // 2. Header Case Sensitivity & User Override Protection in YAML
  // =========================================================================
  describe('2. Header Case Sensitivity & User Override Protection in YAML', () => {
    it('preserves user custom headers in YAML with lowercase cf-access-client-id', () => {
      const yaml = `
tools:
  - name: custom-header-tool
    type: http
    url: https://internal-vault.corp/v1
    tunnel:
      mode: cloudflare
      headers:
        cf-access-client-id: "user-defined-client-id"
        cf-access-client-secret: "user-defined-client-secret"
`;
      const parsed = parseToolingConfigYaml(yaml, {});
      const globalDefaults = {
        cfAccessClientId: 'global-env-client-id',
        cfAccessClientSecret: 'global-env-client-secret',
      };

      const resolved = resolveToolConnection(parsed.tools[0], globalDefaults);

      // User headers must NOT be overwritten by global credentials
      assert.equal(resolved.headers['cf-access-client-id'], 'user-defined-client-id');
      assert.equal(resolved.headers['cf-access-client-secret'], 'user-defined-client-secret');
      // Must not create duplicate keys with differing casing
      assert.equal(resolved.headers['CF-Access-Client-Id'], undefined);
      assert.equal(resolved.headers['CF-Access-Client-Secret'], undefined);
    });

    it('preserves user custom headers in YAML with uppercase CF-ACCESS-CLIENT-ID', () => {
      const yaml = `
tools:
  - name: upper-header-tool
    type: http
    url: https://10.244.0.15:9090/query
    tunnel:
      mode: auto
      headers:
        CF-ACCESS-CLIENT-ID: "UPPER-TOKEN-ID"
        CF-ACCESS-CLIENT-SECRET: "UPPER-TOKEN-SECRET"
`;
      const parsed = parseToolingConfigYaml(yaml, {});
      const globalDefaults = {
        cfAccessClientId: 'default-id',
        cfAccessClientSecret: 'default-secret',
      };

      const resolved = resolveToolConnection(parsed.tools[0], globalDefaults);

      assert.equal(resolved.headers['CF-ACCESS-CLIENT-ID'], 'UPPER-TOKEN-ID');
      assert.equal(resolved.headers['CF-ACCESS-CLIENT-SECRET'], 'UPPER-TOKEN-SECRET');
      assert.equal(resolved.headers['CF-Access-Client-Id'], undefined);
      assert.equal(resolved.headers['CF-Access-Client-Secret'], undefined);
    });

    it('injects standard CF-Access headers when tool does not specify any existing auth headers', () => {
      const yaml = `
tools:
  - name: standard-auth-tool
    type: http
    url: https://10.0.0.1:8080/api
    tunnel:
      mode: auto
      headers:
        X-Custom-Header: "hello-world"
`;
      const parsed = parseToolingConfigYaml(yaml, {});
      const globalDefaults = {
        cfAccessClientId: 'global-injected-id',
        cfAccessClientSecret: 'global-injected-secret',
      };

      const resolved = resolveToolConnection(parsed.tools[0], globalDefaults);

      assert.equal(resolved.headers['X-Custom-Header'], 'hello-world');
      assert.equal(resolved.headers['CF-Access-Client-Id'], 'global-injected-id');
      assert.equal(resolved.headers['CF-Access-Client-Secret'], 'global-injected-secret');
    });
  });

  // =========================================================================
  // 3. Credential Completeness Enforcement via YAML & Env Interpolation
  // =========================================================================
  describe('3. Credential Completeness Enforcement via YAML & Interpolation', () => {
    it('throws error when tool YAML specifies only access_client_id on auto-resolved internal tool', () => {
      const yaml = `
tools:
  - name: partial-cred-tool
    type: http
    url: https://192.168.1.50/mcp
    tunnel:
      mode: auto
      cloudflare:
        access_client_id: "\${GIVEN_ID}"
`;
      const parsed = parseToolingConfigYaml(yaml, { GIVEN_ID: 'id-123' });
      assert.throws(
        () => resolveToolConnection(parsed.tools[0], {}),
        /Incomplete Cloudflare Access credentials for tool "partial-cred-tool"/
      );
    });

    it('throws error when tool YAML specifies only access_client_secret on explicit cloudflare tool', () => {
      const yaml = `
tools:
  - name: partial-secret-tool
    type: http
    url: https://api.example.com/mcp
    tunnel:
      mode: cloudflare
      cloudflare:
        access_client_secret: "\${GIVEN_SECRET}"
`;
      const parsed = parseToolingConfigYaml(yaml, { GIVEN_SECRET: 'secret-xyz' });
      assert.throws(
        () => resolveToolConnection(parsed.tools[0], {}),
        /Incomplete Cloudflare Access credentials for tool "partial-secret-tool"/
      );
    });

    it('does NOT throw on public tool endpoint in mode: auto when partial credentials are in env', () => {
      const yaml = `
tools:
  - name: public-tool-safe
    type: http
    url: https://api.anthropic.com/v1
    tunnel:
      mode: auto
`;
      const parsed = parseToolingConfigYaml(yaml, {});
      // Global defaults have only client ID (partial)
      const globalDefaults = {
        cfAccessClientId: 'some-ambient-client-id',
      };

      const resolved = resolveToolConnection(parsed.tools[0], globalDefaults);
      // Because it is a public endpoint and mode: auto, it resolves to direct without requiring CF credentials
      assert.equal(resolved.tunnelMode, 'direct');
      assert.equal(resolved.requiresTunnelDaemon, false);
      assert.deepEqual(resolved.headers, {});
    });

    it('resolves cleanly without error when zero Cloudflare credentials exist for internal endpoint (fallback mode)', () => {
      const yaml = `
tools:
  - name: zero-cred-internal-tool
    type: http
    url: https://internal.corp/api
    tunnel:
      mode: auto
`;
      const parsed = parseToolingConfigYaml(yaml, {});
      const resolved = resolveToolConnection(parsed.tools[0], {});

      assert.equal(resolved.tunnelMode, 'cloudflare');
      assert.deepEqual(resolved.headers, {});
      assert.equal(resolved.requiresTunnelDaemon, false);
    });
  });

  // =========================================================================
  // 4. Pathological Inputs, ReDoS Defense & Schema Validation Boundaries
  // =========================================================================
  describe('4. Pathological Inputs, ReDoS Defense & Schema Validation Boundaries', () => {
    it('isIPv4Address handles pathological hostnames with ReDoS resilience and boundaries', () => {
      // 0 octets, 1 octet, 2 octets, 3 octets, 5 octets
      assert.equal(isIPv4Address(''), false);
      assert.equal(isIPv4Address('10'), false);
      assert.equal(isIPv4Address('10.0'), false);
      assert.equal(isIPv4Address('10.0.0'), false);
      assert.equal(isIPv4Address('10.0.0.1.5'), false);

      // Non-numeric tokens
      assert.equal(isIPv4Address('10.0.0.a'), false);
      assert.equal(isIPv4Address('10.0.foo.1'), false);
      assert.equal(isIPv4Address('10.0.-1.1'), false);
      assert.equal(isIPv4Address('10.0.+1.1'), false);

      // Out of range (256, 999999)
      assert.equal(isIPv4Address('10.0.0.256'), false);
      assert.equal(isIPv4Address('256.0.0.1'), false);
      assert.equal(isIPv4Address('192.168.1.99999'), false);

      // Valid boundary values (0.0.0.0, 255.255.255.255)
      assert.equal(isIPv4Address('0.0.0.0'), true);
      assert.equal(isIPv4Address('255.255.255.255'), true);
      assert.equal(isIPv4Address('127.0.0.1'), true);
    });

    it('isTailscaleUrl handles pathological URL strings without crashing', () => {
      assert.equal(isTailscaleUrl(''), false);
      assert.equal(isTailscaleUrl('not a url'), false);
      assert.equal(isTailscaleUrl('http://'), false);
      assert.equal(isTailscaleUrl('https://evil.ts.net.com'), false);
      assert.equal(isTailscaleUrl('https://ts.net:8443'), true);
      assert.equal(isTailscaleUrl('https://host.ts.net:8443'), true);
      assert.equal(isTailscaleUrl('https://deep.sub.corp.ts.net'), true);
      assert.equal(isTailscaleUrl('https://evil.com?param=sub.ts.net'), false);
      assert.equal(isTailscaleUrl('https://evil.com/#/sub.ts.net'), false);
    });

    it('parses massive 50-tool manifest with nested interpolations within 50ms', () => {
      let yaml = 'version: 1\ntools:\n';
      const env: Record<string, string> = {};

      for (let i = 0; i < 50; i++) {
        const varName = `TOOL_URL_${i}`;
        env[varName] = i % 2 === 0 ? `https://10.0.${i}.1:8080/mcp` : `https://api.tool-${i}.com/v1`;
        yaml += `  - name: generated-tool-${i}\n`;
        yaml += `    type: ${i % 3 === 0 ? 'mcp' : 'http'}\n`;
        yaml += `    url: "\${${varName}}"\n`;
        yaml += `    tunnel:\n`;
        yaml += `      mode: auto\n`;
        yaml += `      timeout_ms: ${5000 + i * 100}\n`;
        yaml += `      headers:\n`;
        yaml += `        X-Tool-Id: "id-${i}"\n`;
      }

      const t0 = performance.now();
      const parsed = parseToolingConfigYaml(yaml, env);
      const elapsed = performance.now() - t0;

      assert.equal(parsed.tools.length, 50);
      assert.ok(elapsed < 1000, `YAML parsing took ${elapsed.toFixed(2)}ms, expected < 1000ms`);

      // Verify connection resolution across all 50 tools
      for (let i = 0; i < 50; i++) {
        const resolved = resolveToolConnection(parsed.tools[i]);
        if (i % 2 === 0) {
          assert.equal(resolved.tunnelMode, 'cloudflare');
        } else {
          assert.equal(resolved.tunnelMode, 'direct');
        }
        assert.equal(resolved.headers['X-Tool-Id'], `id-${i}`);
      }
    });

    it('resolves unbraced fallback chains (${VAR_A:-$VAR_B}) across unset, fallback, and populated branches', () => {
      const template = '${VAR_A:-$VAR_B}';
      assert.equal(interpolateEnvVars(template, {}), '');
      assert.equal(interpolateEnvVars(template, { VAR_B: 'fallback_b' }), 'fallback_b');
      assert.equal(interpolateEnvVars(template, { VAR_A: 'primary_a' }), 'primary_a');
      assert.equal(interpolateEnvVars(template, { VAR_A: 'primary_a', VAR_B: 'fallback_b' }), 'primary_a');
    });

    it('resolves 5-level recursive environment variable chains cleanly without grammar ambiguity', () => {
      const chainEnv = {
        L1: '${L2}',
        L2: '${L3}',
        L3: '${L4}',
        L4: '${L5}',
        L5: 'deep_terminal_val',
      };
      assert.equal(interpolateEnvVars('${L1}', chainEnv), 'deep_terminal_val');
    });

    it('documents braced fallback delimiter boundary when all variables are unset', () => {
      // When all outer variables in a nested braced fallback are unset, regex terminates at inner brace
      // and passes leftover braces forward, resolving terminal fallback cleanly
      const template = '${VAR_A:-${VAR_B:-${VAR_C:-level_3_reached}}}';
      assert.equal(interpolateEnvVars(template, {}), 'level_3_reached');
    });

    it('handles special characters, newlines, JSON strings, and emoji values safely in env vars', () => {
      const env = {
        JSON_PAYLOAD: '{"key":"value","count":42}',
        SPECIAL_CHARS: '<>&"\'/\\=$%^&*()',
        EMOJI_DATA: '🛡️-shield-token-🚀',
      };
      const yaml = `
tools:
  - name: special-chars-tool
    type: http
    url: https://api.com/v1
    options:
      json: '\${JSON_PAYLOAD}'
      special: '\${SPECIAL_CHARS}'
      emoji: '\${EMOJI_DATA}'
`;
      const parsed = parseToolingConfigYaml(yaml, env);
      assert.equal(parsed.tools[0].options?.json, '{"key":"value","count":42}');
      assert.equal(parsed.tools[0].options?.special, '<>&"\'/\\=$%^&*()');
      assert.equal(parsed.tools[0].options?.emoji, '🛡️-shield-token-🚀');
    });

    it('handles YAML anchors and aliases with overridden properties safely across tools', () => {
      const anchorYaml = `
shared_tunnel: &shared_config
  mode: auto
  timeout_ms: 8000
  headers:
    X-Shared: "true"

tools:
  - name: inherited-tool
    type: http
    url: https://10.0.0.5/api
    tunnel: *shared_config

  - name: overridden-tool
    type: http
    url: https://10.0.0.5/api
    tunnel:
      mode: direct
      timeout_ms: 12000
      headers:
        X-Shared: "overridden"
`;
      const parsed = parseToolingConfigYaml(anchorYaml, {});
      const conn1 = resolveToolConnection(parsed.tools[0]);
      const conn2 = resolveToolConnection(parsed.tools[1]);

      // Tool 1 gets auto mode on 10.0.0.5 -> cloudflare
      assert.equal(conn1.tunnelMode, 'cloudflare');
      assert.equal(conn1.timeoutMs, 8000);
      assert.equal(conn1.headers['X-Shared'], 'true');

      // Tool 2 explicitly overrides mode: direct
      assert.equal(conn2.tunnelMode, 'direct');
      assert.equal(conn2.timeoutMs, 12000);
      assert.equal(conn2.headers['X-Shared'], 'overridden');
    });
  });
});
