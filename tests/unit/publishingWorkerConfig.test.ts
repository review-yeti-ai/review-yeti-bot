import { describe, expect, it } from 'vitest';
import {
  getPersonaEcosystemPaths,
  resolveWorkerConfig,
  STATIC_FALLBACK_ECOSYSTEM_PATHS,
} from '../../src/config/publishingWorkerConfig';
import { CompiledDomainIndex, loadCompiledIndex } from '../../src/pipeline/domainIndex';
import { resolveComposedEngineMaxTurns, resolveTaskTurnCeiling } from '../../src/panel/composedEngine';
import { resolveComposedMaxTasks } from '../../src/reviewTaskContract';

describe('publishingWorkerConfig', () => {
  it('keeps the default lockfile cap implicit and projects an explicitly admitted bounded cap', () => {
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'review-model' };
    const legacy = resolveWorkerConfig({}, transport);
    expect(legacy.max_reviewed_lockfile_patch_chars).toBeUndefined();

    const admitted = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', budget: { max_investigation_turns: 10, max_reviewed_lockfile_patch_chars: 65_536 },
    } }) }, transport);
    expect(admitted.max_reviewed_lockfile_patch_chars).toBe(65_536);
  });

  it.each([19_999, 65_537, '65536'])('rejects out-of-bound or non-numeric raw-lockfile cap %s', (value) => {
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', budget: { max_investigation_turns: 10, max_reviewed_lockfile_patch_chars: value },
    } }) }, { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'review-model' }))
      .toThrow('review policy could not be parsed');
  });

  it.each([[1, 1], [3, 3], [5, 5], [10, 10], [11, 11], [20, 15]])(
    'projects admitted turn budget %i to %i without replacing a lower limit', (requested, expected) => {
      const config = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({
        review_yeti: { personas: 'security', budget: { max_investigation_turns: requested } },
      }) }, { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'review-model' });

      expect(config.default_max_turns).toBe(expected);
      expect(config.reviewers.overall_timeout_s).toBe(1200);
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

  it('defaults to the panel engine and the default6 roster when no policy is supplied at all', () => {
    const config = resolveWorkerConfig({}, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });
    expect(config.review_engine).toBe('panel');
    expect(config.personas.length).toBe(6);
  });

  it('projects review_engine and the composed budget block from central policy', () => {
    const config = resolveWorkerConfig({
      REVIEW_YETI_POLICY_JSON: JSON.stringify({
        review_yeti: {
          personas: 'security',
          budget: { max_investigation_turns: 5 },
          review_engine: 'composed',
          composed: {
            max_tasks: 4,
            max_turns_total: 20,
            max_turns_per_task: 3,
          },
        },
      }),
    }, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });

    expect(config.review_engine).toBe('composed');
    expect(config.composed).toEqual({
      max_tasks: 4,
      max_turns_total: 20,
      max_turns_per_task: 3,
    });
  });

  it.each(['task_dimensions', 'require_security_task'])('rejects unsupported composed policy key %s', (key) => {
    const transport = { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' };
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'composed', composed: { [key]: ['security'] },
    } }) }, transport)).toThrow(/review policy could not be parsed/u);
  });

  it.each(['dsh', 'deepseek-harness'])('uses composed only for an explicit %s fallback while preserving the public panel default', (engine) => {
    const transport = { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' };
    const dsh = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: engine, fallback_review_engine: 'composed',
    } }) }, transport);
    expect(dsh.review_engine).toBe('composed');
    expect(resolveWorkerConfig({}, transport).review_engine).toBe('panel');
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: engine,
    } }) }, transport)).toThrow(/review policy could not be parsed/u);
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: engine, fallback_review_engine: 'panel',
    } }) }, transport)).toThrow(/review policy could not be parsed/u);
  });

  it.each(['chill', 'balanced', 'assertive'] as const)(
    'marks the %s advisory profile applied only when composed uses severity v2', (profile) => {
      const transport = { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' };
      const v2 = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
        personas: 'security', profile, review_engine: 'composed', severity_policy: 'review-yeti-severity.v2',
      } }) }, transport);
      const legacy = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
        personas: 'security', profile, review_engine: 'composed',
      } }) }, transport);

      expect(v2.review_configuration_receipt?.effective.profile).toMatchObject({ value: profile, applied: true });
      expect(legacy.review_configuration_receipt?.effective.profile).toMatchObject({
        value: profile, applied: false,
        reason: 'The composed advisory profile is inactive under legacy severity because P2 findings remain blocking.',
      });
      expect(v2.composed).toEqual(legacy.composed);
      expect(v2.default_max_turns).toBe(legacy.default_max_turns);
      expect(v2.reviewer_effort).toBe(legacy.reviewer_effort);
    },
  );

  it('projects a truthful versioned effective receipt for the central composed policy', () => {
    const config = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'architecture,security,documentation',
      budget: { max_investigation_turns: 20, max_reviewed_lockfile_patch_chars: 65_536 },
      profile: 'balanced',
      review_engine: 'dsh',
      fallback_review_engine: 'composed',
      severity_policy: 'review-yeti-severity.v2',
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'medium' }],
      mcp_servers: [
        { id: 'ct-impact', enabled: true },
        { id: 'honcho-memory', enabled: true },
      ],
    } }) }, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });

    expect(config.review_engine).toBe('composed');
    expect(config.severity_policy).toBe('review-yeti-severity.v2');
    expect(config.reviewer_effort).toBe('medium');
    expect(config.reviewers.providers[0].effort).toBe('medium');
    expect(config.personas.find((persona) => persona.id === 'documentation')?.charter).toBe('builtin:docs');
    expect(config.review_configuration_receipt).toMatchObject({
      schema: 'review-yeti-effective-config.v1',
      requested: {
        profile: 'balanced', review_engine: 'dsh', severity_policy: 'review-yeti-severity.v2',
        bifrost_reasoning_effort: 'medium', mcp_servers: ['ct-impact', 'honcho-memory'],
        confidence_threshold: null,
      },
      effective: {
        review_engine: 'composed', severity_policy: 'review-yeti-severity.v2',
        confidence_threshold: {
          value: 70,
          applied: false,
          reason: expect.stringContaining('does not consume confidence_threshold'),
        },
        profile: {
          value: 'balanced', applied: true,
          reason: 'The composed engine applies this profile to advisory breadth under severity v2; blocker evidence and coverage remain profile-independent.',
        },
        provider: {
          id: 'bifrost', model: 'test-model', requested_effort: 'medium',
          upstream_observed_model: 'unknown', upstream_observed_effort: 'unknown',
        },
        memory: { state: 'not_loaded', configured_servers: ['ct-impact', 'honcho-memory'], loaded_servers: [] },
        personas: [
          { requested: 'architecture', id: 'arch-lane', charter: 'builtin:architecture' },
          { requested: 'security', id: 'sec-lane', charter: 'builtin:security' },
          { requested: 'documentation', id: 'documentation', charter: 'builtin:docs' },
        ],
        composed_budget: {
          source: 'engine_defaults', configured_overrides: {}, central_policy_total_turns: 100,
          central_policy_max_tasks: 8, plan_turns: 4, base_task_turns: 12, dynamic_task_turns_max: 18,
          max_concurrent_tasks: 3, total_turns_hard_cap: 200,
          operator_total_turn_override: 'COMPOSED_ENGINE_MAX_TURNS',
        },
        worker_limits: {
          effective_investigation_turns: 15, effective_reviewed_lockfile_patch_chars: 65_536,
        },
      },
    });
    expect(config.default_max_turns).toBe(15);
    expect(config.max_reviewed_lockfile_patch_chars).toBe(65_536);
    const composed = config.composed ?? {};
    expect(resolveComposedEngineMaxTurns({} as NodeJS.ProcessEnv, composed.max_turns_total)).toBe(100);
    expect(resolveComposedMaxTasks(composed.max_tasks)).toBe(8);
    expect(resolveTaskTurnCeiling(composed.max_turns_per_task, 18, 1)).toBe(12);
    expect(resolveTaskTurnCeiling(composed.max_turns_per_task, 18, 4)).toBe(18);
    expect(config.composed).toEqual({});
    expect(JSON.stringify(config)).not.toContain('apiKey');
  });

  it('labels confidence_threshold as inactive while preserving its requested value', () => {
    const resolveWithThreshold = (confidence_threshold: number) => resolveWorkerConfig({
      REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
        personas: 'security',
        review_engine: 'composed',
        severity_policy: 'review-yeti-severity.v2',
        confidence_threshold,
      } }),
    }, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });

    const lower = resolveWithThreshold(10);
    const higher = resolveWithThreshold(95);
    const lowerReceipt = lower.review_configuration_receipt!;
    const higherReceipt = higher.review_configuration_receipt!;

    expect(lowerReceipt.requested.confidence_threshold).toBe(10);
    expect(lowerReceipt.effective.confidence_threshold).toMatchObject({
      value: 10,
      applied: false,
      reason: expect.stringContaining('does not consume confidence_threshold'),
    });
    expect(higherReceipt.requested.confidence_threshold).toBe(95);
    expect(higherReceipt.effective.confidence_threshold).toMatchObject({
      value: 95,
      applied: false,
      reason: expect.stringContaining('does not consume confidence_threshold'),
    });
    expect(lower.review_engine).toBe(higher.review_engine);
    expect(lower.severity_policy).toBe(higher.severity_policy);
    expect(lower.personas).toEqual(higher.personas);
    expect(lower.composed).toEqual(higher.composed);
  });

  it.each([
    ['legacy reviews section', { reviews: { confidence_threshold: 82 } }],
    ['legacy dials section', { dials: { confidence_threshold: 82 } }],
  ])('discloses confidence_threshold from the %s without applying it', (_label, extra) => {
    const config = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'composed', ...extra,
    } }) }, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' });

    expect(config.review_configuration_receipt?.requested.confidence_threshold).toBe(82);
    expect(config.review_configuration_receipt?.effective.confidence_threshold).toMatchObject({
      value: 82, applied: false,
    });
  });

  it('rejects invalid confidence_threshold values while describing the accepted range', () => {
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'composed', confidence_threshold: 101,
    } }) }, { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' }))
      .toThrow(/review policy could not be parsed/u);
  });

  it('projects an optional disputed-blocker adjudicator without switching the primary route or WS4 receipt', () => {
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'primary-review-alias' };
    const selector = { version: 'DisputedBlockerAdjudicator.v1', model: 'qualified-adjudicator-alias', reasoning_effort: 'high' };
    const policy = (extra: Record<string, unknown> = {}) => ({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'composed', severity_policy: 'review-yeti-severity.v2',
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'medium' }], ...extra,
    } }) });
    const configured = resolveWorkerConfig(policy({ disputed_blocker_adjudicator: selector }), transport);
    const absent = resolveWorkerConfig(policy(), transport);

    expect(configured.disputed_blocker_adjudicator).toEqual(selector);
    expect(configured.review_configuration_receipt?.requested.disputed_blocker_adjudicator).toEqual(selector);
    expect(configured.review_configuration_receipt?.effective.disputed_blocker_adjudicator).toMatchObject({
      state: 'available', model_alias: selector.model, reasoning_effort: selector.reasoning_effort, applied: false,
    });
    expect(configured.reviewers.providers).toEqual([expect.objectContaining({
      id: 'bifrost', model: 'primary-review-alias', effort: 'medium',
    })]);
    expect(configured.reviewer_effort).toBe('medium');
    expect(absent.disputed_blocker_adjudicator).toBeUndefined();
    expect(absent.review_configuration_receipt?.effective.disputed_blocker_adjudicator).toBeUndefined();
    expect(JSON.stringify(absent)).not.toContain('disputed_blocker_adjudicator');
    expect(absent.reviewers.providers).toEqual(configured.reviewers.providers);
    expect(configured.review_configuration_receipt?.effective.confidence_threshold)
      .toEqual(absent.review_configuration_receipt?.effective.confidence_threshold);
    expect(configured.review_configuration_receipt?.effective.composed_budget)
      .toEqual(absent.review_configuration_receipt?.effective.composed_budget);
    expect(configured.review_configuration_receipt?.effective.worker_limits)
      .toEqual(absent.review_configuration_receipt?.effective.worker_limits);
  });

  it.each([
    ['legacy severity', { review_engine: 'composed' }],
    ['panel engine', { review_engine: 'panel', severity_policy: 'review-yeti-severity.v2' }],
  ])('marks configured adjudication inactive for %s', (_label, selection) => {
    const selector = { version: 'DisputedBlockerAdjudicator.v1', model: 'qualified-adjudicator-alias', reasoning_effort: 'high' };
    const config = resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', ...selection, disputed_blocker_adjudicator: selector,
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'medium' }],
    } }) }, { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'primary-review-alias' });
    expect(config.review_configuration_receipt?.effective.disputed_blocker_adjudicator).toMatchObject({
      state: 'inactive', model_alias: selector.model, reasoning_effort: selector.reasoning_effort, applied: false,
    });
    expect(config.reviewers.providers[0]).toMatchObject({ model: 'primary-review-alias', effort: 'medium' });
  });

  it.each([
    ['unknown version', { version: 'DisputedBlockerAdjudicator.v99', model: 'qualified-adjudicator-alias', reasoning_effort: 'high' }],
    ['unsupported effort', { version: 'DisputedBlockerAdjudicator.v1', model: 'qualified-adjudicator-alias', reasoning_effort: 'none' }],
    ['same primary alias', { version: 'DisputedBlockerAdjudicator.v1', model: 'primary-review-alias', reasoning_effort: 'high' }],
    ['case-folded same primary alias', { version: 'DisputedBlockerAdjudicator.v1', model: 'PRIMARY-REVIEW-ALIAS', reasoning_effort: 'high' }],
    ['transport URL as model', { version: 'DisputedBlockerAdjudicator.v1', model: 'https://direct.example.invalid/v1', reasoning_effort: 'high' }],
    ['unsupported transport switch', { version: 'DisputedBlockerAdjudicator.v1', model: 'qualified-adjudicator-alias', reasoning_effort: 'high', base_url: 'https://direct.example.invalid/v1' }],
  ])('rejects %s in the adjudicator selector', (_label, selector) => {
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'composed', severity_policy: 'review-yeti-severity.v2',
      disputed_blocker_adjudicator: selector,
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'medium' }],
    } }) }, { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'not-persisted', model: 'primary-review-alias' }))
      .toThrow(/review policy could not be parsed/u);
  });

  it('rejects unrecognized review engines and unsupported Bifrost reasoning effort instead of substituting defaults', () => {
    const transport = { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' };
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'yolo',
    } }) }, transport)).toThrow(/review policy could not be parsed/u);
    expect(() => resolveWorkerConfig({ REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'security', review_engine: 'composed',
      transports: [{ name: 'bifrost', enabled: true, reasoning_effort: 'none' }],
    } }) }, transport)).toThrow(/review policy could not be parsed/u);
  });

  it('fails closed on a malformed REVIEW_YETI_POLICY_JSON instead of silently falling back to the default6 panel roster', () => {
    // Represents a policy that asked for the composed engine but whose JSON payload was corrupted
    // (truncated here). A parse failure must never be silently treated as "use the panel engine
    // with its full six-persona fan-out roster" -- that is exactly the roster (and engine) this
    // policy was trying to avoid by selecting `composed` in the first place. Deliberately does not
    // assert what engine resolveWorkerConfig "should have" picked -- the whole point is that it
    // cannot know, and must refuse to guess rather than default to panel.
    const corruptedComposedPolicy = '{"review_yeti":{"review_engine":"composed","personas":"security"';
    expect(() => resolveWorkerConfig(
      { REVIEW_YETI_POLICY_JSON: corruptedComposedPolicy },
      { baseUrl: 'https://bifrost.local', apiKey: 'test', model: 'test-model' },
    )).toThrow();
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
