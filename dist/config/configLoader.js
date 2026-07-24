"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigValidationError = void 0;
exports.deepMergeConfig = deepMergeConfig;
exports.convertCodeRabbitConfig = convertCodeRabbitConfig;
exports.parseAndValidateConfig = parseAndValidateConfig;
const js_yaml_1 = __importDefault(require("js-yaml"));
const defaultOrgConfig_1 = require("./defaultOrgConfig");
const schema_1 = require("./schema");
class ConfigValidationError extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
        this.name = 'ConfigValidationError';
    }
}
exports.ConfigValidationError = ConfigValidationError;
/**
 * Deep merge utility for config objects.
 * - Primitive values in target override source.
 * - Objects are recursively merged.
 * - Arrays in target override source (if target array is non-empty/defined).
 */
function deepMergeConfig(target, source) {
    const result = { ...source };
    for (const key of Object.keys(target)) {
        const targetVal = target[key];
        const sourceVal = source[key];
        if (targetVal === undefined || targetVal === null) {
            continue;
        }
        if (Array.isArray(targetVal)) {
            result[key] = targetVal;
        }
        else if (typeof targetVal === 'object' && !Array.isArray(targetVal) && targetVal !== null) {
            result[key] = deepMergeConfig(targetVal, typeof sourceVal === 'object' && sourceVal !== null ? sourceVal : {});
        }
        else {
            result[key] = targetVal;
        }
    }
    return result;
}
/**
 * Converts parsed `.coderabbit.yaml` config into equivalent `CtReviewConfig` overrides.
 */
function convertCodeRabbitConfig(raw) {
    const parsed = schema_1.codeRabbitConfigSchema.safeParse(raw);
    if (!parsed.success) {
        return {};
    }
    const cr = parsed.data;
    const config = {};
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
function parseAndValidateConfig(rawYaml, isCodeRabbitFormat = false) {
    let parsedRaw;
    try {
        parsedRaw = js_yaml_1.default.load(rawYaml);
    }
    catch (err) {
        throw new ConfigValidationError(`YAML syntax error: ${err.message}`, err);
    }
    if (Array.isArray(parsedRaw)) {
        throw new ConfigValidationError('Configuration YAML must be a key-value mapping object, not an array');
    }
    if (typeof parsedRaw !== 'object' || parsedRaw === null) {
        parsedRaw = {};
    }
    let userOverrides = parsedRaw;
    if (isCodeRabbitFormat) {
        userOverrides = convertCodeRabbitConfig(userOverrides);
    }
    const merged = deepMergeConfig(userOverrides, defaultOrgConfig_1.DEFAULT_ORG_CONFIG);
    const validationResult = schema_1.ctReviewConfigSchema.safeParse(merged);
    if (!validationResult.success) {
        throw new ConfigValidationError(`Config validation failed: ${validationResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, validationResult.error.format());
    }
    return validationResult.data;
}
//# sourceMappingURL=configLoader.js.map