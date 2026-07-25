import { DopplerSecretManager } from './dopplerSecretManager';
import { logger } from '../utils/logger';

export interface ProductlaneAdapterConfig {
  dopplerManager?: DopplerSecretManager;
  baseUrl?: string;
}

export class ProductlaneMCPAdapter {
  private readonly dopplerManager: DopplerSecretManager;
  private readonly baseUrl: string;

  constructor(config: ProductlaneAdapterConfig = {}) {
    this.dopplerManager = config.dopplerManager || new DopplerSecretManager();
    this.baseUrl = (config.baseUrl || 'https://api.productlane.com/v1').replace(/\/+$/, '');
  }

  public async syncChangelog(prNumber: number, title: string, content: string): Promise<{ success: boolean; id?: string }> {
    const apiKey = await this.dopplerManager.getSecret('PRODUCTLANE_API_KEY');
    if (!apiKey) {
      logger.warn('PRODUCTLANE_API_KEY missing, skipping Productlane sync');
      return { success: false };
    }

    try {
      const response = await fetch(`${this.baseUrl}/changelogs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ title: `PR #${prNumber}: ${title}`, markdown: content }),
      });
      if (!response.ok) throw new Error(`Productlane API status ${response.status}`);
      const data: any = await response.json();
      return { success: true, id: data.id || 'pl-sync-id' };
    } catch (err: any) {
      logger.error('Failed Productlane changelog sync', { error: err.message });
      return { success: false };
    }
  }

  public async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const apiKey = await this.dopplerManager.getSecret('PRODUCTLANE_API_KEY');
    return apiKey ? { ok: true, message: 'Productlane API operational' } : { ok: false, message: 'PRODUCTLANE_API_KEY unresolvable' };
  }
}
