import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry } from '../../src/mcp/server/remoteMcpRouter';

describe('Node MCP Full API Parity (Onboarding, Repo Settings, Platform Settings, Analytics & Memory)', () => {
  it('Node MCP registry exposes and executes all 8 API parity tools', async () => {
    const registry = createDefaultToolRegistry();
    const names = registry.listTools().map((t) => t.name);

    expect(names).toContain('get_onboarding_status');
    expect(names).toContain('configure_onboarding');
    expect(names).toContain('list_repositories');
    expect(names).toContain('update_repository_settings');
    expect(names).toContain('get_platform_settings');
    expect(names).toContain('update_platform_settings');
    expect(names).toContain('get_usage_analytics');
    expect(names).toContain('manage_memory_graph');

    // 1. Onboarding status & configuration
    const onbConfigRes: any = await registry.getTool('configure_onboarding')!.execute(
      { appId: '777888', installationId: '999000', generateConfig: true },
      {} as any
    );
    const onbConfigJson = JSON.parse(onbConfigRes.content[0].text);
    expect(onbConfigJson.success).toBe(true);
    expect(onbConfigJson.appConfig.appId).toBe('777888');
    expect(onbConfigJson.generatedFiles['.reviewyeti/config.md']).toContain('mode:');

    const onbStatusRes: any = await registry.getTool('get_onboarding_status')!.execute({}, {} as any);
    const onbStatusJson = JSON.parse(onbStatusRes.content[0].text);
    expect(onbStatusJson.success).toBe(true);
    expect(onbStatusJson.steps).toHaveLength(5);

    // 2. Repository list & settings update
    const listReposRes: any = await registry.getTool('list_repositories')!.execute({}, {} as any);
    const listReposJson = JSON.parse(listReposRes.content[0].text);
    expect(listReposJson.success).toBe(true);
    expect(Array.isArray(listReposJson.repositories)).toBe(true);

    const firstRepo = listReposJson.repositories[0]?.fullName || 'reviewyeti-ai/review-yeti-bot';
    const updateRepoRes: any = await registry.getTool('update_repository_settings')!.execute(
      {
        repo: firstRepo,
        automationEnabled: true,
        enforcementMode: 'block',
        customRules: 'Require bounded database queries.',
      },
      {} as any
    );
    const updateRepoJson = JSON.parse(updateRepoRes.content[0].text);
    expect(updateRepoJson.success).toBe(true);

    // 3. Platform settings, Check Run Agents & Personas
    const updateSettingsRes: any = await registry.getTool('update_platform_settings')!.execute(
      {
        detectionMode: 'deep',
        minSeverity: 'high',
        monthlyCostCapUSD: 250,
        perPrCapUSD: 4.5,
      },
      {} as any
    );
    const updateSettingsJson = JSON.parse(updateSettingsRes.content[0].text);
    expect(updateSettingsJson.settings.detectionMode).toBe('deep');
    expect(updateSettingsJson.settings.minSeverity).toBe('high');
    expect(updateSettingsJson.settings.monthlyCostCapUSD).toBe(250);

    const getSettingsRes: any = await registry.getTool('get_platform_settings')!.execute({}, {} as any);
    const getSettingsJson = JSON.parse(getSettingsRes.content[0].text);
    expect(getSettingsJson.settings.detectionMode).toBe('deep');
    expect(Array.isArray(getSettingsJson.checkAgents)).toBe(true);
    expect(Array.isArray(getSettingsJson.personas)).toBe(true);

    // 4. Usage analytics
    const usageRes: any = await registry.getTool('get_usage_analytics')!.execute({ timeframe: '7d' }, {} as any);
    const usageJson = JSON.parse(usageRes.content[0].text);
    expect(usageJson.success).toBe(true);
    expect(usageJson.costs.monthlyCapUSD).toBe(250);
    expect(Array.isArray(usageJson.costs.breakdownByModel)).toBe(true);

    // 5. Memory Graph
    const learnRes: any = await registry.getTool('manage_memory_graph')!.execute(
      {
        action: 'learn',
        repo: 'reviewyeti-ai/review-yeti-bot',
        category: 'security',
        rule: 'Always use constantTimeEquals for MCP token verification.',
      },
      {} as any
    );
    const learnJson = JSON.parse(learnRes.content[0].text);
    expect(learnJson.success).toBe(true);

    const queryMemRes: any = await registry.getTool('manage_memory_graph')!.execute(
      { action: 'query', repo: 'reviewyeti-ai/review-yeti-bot' },
      {} as any
    );
    const queryMemJson = JSON.parse(queryMemRes.content[0].text);
    expect(queryMemJson.success).toBe(true);
    expect(queryMemJson.entries.length).toBeGreaterThan(0);
  });
});
