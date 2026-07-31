import { ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';
import { OMNIROUTE_GENERATED_PROVIDERS, ProviderType } from '@/types/providers.generated';

/**
 * Canonical mapping for legacy or variant provider IDs.
 */
export const CANONICAL_PROVIDER_IDS: Record<string, string> = {
  custom_openai: 'custom-openai',
  agy_thinking: 'agy',
};

/**
 * List of all 11 canonical OmniRoute providers.
 */
export const ALL_CANONICAL_PROVIDERS: ProviderType[] = [
  'anthropic',
  'openai',
  'grok',
  'deepseek',
  'glm',
  'gemini',
  'doppler',
  'ollama',
  'custom-openai',
  'codex',
  'agy',
];

/**
 * Resolves the provider ID associated with a given model ID.
 */
export function getProviderIdForModel(
  modelId: string,
  modelRegistry?: Record<string, ModelRegistryItem>
): string {
  if (!modelId) return 'anthropic';

  const canonicalModelId = modelId.trim();

  if (modelRegistry?.[canonicalModelId]?.providerId) {
    const registryProvider = modelRegistry[canonicalModelId].providerId;
    return CANONICAL_PROVIDER_IDS[registryProvider] || registryProvider;
  }

  // Check generated provider metadata
  for (const [pId, meta] of Object.entries(OMNIROUTE_GENERATED_PROVIDERS)) {
    if (meta.supportedModels.includes(canonicalModelId) || meta.defaultModel === canonicalModelId) {
      return pId;
    }
  }

  // Fallback prefix matching
  const lower = canonicalModelId.toLowerCase();
  if (lower.startsWith('claude') || lower.startsWith('anthropic')) return 'anthropic';
  if (lower.startsWith('gpt-') || lower.startsWith('o1-') || lower.startsWith('o3-') || lower.startsWith('openai')) return 'openai';
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('glm') || lower.startsWith('synthetic')) return 'glm';
  if (lower.startsWith('grok')) return 'grok';
  if (lower.startsWith('gemini') || lower.startsWith('google')) return 'gemini';
  if (lower.startsWith('codex') || lower.startsWith('cx')) return 'codex';
  if (lower.startsWith('agy')) return 'agy';
  if (lower.startsWith('llama') || lower.startsWith('qwen') || lower.startsWith('ollama')) return 'ollama';
  if (lower.startsWith('doppler')) return 'doppler';
  if (lower.startsWith('custom')) return 'custom-openai';

  return 'anthropic';
}

/**
 * Determines whether a provider is configured and enabled in the given providers state.
 */
export function isProviderEnabled(
  providerId: string,
  providers?: Record<string, ProviderConfigRecord>
): boolean {
  if (!providers || Object.keys(providers).length === 0) {
    return true;
  }

  const canonicalId = CANONICAL_PROVIDER_IDS[providerId] || providerId;
  const config = providers[canonicalId] || providers[providerId];

  if (!config) {
    return false;
  }

  return config.enabled !== false && config.active !== false;
}

/**
 * Determines whether a model is enabled by checking if its associated provider is enabled.
 */
export function isModelEnabled(
  modelId: string,
  providers?: Record<string, ProviderConfigRecord>,
  modelRegistry?: Record<string, ModelRegistryItem>
): boolean {
  const providerId = getProviderIdForModel(modelId, modelRegistry);
  return isProviderEnabled(providerId, providers);
}

/**
 * Returns an array of provider IDs for all active/enabled providers.
 */
export function getEnabledProviders(
  providers?: Record<string, ProviderConfigRecord>
): string[] {
  return ALL_CANONICAL_PROVIDERS.filter((pId) => isProviderEnabled(pId, providers));
}

/**
 * Filters a list of model option objects to only include models from active/enabled providers.
 */
export function getEnabledModelOptions<T extends { value: string }>(
  modelOptions: T[],
  providers?: Record<string, ProviderConfigRecord>,
  modelRegistry?: Record<string, ModelRegistryItem>
): T[] {
  return modelOptions.filter((opt) => isModelEnabled(opt.value, providers, modelRegistry));
}

/**
 * Selects an enabled fallback model if the current model belongs to a disabled provider.
 */
export function getFallbackModelForPersona(
  currentModel: string,
  enabledOptions: { label: string; value: string }[],
  defaultFallback: string = 'claude-haiku-4.5'
): string {
  if (enabledOptions.some((opt) => opt.value === currentModel)) {
    return currentModel;
  }
  if (enabledOptions.length > 0) {
    return enabledOptions[0].value;
  }
  return defaultFallback;
}
