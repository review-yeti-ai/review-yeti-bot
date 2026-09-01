import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const fs = require('fs');

const root = path.resolve(__dirname, '../..');
const profileModule = require(path.join(root, '.github/workflows/pipelines/execution-profile.js'));

const {
  PROFILE_SCHEMA_VERSION,
  getExecutionProfiles,
  loadExecutionProfileManifest,
  normalizeProfile,
  resolveExecutionProfile,
} = profileModule;

describe('canonical execution-profile contract', () => {
  it('loads exactly the three pre-approved profiles with stable digests', () => {
    expect(PROFILE_SCHEMA_VERSION).toBe(1);
    const profiles = getExecutionProfiles();
    expect(Object.keys(profiles).sort()).toEqual([
      'fireworks-breakglass',
      'ollama-evaluation',
      'openrouter-primary',
    ]);
    expect(Object.isFrozen(profiles)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].timeouts)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].reasoning)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].routing)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].routing.ignore_providers)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].privacy)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].retry)).toBe(true);
    expect(Object.isFrozen(profiles['openrouter-primary'].quarantine)).toBe(true);

    const openrouter = resolveExecutionProfile();
    expect(openrouter).toMatchObject({
      id: 'openrouter-primary',
      transport: 'openrouter',
      base_url_class: 'openrouter-gateway',
      model: 'deepseek/deepseek-v4-flash-0731',
      compatibility_mode: 'openrouter',
      streaming: true,
      structured_output: 'strict',
      reasoning: { effort: 'high', wire_shape: 'reasoning.effort' },
      routing: { mode: 'gateway-delegated' },
      timeouts: { connect_ms: 30000, request_ms: 90000, stall_ms: 20000, ttft_ms: 30000 },
      active: true,
    });
    expect(openrouter.profile_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveExecutionProfile('openrouter-primary')).toEqual(openrouter);
  });

  it('keeps break-glass and evaluation profiles inactive and bounded', () => {
    expect(resolveExecutionProfile('fireworks-breakglass')).toMatchObject({
      transport: 'fireworks',
      base_url_class: 'direct-fireworks-openai-compatible',
      active: false,
    });
    expect(resolveExecutionProfile('ollama-evaluation')).toMatchObject({
      transport: 'ollama',
      base_url_class: 'direct-ollama-cloud-openai-compatible',
      active: false,
    });
  });

  it('rejects arbitrary JSON and unknown profile identifiers', () => {
    expect(() => resolveExecutionProfile('{"id":"fireworks-breakglass"}')).toThrow(/one of|allowlisted|JSON/i);
    expect(() => resolveExecutionProfile('["fireworks-breakglass"]')).toThrow(/one of|allowlisted|JSON/i);
    expect(() => resolveExecutionProfile('  ')).toThrow(/allowlisted|JSON/i);
    expect(() => resolveExecutionProfile('unknown-profile')).toThrow(/one of|defined/i);
  });

  it('rejects unknown fields and unsafe profile values instead of ignoring them', () => {
    const base = { ...resolveExecutionProfile('openrouter-primary') };
    delete base.profile_digest;
    expect(() => normalizeProfile({ ...base, ignored: true })).toThrow(/unknown/i);
    expect(() => normalizeProfile({ ...base, model: 'Bearer secret-value' })).toThrow(/credential-free/i);
    expect(() => normalizeProfile({ ...base, streaming: false })).toThrow(/streaming/i);
    expect(() => normalizeProfile({ ...base, timeouts: { ...base.timeouts, request_ms: 1 } })).toThrow(/request_ms/i);
  });

  it('covers each profile contract rejection family before any runtime wiring', () => {
    const copy = (id: string) => {
      const profile = JSON.parse(JSON.stringify(resolveExecutionProfile(id)));
      delete profile.profile_digest;
      return profile;
    };
    const reject = (profile: any, pattern: RegExp) => expect(() => normalizeProfile(profile)).toThrow(pattern);

    const transport = copy('openrouter-primary');
    transport.transport = 'fireworks';
    reject(transport, /wrong transport/i);

    const baseClass = copy('openrouter-primary');
    baseClass.base_url_class = 'direct-fireworks-openai-compatible';
    reject(baseClass, /OpenRouter gateway/i);

    const fireworksClass = copy('fireworks-breakglass');
    fireworksClass.base_url_class = 'openrouter-gateway';
    reject(fireworksClass, /Fireworks direct/i);

    const ollamaClass = copy('ollama-evaluation');
    ollamaClass.base_url_class = 'openrouter-gateway';
    reject(ollamaClass, /Ollama direct/i);

    const structured = copy('openrouter-primary');
    structured.structured_output = 'ignored';
    reject(structured, /structured_output/i);

    const reasoningEffort = copy('openrouter-primary');
    reasoningEffort.reasoning.effort = 'low';
    reject(reasoningEffort, /reasoning effort/i);

    const reasoningWire = copy('openrouter-primary');
    reasoningWire.reasoning.wire_shape = 'reasoning_effort';
    reject(reasoningWire, /OpenRouter.*reasoning/i);

    const directWire = copy('fireworks-breakglass');
    directWire.reasoning.wire_shape = 'reasoning.effort';
    reject(directWire, /Direct.*reasoning/i);

    const extension = copy('openrouter-primary');
    extension.request_extensions.perf_metrics_in_response = 'true';
    reject(extension, /perf_metrics_in_response/i);

    const routingMode = copy('openrouter-primary');
    routingMode.routing.mode = 'direct';
    reject(routingMode, /gateway-delegated/i);

    const directRouting = copy('fireworks-breakglass');
    directRouting.routing.mode = 'gateway-delegated';
    reject(directRouting, /direct routing/i);

    const ignoreProviders = copy('openrouter-primary');
    ignoreProviders.routing.ignore_providers = ['fireworks', 3];
    reject(ignoreProviders, /ignore_providers/i);

    const providerKeys = copy('openrouter-primary');
    providerKeys.routing.provider.extra = true;
    reject(providerKeys, /provider.*unknown/i);

    const providerPrivacy = copy('openrouter-primary');
    providerPrivacy.routing.provider.data_collection = 'allow';
    reject(providerPrivacy, /provider data collection/i);

    const privacy = copy('openrouter-primary');
    privacy.privacy.data_collection = 'allow';
    reject(privacy, /privacy/i);

    const retry = copy('openrouter-primary');
    retry.retry.max_attempts = 3;
    reject(retry, /retry contract/i);

    const quarantine = copy('openrouter-primary');
    quarantine.quarantine.on_timeout = 'unexpected';
    reject(quarantine, /quarantine/i);

    const active = copy('fireworks-breakglass');
    active.active = true;
    reject(active, /inactive/i);
  });

  it('is validation-only in this slice: profile selection does not mutate the registry', () => {
    const profiles = getExecutionProfiles();
    const before = JSON.stringify(profiles);
    const candidate = resolveExecutionProfile('fireworks-breakglass');

    expect(candidate.id).toBe('fireworks-breakglass');
    expect(JSON.stringify(profiles)).toBe(before);
    expect(() => {
      (candidate.timeouts as any).request_ms = 1;
    }).toThrow(TypeError);
    expect(candidate.timeouts.request_ms).toBe(120000);
  });

  it('rejects prototype-pollution keys in manifest JSON before normalization', () => {
    const readFileSync = vi.spyOn(fs, 'readFileSync').mockReturnValue('{"__proto__":{"polluted":true}}' as any);
    try {
      expect(() => loadExecutionProfileManifest()).toThrow(/forbidden key.*__proto__/i);
    } finally {
      readFileSync.mockRestore();
    }
  });
});
