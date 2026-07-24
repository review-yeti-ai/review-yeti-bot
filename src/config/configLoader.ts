import yaml from 'js-yaml';
import { DEFAULT_ORG_CONFIG } from './defaultOrgConfig';
import { ctReviewConfigSchema, codeRabbitConfigSchema, CtReviewConfig } from './schema';

export class ConfigValidationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Deep merge utility for config objects.
 * - Primitive values in target override source.
 * - Objects are recursively merged.
 * - Arrays in target override source (if target array is non-empty/defined).
 */
export function deepMergeConfig(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...source };
  
  for (const key of Object.keys(target)) {
    const targetVal = target[key];
    const sourceVal = source[key];
    
    if (targetVal === undefined || targetVal === null) {
      continue;
    }
    
    if (Array.isArray(targetVal)) {
      result[key] = targetVal;
    } else if (typeof targetVal === 'object' && !Array.isArray(targetVal) && targetVal !== null) {
      result[key] = deepMergeConfig(targetVal, typeof sourceVal === 'object' && sourceVal !== null ? sourceVal : {});
    } else {
      result[key] = targetVal;
    }
  }
  
  return result;
}

/**
 * Converts parsed `.coderabbit.yaml` config into equivalent `CtReviewConfig` overrides.
 */
export function convertCodeRabbitConfig(raw: Record<string, any>): Partial<CtReviewConfig> {
  const parsed = codeRabbitConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {};
  }

  const cr = parsed.data;
  const config: Partial<CtReviewConfig> = {};

  if (cr.reviews) {
    config.quorum = {
      minApprovals: 2,
      personas: ['security', 'architecture', 'performance', 'quality'],
      effortLevel: cr.reviews.profile === 'chill' ? 'low' : cr.reviews.profile === 'assertive' ? 'high' : 'medium',
    };
  }

  return config;
}

/**
 * Main Loader API
 */
export function parseAndValidateConfig(rawYaml: string, isCodeRabbitFormat = false): CtReviewConfig {
  let parsedRaw: unknown;
  try {
    parsedRaw = yaml.load(rawYaml);
  } catch (err: any) {
    throw new ConfigValidationError(`YAML syntax error: ${err.message}`, err);
  }

  if (Array.isArray(parsedRaw)) {
    throw new ConfigValidationError('Configuration YAML must be a key-value mapping object, not an array');
  }

  if (typeof parsedRaw !== 'object' || parsedRaw === null) {
    parsedRaw = {};
  }

  let userOverrides: Record<string, any> = parsedRaw as Record<string, any>;
  if (isCodeRabbitFormat) {
    userOverrides = convertCodeRabbitConfig(userOverrides) as Record<string, any>;
  }

  const merged = deepMergeConfig(userOverrides, DEFAULT_ORG_CONFIG);

  const validationResult = ctReviewConfigSchema.safeParse(merged);
  if (!validationResult.success) {
    throw new ConfigValidationError(
      `Config validation failed: ${validationResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      validationResult.error.format()
    );
  }

  return validationResult.data;
}
