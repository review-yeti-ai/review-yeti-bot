import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  interpolateEnvVars,
  interpolateObject,
  parseToolingConfigYaml,
  resolveToolConnection,
  validateToolingConfig,
  extractReferencedEnvVars,
  type ToolDefinition,
} from '../src/tunnel/toolTunnelDefinition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getExampleYamlPath(): string {
  const candidates = [
    resolve(__dirname, '../../examples/mcp-tooling-tunnel-config.yaml'),
    resolve(__dirname, '../examples/mcp-tooling-tunnel-config.yaml'),
    resolve(process.cwd(), 'examples/mcp-tooling-tunnel-config.yaml'),
    resolve(process.cwd(), 'packages/cf-orchestrator/examples/mcp-tooling-tunnel-config.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot locate examples/mcp-tooling-tunnel-config.yaml. Tried: ${candidates.join(', ')}`);
}

describe('Tool & MCP Tunnel YAML Definition', () => {
  // =========================================================================
  // 1. Environment Variable Interpolation
  // =========================================================================
  describe('interpolateEnvVars', () => {
    it('interpolates environment variables properly with braced and unbraced tokens', () => {
      const env = {
        MY_SECRET: 'secret_123',
        ENDPOINT_HOST: 'internal.corp',
      };

      const template = 'https://${ENDPOINT_HOST}/api with $MY_SECRET';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, 'https://internal.corp/api with secret_123');
    });

    it('resolves fallback default values using ${VAR:-default} when variable is unset', () => {
      const env = {};
      const template = 'https://${HOST:-localhost}:${PORT:-8080}/v1';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, 'https://localhost:8080/v1');
    });

    it('resolves fallback default values using ${VAR:default} when variable is unset', () => {
      const env = {};
      const template = 'https://${HOST:localhost}:${PORT:8080}/v1';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, 'https://localhost:8080/v1');
    });

    it('uses environment variable value over fallback default when variable is set', () => {
      const env = { HOST: 'remote.corp', PORT: '9000' };
      const template = 'https://${HOST:-localhost}:${PORT:-8080}/v1';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, 'https://remote.corp:9000/v1');
    });

    it('uses fallback default when variable is set to empty string', () => {
      const env = { HOST: '', PORT: '9000' };
      const template = 'https://${HOST:-localhost}:${PORT:-8080}/v1';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, 'https://localhost:9000/v1');
    });

    it('resolves ${VAR:-} to empty string when unset', () => {
      const result = interpolateEnvVars('path/${EMPTY_FALLBACK:-}/done', {});
      assert.equal(result, 'path//done');
    });

    it('resolves undefined variables to empty string by default without throwing', () => {
      const result = interpolateEnvVars('https://api.com/${UNDEFINED_VAR}', {});
      assert.equal(result, 'https://api.com/');
    });

    it('resolves braced variable set to empty string without fallback', () => {
      const result = interpolateEnvVars('https://api.com/${EMPTY_VAL}/end', { EMPTY_VAL: '' });
      assert.equal(result, 'https://api.com//end');
    });

    it('resolves undefined unbraced variable to empty string by default', () => {
      const result = interpolateEnvVars('https://api.com/$UNDEFINED_VAR/end', {});
      assert.equal(result, 'https://api.com//end');
    });

    it('throws error on missing environment variable when strictEnv is true', () => {
      assert.throws(
        () => interpolateEnvVars('https://api.com/${REQUIRED_SECRET}', {}, { strictEnv: true }),
        /Missing required environment variable: REQUIRED_SECRET/
      );
    });

    it('throws error on missing unbraced variable when strictEnv is true', () => {
      assert.throws(
        () => interpolateEnvVars('https://api.com/$REQUIRED_SECRET/v1', {}, { strictEnv: true }),
        /Missing required environment variable: REQUIRED_SECRET/
      );
    });

    it('invokes custom onMissingEnv callback when provided', () => {
      const result = interpolateEnvVars(
        'https://${MISSING}/endpoint with $ALSO_MISSING',
        {},
        { onMissingEnv: (v) => `[MISSING_${v}]` }
      );
      assert.equal(result, 'https://[MISSING_MISSING]/endpoint with [MISSING_ALSO_MISSING]');
    });

    it('preserves undefined variable tokens when onMissingEnv is "preserve"', () => {
      const result = interpolateEnvVars(
        'https://${PRESERVED_VAR}/endpoint with $PRESERVED_UNBRACED',
        {},
        { onMissingEnv: 'preserve' }
      );
      assert.equal(result, 'https://${PRESERVED_VAR}/endpoint with $PRESERVED_UNBRACED');
    });

    it('throws error when onMissingEnv is "throw"', () => {
      assert.throws(
        () => interpolateEnvVars('https://${ERR}/endpoint', {}, { onMissingEnv: 'throw' }),
        /Missing required environment variable: ERR/
      );
      assert.throws(
        () => interpolateEnvVars('https://$ERR/endpoint', {}, { onMissingEnv: 'throw' }),
        /Missing required environment variable: ERR/
      );
    });

    it('preserves escaped tokens \\${VAR} and $$VAR without expanding', () => {
      const result = interpolateEnvVars(
        'literal \\${DO_NOT_EXPAND} and $$ESCAPED_DOLLAR and \\${ESCAPE_WITH_DEF:-default}',
        { DO_NOT_EXPAND: 'fail', ESCAPED_DOLLAR: 'fail', ESCAPE_WITH_DEF: 'fail' }
      );
      assert.equal(result, 'literal ${DO_NOT_EXPAND} and $ESCAPED_DOLLAR and ${ESCAPE_WITH_DEF:-default}');
    });

    it('performs recursive/chained expansion of nested variable references', () => {
      const env = {
        PROTO: 'https',
        DOMAIN: 'api.example.com',
        BASE_URL: '${PROTO}://${DOMAIN}',
      };
      const result = interpolateEnvVars('${BASE_URL}/v1/chat', env);
      assert.equal(result, 'https://api.example.com/v1/chat');
    });

    it('terminates recursive expansion at maxInterpolationDepth on circular references', () => {
      const env = {
        LOOP_A: '${LOOP_B}',
        LOOP_B: '${LOOP_A}',
      };
      const result = interpolateEnvVars('${LOOP_A}', env, { maxInterpolationDepth: 3 });
      assert.ok(typeof result === 'string');
    });

    it('handles non-string or falsy input gracefully', () => {
      assert.equal(interpolateEnvVars('', {}), '');
      assert.equal(interpolateEnvVars(null as any, {}), null);
      assert.equal(interpolateEnvVars(undefined as any, {}), undefined);
    });

    it('handles strings without variable patterns and with bare dollar signs', () => {
      assert.equal(interpolateEnvVars('Cost is $ 10 or 100$', {}), 'Cost is $ 10 or 100$');
      assert.equal(interpolateEnvVars('Literal $ with no var', {}), 'Literal $ with no var');
    });
  });

  // =========================================================================
  // 2. Object & Tree Interpolation
  // =========================================================================
  describe('interpolateObject', () => {
    it('recursively interpolates strings inside nested objects and arrays', () => {
      const env = { KEY: 'secret-val', NUM: '42' };
      const input = {
        headers: { Authorization: 'Bearer ${KEY}' },
        tags: ['prefix-${NUM}', 'static'],
        nested: { inner: '$KEY' },
        count: 10,
        active: true,
      };

      const result = interpolateObject(input, env);
      assert.equal(result.headers.Authorization, 'Bearer secret-val');
      assert.equal(result.tags[0], 'prefix-42');
      assert.equal(result.tags[1], 'static');
      assert.equal(result.nested.inner, 'secret-val');
      assert.equal(result.count, 10);
      assert.equal(result.active, true);
    });

    it('interpolates object keys containing environment variables', () => {
      const env = { DYNAMIC_KEY: 'X-Custom-Auth', BARE_KEY: 'X-Bare' };
      const input: Record<string, any> = {
        '${DYNAMIC_KEY}': 'token-value',
        '$BARE_KEY': 'bare-value',
        'staticKey': 'static-value',
      };
      const result = interpolateObject(input, env);
      assert.equal(result['X-Custom-Auth'], 'token-value');
      assert.equal(result['X-Bare'], 'bare-value');
      assert.equal(result['staticKey'], 'static-value');
    });

    it('handles circular references in objects and arrays safely via WeakSet', () => {
      const obj: any = { a: 'val-${NUM}' };
      obj.self = obj;
      const arr: any = ['val-${NUM}'];
      arr.push(arr);

      const env = { NUM: '99' };
      const resObj = interpolateObject(obj, env);
      assert.equal(resObj.a, 'val-99');
      assert.equal(resObj.self, obj);

      const resArr = interpolateObject(arr, env);
      assert.equal(resArr[0], 'val-99');
      assert.equal(resArr[1], arr);
    });

    it('returns primitives and null as-is', () => {
      assert.equal(interpolateObject(123 as any, {}), 123);
      assert.equal(interpolateObject(true as any, {}), true);
      assert.equal(interpolateObject(null as any, {}), null);
      assert.equal(interpolateObject(undefined as any, {}), undefined);
    });
  });

  // =========================================================================
  // 3. Referenced Variable Extraction
  // =========================================================================
  describe('extractReferencedEnvVars', () => {
    it('extracts unique, sorted variable names from YAML string', () => {
      const yaml = `
tools:
  - name: bifrost
    url: https://\${HOST}/v1
    tunnel:
      cloudflare:
        access_client_id: "\${CF_CLIENT_ID}"
        access_client_secret: "$CF_CLIENT_SECRET"
        tunnel_token: "\${CF_TOKEN:-default_tok}"
`;
      const vars = extractReferencedEnvVars(yaml);
      assert.deepEqual(vars, ['CF_CLIENT_ID', 'CF_CLIENT_SECRET', 'CF_TOKEN', 'HOST']);
    });

    it('extracts variable names from parsed object tree', () => {
      const obj = {
        url: 'https://${ENDPOINT}/api',
        headers: { Auth: 'Bearer $TOKEN' },
        nested: [{ key: '${NESTED_KEY}' }],
      };
      const vars = extractReferencedEnvVars(obj);
      assert.deepEqual(vars, ['ENDPOINT', 'NESTED_KEY', 'TOKEN']);
    });

    it('returns empty array when no variables are present', () => {
      assert.deepEqual(extractReferencedEnvVars('plain string without vars'), []);
    });

    it('ignores escaped tokens \\${VAR} and $$VAR', () => {
      const str = 'literal \\${DO_NOT_EXTRACT} and $$IGNORE_ME but ${EXTRACT_ME}';
      const vars = extractReferencedEnvVars(str);
      assert.deepEqual(vars, ['EXTRACT_ME']);
    });

    it('handles circular objects and arrays without infinite recursion', () => {
      const circularObj: any = { a: '${VAR_A}' };
      circularObj.child = circularObj;
      const circularArr: any = ['${VAR_B}'];
      circularArr.push(circularArr);

      assert.deepEqual(extractReferencedEnvVars(circularObj), ['VAR_A']);
      assert.deepEqual(extractReferencedEnvVars(circularArr), ['VAR_B']);
    });
  });

  // =========================================================================
  // 4. YAML Parsing & Schema Validation
  // =========================================================================
  describe('parseToolingConfigYaml & validateToolingConfig', () => {
    it('parses valid tooling YAML file and expands env vars', () => {
      const yamlPath = getExampleYamlPath();
      const content = readFileSync(yamlPath, 'utf-8');

      const fakeEnv = {
        CF_ACCESS_CLIENT_ID: 'cf-id-abc',
        CF_ACCESS_CLIENT_SECRET: 'cf-secret-xyz',
        CLOUDFLARE_TUNNEL_TOKEN: 'cf-token-123',
        TAILSCALE_AUTH_KEY: 'ts-key-456',
      };

      const parsed = parseToolingConfigYaml(content, fakeEnv);
      assert.equal(parsed.version, 1);
      assert.ok(Array.isArray(parsed.tools));
      assert.equal(parsed.tools.length, 6);

      // Verify Cloudflare tool interpolated
      const bifrost = parsed.tools.find((t) => t.name === 'bifrost-llm-gateway')!;
      assert.equal(bifrost.tunnel?.cloudflare?.access_client_id, 'cf-id-abc');
      assert.equal(bifrost.tunnel?.cloudflare?.access_client_secret, 'cf-secret-xyz');

      // Verify Tailscale tool interpolated
      const honcho = parsed.tools.find((t) => t.name === 'honcho-memory-mcp')!;
      assert.equal(honcho.tunnel?.tailscale?.auth_key, 'ts-key-456');
    });

    it('allows bypassing schema validation when validateSchema is false', () => {
      const yaml = 'tools:\n  - name: test\n    type: custom_unsupported';
      const parsed = parseToolingConfigYaml(yaml, {}, { validateSchema: false });
      assert.equal(parsed.tools[0].name, 'test');
    });

    it('throws descriptive error on malformed YAML syntax', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools: [unclosed array'),
        /Invalid tooling YAML syntax/
      );
    });

    it('throws descriptive error on empty YAML string or comments only', () => {
      assert.throws(
        () => parseToolingConfigYaml(''),
        /Invalid tooling YAML: expected root object/
      );
      assert.throws(
        () => parseToolingConfigYaml('   \n\n  '),
        /Invalid tooling YAML: expected root object/
      );
      assert.throws(
        () => parseToolingConfigYaml('# only comments\n# nothing else'),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('throws descriptive error when YAML root is a primitive or array', () => {
      assert.throws(
        () => parseToolingConfigYaml('just-a-string'),
        /Invalid tooling YAML: expected root object/
      );
      assert.throws(
        () => parseToolingConfigYaml('12345'),
        /Invalid tooling YAML: expected root object/
      );
      assert.throws(
        () => parseToolingConfigYaml('true'),
        /Invalid tooling YAML: expected root object/
      );
      assert.throws(
        () => parseToolingConfigYaml('- array_item_1\n- array_item_2'),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('throws descriptive error on malformed YAML missing tools list', () => {
      assert.throws(
        () => parseToolingConfigYaml('invalid: true\nnot_tools: []'),
        { message: /missing or invalid 'tools' array/ }
      );
      assert.throws(
        () => parseToolingConfigYaml('tools: "not-an-array"'),
        { message: /missing or invalid 'tools' array/ }
      );
    });

    it('accepts empty tools array as valid configuration', () => {
      const config = parseToolingConfigYaml('version: 1\ntools: []');
      assert.equal(config.tools.length, 0);
    });

    it('throws error when a tool element is null or non-object', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - null'),
        /expected tool object/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - "string-item"'),
        /expected tool object/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - [1, 2, 3]'),
        /expected tool object/
      );
    });

    it('throws error when tool name is missing, empty, or not a string', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: ""\n    type: http'),
        /missing or empty 'name'/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: "   "\n    type: http'),
        /missing or empty 'name'/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - type: http'),
        /missing or empty 'name'/
      );
    });

    it('throws error on duplicate tool names', () => {
      const yaml = `
tools:
  - name: tool-a
    type: http
  - name: tool-a
    type: mcp
`;
      assert.throws(
        () => parseToolingConfigYaml(yaml),
        /duplicate tool name 'tool-a'/
      );
    });

    it('throws error on invalid tool type', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: tool-x\n    type: unknown_type'),
        /invalid type 'unknown_type'/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: tool-x\n    type: 123'),
        /invalid type '123'/
      );
    });

    it('accepts all valid tool types: mcp, http, sse, stdio, inference', () => {
      const yaml = `
tools:
  - name: t1
    type: mcp
  - name: t2
    type: http
  - name: t3
    type: sse
  - name: t4
    type: stdio
  - name: t5
    type: inference
`;
      const config = parseToolingConfigYaml(yaml);
      assert.equal(config.tools.length, 5);
    });

    it('validates tool attributes: url, enabled, tunnel, timeout_ms, headers', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    url: 123'),
        /'url' must be a string/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    enabled: "yes"'),
        /'enabled' must be a boolean/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel: "invalid"'),
        /'tunnel' must be an object/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel:\n      mode: bad-mode'),
        /Invalid tunnel mode 'bad-mode'/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel:\n      mode: direct\n      timeout_ms: -50'),
        /must be a non-negative number/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel:\n      mode: direct\n      headers: "not-a-map"'),
        /must be an object map/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel:\n      mode: direct\n      headers:\n        X-Num: 123'),
        /expected string/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel:\n      mode: cloudflare\n      cloudflare: "str"'),
        /must be an object/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: t1\n    type: http\n    tunnel:\n      mode: tailscale\n      tailscale: "str"'),
        /must be an object/
      );
    });

    it('validates standalone validateToolingConfig call directly', () => {
      assert.throws(() => validateToolingConfig(null), /expected root object/);
      assert.throws(() => validateToolingConfig([]), /expected root object/);
      assert.throws(() => validateToolingConfig({ not_tools: [] }), /missing or invalid 'tools' array/);
    });
  });

  // =========================================================================
  // 5. Connection Resolution
  // =========================================================================
  describe('resolveToolConnection', () => {
    it('resolves direct public tool connection', () => {
      const tool: ToolDefinition = {
        name: 'openrouter-llm',
        type: 'inference',
        url: 'https://openrouter.ai/api/v1',
        tunnel: { mode: 'direct', timeout_ms: 120000 },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.name, 'openrouter-llm');
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.timeoutMs, 120000);
      assert.equal(res.requiresTunnelDaemon, false);
      assert.deepEqual(res.headers, {});
    });

    it('resolves explicit mode: none with direct settings', () => {
      const tool: ToolDefinition = {
        name: 'local-test',
        type: 'http',
        url: 'http://localhost:8080',
        tunnel: { mode: 'none' },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.requiresTunnelDaemon, false);
    });

    it('resolves mode: auto with public endpoint to direct fallback', () => {
      const tool: ToolDefinition = {
        name: 'public-api',
        type: 'http',
        url: 'https://api.github.com',
        tunnel: { mode: 'auto' },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.requiresTunnelDaemon, false);
    });

    it('resolves Cloudflare Tunnel connection with access headers', () => {
      const tool: ToolDefinition = {
        name: 'bifrost-llm-gateway',
        type: 'inference',
        url: 'https://gateway-internal.example.com/v1',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: {
            access_client_id: 'client_id_test',
            access_client_secret: 'client_secret_test',
          },
          headers: { 'X-Custom-Header': 'hello' },
          timeout_ms: 45000,
        },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'cloudflare');
      assert.equal(res.headers['CF-Access-Client-Id'], 'client_id_test');
      assert.equal(res.headers['CF-Access-Client-Secret'], 'client_secret_test');
      assert.equal(res.headers['X-Custom-Header'], 'hello');
      assert.equal(res.timeoutMs, 45000);
    });

    it('resolves Cloudflare Tunnel using global defaults (both flat and structured)', () => {
      const tool: ToolDefinition = {
        name: 'internal-service',
        type: 'http',
        url: 'https://internal.service.local',
        tunnel: { mode: 'cloudflare' },
      };

      // Flat defaults
      const resFlat = resolveToolConnection(tool, {
        cfAccessClientId: 'global-cf-id',
        cfAccessClientSecret: 'global-cf-secret',
      });
      assert.equal(resFlat.tunnelMode, 'cloudflare');
      assert.equal(resFlat.headers['CF-Access-Client-Id'], 'global-cf-id');
      assert.equal(resFlat.headers['CF-Access-Client-Secret'], 'global-cf-secret');

      // Structured defaults
      const resStructured = resolveToolConnection(tool, {
        cloudflare: {
          access_client_id: 'global-cf-id-struct',
          access_client_secret: 'global-cf-secret-struct',
        },
      });
      assert.equal(resStructured.tunnelMode, 'cloudflare');
      assert.equal(resStructured.headers['CF-Access-Client-Id'], 'global-cf-id-struct');
      assert.equal(resStructured.headers['CF-Access-Client-Secret'], 'global-cf-secret-struct');
    });

    it('sets requiresTunnelDaemon true for Cloudflare when tunnel_token is present', () => {
      const tool: ToolDefinition = {
        name: 'bifrost',
        type: 'http',
        url: 'https://bifrost.internal',
        tunnel: {
          mode: 'cloudflare',
          cloudflare: { tunnel_token: 'cf-tunnel-tok-123' },
        },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.requiresTunnelDaemon, true);
    });

    it('resolves Tailscale connection for .ts.net services', () => {
      const tool: ToolDefinition = {
        name: 'honcho-memory-mcp',
        type: 'mcp',
        url: 'https://honcho.tailebe851.ts.net/sse',
        tunnel: {
          mode: 'tailscale',
          tailscale: { auth_key: 'tskey-auth-live' },
        },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'tailscale');
      assert.equal(res.requiresTunnelDaemon, true);
    });

    it('resolves Tailscale using global defaults', () => {
      const tool: ToolDefinition = {
        name: 'honcho-memory-mcp',
        type: 'mcp',
        url: 'https://honcho.tailebe851.ts.net/sse',
        tunnel: { mode: 'tailscale' },
      };

      const res = resolveToolConnection(tool, { tailscaleAuthKey: 'ts-global-key' });
      assert.equal(res.tunnelMode, 'tailscale');
      assert.equal(res.requiresTunnelDaemon, true);
    });

    it('resolves mode: auto with .ts.net URL to Tailscale transport', () => {
      const tool: ToolDefinition = {
        name: 'honcho-auto',
        type: 'mcp',
        url: 'https://honcho.node.ts.net/sse',
        tunnel: { mode: 'auto' },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'tailscale');
    });

    it('resolves mode: auto with internal endpoint to Cloudflare transport', () => {
      const tool: ToolDefinition = {
        name: 'cluster-service',
        type: 'http',
        url: 'http://svc.internal.example.internal:8080',
        tunnel: { mode: 'auto' },
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.tunnelMode, 'cloudflare');
    });

    it('defaults URL to empty string and tunnel to auto if omitted for stdio tools', () => {
      const tool: ToolDefinition = {
        name: 'minimal-tool',
        type: 'stdio',
      };

      const res = resolveToolConnection(tool);
      assert.equal(res.url, '');
      assert.equal(res.tunnelMode, 'direct');
      assert.equal(res.timeoutMs, 30000);
    });
  });
});
