// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

import { PromptEditor } from '@/components/settings/prompt-editor';
import { PersonaSelector, ALL_PERSONA_IDS, PERSONA_METADATA } from '@/components/settings/persona-selector';
import SettingsPage from '@/app/settings/page';
import { DashboardStore, dashboardStore } from '@/persistence/dashboardStore';
import { createDashboardRouter } from '@/api/dashboardApi';
import { timeBudgetMs } from '../support/timeBudget';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
}));

// Mock api-client fetchPersonas and updatePersona for unit/integration isolation
vi.mock('@/lib/api-client', () => {
  const mockPersonasStore: Record<string, any> = {
    security: {
      id: 'security',
      displayName: '🛡️ Security & Tenancy Guardian',
      model: 'claude-3-5-sonnet',
      effort: 'high',
      confidenceThreshold: 80,
      enabled: true,
      customPrompt: 'Initial Security Prompt',
      charter: 'builtin:security',
    },
    architecture: {
      id: 'architecture',
      displayName: '🏛️ System Architecture & Design',
      model: 'gpt-4o',
      effort: 'medium',
      confidenceThreshold: 75,
      enabled: true,
      customPrompt: 'Initial Architecture Prompt',
      charter: 'builtin:architecture',
    },
  };

  return {
    fetchPersonas: vi.fn(async () => ({ ...mockPersonasStore })),
    updatePersona: vi.fn(async (id: string, patch: any) => {
      mockPersonasStore[id] = { ...mockPersonasStore[id], ...patch, id };
      return mockPersonasStore[id];
    }),
  };
});

describe('Empirical Challenger 2 — Persona Prompt Editor Edge Cases & Stress Harness', () => {

  describe('1. Updating Empty Prompts Edge Cases', () => {
    it('renders PromptEditor with empty string prompt and displays 0 char/word/token counts', () => {
      const onChange = vi.fn();
      const onSave = vi.fn();
      const onReset = vi.fn();

      render(
        <PromptEditor
          value=""
          defaultValue=""
          onChange={onChange}
          onSave={onSave}
          onReset={onReset}
        />
      );

      expect(screen.getByText('Synced')).toBeDefined();
      expect(screen.getAllByText('0').length).toBe(2); // charCount and wordCount
      expect(screen.getByText('~0')).toBeDefined(); // estTokens

      const saveBtn = screen.getByRole('button', { name: /save prompt/i });
      expect(saveBtn).toHaveProperty('disabled', true);

      const resetBtn = screen.getByRole('button', { name: /reset/i });
      expect(resetBtn).toHaveProperty('disabled', true);
    });

    it('displays Unsaved Changes and enables Save/Reset when value is empty string but defaultValue is non-empty', () => {
      render(
        <PromptEditor
          value=""
          defaultValue="Default security system prompt"
          onChange={vi.fn()}
          onSave={vi.fn()}
          onReset={vi.fn()}
        />
      );

      expect(screen.getByText('Unsaved Changes')).toBeDefined();
      const saveBtn = screen.getByRole('button', { name: /save prompt/i });
      expect(saveBtn).toHaveProperty('disabled', false);

      const resetBtn = screen.getByRole('button', { name: /reset/i });
      expect(resetBtn).toHaveProperty('disabled', false);
    });

    it('calculates 0 words and accurate tokens for whitespace-only prompt strings', () => {
      const whitespacePrompt = '   \n\t   \n  ';
      render(
        <PromptEditor
          value={whitespacePrompt}
          defaultValue=""
          onChange={vi.fn()}
          onSave={vi.fn()}
          onReset={vi.fn()}
        />
      );

      // charCount = whitespacePrompt.length = 11
      // wordCount = 0
      // estTokens = Math.ceil(11 / 4) = 3
      expect(screen.getByText('11')).toBeDefined();
      expect(screen.getByText('0')).toBeDefined();
      expect(screen.getByText('~3')).toBeDefined();
    });

    it('allows saving an empty customPrompt via DashboardStore and API', () => {
      const testStore = new DashboardStore('/tmp/ct_prompt_editor_test_store.json');
      const updated = testStore.updatePersonaSetting('security', { customPrompt: '' });

      expect(updated.customPrompt).toBe('');
      const fetched = testStore.getSettings().personaSettings?.['security'];
      expect(fetched?.customPrompt).toBe('');
    });

    it('rejects non-string customPrompt types (e.g. number, boolean, array) in DashboardStore validation', () => {
      const testStore = new DashboardStore('/tmp/ct_prompt_editor_test_store2.json');

      expect(() => {
        testStore.updatePersonaSetting('security', { customPrompt: 12345 as any });
      }).toThrow(/customPrompt for 'security' must be a string/);

      expect(() => {
        testStore.updatePersonaSetting('security', { customPrompt: ['line1', 'line2'] as any });
      }).toThrow(/customPrompt for 'security' must be a string/);
    });
  });

  describe('2. Extremely Long Prompts Edge Cases', () => {
    it('accurately displays metrics for 150,000 character prompt string', () => {
      const longText = 'a '.repeat(75000); // 150,000 chars, 75,000 words
      const expectedTokens = Math.ceil(longText.length / 4); // 37500

      render(
        <PromptEditor
          value={longText}
          defaultValue=""
          onChange={vi.fn()}
          onSave={vi.fn()}
          onReset={vi.fn()}
        />
      );

      expect(screen.getByText('150000')).toBeDefined();
      expect(screen.getByText('75000')).toBeDefined();
      expect(screen.getByText(`~${expectedTokens}`)).toBeDefined();
    });

    it('handles 500,000 character (0.5MB) prompt string in DashboardStore without error or corruption', () => {
      const hugePrompt = 'X'.repeat(500_000);
      const testStore = new DashboardStore('/tmp/ct_prompt_editor_huge_store.json');

      const startTime = performance.now();
      const updated = testStore.updatePersonaSetting('performance', { customPrompt: hugePrompt });
      const endTime = performance.now();

      expect(updated.customPrompt.length).toBe(500_000);
      expect(endTime - startTime).toBeLessThan(timeBudgetMs(1000)); // fast persistence < 1s

      const reloadedStore = new DashboardStore('/tmp/ct_prompt_editor_huge_store.json');
      const retrieved = reloadedStore.getSettings().personaSettings?.['performance'];
      expect(retrieved?.customPrompt?.length).toBe(500_000);
    });

    it('transmits 100KB prompt over Express API successfully', async () => {
      const app: Express = express();
      app.use(express.json({ limit: '10mb' }));
      app.use('/api/dashboard', createDashboardRouter());

      const largePrompt = 'PR Review Rule: ' + 'Do security audit. '.repeat(5000); // ~100KB

      const res = await request(app)
        .put('/api/dashboard/personas/security')
        .send({ customPrompt: largePrompt });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.persona.customPrompt.length).toBe(largePrompt.length);
    });
  });

  describe('3. Special Characters & Injection Edge Cases', () => {
    it('renders HTML/Script tags safely without executing or altering prompt string content', () => {
      const xssPrompt = `<script>alert('XSS Attack!')</script>\n<iframe src="javascript:alert(1)"></iframe>\n<div onclick="evil()">Click Me</div>`;
      const onChange = vi.fn();

      render(
        <PromptEditor
          value={xssPrompt}
          defaultValue=""
          onChange={onChange}
          onSave={vi.fn()}
          onReset={vi.fn()}
        />
      );

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe(xssPrompt);
    });

    it('preserves multi-byte Unicode characters, emojis, and symbols accurately', () => {
      const unicodePrompt = `🛡️ Security Guardian: 𝓤𝓷𝓲𝓬𝓸𝓭𝓮 Test! 🔥 ⚡ 💰 🎯 🗄️ 🤖 🚀 \nこんにちは世界 \nÑuñoa & Standard & <Tag>`;
      const testStore = new DashboardStore('/tmp/ct_prompt_editor_unicode_store.json');

      const updated = testStore.updatePersonaSetting('security', { customPrompt: unicodePrompt });
      expect(updated.customPrompt).toBe(unicodePrompt);

      const reloadedStore = new DashboardStore('/tmp/ct_prompt_editor_unicode_store.json');
      const retrieved = reloadedStore.getSettings().personaSettings?.['security'];
      expect(retrieved?.customPrompt).toBe(unicodePrompt);
    });

    it('handles special escape characters, quotes, backslashes, and line breaks', () => {
      const complexString = `Line 1\\nLine 2\\r\\nLine 3\tTabbed\n"Double Quotes"\n'Single Quotes'\nBackslash: \\\\\\nNull Byte Test: \\u0000`;
      const testStore = new DashboardStore('/tmp/ct_prompt_editor_escapes_store.json');

      const updated = testStore.updatePersonaSetting('quality', { customPrompt: complexString });
      expect(updated.customPrompt).toBe(complexString);

      const jsonStr = JSON.stringify(updated);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.customPrompt).toBe(complexString);
    });
  });

  describe('4. Rapid Switching Between Personas & Dirty State Behavior', () => {
    it('EMPIRICAL DISCOVERY: Switching personas while prompt editor has unsaved changes discards active unsaved prompt changes', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/Control Panel/)).toBeDefined();
      });

      // Default selected persona is 'security'
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Initial Security Prompt');

      // User types unsaved changes into Security prompt
      fireEvent.change(textarea, { target: { value: 'SECURITY PROMPT HAS UNSAVED EDITS' } });
      expect(textarea.value).toBe('SECURITY PROMPT HAS UNSAVED EDITS');
      expect(screen.getByText('Unsaved Changes')).toBeDefined();

      // Now user clicks on 'architecture' persona pill card
      const archBtn = screen.getByRole('button', { name: /System Architecture/i });
      fireEvent.click(archBtn);

      // Verify that active prompt switched to Architecture's initial prompt
      await waitFor(() => {
        expect(textarea.value).toBe('Initial Architecture Prompt');
      });

      // Now user clicks back to 'security' persona pill card
      const secBtn = screen.getByRole('button', { name: /Security & Tenancy Guardian/i });
      fireEvent.click(secBtn);

      // EMPIRICAL VERIFICATION: Unsaved edits to Security prompt were discarded when switching away!
      await waitFor(() => {
        expect(textarea.value).toBe('Initial Security Prompt');
      });
      expect(screen.queryByText('SECURITY PROMPT HAS UNSAVED EDITS')).toBeNull();
    });

    it('rapidly switches between 5 personas without state corruption or stuck loading states', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/Control Panel/)).toBeDefined();
      });

      const personaIds: PersonaId[] = ['security', 'architecture', 'performance', 'quality', 'database'];

      for (const id of personaIds) {
        const meta = PERSONA_METADATA[id];
        const btn = screen.getByRole('button', { name: new RegExp(meta.name.substring(4, 15), 'i') });
        fireEvent.click(btn);
      }

      // Final persona clicked is database
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toContain('builtin:database');
    });
  });

  describe('5. Reset Triggers & Charter Defaults', () => {
    it('disables Reset button when value equals defaultValue', () => {
      const onReset = vi.fn();
      render(
        <PromptEditor
          value="Same prompt"
          defaultValue="Same prompt"
          onChange={vi.fn()}
          onSave={vi.fn()}
          onReset={onReset}
        />
      );

      const resetBtn = screen.getByRole('button', { name: /reset/i });
      expect(resetBtn).toHaveProperty('disabled', true);
      fireEvent.click(resetBtn);
      expect(onReset).not.toHaveBeenCalled();
    });

    it('enables and invokes onReset when value is modified from defaultValue', () => {
      const onReset = vi.fn();
      render(
        <PromptEditor
          value="Modified prompt text"
          defaultValue="Original prompt text"
          onChange={vi.fn()}
          onSave={vi.fn()}
          onReset={onReset}
        />
      );

      const resetBtn = screen.getByRole('button', { name: /reset/i });
      expect(resetBtn).toHaveProperty('disabled', false);
      fireEvent.click(resetBtn);
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it('SettingsPage handleResetDefaults resets active prompt to charter default', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/Control Panel/)).toBeDefined();
      });

      const resetHeaderBtn = screen.getByRole('button', { name: /reset defaults/i });
      fireEvent.click(resetHeaderBtn);
      const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
      expect(textarea.value).toBe('builtin:security');
      expect(screen.getByText("Reset prompt to default charter for 'security'")).toBeDefined();
    });
  });
});
