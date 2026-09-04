import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ALL_PERSONA_IDS, PERSONA_METADATA } from '../../src/components/settings/persona-selector';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient, type OmniRouteRequest, type OmniRouteResponse } from '../../src/gateway/omniRouteClient';

describe('Milestone 2: Flowchart Persona & Diagram Generation Engine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Task 1 & 2: 12th Persona Registration & Selector Metadata', () => {
    it('registers review_flowchart as the 12th persona in ALL_PERSONA_IDS', () => {
      expect(ALL_PERSONA_IDS).toHaveLength(12);
      expect(ALL_PERSONA_IDS).toContain('review_flowchart');
      expect(ALL_PERSONA_IDS[11]).toBe('review_flowchart');
    });

    it('defines valid metadata for review_flowchart in PERSONA_METADATA', () => {
      const meta = PERSONA_METADATA['review_flowchart'];
      expect(meta).toBeDefined();
      expect(meta.name).toBe('📊 Review Flowchart & Architecture');
      expect(meta.icon).toBeDefined();
      expect(meta.color).toBe('text-sky-400');
    });

    it('populates review_flowchart default configuration in dashboardStore', () => {
      const personas = dashboardStore.getPersonaSettings();
      expect(personas.review_flowchart).toBeDefined();
      expect(personas.review_flowchart.id).toBe('review_flowchart');
      expect(personas.review_flowchart.charter).toBe('builtin:review-flowchart');
      expect(personas.review_flowchart.enabled).toBe(true);
      expect(personas.review_flowchart.required).toBe(false);
      expect(personas.review_flowchart.confidenceThreshold).toBe(75);
    });
  });

  describe('Task 1: Repository Flowchart Toggle Persistence', () => {
    it('persists and updates generateArchitecturalFlowchart setting in dashboardStore', () => {
      const repo = dashboardStore.updateRepository('calltelemetry', 'flowchart-test-repo', {
        automationEnabled: true,
        generateArchitecturalFlowchart: true,
      });

      expect(repo.generateArchitecturalFlowchart).toBe(true);

      const fetched = dashboardStore.getRepository('calltelemetry', 'flowchart-test-repo');
      expect(fetched?.generateArchitecturalFlowchart).toBe(true);

      const updated = dashboardStore.updateRepository('calltelemetry', 'flowchart-test-repo', {
        generateArchitecturalFlowchart: false,
      });
      expect(updated.generateArchitecturalFlowchart).toBe(false);
    });
  });

  describe('Task 3: LLM Analysis Step & Diagram Generation in panelEngine', () => {
    it('executes executePersonaPanel and populates mermaidDiagram when generateArchitecturalFlowchart is enabled', async () => {
      const config = createDefaultV3Config();
      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });

      // Mock completion for LLM calls during panel execution
      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
        const allMsg = JSON.stringify(opts.messages);

        if (allMsg.includes('arbiter')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All checks passed' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.001,
            raw: null,
          };
        } else if (allMsg.includes('moderator')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({
              decision: 'APPROVE',
              findings: [],
              mermaidDiagram: '```mermaid\nsequenceDiagram\n    autonumber\n    Client->>Service: Call API\n```',
            })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          {
            path: 'src/services/paymentService.ts',
            patch: '@@ -1,5 +1,10 @@\n+import { processPayment } from "./gateway";\n+export function pay() { processPayment(); }',
          },
        ],
        repository: 'calltelemetry/flowchart-test-repo',
        headSha: 'abc12345',
        client: mockClient,
        generateArchitecturalFlowchart: true,
      });

      expect(result).toBeDefined();
      expect(result.mermaidDiagram).toBeDefined();
      expect(result.mermaidDiagram).toContain('mermaid');
    });

    it('generates Mermaid diagram when review_flowchart persona is active in config', async () => {
      const config = createDefaultV3Config();
      // Add review_flowchart persona to config
      config.personas.push({
        id: 'review_flowchart',
        enabled: true,
        required: false,
        charter: 'builtin:review-flowchart',
        model: 'claude-3-5-sonnet',
        paths: ['**/*'],
        providers: ['synthetic'],
      });

      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });
      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';
        const allMsg = JSON.stringify(opts.messages);

        if (allMsg.includes('arbiter')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Approved' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.001,
            raw: null,
          };
        } else if (allMsg.includes('moderator')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({
              decision: 'APPROVE',
              findings: [],
              mermaidDiagram: '```mermaid\nflowchart TD\n    A[Input] --> B[Output]\n```',
            })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          {
            path: 'src/api/userController.ts',
            patch: '@@ -1,3 +1,6 @@\n+export function createUser() { fetch(); }',
          },
        ],
        repository: 'calltelemetry/flowchart-test-repo',
        headSha: 'def67890',
        client: mockClient,
      });

      expect(result.mermaidDiagram).toBeDefined();
      expect(result.mermaidDiagram).toContain('flowchart TD');
    });
  });
});
