import { ProviderConfigRecord, ModelRegistryItem } from '@/types/dashboard';
import { OMNIROUTE_GENERATED_PROVIDERS, ProviderType } from '@/types/providers.generated';
import { R4_ALLOWED_MODELS } from '@/config/schema';

/**
 * Canonical mapping for legacy or variant provider IDs.
 */
export const CANONICAL_PROVIDER_IDS: Record<string, string> = {
  custom_openai: 'custom-openai',
  agy_thinking: 'agy',
};

/**
 * List of all canonical OmniRoute providers.
 */
export const ALL_CANONICAL_PROVIDERS: (ProviderType | string)[] = [
  'openrouter',
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

  const lower = canonicalModelId.toLowerCase();
  if (lower === 'openrouter' || lower.startsWith('openrouter/')) {
    return 'openrouter';
  }
  // Resolve an explicit provider-qualified route before generated model
  // metadata. Older generated catalogs can contain the AGY leaf model under
  // Anthropic because it includes "claude"; the route prefix is authoritative.
  if (lower.startsWith('agy/')) return 'agy';

  // Explicit namespaces are authoritative. Generated metadata can contain a
  // model alias shared by another provider, so resolve the transport namespace
  // before scanning its supported-model lists.
  if (lower.startsWith('agy/')) return 'agy';
  if (lower.startsWith('synthetic/') || lower.startsWith('opencode-go/')) return 'glm';
  if (lower.startsWith('codex/')) return 'codex';

  // Check generated provider metadata
  for (const [pId, meta] of Object.entries(OMNIROUTE_GENERATED_PROVIDERS)) {
    if (meta.supportedModels.includes(canonicalModelId) || meta.defaultModel === canonicalModelId) {
      return pId;
    }
  }

  // Fallback prefix matching
  if (lower.startsWith('openrouter')) return 'openrouter';
  if (lower.startsWith('claude') || lower.startsWith('anthropic')) return 'anthropic';
  if (lower.startsWith('gpt-') || lower.startsWith('o1-') || lower.startsWith('o3-') || lower.startsWith('openai')) return 'openai';
  if (lower.startsWith('deepseek')) return 'deepseek';
  if (lower.startsWith('glm') || lower.startsWith('synthetic')) return 'glm';
  if (lower.startsWith('grok')) return 'grok';
  if (lower.startsWith('gemini') || lower.startsWith('google')) return 'gemini';
  if (lower.startsWith('codex') || lower.startsWith('cx')) return 'codex';
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
  const canonicalModelId = modelId ? modelId.trim() : '';

  if (providerId === 'openrouter' || canonicalModelId.startsWith('openrouter/')) {
    const config = providers?.['openrouter'] || providers?.[CANONICAL_PROVIDER_IDS['openrouter'] || 'openrouter'];
    if (config && (config.enabled === false || config.active === false)) {
      return false;
    }
    if (R4_ALLOWED_MODELS.includes(canonicalModelId as any) || canonicalModelId.startsWith('openrouter/')) {
      return true;
    }
  }

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
