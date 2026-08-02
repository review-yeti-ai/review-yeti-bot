import yaml from 'js-yaml';
import { CtReviewConfigV3, CtReviewConfigV4, ctReviewConfigV3Schema } from './schema';
import { parseAndValidateConfig, createDefaultV3Config, ConfigValidationError, translateLegacyConfigToV3, sanitizeV3Config, normalizeConfigToV4 } from './configLoader';
import { sha256 } from '../review/reviewCore';

export interface RepositoryContentClient {
  getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
}

export interface ConfigResolutionOptions {
  owner: string;
  repo: string;
  ref?: string;
  client: RepositoryContentClient;
  systemSettingsOverride?: Record<string, any>;
}

export interface ResolvedConfigProvenance {
  config: CtReviewConfigV4;
  source: 'repository' | 'organization' | 'default';
  configRef: string;
  configDigest: string;
}

export class ConfigResolver {
  public static CONFIG_FILES = [
    '.ct-review.yaml',
    '.ct-review.yml',
    'ct-review.yaml',
    '.coderabbit.yaml',
  ];

  /**
   * Loads and resolves 3-tier configuration hierarchy (Repo -> Org -> System).
   */
  public async resolveConfig(options: ConfigResolutionOptions): Promise<CtReviewConfigV3> {
    const { owner, repo, ref, client, systemSettingsOverride } = options;

    // Tier 3: Base System Defaults
    const systemDefault = createDefaultV3Config();
    if (systemSettingsOverride) {
      this.applySettingsOverride(systemDefault, systemSettingsOverride);
    }

    // Tier 1: Target Repository Config
    const repoConfigRaw = await this.fetchRawConfig(owner, repo, ref, client);

    // Tier 2: Org Defaults (.github repository)
    let orgConfigRaw: Partial<CtReviewConfigV3> | null = null;
    if (repo !== '.github') {
      orgConfigRaw = await this.fetchRawConfig(owner, '.github', undefined, client);
    }

    // Deep merge: System -> Org -> Repo
    const merged = this.deepMergeConfigs(systemDefault, orgConfigRaw, repoConfigRaw);

    // Validate merged config
    return this.validateResolvedConfig(merged);
  }

  /**
   * Resolves the policy used by a run and records the source/ref/digest needed to reproduce it.
   * The older resolveConfig method remains v3-shaped for existing callers.
   */
  public async resolveConfigWithProvenance(options: ConfigResolutionOptions): Promise<ResolvedConfigProvenance> {
    const repoRaw = await this.fetchRawConfig(options.owner, options.repo, options.ref, options.client);
    const orgRaw = repoRaw === null && options.repo !== '.github'
      ? await this.fetchRawConfig(options.owner, '.github', undefined, options.client)
      : null;
    const source = repoRaw !== null ? 'repository' : orgRaw !== null ? 'organization' : 'default';
    const resolvedV3 = await this.resolveConfig(options);
    const selectedV4 = (repoRaw?.version === 4 ? repoRaw : orgRaw?.version === 4 ? orgRaw : null) as CtReviewConfigV4 | null;
    const config = normalizeConfigToV4({
      ...resolvedV3,
      ...(selectedV4 ? {
        submodules: selectedV4.submodules,
        limits: selectedV4.limits,
      } : {}),
    } as unknown as CtReviewConfigV4);
    return {
      config,
      source,
      configRef: options.ref || 'default',
      configDigest: sha256(config),
    };
  }

  public async fetchRawConfig(
    owner: string,
    repo: string,
    ref: string | undefined,
    client: RepositoryContentClient
  ): Promise<any | null> {
    for (const fileName of ConfigResolver.CONFIG_FILES) {
      const content = ref !== undefined
        ? await client.getFileContent(owner, repo, fileName, ref)
        : await client.getFileContent(owner, repo, fileName);
      if (content !== null && content !== undefined) {
        const isCodeRabbit = fileName === '.coderabbit.yaml';
        try {
          const parsed = parseAndValidateConfig(content, isCodeRabbit);
          if ((parsed as any).version !== 3 && (parsed as any).version !== 4) {
            return translateLegacyConfigToV3(parsed);
          }
          if ((parsed as any).version === 4) return parsed;
          return parsed;
        } catch (err: any) {
          if (err instanceof ConfigValidationError && (err.message.includes('YAML syntax error') || err.message.includes('must be a mapping'))) {
            throw err;
          }
          let raw: any;
          try {
            raw = yaml.load(content);
          } catch (yamlErr: any) {
            throw new ConfigValidationError(`YAML syntax error: ${yamlErr.message}`, yamlErr);
          }
          if (Array.isArray(raw)) {
            throw new ConfigValidationError('Configuration YAML must be a mapping, not an array');
          }
          if (raw !== null && typeof raw === 'object') {
            return raw;
          }
          throw err;
        }
      }
    }
    return null;
  }

  public deepMergeConfigs(
    sys: CtReviewConfigV3,
    org: any | null,
    repo: any | null
  ): CtReviewConfigV3 {
    const orgObj = org || {};
    const repoObj = repo || {};

    // 1. Resolve top-level scalars
    const profile = repoObj.profile ?? orgObj.profile ?? sys.profile;
    const confidence_threshold = repoObj.confidence_threshold ?? orgObj.confidence_threshold ?? sys.confidence_threshold;
    const mascot = repoObj.mascot ?? orgObj.mascot ?? sys.mascot;
    const reviewer_effort = repoObj.reviewer_effort ?? orgObj.reviewer_effort ?? sys.reviewer_effort;
    const default_effort = repoObj.default_effort ?? orgObj.default_effort ?? sys.default_effort ?? reviewer_effort;
    const default_max_turns = repoObj.default_max_turns ?? repoObj.reviews?.default_max_turns ?? orgObj.default_max_turns ?? orgObj.reviews?.default_max_turns ?? sys.default_max_turns ?? sys.reviews?.default_max_turns ?? 20;
    const quorum = repoObj.quorum ?? orgObj.quorum ?? sys.quorum;

    // 2. Global persona model override dial if specified
    const persona_model = repoObj.dials?.persona_model ?? orgObj.dials?.persona_model ?? sys.dials?.persona_model;

    // 3. Merge Personas (Keyed by ID across 10 persona lanes)
    const personaMap = new Map<string, any>();

    // Seed with system default personas (10 standard personas)
    for (const p of sys.personas) {
      personaMap.set(p.id, { ...p });
    }

    // Extract personas from org (checking personas array or dials/reviews personas object)
    const orgPersonas = this.extractPersonas(orgObj);
    if (orgPersonas) {
      this.overlayPersonas(personaMap, orgPersonas);
    }

    // Extract personas from repo (checking personas array or dials/reviews personas object)
    const repoPersonas = this.extractPersonas(repoObj);
    if (repoPersonas) {
      this.overlayPersonas(personaMap, repoPersonas);
    }

    // Apply global persona_model dial if persona doesn't explicitly define model
    if (persona_model) {
      for (const [id, persona] of personaMap.entries()) {
        if (!persona.model) {
          personaMap.set(id, { ...persona, model: persona_model });
        }
      }
    }

    const mergedPersonas = Array.from(personaMap.values());

    // 4. Merge Reviewers & Providers
    const sysProviders = sys.reviewers.providers || [];
    const orgProviders = orgObj.reviewers?.providers;
    const repoProviders = repoObj.reviewers?.providers;

    const mergedProviders = this.mergeProviders(sysProviders, orgProviders, repoProviders);

    const mergedReviewers = {
      execution: repoObj.reviewers?.execution ?? orgObj.reviewers?.execution ?? sys.reviewers.execution ?? 'personas',
      fallback: repoObj.reviewers?.fallback ?? orgObj.reviewers?.fallback ?? sys.reviewers.fallback ?? 'ordered',
      overall_timeout_s: repoObj.reviewers?.overall_timeout_s ?? orgObj.reviewers?.overall_timeout_s ?? sys.reviewers.overall_timeout_s ?? 60,
      providers: mergedProviders,
      arbiter: {
        order: repoObj.reviewers?.arbiter?.order ?? orgObj.reviewers?.arbiter?.order ?? sys.reviewers.arbiter.order ?? ['codex', 'claude'],
      },
    };

    // 5. Array Overrides
    const path_instructions = repoObj.path_instructions ?? orgObj.path_instructions ?? sys.path_instructions ?? [];
    const rules = repoObj.rules ?? orgObj.rules ?? sys.rules ?? [];
    const path_filters = repoObj.path_filters ?? orgObj.path_filters ?? sys.path_filters ?? [];
    const mcps = repoObj.mcps ?? orgObj.mcps ?? sys.mcps ?? [];

    // 6. Sub-object merges
    const mergedReviews = {
      ...sys.reviews,
      ...(orgObj.reviews || {}),
      ...(repoObj.reviews || {}),
      profile,
      reviewer_effort,
      default_max_turns,
      confidence_threshold: confidence_threshold ?? sys.reviews.confidence_threshold,
      mascot: mascot ?? sys.reviews.mascot,
      path_instructions,
    };

    const mergedChat = {
      ...sys.chat,
      ...(orgObj.chat || {}),
      ...(repoObj.chat || {}),
    };

    const mergedKb = {
      ...sys.knowledge_base,
      ...(orgObj.knowledge_base || {}),
      ...(repoObj.knowledge_base || {}),
    };

    const mergedAutoReview = {
      ...sys.auto_review,
      ...(orgObj.auto_review || {}),
      ...(repoObj.auto_review || {}),
    };

    const mergedDials = {
      ...sys.dials,
      ...(orgObj.dials || {}),
      ...(repoObj.dials || {}),
      memory_engine: repoObj.dials?.memory_engine ?? orgObj.dials?.memory_engine ?? sys.dials.memory_engine,
      mascot: repoObj.dials?.mascot ?? orgObj.dials?.mascot ?? sys.dials.mascot,
      confidence_threshold: repoObj.dials?.confidence_threshold ?? orgObj.dials?.confidence_threshold ?? sys.dials.confidence_threshold,
      ...(persona_model ? { persona_model } : {}),
    };

    const mergedOnPRClose = {
      ...sys.on_pr_close,
      ...(orgObj.on_pr_close || {}),
      ...(repoObj.on_pr_close || {}),
    };

    // 7. Construct merged V3 config
    const result: CtReviewConfigV3 = {
      ...sys,
      ...orgObj,
      ...repoObj,
      version: 3,
      profile,
      quorum,
      ...(reviewer_effort ? { reviewer_effort } : {}),
      ...(default_effort ? { default_effort } : {}),
      ...(default_max_turns !== undefined ? { default_max_turns } : {}),
      ...(confidence_threshold !== undefined ? { confidence_threshold } : {}),
      ...(mascot !== undefined ? { mascot } : {}),
      personas: mergedPersonas,
      reviewers: mergedReviewers,
      reviews: mergedReviews,
      chat: mergedChat,
      knowledge_base: mergedKb,
      path_filters,
      auto_review: mergedAutoReview,
      dials: mergedDials,
      path_instructions,
      rules,
      mcps,
      on_pr_close: mergedOnPRClose,
    };

    return result;
  }

  private extractPersonas(configObj: any): any[] | Record<string, any> | null {
    if (!configObj) return null;
    if (configObj.personas) return configObj.personas;
    if (configObj.dials?.personas) return configObj.dials.personas;
    if (configObj.reviews?.personas) return configObj.reviews.personas;
    return null;
  }

  private overlayPersonas(targetMap: Map<string, any>, incomingPersonas: any[] | Record<string, any>): void {
    const list = Array.isArray(incomingPersonas)
      ? incomingPersonas
      : Object.entries(incomingPersonas).map(([id, val]) => (typeof val === 'object' && val !== null ? { id, ...val } : { id }));

    for (const item of list) {
      if (!item.id) continue;
      const existing = targetMap.get(item.id) || {
        id: item.id,
        enabled: true,
        required: false,
        charter: 'builtin:correctness',
        paths: ['**'],
        providers: ['synthetic'],
      };
      targetMap.set(item.id, {
        ...existing,
        ...item,
        enabled: item.enabled ?? existing.enabled ?? true,
        required: item.required ?? existing.required ?? false,
        charter: item.charter || existing.charter || 'builtin:correctness',
        paths: item.paths ?? existing.paths ?? ['**'],
        providers: item.providers ?? existing.providers ?? ['synthetic'],
      });
    }
  }

  private mergeProviders(sysProviders: any[], orgProviders?: any[], repoProviders?: any[]): any[] {
    const providerMap = new Map<string, any>();
    for (const p of sysProviders) {
      providerMap.set(p.id, { ...p });
    }
    if (Array.isArray(orgProviders)) {
      for (const p of orgProviders) {
        if (!p.id) continue;
        const existing = providerMap.get(p.id) || {};
        providerMap.set(p.id, { ...existing, ...p });
      }
    }
    if (Array.isArray(repoProviders)) {
      for (const p of repoProviders) {
        if (!p.id) continue;
        const existing = providerMap.get(p.id) || {};
        providerMap.set(p.id, { ...existing, ...p });
      }
    }
    return Array.from(providerMap.values());
  }

  public validateResolvedConfig(config: any): CtReviewConfigV3 {
    sanitizeV3Config(config);
    const parseResult = ctReviewConfigV3Schema.safeParse(config);
    if (!parseResult.success) {
      throw new ConfigValidationError(
        `Config validation failed: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        parseResult.error.format()
      );
    }
    return parseResult.data;
  }

  private applySettingsOverride(target: CtReviewConfigV3, overrides: Record<string, any>): void {
    if (overrides.defaultModelOverrides) {
      for (const p of target.reviewers.providers) {
        if (overrides.defaultModelOverrides[p.id]) {
          p.model = overrides.defaultModelOverrides[p.id];
        }
      }
    }
  }
}
