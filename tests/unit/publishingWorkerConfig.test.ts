import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig as resolveFromCli, getPersonaEcosystemPaths as getPathsFromCli } from '../../src/cli/publishingReview';
import { resolveWorkerConfig, getPersonaEcosystemPaths } from '../../src/config/publishingWorkerConfig';
import type { CompiledDomainIndex } from '../../src/pipeline/domainIndex';

const transport = { baseUrl: 'https://bifrost.example.test', apiKey: 'synthetic-test-key', model: 'review-model' };

describe('publishing worker config extraction', () => {
  it('keeps the CLI export as the same dependency-light resolver', () => {
    expect(resolveFromCli).toBe(resolveWorkerConfig);
    expect(getPathsFromCli).toBe(getPersonaEcosystemPaths);
  });

  it('preserves the Bifrost provider, 90s timeout clamp, and current turn clamp', () => {
    const config = resolveWorkerConfig({ NODE_ENV: 'test', REVIEW_PERSONAS: 'security, architecture', MAX_INVESTIGATION_TURNS: '99' }, transport);

    expect(config.default_max_turns).toBe(3);
    expect(config.personas.map((persona) => persona.id)).toEqual(['sec-lane', 'arch-lane']);
    expect(config.personas.every((persona) => persona.providers?.length === 1 && persona.providers[0] === 'bifrost')).toBe(true);
    expect(config.reviewers.providers).toMatchObject([{ id: 'bifrost', model: 'review-model', review_timeout_s: 90, arbiter_timeout_s: 90 }]);
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
  });

  it('wires getPersonaEcosystemPaths into resolved persona paths', () => {
    const config = resolveWorkerConfig({ NODE_ENV: 'test', REVIEW_PERSONAS: 'security, performance' }, transport);
    const secPersona = config.personas.find((p) => p.id === 'sec-lane');
    const perfPersona = config.personas.find((p) => p.id === 'perf-lane');

    expect(secPersona).toBeDefined();
    expect(perfPersona).toBeDefined();
    expect(secPersona?.paths).toEqual(getPersonaEcosystemPaths('security'));
    expect(perfPersona?.paths).toEqual(getPersonaEcosystemPaths('performance'));
    expect(secPersona?.paths).not.toEqual(['**']);
  });

  describe('getPersonaEcosystemPaths', () => {
    it('resolves canonical aliases and returns sorted unique globs', () => {
      const pathsSec = getPersonaEcosystemPaths('security');
      const pathsSecLane = getPersonaEcosystemPaths('sec-lane');
      expect(pathsSec).toEqual(pathsSecLane);
      expect(pathsSec.length).toBeGreaterThan(0);
      expect(pathsSec).not.toContain('**');
    });

    it('falls back to [**] when persona is unknown', () => {
      expect(getPersonaEcosystemPaths('nonexistent-lane')).toEqual(['**']);
    });

    it('falls back to [**] when compiled index is null', () => {
      expect(getPersonaEcosystemPaths('security', null)).toEqual(['**']);
    });

    it('unions classes across ecosystems from a custom compiled index', () => {
      const mockIndex: CompiledDomainIndex = {
        schemaVersion: 'domain-index-v1',
        classVocabulary: ['auth_rules', 'api_routes'],
        personaVocabulary: ['security', 'architecture'],
        indexDigest: 'abc',
        classes: {
          auth_rules: ['security'],
          api_routes: ['security', 'architecture'],
        },
        ecosystems: {
          backend: {
            description: 'Backend services',
            classes: {
              auth_rules: ['auth/**', 'policies/**'],
              api_routes: ['routes/**', 'controllers/**'],
            },
          },
          frontend: {
            description: 'Frontend client',
            classes: {
              auth_rules: ['src/auth/**'],
            },
          },
        },
      };

      const result = getPersonaEcosystemPaths('security', mockIndex);
      expect(result).toEqual([
        'auth/**',
        'controllers/**',
        'policies/**',
        'routes/**',
        'src/auth/**',
      ]);
    });
  });
});
