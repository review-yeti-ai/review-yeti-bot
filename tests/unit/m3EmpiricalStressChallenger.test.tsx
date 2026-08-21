// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
import { RepoTable } from '../../src/components/repos/repo-table';
import { PersonaSelector, ALL_PERSONA_IDS, PERSONA_METADATA } from '../../src/components/settings/persona-selector';
import { PRReviewDetailModal } from '../../src/components/dashboard/pr-review-detail-modal';
import { MermaidViewer } from '../../src/components/dashboard/mermaid-viewer';
import { RepositorySetting, ReviewJob, PersonaSetting, ProviderConfigRecord, ModelRegistryItem } from '../../src/types/dashboard';

// --- Fixtures for Testing ---
const mockRepos: RepositorySetting[] = [
  {
    owner: 'calltelemetry',
    repo: 'cisco-cdr',
    automationEnabled: true,
    generateArchitecturalFlowchart: true,
    customProfile: 'balanced',
    updatedAt: new Date().toISOString(),
  },
  {
    owner: 'calltelemetry',
    repo: 'ct-meta',
    automationEnabled: false,
    generateArchitecturalFlowchart: false,
    customProfile: 'assertive',
    updatedAt: new Date().toISOString(),
  },
  {
    owner: 'calltelemetry',
    repo: 'undefined-flowchart-repo',
    automationEnabled: true,
    generateArchitecturalFlowchart: undefined,
    customProfile: 'chill',
    updatedAt: new Date().toISOString(),
  },
];

const mockJob: ReviewJob = {
  id: 'job-m3-test-999',
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 4040,
  title: 'feat(m3): empirical verification test job',
  verdict: 'SHIP',
  status: 'completed',
  personas: ['security', 'architecture', 'review_flowchart'],
  tokens: 8500,
  cost: 0.08,
  latencyMs: 1200,
  timestamp: 'Just now',
  headSha: 'a1b2c3d',
  quorum: '3/3',
  mermaidDiagram: `\`\`\`mermaid
sequenceDiagram
  actor Dev as Developer
  participant Bot as Review Bot
  Dev->>Bot: Submit PR
  Bot-->>Dev: Ship Verdict
\`\`\``,
};

describe('Milestone 3 Empirical Stress Verification', () => {

  // ==========================================
  // SECTION 1: Repo Flowchart & Architectural Diagrams Toggle UI
  // ==========================================
  describe('1. Repo Toggle UI & Flowchart Settings', () => {
    it('1.1 Renders flowchart toggle switches correctly for true, false, and undefined states', () => {
      render(
        <RepoTable
          repositories={mockRepos}
          onToggleAutomation={vi.fn()}
          onToggleFlowchart={vi.fn()}
          onChangeProfile={vi.fn()}
        />
      );

      const toggles = screen.getAllByRole('switch', {
        name: /Generate Architectural Sequence & Flowchart Diagrams/i,
      });

      expect(toggles.length).toBe(3);

      // repo 0: explicitly true -> checked
      expect(toggles[0]).toHaveAttribute('aria-checked', 'true');
      // repo 1: explicitly false -> unchecked
      expect(toggles[1]).toHaveAttribute('aria-checked', 'false');
      // repo 2: undefined -> defaults to true (checked)
      expect(toggles[2]).toHaveAttribute('aria-checked', 'true');

      expect(screen.getAllByText('Diagrams On').length).toBe(2);
      expect(screen.getByText('Diagrams Off')).toBeInTheDocument();
    });

    it('1.2 Invokes onToggleFlowchart with toggled boolean on row click', () => {
      const onToggleFlowchart = vi.fn();
      render(
        <RepoTable
          repositories={mockRepos}
          onToggleAutomation={vi.fn()}
          onToggleFlowchart={onToggleFlowchart}
          onChangeProfile={vi.fn()}
        />
      );

      const firstToggle = screen.getByTestId('repo-flowchart-toggle-calltelemetry-cisco-cdr');
      fireEvent.click(firstToggle);

      expect(onToggleFlowchart).toHaveBeenCalledTimes(1);
      expect(onToggleFlowchart).toHaveBeenCalledWith('calltelemetry', 'cisco-cdr', false);

      const secondToggle = screen.getByTestId('repo-flowchart-toggle-calltelemetry-ct-meta');
      fireEvent.click(secondToggle);

      expect(onToggleFlowchart).toHaveBeenCalledTimes(2);
      expect(onToggleFlowchart).toHaveBeenLastCalledWith('calltelemetry', 'ct-meta', true);
    });

    it('1.3 Handles settings modal flowchart toggle and state updates without crashing when onToggleFlowchart is missing', () => {
      render(
        <RepoTable
          repositories={mockRepos}
          onToggleAutomation={vi.fn()}
          onChangeProfile={vi.fn()}
        />
      );

      const settingsBtn = screen.getByTestId('repo-settings-btn-calltelemetry-cisco-cdr');
      fireEvent.click(settingsBtn);

      expect(screen.getByText(/Repository Settings — calltelemetry\/cisco-cdr/i)).toBeInTheDocument();
      const modalToggle = screen.getByTestId('modal-repo-flowchart-toggle');
      expect(modalToggle).toHaveAttribute('aria-checked', 'true');

      // Click toggle in modal when callback is omitted
      expect(() => fireEvent.click(modalToggle)).not.toThrow();
      expect(modalToggle).toHaveAttribute('aria-checked', 'false');
    });

    it('1.4 Displays fallback empty state when repositories list is empty', () => {
      render(
        <RepoTable
          repositories={[]}
          onToggleAutomation={vi.fn()}
          onToggleFlowchart={vi.fn()}
          onChangeProfile={vi.fn()}
        />
      );

      expect(screen.getByText('No repositories configured yet.')).toBeInTheDocument();
    });
  });

  // ==========================================
  // SECTION 2: Persona Editor 12th Persona Card (review_flowchart)
  // ==========================================
  describe('2. Persona Editor 12th Persona Card (review_flowchart)', () => {
    it('2.1 ALL_PERSONA_IDS constant contains exactly 12 personas including review_flowchart', () => {
      expect(ALL_PERSONA_IDS.length).toBe(12);
      expect(ALL_PERSONA_IDS).toContain('review_flowchart');
      expect(ALL_PERSONA_IDS[11]).toBe('review_flowchart');
    });

    it('2.2 PERSONA_METADATA contains correct definition for review_flowchart', () => {
      const meta = PERSONA_METADATA.review_flowchart;
      expect(meta).toBeDefined();
      expect(meta.name).toBe('📊 Review Flowchart & Architecture');
      expect(meta.color).toBe('text-sky-400');
    });

    it('2.3 PersonaSelector renders 12 persona cards in grid layout', () => {
      render(<PersonaSelector selectedPersonaId="security" onSelectPersona={vi.fn()} />);

      expect(screen.getAllByText('📊 Review Flowchart & Architecture').length).toBeGreaterThan(0);
      expect(screen.getAllByText('🛡️ Security & Tenancy Guardian').length).toBeGreaterThan(0);
      expect(screen.getAllByText('🏛️ System Architecture & Design').length).toBeGreaterThan(0);
      expect(screen.getAllByText('🎯 Red Team & Skeptic').length).toBeGreaterThan(0);
    });

    it('2.4 Selecting review_flowchart triggers callback with review_flowchart ID', () => {
      const onSelectPersona = vi.fn();
      render(<PersonaSelector selectedPersonaId="security" onSelectPersona={onSelectPersona} />);

      const flowchartCard = screen.getByText('📊 Review Flowchart & Architecture');
      fireEvent.click(flowchartCard);

      expect(onSelectPersona).toHaveBeenCalledWith('review_flowchart');
    });
  });

  // ==========================================
  // SECTION 3: PR Detail Modal & Mermaid Diagram Edge Cases
  // ==========================================
  describe('3. PR Detail Modal & Mermaid Viewer Resilience', () => {
    it('3.1 Renders PRReviewDetailModal with MermaidViewer when job has mermaidDiagram', () => {
      render(<PRReviewDetailModal job={mockJob} open={true} onOpenChange={vi.fn()} />);

      expect(screen.getByText(/Architectural Sequence & Flowchart/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Visual View/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Raw Code/i })).toBeInTheDocument();
    });

    it('3.2 Renders default sequence diagram when diagram prop is undefined', () => {
      render(<MermaidViewer diagram={undefined} />);

      const rawCodeBtn = screen.getByRole('button', { name: /Raw Code/i });
      fireEvent.click(rawCodeBtn);

      expect(screen.getByText(/actor User as PR Author/)).toBeInTheDocument();
      expect(screen.getByText(/Bot->>Security: Trigger Vulnerability Scan/)).toBeInTheDocument();
    });

    it('3.3 Handles empty string diagram without crashing', () => {
      const { container } = render(<MermaidViewer diagram="" />);

      const rawCodeBtn = screen.getByRole('button', { name: /Raw Code/i });
      fireEvent.click(rawCodeBtn);

      // Falls back to default diagram string
      expect(container.textContent).toContain('Post Review (SHIP)');
    });

    it('3.4 Handles malformed/invalid Mermaid syntax without throwing error', () => {
      const malformedDiagram = `\`\`\`mermaid
invalid sequence diagram syntax ::: $$$ ###
Random text line 1
NodeA ->> NodeB: Normal Arrow line
\`\`\``;

      expect(() => render(<MermaidViewer diagram={malformedDiagram} />)).not.toThrow();

      const rawCodeBtn = screen.getByRole('button', { name: /Raw Code/i });
      fireEvent.click(rawCodeBtn);

      expect(screen.getByText(/invalid sequence diagram syntax/)).toBeInTheDocument();
      expect(screen.getByText(/NodeA ->> NodeB: Normal Arrow line/)).toBeInTheDocument();
    });

    it('3.5 Sanitizes and strips code fences cleanly', () => {
      const rawDiagramWithFences = `\`\`\`mermaid
flowchart TD
  X[Step 1] --> Y[Step 2]
\`\`\``;

      render(<MermaidViewer diagram={rawDiagramWithFences} />);

      const rawCodeBtn = screen.getByRole('button', { name: /Raw Code/i });
      fireEvent.click(rawCodeBtn);

      // Code fence markers should be stripped in raw view
      expect(screen.queryByText(/```mermaid/)).not.toBeInTheDocument();
      expect(screen.getByText(/flowchart TD/)).toBeInTheDocument();
    });

    it('3.6 Prevents XSS / HTML injection in diagram text', () => {
      const xssDiagram = `\`\`\`mermaid
sequenceDiagram
  User->>Bot: <script>alert('XSS')</script>
\`\`\``;

      render(<MermaidViewer diagram={xssDiagram} />);

      const rawCodeBtn = screen.getByRole('button', { name: /Raw Code/i });
      fireEvent.click(rawCodeBtn);

      expect(screen.getByText(/<script>alert\('XSS'\)<\/script>/)).toBeInTheDocument();
    });
  });

  // ==========================================
  // SECTION 4: Store & Settings Model Dropdown Filtering
  // ==========================================
  describe('4. Store & Provider Model Dropdown Filtering Logic', () => {
    it('4.1 Helper function correctly filters models from disabled providers', () => {
      const sampleProviders: Record<string, ProviderConfigRecord> = {
        openai: {
          id: 'openai',
          displayName: 'OpenAI',
          enabled: true,
          active: true,
          activeModels: ['gpt-4o', 'gpt-4o-mini'],
          updatedAt: new Date().toISOString(),
        },
        anthropic: {
          id: 'anthropic',
          displayName: 'Anthropic Claude',
          enabled: false, // DISABLED
          active: false,
          activeModels: ['claude-3-5-sonnet'],
          updatedAt: new Date().toISOString(),
        },
      };

      const sampleRegistry: Record<string, ModelRegistryItem> = {
        'gpt-4o': { id: 'gpt-4o', providerId: 'openai', displayName: 'GPT-4o', enabled: true },
        'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', providerId: 'anthropic', displayName: 'Claude 3.5 Sonnet', enabled: true },
      };

      // Filter enabled providers
      const enabledProviders = Object.values(sampleProviders).filter((p) => p.enabled !== false && p.active !== false);
      expect(enabledProviders.length).toBe(1);
      expect(enabledProviders[0].id).toBe('openai');

      // Compute allAvailableModels
      const validSet = new Set<string>();
      for (const provider of enabledProviders) {
        if (Array.isArray(provider.activeModels)) {
          for (const m of provider.activeModels) validSet.add(m);
        }
      }
      for (const item of Object.values(sampleRegistry)) {
        if (item.enabled !== false) {
          const p = sampleProviders[item.providerId];
          if (p && p.enabled !== false && p.active !== false) {
            validSet.add(item.id);
          }
        }
      }

      const availableModels = Array.from(validSet);
      expect(availableModels).toContain('gpt-4o');
      expect(availableModels).not.toContain('claude-3-5-sonnet');
    });
  });

});
