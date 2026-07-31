import { describe, it, expect, vi } from 'vitest';
import { personaSchema, reviewsSchema } from '../../src/config/schema';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('Milestones M2 & M3: Multi-Turn & Reasoning Effort Suite', () => {
  describe('Milestone M2: Schema & Validation', () => {
    it('validates personaSchema maxTurns between 1 and 20', () => {
      const valid = personaSchema.safeParse({
        id: 'security',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**/*'],
        providers: ['claude'],
        maxTurns: 15,
      });
      expect(valid.success).toBe(true);

      const invalidMin = personaSchema.safeParse({
        id: 'security',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**/*'],
        providers: ['claude'],
        maxTurns: 0,
      });
      expect(invalidMin.success).toBe(false);

      const invalidMax = personaSchema.safeParse({
        id: 'security',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**/*'],
        providers: ['claude'],
        maxTurns: 25,
      });
      expect(invalidMax.success).toBe(false);
    });

    it('defaults reviewsSchema default_max_turns to 20', () => {
      const parsed = reviewsSchema.parse({});
      expect(parsed.default_max_turns).toBe(20);
    });

    it('validates dashboardStore personaSetting maxTurns bounds in validatePersonaSetting', () => {
      expect(() => {
        dashboardStore.validatePersonaSetting({
          id: 'security',
          displayName: 'Security',
          model: 'claude-3-5-sonnet',
          effort: 'low',
          confidenceThreshold: 80,
          enabled: true,
          maxTurns: 25,
        });
      }).toThrow(/maxTurns for 'security' must be an integer between 1 and 20/);

      expect(() => {
        dashboardStore.validatePersonaSetting({
          id: 'security',
          displayName: 'Security',
          model: 'claude-3-5-sonnet',
          effort: 'low',
          confidenceThreshold: 80,
          enabled: true,
          maxTurns: 12,
        });
      }).not.toThrow();
    });

    it('persists and retrieves defaultMaxTurns and defaultEffort in platform settings', () => {
      const updated = dashboardStore.updateSettings({
        defaultMaxTurns: 18,
        defaultEffort: 'xhigh',
      });
      expect(updated.defaultMaxTurns).toBe(18);
      expect(updated.defaultEffort).toBe('xhigh');

      const settings = dashboardStore.getSettings();
      expect(settings.defaultMaxTurns).toBe(18);
      expect(settings.defaultEffort).toBe('xhigh');
    });

    it('updates persona maxTurns override cleanly in dashboardStore', () => {
      const updated = dashboardStore.updatePersonaSetting('security', {
        maxTurns: 15,
        effort: 'high',
      });
      expect(updated.maxTurns).toBe(15);
      expect(updated.effort).toBe('high');

      const persona = dashboardStore.getPersonaSetting('security');
      expect(persona?.maxTurns).toBe(15);
      expect(persona?.effort).toBe('high');
    });
  });

  describe('Milestone M3: OmniRouteClient & Engine Harness', () => {
    it('passes reasoning_effort in fetch request body when provided to OmniRouteClient.complete', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        headers: new Headers({
          'x-omniroute-model': 'claude-3-5-sonnet',
          'x-omniroute-provider': 'claude',
        }),
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'CT_REVIEW_BEGIN:123\n{"decision":"SHIP"}\nCT_REVIEW_END:123' } }],
        }),
        body: {
          getReader: () => {
            const encoder = new TextEncoder();
            const text = 'data: ' + JSON.stringify({
              choices: [{ delta: { content: 'CT_REVIEW_BEGIN:123\n{"decision":"SHIP"}\nCT_REVIEW_END:123' } }],
            }) + '\n\n';
            let sent = false;
            return {
              read: async () => {
                if (!sent) {
                  sent = true;
                  return { done: false, value: encoder.encode(text) };
                }
                return { done: true, value: undefined };
              },
            };
          },
        },
      } as any);

      const client = new OmniRouteClient({ baseUrl: 'http://localhost:9999' });
      await client.complete({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'test' }],
        timeoutMs: 5000,
        reasoningEffort: 'xhigh',
      });

      expect(fetchSpy).toHaveBeenCalled();
      const fetchCallBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(fetchCallBody.reasoning_effort).toBe('xhigh');

      fetchSpy.mockRestore();
    });
  });
});
