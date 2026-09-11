import { describe, expect, it } from 'vitest';
import {
  getPersonaEcosystemPaths,
  resolveWorkerConfig,
  STATIC_FALLBACK_ECOSYSTEM_PATHS,
} from '../../src/config/publishingWorkerConfig';
import { CompiledDomainIndex, loadCompiledIndex } from '../../src/pipeline/domainIndex';

describe('publishingWorkerConfig', () => {
  it.each([[1, 1], [3, 3], [5, 5], [10, 10], [11, 10], [20, 10]])(
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
});
