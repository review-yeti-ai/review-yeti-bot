import { createDefaultV3Config } from './configLoader';
import type { CtReviewConfigV3, ProviderId } from './schema';
import { logger } from '../utils/logger';

export function resolveWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  transport: { baseUrl: string; apiKey: string; model: string },
): CtReviewConfigV3 {
  const baseConfig = createDefaultV3Config();

  let maxInvestigationTurns = 2;
  let personasList: string[] = [];

  if (env.REVIEW_YETI_POLICY_JSON) {
    try {
      const raw = JSON.parse(env.REVIEW_YETI_POLICY_JSON);
      const policy = raw.review_yeti || raw;
      if (policy.budget?.max_investigation_turns) {
        maxInvestigationTurns = Number(policy.budget.max_investigation_turns);
      }
      if (typeof policy.personas === 'string') {
        personasList = policy.personas.split(',').map((p: string) => p.trim()).filter(Boolean);
      } else if (Array.isArray(policy.personas)) {
        personasList = policy.personas;
      }
    } catch (e) {
      logger.warn('Failed to parse REVIEW_YETI_POLICY_JSON', { error: e });
    }
  }

  if (personasList.length === 0 && env.REVIEW_PERSONAS) {
    personasList = env.REVIEW_PERSONAS.split(',').map((p) => p.trim()).filter(Boolean);
  }

  if (env.MAX_INVESTIGATION_TURNS) {
    const turns = Number(env.MAX_INVESTIGATION_TURNS);
    if (Number.isSafeInteger(turns) && turns > 0) {
      maxInvestigationTurns = turns;
    }
  }

  const default6 = ['security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing'];
  const effectivePersonaNames = personasList.length > 0 ? personasList : default6;

  const personaMap: Record<string, { id: string; required: boolean; charter: string; paths: string[] }> = {
    'security': { id: 'sec-lane', required: true, charter: 'builtin:security', paths: ['**'] },
    'sec-lane': { id: 'sec-lane', required: true, charter: 'builtin:security', paths: ['**'] },
    'performance': { id: 'perf-lane', required: false, charter: 'builtin:performance', paths: ['**'] },
    'perf-lane': { id: 'perf-lane', required: false, charter: 'builtin:performance', paths: ['**'] },
    'architecture': { id: 'arch-lane', required: false, charter: 'builtin:constitutional-goals', paths: ['**'] },
    'arch-lane': { id: 'arch-lane', required: false, charter: 'builtin:constitutional-goals', paths: ['**'] },
    'testing': { id: 'qual-lane', required: false, charter: 'builtin:consistency', paths: ['**'] },
    'qual-lane': { id: 'qual-lane', required: false, charter: 'builtin:consistency', paths: ['**'] },
    'dependencies': { id: 'dep-lane', required: false, charter: 'builtin:contract', paths: ['**'] },
    'dep-lane': { id: 'dep-lane', required: false, charter: 'builtin:contract', paths: ['**'] },
    'licensing': { id: 'policy-lane', required: false, charter: 'builtin:policy-compliance', paths: ['**'] },
    'policy-lane': { id: 'policy-lane', required: false, charter: 'builtin:policy-compliance', paths: ['**'] },
  };

  const personas = effectivePersonaNames.map((name) => {
    const key = name.toLowerCase().trim();
    const matched = personaMap[key] || {
      id: name,
      required: false,
      charter: 'builtin:correctness',
      paths: ['**'],
    };
    return {
      id: matched.id,
      enabled: true,
      required: matched.required,
      charter: matched.charter,
      paths: matched.paths,
      providers: ['bifrost'] as ProviderId[],
    };
  });

  return {
    ...baseConfig,
    personas,
    default_max_turns: Math.min(3, Math.max(1, maxInvestigationTurns || 2)),
    reviewer_effort: 'medium',
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 900,
      providers: [
        {
          id: 'bifrost' as ProviderId,
          enabled: true,
          model: transport.model,
          effort: 'medium',
          review_timeout_s: 300,
          arbiter_timeout_s: 300,
        },
      ],
      arbiter: {
        order: ['bifrost' as ProviderId],
      },
    },
    evidence: {
      zoekt: {
        enabled: true,
      },
    },
  };
}
