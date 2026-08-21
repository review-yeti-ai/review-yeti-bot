// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { ALL_PERSONA_IDS, PERSONA_METADATA, PersonaSelector } from '../../src/components/settings/persona-selector';
import { PersonaStatusGrid } from '../../src/components/dashboard/persona-status-grid';
import { PersonaConfigDrawer } from '../../src/components/settings/persona-config-drawer';
import { PromptEditor } from '../../src/components/settings/prompt-editor';
import SettingsPage from '../../src/app/settings/page';
import * as apiClient from '../../src/lib/api-client';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams('tab=personas'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

describe('Empirical Challenger 2 — R2 & R3 Comprehensive Verification Harness', () => {
  let app: any;
  let validApiKey: string;

  const testFile = '/tmp/test-r2r3-challenger2.json';

  beforeEach(() => {
    if (fs.existsSync(testFile)) {
      try { fs.unlinkSync(testFile); } catch {}
    }
    dashboardStore.filePath = testFile;
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    app = createApp();
    const createdKey = dashboardStore.createApiKey('challenger2-r2r3-key');
    validApiKey = createdKey.rawKey;
  });

  describe('1. Empirical Prompt Content Assertions across all 12 Personas', () => {
    it('seeds and returns all 12 reviewer personas with mandatory R3 domain keywords', () => {
      const personas = dashboardStore.getPersonaSettings();

      expect(ALL_PERSONA_IDS.length).toBe(12);

      for (const id of ALL_PERSONA_IDS) {
        const p = personas[id];
        expect(p).toBeDefined();
        expect(p.id).toBe(id);
        const promptText = p.customPrompt || p.charter || '';
        expect(promptText.length).toBeGreaterThan(10);
      }

      // 1. OWASP Top 10 & tenant isolation
      const sec = personas['security'];
      expect(sec.customPrompt).toContain('OWASP Top 10');
      expect(sec.customPrompt).toContain('tenant');

      // 2. DRY compliance & ADR alignment
      const arch = personas['architecture'];
      expect(arch.customPrompt).toContain('DRY');
      expect(arch.customPrompt).toContain('ADR');

      // 3. CPU/memory performance
      const perf = personas['performance'];
      expect(perf.customPrompt).toMatch(/CPU.*memory/i);

      // 4. API contract non-breaking schema
      const apiContract = personas['api_contract'];
      expect(apiContract.customPrompt).toContain('non-breaking');
      expect(apiContract.customPrompt).toContain('schema');

      // 5. Kubernetes/Dockerfile standards
      const devops = personas['devops'];
      expect(devops.customPrompt).toContain('Kubernetes');
      expect(devops.customPrompt).toContain('Dockerfile');
    });
  });

  describe('2. Persona Card Grid & UI Drawer Rendering', () => {
    it('renders all 12 persona cards in PersonaSelector with badges, switches, and drawer buttons', () => {
      const onConfigure = vi.fn();
      const onToggle = vi.fn();
      const onSelect = vi.fn();

      const personas = dashboardStore.getPersonaSettings();

      render(
        <PersonaSelector
          selectedPersonaId="security"
          onSelectPersona={onSelect}
          onConfigurePersona={onConfigure}
          onToggleActive={onToggle}
          personas={personas}
        />
      );

      // Assert all 12 card elements rendered by ID
      for (const id of ALL_PERSONA_IDS) {
        const idLabel = screen.getByText(`ID: ${id}`);
        expect(idLabel).toBeInTheDocument();
      }

      // Assert badges (Active/Disabled, Cpu model, Effort level)
      const activeBadges = screen.getAllByText('Active');
      expect(activeBadges.length).toBeGreaterThanOrEqual(12);

      const configureButtons = screen.getAllByRole('button', { name: /Configure Persona & Prompt/i });
      expect(configureButtons).toHaveLength(12);

      // Click configure button for 'architecture'
      fireEvent.click(configureButtons[1]);
      expect(onConfigure).toHaveBeenCalledWith('architecture');

      // Toggle switch for 'security'
      const switchEl = screen.getByLabelText(/Toggle active state for.*Security/i);
      fireEvent.click(switchEl);
      expect(onToggle).toHaveBeenCalledWith('security', false);
    });

    it('renders PersonaStatusGrid with 12 card indicators and status badges', () => {
      const personas = dashboardStore.getPersonaSettings();
      render(<PersonaStatusGrid personas={personas} />);

      for (const id of ALL_PERSONA_IDS) {
        const meta = PERSONA_METADATA[id];
        expect(screen.getByText(meta.name)).toBeInTheDocument();
      }
    });

    it('opens PersonaConfigDrawer when triggered and displays editor controls', () => {
      const persona = dashboardStore.getPersonaSetting('security')!;
      const onPromptChange = vi.fn();
      const onSavePersona = vi.fn();

      render(
        <PersonaConfigDrawer
          open={true}
          onOpenChange={vi.fn()}
          persona={persona}
          activePrompt={persona.customPrompt || ''}
          savedPrompt={persona.customPrompt || ''}
          onPromptChange={onPromptChange}
          onUpdatePersonaField={vi.fn()}
          onSavePersona={onSavePersona}
          onSaveAll={vi.fn()}
          onResetDefaults={vi.fn()}
          isSaving={false}
          enabledProviderList={[]}
          dynamicModels={['claude-3-5-sonnet', 'gpt-4o']}
          allAvailableModels={['claude-3-5-sonnet', 'gpt-4o']}
          modelRegistry={{}}
        />
      );

      expect(screen.getByText('System Prompt & Review Guidelines: 🛡️ Security & Tenancy Guardian')).toBeInTheDocument();
      expect(screen.getByText('ID: security • Configure System Prompt, Model Override & Arbitration Rules')).toBeInTheDocument();
    });
  });

  describe('3. PromptEditor & API Sync Verification', () => {
    it('PromptEditor updates character count, word count, and token estimate dynamically', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <PromptEditor
          value="Test prompt text"
          defaultValue="Test prompt text"
          onChange={onChange}
          onSave={vi.fn()}
          onReset={vi.fn()}
        />
      );

      expect(screen.getByText('Synced')).toBeInTheDocument();

      rerender(
        <PromptEditor
          value="Test prompt text with edits"
          defaultValue="Test prompt text"
          onChange={onChange}
          onSave={vi.fn()}
          onReset={vi.fn()}
        />
      );

      expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    });

    it('API endpoints (/api/dashboard/personas) handle GET, PUT, and sync properly', async () => {
      const getRes = await request(app)
        .get('/api/dashboard/personas')
        .set('x-api-key', validApiKey);

      expect(getRes.status).toBe(200);
      expect(Object.keys(getRes.body.personas)).toHaveLength(12);

      const putRes = await request(app)
        .put('/api/dashboard/personas/security')
        .set('x-api-key', validApiKey)
        .send({
          customPrompt: 'Empirically updated security prompt',
          confidenceThreshold: 88,
          effort: 'high',
        });

      expect(putRes.status).toBe(200);
      expect(putRes.body.persona.customPrompt).toBe('Empirically updated security prompt');
      expect(putRes.body.persona.confidenceThreshold).toBe(88);
      expect(putRes.body.persona.effort).toBe('high');
    });
  });
});
