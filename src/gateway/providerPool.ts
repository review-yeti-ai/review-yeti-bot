import { z } from 'zod';

export const providerConfigSchema = z.object({
  id: z.string().min(1, 'Provider id is required'),
  type: z.string().min(1, 'Provider type is required'),
  apiKey: z.string().min(1, 'apiKey is required'),
  baseUrl: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).min(1, 'models must contain at least one model'),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export class ProviderPool {
  private providers = new Map<string, ProviderConfig>();

  /**
   * Registers a new provider into the pool.
   * Validates config schema and prevents duplicate provider IDs.
   */
  public registerProvider(config: ProviderConfig, allowUpdate = false): ProviderConfig {
    const raw = { ...config };
    if (raw.baseUrl === '') {
      delete raw.baseUrl;
    }
    const validated = providerConfigSchema.parse(raw);
    if (this.providers.has(validated.id) && !allowUpdate) {
      throw new Error(`Provider with id '${validated.id}' is already registered`);
    }

    this.providers.set(validated.id, validated);
    return validated;
  }

  /** Registers a provider or replaces the current config for its stable id. */
  public upsertProvider(config: ProviderConfig): ProviderConfig {
    const validated = providerConfigSchema.parse(config);
    this.providers.set(validated.id, validated);
    return validated;
  }

  /**
   * Retrieves a registered provider by ID.
   */
  public getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  /**
   * Checks if a provider with the given ID exists.
   */
  public hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Lists all registered providers.
   */
  public listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Removes a provider by ID from the pool.
   */
  public removeProvider(id: string): boolean {
    return this.providers.delete(id);
  }

  /**
   * Checks if a model is allowlisted for a specific provider.
   */
  public isModelAllowed(providerId: string, model: string): boolean {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return false;
    }
    return provider.models.includes(model);
  }

  /**
   * Clears all registered providers (useful for test isolation).
   */
  public clear(): void {
    this.providers.clear();
  }
}

export const providerPool = new ProviderPool();
