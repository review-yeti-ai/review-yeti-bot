import { describe, expect, it } from 'vitest';
import {
  fallbackProviderId,
  getPersonaEcosystemPaths,
  parseFallbackModelList,
  resolveWorkerConfig,
  STATIC_FALLBACK_ECOSYSTEM_PATHS,
} from '../../src/config/publishingWorkerConfig';
import { CompiledDomainIndex, loadCompiledIndex } from '../../src/pipeline/domainIndex';

describe('publishingWorkerConfig', () => {
  it.each([[1, 1], [3, 3], [5, 5], [10, 10], [11, 11], [20, 15]])(
    'projects admitted turn budget %i to %i without replacing a lower limit', (requested, expected) => {
      const config = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({
        review_yeti: { personas: 'security', budget: { max_investigation_turns: requested } },
      }) }, { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'review-model' });

      expect(config.default_max_turns).toBe(expected);
      expect(config.reviewers.overall_timeout_s).toBe(1800);
      expect(config.reviewers.providers).toEqual([expect.objectContaining({
        id: 'bifrost', model: 'review-model', review_timeout_s: 180, arbiter_timeout_s: 180,
      })]);
      expect(JSON.stringify(config)).not.toContain('not-persisted');
    },
  );

  it('resolves specific ecosystem paths for dep-lane from compiled index', () => {
    const index = loadCompiledIndex();
    expect(index).toBeDefined();
    const paths = getPersonaEcosystemPaths('dep-lane', index);
    expect(paths.length).toBeGreaterThan(10);
    expect(paths).not.toContain('**');
    expect(paths.some((p) => p.includes('package.json') || p.includes('lock') || p.includes('gemspec'))).toBe(true);
  });

  it('unions classes across ecosystems deterministically from synthetic compiled index', () => {
    const syntheticIndex: CompiledDomainIndex = {
      schemaVersion: 'domain-index-v1',
      classVocabulary: ['auth_rules', 'api_routes'],
      personaVocabulary: ['security'],
      indexDigest: 'test-digest',
      classes: {
        auth_rules: ['security'],
        api_routes: ['security'],
      },
      ecosystems: {
        backend: {
          description: 'Backend',
          classes: {
            auth_rules: ['src/auth/**', 'policies/**'],
          },
        },
        frontend: {
          description: 'Frontend',
          classes: {
            api_routes: ['src/api/**'],
          },
        },
      },
    };
    const paths = getPersonaEcosystemPaths('security', syntheticIndex);
    expect(paths).toEqual(['policies/**', 'src/api/**', 'src/auth/**']);
  });

  it('falls back to static paths when compiled index has classes for persona but ecosystems define zero globs', () => {
    const syntheticIndex: CompiledDomainIndex = {
      schemaVersion: 'domain-index-v1',
      classVocabulary: ['auth_rules'],
      personaVocabulary: ['security'],
      indexDigest: 'test-digest',
      classes: {
        auth_rules: ['security'],
      },
      ecosystems: {
        backend: {
          description: 'Empty globs ecosystem',
          classes: {
            auth_rules: [],
          },
        },
      },
    };
    const paths = getPersonaEcosystemPaths('security', syntheticIndex);
    expect(paths).toEqual(STATIC_FALLBACK_ECOSYSTEM_PATHS.security);
    expect(paths.length).toBeGreaterThan(0);
  });

  it('falls back to STATIC_FALLBACK_ECOSYSTEM_PATHS when index is null', () => {
    const paths = getPersonaEcosystemPaths('dep-lane', null);
    expect(paths).toEqual(STATIC_FALLBACK_ECOSYSTEM_PATHS.dependencies);
    expect(paths).not.toContain('**');
    expect(paths).toContain('**/package.json');
    expect(paths).toContain('**/mix.lock');
    expect(paths).toContain('**/go.mod');
    expect(paths).toContain('**/Cargo.toml');
  });

  it('pins static fallback patterns for accessibility and i18n ecosystems', () => {
    const a11yPaths = STATIC_FALLBACK_ECOSYSTEM_PATHS.accessibility;
    expect(a11yPaths).toContain('**/*.tsx');
    expect(a11yPaths).toContain('**/*.html');
    expect(a11yPaths).toContain('**/*.vue');

    const i18nPaths = STATIC_FALLBACK_ECOSYSTEM_PATHS.i18n;
    expect(i18nPaths).toContain('**/locales/**');
    expect(i18nPaths).toContain('**/*.po');
    expect(i18nPaths).toContain('**/messages.json');
  });

  it('ensures every persona in compiled domain index has a matching non-empty static fallback to prevent drift', () => {
    const index = loadCompiledIndex();
    expect(index).toBeDefined();
    for (const persona of index!.personaVocabulary) {
      const fallbackPaths = getPersonaEcosystemPaths(persona, null);
      expect(fallbackPaths.length, `Persona ${persona} must have non-empty static fallback`).toBeGreaterThan(0);
      expect(fallbackPaths, `Persona ${persona} must not fall back to **`).not.toEqual(['**']);
    }
  });

  it('never returns open ** glob for any standard persona in fallback mode', () => {
    const standardPersonas = [
      'security',
      'sec-lane',
      'performance',
      'perf-lane',
      'architecture',
      'arch-lane',
      'testing',
      'qual-lane',
      'dependencies',
      'dep-lane',
      'licensing',
      'policy-lane',
      'database',
      'db-lane',
      'devops',
      'devops-lane',
    ];

    for (const persona of standardPersonas) {
      const paths = getPersonaEcosystemPaths(persona, null);
      expect(paths, `Persona ${persona} should not fall back to **`).not.toEqual(['**']);
      expect(paths.length).toBeGreaterThan(0);
    }
  });

  it('assigns builtin:dependency-health charter to dep-lane', () => {
    const config = resolveWorkerConfig({}, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });
    const depPersona = config.personas.find((p) => p.id === 'dep-lane');
    expect(depPersona).toBeDefined();
    expect(depPersona?.charter).toBe('builtin:dependency-health');
    expect(depPersona?.paths).not.toContain('**');
    expect(depPersona?.paths.length).toBeGreaterThan(0);
  });

  it('asserts dep-lane includes expected package manifests and excludes code/markdown files', () => {
    const depPaths = getPersonaEcosystemPaths('dep-lane', null);
    expect(depPaths).toContain('**/package.json');
    expect(depPaths).toContain('**/mix.lock');
    expect(depPaths).toContain('**/go.mod');
    expect(depPaths).toContain('**/Cargo.toml');
    expect(depPaths).not.toContain('**/*.md');
    expect(depPaths).not.toContain('**/*.ts');
    expect(depPaths).not.toContain('**');
  });

  // REL-886: resolveWorkerConfig used to hardcode a single `bifrost` provider
  // entry no matter what transport.model carried, so panelEngine's own
  // retry-then-failover loop had nothing to fail over to. These tests prove a
  // multi-value REVIEW_MODEL resolves to a real ordered fallback chain, and
  // that the single-value shape deployed today is untouched.
  describe('fallback provider resolution (REL-886)', () => {
    it('parses a comma-delimited model list in order, trimming and dropping empty segments', () => {
      expect(parseFallbackModelList('bifrost/pr-reviewer, ollama/deepseek-v4.1-flash'))
        .toEqual(['bifrost/pr-reviewer', 'ollama/deepseek-v4.1-flash']);
      expect(parseFallbackModelList('bifrost/pr-reviewer,,ollama/deepseek-v4.1-flash,'))
        .toEqual(['bifrost/pr-reviewer', 'ollama/deepseek-v4.1-flash']);
    });

    it('parses a bare single-value model unchanged, matching the only shape deployed today', () => {
      expect(parseFallbackModelList('bifrost/pr-reviewer')).toEqual(['bifrost/pr-reviewer']);
    });

    it('deduplicates a repeated model string so it cannot be retried against itself under a second id', () => {
      expect(parseFallbackModelList('bifrost/pr-reviewer,bifrost/pr-reviewer')).toEqual(['bifrost/pr-reviewer']);
    });

    it('assigns the stable bifrost id to index 0 and an ordinal fallback id to every later entry', () => {
      expect(fallbackProviderId(0)).toBe('bifrost');
      expect(fallbackProviderId(1)).toBe('bifrost-fallback-1');
      expect(fallbackProviderId(2)).toBe('bifrost-fallback-2');
    });

    it('resolves a single-value transport.model to exactly one bifrost provider (backward compatible)', () => {
      const config = resolveWorkerConfig({}, {
        baseUrl: 'https://gateway.example.invalid/v1',
        apiKey: 'not-persisted',
        model: 'bifrost/pr-reviewer',
      });

      expect(config.reviewers.providers).toEqual([
        expect.objectContaining({ id: 'bifrost', model: 'bifrost/pr-reviewer' }),
      ]);
      expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
      for (const persona of config.personas) {
        expect(persona.providers).toEqual(['bifrost']);
      }
    });

    it('resolves a comma-delimited transport.model to an ordered multi-provider fallback chain', () => {
      const config = resolveWorkerConfig({}, {
        baseUrl: 'https://gateway.example.invalid/v1',
        apiKey: 'not-persisted',
        model: 'bifrost/pr-reviewer,ollama/deepseek-v4.1-flash',
      });

      expect(config.reviewers.providers).toEqual([
        expect.objectContaining({ id: 'bifrost', model: 'bifrost/pr-reviewer' }),
        expect.objectContaining({ id: 'bifrost-fallback-1', model: 'ollama/deepseek-v4.1-flash' }),
      ]);
      expect(config.reviewers.arbiter.order).toEqual(['bifrost', 'bifrost-fallback-1']);
      for (const persona of config.personas) {
        expect(persona.providers).toEqual(['bifrost', 'bifrost-fallback-1']);
      }
    });

    it('supports three or more fallback entries in the configured order', () => {
      const config = resolveWorkerConfig({}, {
        baseUrl: 'https://gateway.example.invalid/v1',
        apiKey: 'not-persisted',
        model: 'bifrost/pr-reviewer,ollama/deepseek-v4.1-flash,ollama/glm-5.3-flash',
      });

      expect(config.reviewers.providers.map((p) => p.id)).toEqual([
        'bifrost', 'bifrost-fallback-1', 'bifrost-fallback-2',
      ]);
      expect(config.reviewers.providers.map((p) => p.model)).toEqual([
        'bifrost/pr-reviewer', 'ollama/deepseek-v4.1-flash', 'ollama/glm-5.3-flash',
      ]);
    });
  });
});
