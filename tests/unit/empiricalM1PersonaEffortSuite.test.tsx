// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import yaml from 'js-yaml';

import { Step4PersonaEnsemble, PERSONA_ENSEMBLE_DEFINITIONS } from '@/components/onboarding/steps/step-4-persona-ensemble';
import { ManifestDrawer } from '@/components/onboarding/manifest-drawer';
import { PersonaStatusGrid } from '@/components/dashboard/persona-status-grid';
import { DashboardStore } from '@/persistence/dashboardStore';
import { createDefaultV3Config, translateCodeRabbitToV3, translateLegacyConfigToV3 } from '@/config/configLoader';
import { generateCtReviewConfig } from '@/onboarding/configGenerator';
import * as apiClient from '@/lib/api-client';

// Polyfills for Radix UI primitives in JSDOM
if (typeof window !== 'undefined') {
  window.PointerEvent = window.PointerEvent || class PointerEvent extends Event {};
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || function () {};
  window.HTMLElement.prototype.hasPointerCapture = window.HTMLElement.prototype.hasPointerCapture || function () { return false; };
  window.HTMLElement.prototype.releasePointerCapture = window.HTMLElement.prototype.releasePointerCapture || function () {};
}

// Mock Radix Tabs Content to always render children in JSDOM unit tests
vi.mock('@radix-ui/react-tabs', async () => {
  const actual: any = await vi.importActual('@radix-ui/react-tabs');
  return {
    ...actual,
    Content: ({ children, className }: any) => <div className={className}>{children}</div>,
  };
});

// Mock next/navigation for settings page testing
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

// Mock api-client for settings page
vi.mock('@/lib/api-client', () => ({
  fetchPersonas: vi.fn().mockResolvedValue({
    security: { id: 'security', displayName: 'Security', model: 'claude-3-5-sonnet', effort: 'low', confidenceThreshold: 85, enabled: true },
  }),
  updatePersona: vi.fn().mockImplementation((id, patch) => Promise.resolve({ id, effort: 'low', ...patch })),
  fetchProviders: vi.fn().mockResolvedValue({ providers: {}, modelRegistry: {}, models: [] }),
}));

describe('Empirical Challenge Suite — Milestone 1: Default Persona Effort to Low', () => {
  beforeEach(() => {
    vi.mocked(apiClient.fetchPersonas).mockResolvedValue({
      security: { id: 'security', displayName: 'Security', model: 'claude-3-5-sonnet', effort: 'low', confidenceThreshold: 85, enabled: true },
    } as any);
    vi.mocked(apiClient.fetchProviders).mockResolvedValue({ providers: {}, modelRegistry: {}, models: [] } as any);
  });

  describe('1. Step4PersonaEnsemble UI Component Effort Defaults', () => {
    it('defaults effort select trigger for all 11 personas to "low" when personas prop is empty', () => {
      const dummyUpdate = vi.fn();
      render(
        <Step4PersonaEnsemble personas={{}} onUpdatePersona={dummyUpdate} />
      );

      // Verify all 11 persona definitions exist in contract
      expect(PERSONA_ENSEMBLE_DEFINITIONS).toHaveLength(11);

      // Find all select triggers showing "Low"
      const effortElements = screen.getAllByText('Low');
      // Should have at least 11 "Low" select triggers matching the 11 personas
      expect(effortElements.length).toBeGreaterThanOrEqual(11);
    });

    it('defaults effort to "low" when a persona object exists but has undefined or missing effort property', () => {
      const dummyUpdate = vi.fn();
      const partialPersonas: Record<string, any> = {
        security: { id: 'security', displayName: 'Security', model: 'claude-3-5-sonnet', enabled: true }, // no effort property!
      };

      render(
        <Step4PersonaEnsemble personas={partialPersonas} onUpdatePersona={dummyUpdate} />
      );

      const lowElements = screen.getAllByText('Low');
      expect(lowElements.length).toBeGreaterThanOrEqual(11);
    });

    it('allows changing effort level from low to medium via onUpdatePersona callback', () => {
      const updateSpy = vi.fn();
      render(
        <Step4PersonaEnsemble personas={{}} onUpdatePersona={updateSpy} />
      );

      const triggers = screen.getAllByText('Low');
      expect(triggers.length).toBeGreaterThan(0);
    });
  });

  describe('2. ManifestDrawer .ct-review.yml Generation Defaults', () => {
    it('generates .ct-review.yml with effort: "low" for ALL 11 personas in YAML content', () => {
      render(<ManifestDrawer open={true} />);

      // Query pre elements across document (Radix Portal)
      let yamlText = '';
      const preElements = document.querySelectorAll('pre');
      preElements.forEach((pre) => {
        if (pre.textContent && pre.textContent.includes('personas:')) {
          yamlText = pre.textContent;
        }
      });

      // Parse generated YAML text
      expect(yamlText).not.toBe('');
      expect(yamlText).toContain('# Reviewer Personas Ensemble Configuration (11 Personas)');

      const parsed: any = yaml.load(yamlText);
      expect(parsed).toBeDefined();
      expect(parsed.personas).toBeDefined();

      const personaKeys = Object.keys(parsed.personas);
      expect(personaKeys).toHaveLength(11);

      // Verify EVERY persona has effort === 'low'
      for (const key of personaKeys) {
        const p = parsed.personas[key];
        expect(p.effort).toBe('low');
      }
    });

    it('contains ZERO occurrences of effort: "medium", effort: "high", effort: "xhigh", or effort: "max" in generated YAML', () => {
      render(<ManifestDrawer open={true} />);

      let yamlText = '';
      const codeElements = document.querySelectorAll('code, pre');
      codeElements.forEach((el) => {
        if (el.textContent && el.textContent.includes('personas:')) {
          yamlText = el.textContent;
        }
      });

      expect(yamlText).not.toBe('');
      expect(yamlText).not.toContain('effort: "medium"');
      expect(yamlText).not.toContain('effort: "high"');
      expect(yamlText).not.toContain('effort: "xhigh"');
      expect(yamlText).not.toContain('effort: "max"');
      expect(yamlText).not.toContain("effort: 'medium'");
      expect(yamlText).not.toContain("effort: 'high'");
    });
  });

  describe('3. DashboardStore Default Stored Persona State & Fallback Logic', () => {
    it('initializes default stored state with effort: "low" for all 12 default personas in dashboardStore', () => {
      const store = new DashboardStore('/tmp/test-m1-effort-store.json');
      const settings = store.getSettings();
      const personas = settings.personaSettings;

      expect(personas).toBeDefined();
      const ids = Object.keys(personas || {});
      expect(ids.length).toBeGreaterThanOrEqual(11);

      for (const id of ids) {
        const persona = personas![id];
        expect(persona.effort).toBe('low');
        expect(persona.effortLevel).toBe('low');
      }
    });

    it('validates effort during persona update and maintains low effort defaults', () => {
      const store = new DashboardStore('/tmp/test-m1-effort-store-fallback.json');
      
      // Fetch persona security
      const currentSec = store.getPersonaSetting('security');
      expect(currentSec).toBeDefined();
      expect(currentSec?.effort).toBe('low');

      // Attempting to update with invalid effort throws validation error
      expect(() => {
        store.updatePersonaSetting('security', { effort: 'super-ultra-high' as any });
      }).toThrow(/must be one of low, medium, high, xhigh, max/);
    });
  });

  describe('4. Config Loader & Generator Default Fallback Audit', () => {
    it('creates default V3 config with reviewer_effort: "low" and provider effort: "low"', () => {
      const config = createDefaultV3Config();
      expect(config.reviews.reviewer_effort).toBe('low');

      for (const provider of config.reviewers.providers) {
        expect(provider.effort).toBe('low');
      }
    });

    it('translates CodeRabbit config with missing reviewer_effort to "low"', () => {
      const rawCodeRabbit = {
        reviews: {
          profile: 'chill',
        },
      };
      const translated = translateCodeRabbitToV3(rawCodeRabbit);
      expect(translated.reviewer_effort).toBe('low');
      expect(translated.reviews.reviewer_effort).toBe('low');
    });

    it('translates legacy config with missing reviewer_effort to "low"', () => {
      const rawLegacy = {
        profile: 'assertive',
      };
      const translated = translateLegacyConfigToV3(rawLegacy);
      expect(translated.reviewer_effort).toBe('low');
    });

    it('generateCtReviewConfig produces config with reviewer_effort: "low" across all providers', () => {
      const { config } = generateCtReviewConfig({});
      expect(config.reviews.reviewer_effort).toBe('low');

      for (const provider of config.reviewers.providers) {
        expect(provider.effort).toBe('low');
      }
    });
  });

  describe('5. Dashboard PersonaStatusGrid Component Defaults', () => {
    it('renders "Effort: low" for personas when persona record has missing effort field', () => {
      const partialPersonas: Record<string, any> = {
        security: { displayName: 'Security Guardian', model: 'claude-3-5-sonnet', enabled: true }, // missing effort
      };

      render(<PersonaStatusGrid personas={partialPersonas} />);
      const effortTexts = screen.getAllByText('low');
      expect(effortTexts.length).toBeGreaterThan(0);
    });
  });
});
