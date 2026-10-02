import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolateEnvVars,
  interpolateObject,
  parseToolingConfigYaml,
  validateToolingConfig,
  extractReferencedEnvVars,
  resolveToolConnection,
} from '../src/tunnel/toolTunnelDefinition.js';

describe('Adversarial Challenge: YAML Parser & Env Interpolation Engine', () => {
  // =========================================================================
  // 1. Circular Reference Loops
  // =========================================================================
  describe('1. Circular Reference Loops & Termination', () => {
    it('terminates 2-variable cycle cleanly without infinite recursion or stack overflow', () => {
      const env = {
        A: '${B}',
        B: '${A}',
      };
      // Must terminate cleanly within maxInterpolationDepth
      const result = interpolateEnvVars('${A}', env);
      assert.ok(typeof result === 'string');
      // After default 5 iterations, it should stop without crashing
      assert.equal(result, '${B}');
    });

    it('terminates 5-variable circular chain cleanly', () => {
      const env = {
        A: '${B}',
        B: '${C}',
        C: '${D}',
        D: '${E}',
        E: '${A}',
      };
      const result = interpolateEnvVars('${A}', env, { maxInterpolationDepth: 5 });
      assert.ok(typeof result === 'string');
    });

    it('terminates direct self-referencing braced variable cleanly (${A} -> ${A})', () => {
      const env = {
        A: '${A}',
      };
      const result = interpolateEnvVars('${A}', env);
      assert.equal(result, '${A}');
    });

    it('terminates direct self-referencing unbraced variable cleanly ($A -> $A)', () => {
      const env = {
        A: '$A',
      };
      const result = interpolateEnvVars('$A', env);
      assert.equal(result, '$A');
    });

    it('terminates recursive variable with prefix and suffix without memory explosion', () => {
      const env = {
        A: 'pre_${A}_post',
      };
      const result = interpolateEnvVars('${A}', env, { maxInterpolationDepth: 4 });
      assert.ok(typeof result === 'string');
      // Should have repeated 'pre_' and '_post' 4 times
      assert.ok(result.startsWith('pre_pre_pre_pre_'));
    });

    it('respects custom maxInterpolationDepth parameter', () => {
      const env = {
        A: '${B}',
        B: '${C}',
        C: '${D}',
        D: 'final_value',
      };
      // depth = 1: ${A} -> ${B}
      const res1 = interpolateEnvVars('${A}', env, { maxInterpolationDepth: 1 });
      assert.equal(res1, '${B}');

      // depth = 2: ${A} -> ${B} -> ${C}
      const res2 = interpolateEnvVars('${A}', env, { maxInterpolationDepth: 2 });
      assert.equal(res2, '${C}');

      // depth = 4: reaches final_value
      const res4 = interpolateEnvVars('${A}', env, { maxInterpolationDepth: 4 });
      assert.equal(res4, 'final_value');
    });

    it('handles mutually referencing JavaScript objects without stack overflow', () => {
      const objA: any = { name: 'A', token: '${SECRET}' };
      const objB: any = { name: 'B', parent: objA };
      objA.child = objB;

      const env = { SECRET: 'classified' };
      const interpolated = interpolateObject(objA, env);

      assert.equal(interpolated.token, 'classified');
      assert.equal(interpolated.name, 'A');
      assert.equal(interpolated.child.name, 'B');
      // Circular reference is safely broken via WeakSet
      assert.equal(interpolated.child.parent, objA);
    });

    it('handles self-referencing arrays and arrays of arrays without infinite recursion', () => {
      const arr: any[] = ['prefix-${ENV_VAR}', 'second-item'];
      arr.push(arr);

      const env = { ENV_VAR: 'interpolated' };
      const res = interpolateObject(arr, env);

      assert.equal(res[0], 'prefix-interpolated');
      assert.equal(res[1], 'second-item');
      assert.equal(res[2], arr);
    });

    it('extractReferencedEnvVars terminates on circular object graphs without infinite loop', () => {
      const cyclic1: any = { field1: '${VAR_ONE}' };
      const cyclic2: any = { field2: '${VAR_TWO}', ref: cyclic1 };
      cyclic1.ref = cyclic2;

      const vars = extractReferencedEnvVars(cyclic1);
      assert.deepEqual(vars, ['VAR_ONE', 'VAR_TWO']);
    });
  });

  // =========================================================================
  // 2. Deeply Nested Objects & Arrays (>10 levels)
  // =========================================================================
  describe('2. Deeply Nested Structures (>10 levels)', () => {
    it('interpolates tokens in a 15-level deeply nested object structure', () => {
      let currentObj: any = { leaf: 'https://${LEAF_HOST}:${PORT}/api' };
      for (let i = 14; i >= 1; i--) {
        currentObj = { [`level_${i}`]: currentObj, levelNum: i };
      }

      const env = {
        LEAF_HOST: 'deep.internal.corp',
        PORT: '9443',
      };

      const result = interpolateObject(currentObj, env);

      let walker = result;
      for (let i = 1; i <= 14; i++) {
        assert.equal(walker.levelNum, i);
        walker = walker[`level_${i}`];
      }
      assert.equal(walker.leaf, 'https://deep.internal.corp:9443/api');
    });

    it('interpolates tokens in a 20-level deeply nested array structure', () => {
      let currentArr: any = ['deep-token-${LEAF_ID}', 'static-val'];
      for (let i = 0; i < 19; i++) {
        currentArr = [currentArr];
      }

      const env = { LEAF_ID: 'node-99' };
      const result = interpolateObject(currentArr, env);

      let walker = result;
      for (let i = 0; i < 19; i++) {
        assert.ok(Array.isArray(walker));
        walker = walker[0];
      }
      assert.equal(walker[0], 'deep-token-node-99');
      assert.equal(walker[1], 'static-val');
    });

    it('interpolates dynamic object keys at depth 12', () => {
      let currentObj: any = { '${DYNAMIC_KEY}': 'deep-value' };
      for (let i = 11; i >= 1; i--) {
        currentObj = { next: currentObj };
      }

      const env = { DYNAMIC_KEY: 'interpolated_key_name' };
      const result = interpolateObject(currentObj, env);

      let walker = result;
      for (let i = 1; i <= 11; i++) {
        walker = walker.next;
      }
      assert.equal(walker.interpolated_key_name, 'deep-value');
    });

    it('extractReferencedEnvVars discovers all variables across 20-level nested structures', () => {
      let current: any = { key: '${LEVEL_20_VAR}' };
      for (let i = 19; i >= 1; i--) {
        current = {
          branchA: current,
          branchB: [`\${LEVEL_${i}_VAR}`],
        };
      }

      const vars = extractReferencedEnvVars(current);
      assert.ok(vars.includes('LEVEL_20_VAR'));
      assert.ok(vars.includes('LEVEL_1_VAR'));
      assert.ok(vars.includes('LEVEL_10_VAR'));
      assert.equal(vars.length, 20);
    });

    it('parses valid tooling YAML containing >10 levels of nested tool options', () => {
      const nestedYaml = `
tools:
  - name: deep-options-tool
    type: mcp
    url: https://\${HOST}/deep
    options:
      l1:
        l2:
          l3:
            l4:
              l5:
                l6:
                  l7:
                    l8:
                      l9:
                        l10:
                          l11:
                            l12:
                              target: "\${DEEP_TARGET}"
`;
      const env = { HOST: 'example.com', DEEP_TARGET: 'depth-12-reached' };
      const parsed = parseToolingConfigYaml(nestedYaml, env);

      assert.equal(parsed.tools[0].name, 'deep-options-tool');
      assert.equal(parsed.tools[0].url, 'https://example.com/deep');
      const l12 =
        parsed.tools[0].options?.l1?.l2?.l3?.l4?.l5?.l6?.l7?.l8?.l9?.l10?.l11?.l12;
      assert.equal(l12?.target, 'depth-12-reached');
    });
  });

  // =========================================================================
  // 3. Escape Sequences
  // =========================================================================
  describe('3. Escape Sequences (\\${VAR} and $$VAR)', () => {
    it('preserves literal \\${VAR} and does not expand value', () => {
      const env = { VAR: 'EXPANDED_VALUE' };
      const result = interpolateEnvVars('prefix \\${VAR} suffix', env);
      assert.equal(result, 'prefix ${VAR} suffix');
    });

    it('preserves literal $$VAR and does not expand value', () => {
      const env = { VAR: 'EXPANDED_VALUE' };
      const result = interpolateEnvVars('prefix $$VAR suffix', env);
      assert.equal(result, 'prefix $VAR suffix');
    });

    it('preserves literal \\${VAR:-default} with fallback syntax', () => {
      const env = { VAR: 'EXPANDED_VALUE' };
      const result = interpolateEnvVars('escaped \\${VAR:-my_default}', env);
      assert.equal(result, 'escaped ${VAR:-my_default}');
    });

    it('preserves literal \\${VAR:default} with colon fallback syntax', () => {
      const env = { VAR: 'EXPANDED_VALUE' };
      const result = interpolateEnvVars('escaped \\${VAR:my_default}', env);
      assert.equal(result, 'escaped ${VAR:my_default}');
    });

    it('preserves literal \\${VAR:-} with empty fallback syntax', () => {
      const env = { VAR: 'EXPANDED_VALUE' };
      const result = interpolateEnvVars('escaped \\${VAR:-}', env);
      assert.equal(result, 'escaped ${VAR:-}');
    });

    it('handles mixed escaped and unescaped variables in the same string', () => {
      const env = {
        ESCAPED: 'SHOULD_NOT_APPEAR',
        EXPANDED: 'APPEARS_CORRECTLY',
        ANOTHER_ESC: 'NOT_HERE',
      };
      const template = '\\${ESCAPED}_${EXPANDED}_$$ANOTHER_ESC';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, '${ESCAPED}_APPEARS_CORRECTLY_$ANOTHER_ESC');
    });

    it('preserves escaped tokens when parsing YAML manifests with single quotes', () => {
      const yaml = [
        'tools:',
        '  - name: test-tool',
        '    type: http',
        '    url: \'https://api.com/\\${STATIC_LITERAL}/endpoint\'',
      ].join('\n');
      const env = { STATIC_LITERAL: 'FAILED' };
      const parsed = parseToolingConfigYaml(yaml, env);
      assert.equal(parsed.tools[0].url, 'https://api.com/${STATIC_LITERAL}/endpoint');
    });

    it('preserves escaped tokens when parsing YAML manifests with double quotes', () => {
      const yaml = [
        'tools:',
        '  - name: test-tool',
        '    type: http',
        '    url: "https://api.com/\\\\${STATIC_LITERAL}/endpoint"',
      ].join('\n');
      const env = { STATIC_LITERAL: 'FAILED' };
      const parsed = parseToolingConfigYaml(yaml, env);
      assert.equal(parsed.tools[0].url, 'https://api.com/${STATIC_LITERAL}/endpoint');
    });

    it('omits escaped tokens from extractReferencedEnvVars output', () => {
      const text = 'Use \\${IGNORE_ME_1} and $$IGNORE_ME_2 but expand ${EXTRACT_ME} and $ALSO_EXTRACT';
      const vars = extractReferencedEnvVars(text);
      assert.deepEqual(vars, ['ALSO_EXTRACT', 'EXTRACT_ME']);
    });
  });

  // =========================================================================
  // 4. Default Fallbacks
  // =========================================================================
  describe('4. Default Fallbacks (${VAR:-default}, ${VAR:default}, ${VAR:-})', () => {
    it('uses fallback when VAR is undefined (${VAR:-default})', () => {
      const result = interpolateEnvVars('http://${HOST:-localhost}:8080', {});
      assert.equal(result, 'http://localhost:8080');
    });

    it('uses fallback when VAR is empty string (${VAR:-default})', () => {
      const result = interpolateEnvVars('http://${HOST:-localhost}:8080', { HOST: '' });
      assert.equal(result, 'http://localhost:8080');
    });

    it('uses environment variable when VAR is whitespace (${VAR:-default})', () => {
      const result = interpolateEnvVars('val:[${SPACE:-default}]', { SPACE: '   ' });
      assert.equal(result, 'val:[   ]');
    });

    it('uses environment variable when VAR is non-empty (${VAR:-default})', () => {
      const result = interpolateEnvVars('http://${HOST:-localhost}:8080', { HOST: 'prod.service.com' });
      assert.equal(result, 'http://prod.service.com:8080');
    });

    it('uses fallback when VAR is undefined (${VAR:default})', () => {
      const result = interpolateEnvVars('http://${HOST:localhost}:8080', {});
      assert.equal(result, 'http://localhost:8080');
    });

    it('uses fallback when VAR is empty string (${VAR:default})', () => {
      const result = interpolateEnvVars('http://${HOST:localhost}:8080', { HOST: '' });
      assert.equal(result, 'http://localhost:8080');
    });

    it('uses environment variable when VAR is whitespace (${VAR:default})', () => {
      const result = interpolateEnvVars('val:[${SPACE:default}]', { SPACE: '   ' });
      assert.equal(result, 'val:[   ]');
    });

    it('resolves ${VAR:-} to empty string when VAR is undefined', () => {
      const result = interpolateEnvVars('path/${EMPTY:-}/sub', {});
      assert.equal(result, 'path//sub');
    });

    it('resolves ${VAR:-} to empty string when VAR is empty string', () => {
      const result = interpolateEnvVars('path/${EMPTY:-}/sub', { EMPTY: '' });
      assert.equal(result, 'path//sub');
    });

    it('resolves ${VAR:-} to actual value when VAR is set', () => {
      const result = interpolateEnvVars('path/${EMPTY:-}/sub', { EMPTY: 'v1' });
      assert.equal(result, 'path/v1/sub');
    });

    it('resolves fallback containing colons, ports, paths, and query parameters', () => {
      const template = 'url=${ENDPOINT:-http://internal-svc:8080/v1/query?tag=all&format=json}';
      const result = interpolateEnvVars(template, {});
      assert.equal(result, 'url=http://internal-svc:8080/v1/query?tag=all&format=json');
    });

    it('does NOT throw when strictEnv is true if variable has fallback default', () => {
      const template = 'https://${HOST:-default.service.com}/api';
      const result = interpolateEnvVars(template, {}, { strictEnv: true });
      assert.equal(result, 'https://default.service.com/api');
    });

    it('does NOT throw when onMissingEnv is "throw" if variable has fallback default', () => {
      const template = 'https://${HOST:fallback.service.com}/api';
      const result = interpolateEnvVars(template, {}, { onMissingEnv: 'throw' });
      assert.equal(result, 'https://fallback.service.com/api');
    });
  });

  // =========================================================================
  // 5. Malformed YAML Inputs
  // =========================================================================
  describe('5. Malformed YAML Inputs & Error Handling', () => {
    it('rejects empty string with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('', {}),
        (err: Error) => {
          assert.equal(err.message, 'Invalid tooling YAML: expected root object');
          return true;
        }
      );
    });

    it('rejects whitespace-only string with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('   \n\t\n   ', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects comment-only YAML with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('# Only comments\n# Second comment line', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects literal YAML null ("null") with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('null', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML null tilde ("~") with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('~', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML boolean ("true") with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('true', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML boolean ("false") with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('false', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML integer number ("12345") with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('12345', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML float number ("3.14159") with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('3.14159', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML top-level array with "Invalid tooling YAML: expected root object"', () => {
      assert.throws(
        () => parseToolingConfigYaml('- tool1\n- tool2', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('rejects YAML with invalid tab indentation with "Invalid tooling YAML syntax:"', () => {
      const tabbedYaml = 'tools:\n\t- name: bad_tab\n\t  type: http';
      assert.throws(
        () => parseToolingConfigYaml(tabbedYaml, {}),
        /Invalid tooling YAML syntax:/
      );
    });

    it('rejects unclosed brackets with "Invalid tooling YAML syntax:"', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools: [unclosed', {}),
        /Invalid tooling YAML syntax:/
      );
    });

    it('rejects unclosed braces with "Invalid tooling YAML syntax:"', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools: {unclosed', {}),
        /Invalid tooling YAML syntax:/
      );
    });

    it('rejects unclosed quotes and illegal colons with "Invalid tooling YAML syntax:"', () => {
      assert.throws(
        () => parseToolingConfigYaml('foo: "unclosed string', {}),
        /Invalid tooling YAML syntax:/
      );
      assert.throws(
        () => parseToolingConfigYaml('a: : bad compact mapping', {}),
        /Invalid tooling YAML syntax:/
      );
    });

    it('rejects colon-heavy mapping missing tools property with "missing or invalid \'tools\' array"', () => {
      assert.throws(
        () => parseToolingConfigYaml(':::bad:::yaml:::', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
    });

    it('rejects YAML without tools property with "Invalid tooling YAML: missing or invalid \'tools\' array"', () => {
      assert.throws(
        () => parseToolingConfigYaml('version: 1\nauthor: test', {}),
        (err: Error) => {
          assert.equal(err.message, "Invalid tooling YAML: missing or invalid 'tools' array");
          return true;
        }
      );
    });

    it('rejects YAML with non-array tools property with "Invalid tooling YAML: missing or invalid \'tools\' array"', () => {
      assert.throws(
        () => parseToolingConfigYaml('version: 1\ntools: "not-an-array"', {}),
        (err: Error) => {
          assert.equal(err.message, "Invalid tooling YAML: missing or invalid 'tools' array");
          return true;
        }
      );
      assert.throws(
        () => parseToolingConfigYaml('version: 1\ntools: 12345', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
      assert.throws(
        () => parseToolingConfigYaml('version: 1\ntools: null', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
      assert.throws(
        () => parseToolingConfigYaml('version: 1\ntools: { a: 1 }', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
    });
  });

  // =========================================================================
  // 6. Strict Adherence to Tier 2 Tests B20 and B21
  // =========================================================================
  describe('6. Tier 2 B20 and B21 Conformance', () => {
    it('B20: Empty YAML string throws expected root object error', () => {
      assert.throws(
        () => parseToolingConfigYaml('', {}),
        /Invalid tooling YAML: expected root object/
      );
    });

    it('B21: YAML missing or non-array tools throws missing tools error', () => {
      assert.throws(
        () => parseToolingConfigYaml('version: 1\ntools: "not-an-array"', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
      assert.throws(
        () => parseToolingConfigYaml('version: 1', {}),
        /Invalid tooling YAML: missing or invalid 'tools' array/
      );
    });
  });

  // =========================================================================
  // 7. Schema & Tool Definition Boundaries
  // =========================================================================
  describe('7. Schema & Tool Definition Boundaries', () => {
    it('rejects null tool entries in array', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - null'),
        /Invalid tool definition at index 0: expected tool object/
      );
    });

    it('rejects primitive string tool entries in array', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - "primitive-tool"'),
        /Invalid tool definition at index 0: expected tool object/
      );
    });

    it('rejects missing or empty tool name', () => {
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - type: http\n    url: https://api.com'),
        /missing or empty 'name'/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: ""\n    type: http'),
        /missing or empty 'name'/
      );
      assert.throws(
        () => parseToolingConfigYaml('tools:\n  - name: "   "\n    type: http'),
        /missing or empty 'name'/
      );
    });

    it('rejects duplicate tool names', () => {
      const yaml = `
tools:
  - name: duplicate-tool
    type: http
    url: https://api.com
  - name: duplicate-tool
    type: mcp
    url: https://mcp.com
`;
      assert.throws(
        () => parseToolingConfigYaml(yaml),
        /Invalid tooling YAML: duplicate tool name 'duplicate-tool' at index 1/
      );
    });

    it('rejects invalid tool type', () => {
      const yaml = `
tools:
  - name: bad-type-tool
    type: grpc
    url: https://api.com
`;
      assert.throws(
        () => parseToolingConfigYaml(yaml),
        /invalid type 'grpc'. Expected one of: mcp, http, sse, stdio, inference/
      );
    });

    it('rejects invalid tunnel mode', () => {
      const yaml = `
tools:
  - name: bad-mode-tool
    type: http
    url: https://api.com
    tunnel:
      mode: wireguard
`;
      assert.throws(
        () => parseToolingConfigYaml(yaml),
        /Invalid tunnel mode 'wireguard' for tool 'bad-mode-tool'/
      );
    });

    it('rejects negative or NaN timeout_ms', () => {
      const yamlNeg = `
tools:
  - name: neg-timeout-tool
    type: http
    url: https://api.com
    tunnel:
      timeout_ms: -100
`;
      assert.throws(
        () => parseToolingConfigYaml(yamlNeg),
        /must be a non-negative number/
      );
    });

    it('rejects non-object headers or non-string header values', () => {
      const yamlNonObj = `
tools:
  - name: bad-header-tool
    type: http
    url: https://api.com
    tunnel:
      headers: "not-an-object"
`;
      assert.throws(
        () => parseToolingConfigYaml(yamlNonObj),
        /must be an object map/
      );

      const yamlNonStrVal = `
tools:
  - name: bad-header-val-tool
    type: http
    url: https://api.com
    tunnel:
      headers:
        X-Count: 123
`;
      assert.throws(
        () => parseToolingConfigYaml(yamlNonStrVal),
        /Invalid header value for 'X-Count' in tool 'bad-header-val-tool': expected string, got number/
      );
    });
  });

  // =========================================================================
  // 8. End-to-End Tunnel Connection Resolution Integration
  // =========================================================================
  describe('8. Tunnel Connection Resolution Integration', () => {
    it('resolves tool connection from interpolated YAML definition', () => {
      const yaml = `
tools:
  - name: bifrost-cf
    type: http
    url: https://bifrost.internal.corp/v1
    tunnel:
      mode: cloudflare
      timeout_ms: 15000
      cloudflare:
        access_client_id: "\${CF_CLIENT_ID}"
        access_client_secret: "\${CF_CLIENT_SECRET}"
        tunnel_token: "\${CF_TUNNEL_TOKEN}"
`;
      const env = {
        CF_CLIENT_ID: 'client-id-abc',
        CF_CLIENT_SECRET: 'client-secret-xyz',
        CF_TUNNEL_TOKEN: 'token-123',
      };
      const parsed = parseToolingConfigYaml(yaml, env);
      const conn = resolveToolConnection(parsed.tools[0]);

      assert.equal(conn.name, 'bifrost-cf');
      assert.equal(conn.url, 'https://bifrost.internal.corp/v1');
      assert.equal(conn.tunnelMode, 'cloudflare');
      assert.equal(conn.timeoutMs, 15000);
      assert.equal(conn.headers['CF-Access-Client-Id'], 'client-id-abc');
      assert.equal(conn.headers['CF-Access-Client-Secret'], 'client-secret-xyz');
      assert.equal(conn.requiresTunnelDaemon, true);
    });

    it('resolves public tool endpoint to direct HTTPS with zero headers and no daemon', () => {
      const yaml = `
tools:
  - name: openrouter-public
    type: inference
    url: https://openrouter.ai/api/v1
    tunnel:
      mode: auto
`;
      const parsed = parseToolingConfigYaml(yaml, {});
      const conn = resolveToolConnection(parsed.tools[0]);

      assert.equal(conn.tunnelMode, 'direct');
      assert.equal(conn.requiresTunnelDaemon, false);
      assert.deepEqual(conn.headers, {});
    });

    it('resolves tailscale tool endpoint for *.ts.net with auth key', () => {
      const yaml = `
tools:
  - name: tailscale-node
    type: http
    url: https://my-node.tailnet.ts.net:8443
    tunnel:
      mode: auto
      tailscale:
        auth_key: "\${TS_KEY}"
`;
      const env = { TS_KEY: 'tskey-auth-mock' };
      const parsed = parseToolingConfigYaml(yaml, env);
      const conn = resolveToolConnection(parsed.tools[0]);

      assert.equal(conn.tunnelMode, 'tailscale');
      assert.equal(conn.requiresTunnelDaemon, true);
    });
  });

  // =========================================================================
  // 9. Hostile Edge Cases: Prototype Pollution, Anchors, Unicode, & Contiguity
  // =========================================================================
  describe('9. Hostile Edge Cases & Attack Vectors', () => {
    it('safely handles __proto__ and constructor keys without prototype pollution', () => {
      const hostileYaml = `
tools:
  - name: proto-tool
    type: http
    url: https://api.com/v1
    options:
      __proto__:
        polluted: true
      constructor:
        prototype:
          polluted: true
`;
      const parsed = parseToolingConfigYaml(hostileYaml, {});
      assert.equal(parsed.tools[0].name, 'proto-tool');
      // Assert Object prototype was NOT polluted
      assert.equal((Object.prototype as any).polluted, undefined);
      assert.equal(({} as any).polluted, undefined);
    });

    it('interpolates UTF-8 multi-byte characters and emojis properly', () => {
      const env = {
        EMOJI_NAME: '🚀-rocket-tool',
        PATH_SEGMENT: 'тест/ñ/🎉',
      };
      const yaml = `
tools:
  - name: "\${EMOJI_NAME}"
    type: http
    url: "https://api.example.com/\${PATH_SEGMENT}"
`;
      const parsed = parseToolingConfigYaml(yaml, env);
      assert.equal(parsed.tools[0].name, '🚀-rocket-tool');
      assert.equal(parsed.tools[0].url, 'https://api.example.com/тест/ñ/🎉');
    });

    it('interpolates multiple contiguous tokens without delimiters (${A}${B}${C})', () => {
      const env = {
        PROTOCOL: 'https://',
        SUBDOMAIN: 'auth.',
        DOMAIN: 'corp.net',
        PORT: ':443',
      };
      const result = interpolateEnvVars('${PROTOCOL}${SUBDOMAIN}${DOMAIN}${PORT}', env);
      assert.equal(result, 'https://auth.corp.net:443');
    });

    it('handles YAML anchors and aliases safely', () => {
      const anchorYaml = `
defaults: &base_tunnel
  mode: direct
  timeout_ms: 5000

tools:
  - name: tool-a
    type: http
    url: https://api.a.com
    tunnel: *base_tunnel
  - name: tool-b
    type: http
    url: https://api.b.com
    tunnel: *base_tunnel
`;
      const parsed = parseToolingConfigYaml(anchorYaml, {});
      assert.equal(parsed.tools[0].tunnel?.mode, 'direct');
      assert.equal(parsed.tools[0].tunnel?.timeout_ms, 5000);
      assert.equal(parsed.tools[1].tunnel?.mode, 'direct');
      assert.equal(parsed.tools[1].tunnel?.timeout_ms, 5000);
    });

    it('handles extractReferencedEnvVars on Object.create(null) and primitive inputs', () => {
      const nullProto: any = Object.create(null);
      nullProto.field = '${SAFE_VAR}';
      const vars = extractReferencedEnvVars(nullProto);
      assert.deepEqual(vars, ['SAFE_VAR']);

      assert.deepEqual(extractReferencedEnvVars(42), []);
      assert.deepEqual(extractReferencedEnvVars(true), []);
      assert.deepEqual(extractReferencedEnvVars(null), []);
      assert.deepEqual(extractReferencedEnvVars(undefined), []);
    });

    it('handles nested fallback expressions gracefully across interpolation passes', () => {
      // First pass resolves outer fallback token, subsequent pass resolves inner token
      const env = { FALLBACK_VAL: 'resolved_nested' };
      const template = '${PRIMARY:-${FALLBACK_VAL}}';
      const result = interpolateEnvVars(template, env);
      assert.equal(result, 'resolved_nested');
    });
  });
});
