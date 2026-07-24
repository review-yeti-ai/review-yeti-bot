import yaml from 'js-yaml';
import { ctReviewConfigSchema, ctReviewConfigV3Schema, CtReviewConfig } from './schema';

export class ConfigValidationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function parseAndValidateConfig(rawYaml: string, isCodeRabbitFormat = false): CtReviewConfig {
  if (isCodeRabbitFormat) {
    throw new ConfigValidationError('CodeRabbit configuration is not a ct-review policy');
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(rawYaml);
  } catch (error: any) {
    throw new ConfigValidationError(`YAML syntax error: ${error.message}`, error);
  }
  if (Array.isArray(parsed)) {
    throw new ConfigValidationError('Configuration YAML must be a mapping, not an array');
  }
  if (parsed === null || parsed === undefined || parsed === '') parsed = {};
  if (typeof parsed !== 'object') throw new ConfigValidationError('Configuration YAML must be a mapping');
  const raw = parsed as Record<string, unknown>;
  if (String(raw.version ?? 1) === '3') {
    if ('lenses' in raw) throw new ConfigValidationError('version 3 personas cannot be mixed with legacy lenses');
    const result = ctReviewConfigV3Schema.safeParse(raw);
    if (!result.success) {
      throw new ConfigValidationError(
        `Config validation failed: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        result.error.format(),
      );
    }
    return result.data;
  }
  const result = ctReviewConfigSchema.safeParse({ version: raw.version ?? 1, ...raw });
  if (!result.success) {
    throw new ConfigValidationError(
      `Config validation failed: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      result.error.format(),
    );
  }
  return result.data;
}
