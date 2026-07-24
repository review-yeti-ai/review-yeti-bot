import { CtReviewConfig } from './schema';
export declare class ConfigValidationError extends Error {
    readonly details?: unknown | undefined;
    constructor(message: string, details?: unknown | undefined);
}
/**
 * Deep merge utility for config objects.
 * - Primitive values in target override source.
 * - Objects are recursively merged.
 * - Arrays in target override source (if target array is non-empty/defined).
 */
export declare function deepMergeConfig(target: Record<string, any>, source: Record<string, any>): Record<string, any>;
/**
 * Converts parsed `.coderabbit.yaml` config into equivalent `CtReviewConfig` overrides.
 */
export declare function convertCodeRabbitConfig(raw: Record<string, any>): Partial<CtReviewConfig>;
/**
 * Main Loader API
 */
export declare function parseAndValidateConfig(rawYaml: string, isCodeRabbitFormat?: boolean): CtReviewConfig;
