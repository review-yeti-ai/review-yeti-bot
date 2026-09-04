import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient, type OmniRouteRequest, type OmniRouteResponse } from '../../src/gateway/omniRouteClient';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { generateMermaidDiagram, analyzeDiffComplexity } from '../../src/review/mermaidEngine';

describe('Milestone 2 Empirical Stress & Corner Case Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Corner Case 1: generateArchitecturalFlowchart toggle permutations', () => {
    it('returns mermaidDiagram when generateArchitecturalFlowchart option is explicitly true (even without review_flowchart persona)', async () => {
      const config = createDefaultV3Config();
      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });

      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';

        if (prompt.includes('"role":"persona"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else if (prompt.includes('"role":"moderator"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          { path: 'src/api/auth.ts', patch: '@@ -1,2 +1,5 @@\n+export function login() {}\n+export function logout() {}' },
          { path: 'src/api/user.ts', patch: '@@ -1,2 +1,5 @@\n+export function getUser() {}' },
        ],
        repository: 'calltelemetry/test-repo-toggle-on',
        headSha: '11111111',
        client: mockClient,
        generateArchitecturalFlowchart: true,
      });

      expect(result.mermaidDiagram).toBeDefined();
      expect(result.mermaidDiagram).toContain('```mermaid');
    });

    it('returns undefined mermaidDiagram when generateArchitecturalFlowchart is false and review_flowchart is NOT in config', async () => {
      const config = createDefaultV3Config();
      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });

      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';

        if (prompt.includes('"role":"persona"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else if (prompt.includes('"role":"moderator"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          { path: 'src/api/auth.ts', patch: '@@ -1,2 +1,5 @@\n+export function login() {}' },
        ],
        repository: 'calltelemetry/test-repo-toggle-off',
        headSha: '22222222',
        client: mockClient,
        generateArchitecturalFlowchart: false,
      });

      expect(result.mermaidDiagram).toBeUndefined();
    });

    it('returns mermaidDiagram when generateArchitecturalFlowchart option is undefined but dashboardStore repository setting is true', async () => {
      dashboardStore.updateRepository('calltelemetry', 'store-toggle-repo', {
        generateArchitecturalFlowchart: true,
      });

      const config = createDefaultV3Config();
      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });

      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';

        if (prompt.includes('"role":"persona"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else if (prompt.includes('"role":"moderator"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          { path: 'src/api/service.ts', patch: '@@ -1,2 +1,5 @@\n+export function service() {}' },
          { path: 'src/api/client.ts', patch: '@@ -1,2 +1,5 @@\n+export function client() {}' },
        ],
        repository: 'calltelemetry/store-toggle-repo',
        headSha: '33333333',
        client: mockClient,
      });

      expect(result.mermaidDiagram).toBeDefined();
    });

    it('returns mermaidDiagram when review_flowchart persona is active even if generateArchitecturalFlowchart option is explicitly false', async () => {
      const config = createDefaultV3Config();
      config.personas.push({
        id: 'review_flowchart',
        enabled: true,
        required: false,
        charter: 'builtin:review-flowchart',
        paths: ['**/*'],
        providers: ['synthetic'],
      });

      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });

      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';

        if (prompt.includes('"role":"persona"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({
              decision: 'APPROVE',
              findings: [],
              mermaidDiagram: '```mermaid\nflowchart TD\n  Start --> End\n```',
            })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else if (prompt.includes('"role":"moderator"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          { path: 'src/api/auth.ts', patch: '@@ -1,2 +1,5 @@\n+export function login() {}' },
        ],
        repository: 'calltelemetry/override-test-repo',
        headSha: '44444444',
        client: mockClient,
        generateArchitecturalFlowchart: false,
      });

      expect(result.mermaidDiagram).toBeDefined();
      expect(result.mermaidDiagram).toContain('Start --> End');
    });

    it('falls back to generateMermaidDiagram when review_flowchart persona fails as optional persona', async () => {
      const config = createDefaultV3Config();
      config.personas.push({
        id: 'review_flowchart',
        enabled: true,
        required: false,
        charter: 'builtin:review-flowchart',
        paths: ['**/*'],
        providers: ['synthetic'],
      });

      const mockClient = new OmniRouteClient({ baseUrl: 'http://localhost:9999/v1', accessToken: 'mock' });

      vi.spyOn(mockClient, 'complete').mockImplementation(async (opts: OmniRouteRequest): Promise<OmniRouteResponse> => {
        const prompt = opts.messages?.[1]?.content || '';
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([^\s]+)/);
        const reqNonce = nonceMatch ? nonceMatch[1] : 'mock-nonce';

        if (prompt.includes('"persona":"review_flowchart"')) {
          throw new Error('LLM Provider timeout for review_flowchart');
        }

        if (prompt.includes('"role":"persona"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else if (prompt.includes('"role":"moderator"')) {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        } else {
          return {
            content: `CT_REVIEW_BEGIN:${reqNonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Pass' })}\nCT_REVIEW_END:${reqNonce}`,
            model: opts.model,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
            raw: null,
          };
        }
      });

      const result = await executePersonaPanel({
        config,
        changedFiles: [
          { path: 'src/api/auth.ts', patch: '@@ -1,2 +1,5 @@\n+export function login() {}' },
          { path: 'src/api/user.ts', patch: '@@ -1,2 +1,5 @@\n+export function getUser() {}' },
        ],
        repository: 'calltelemetry/persona-fail-fallback-repo',
        headSha: '55555555',
        client: mockClient,
      });

      expect(result.optionalFailures.some((f) => f.id === 'review_flowchart')).toBe(true);
      expect(result.mermaidDiagram).toBeDefined();
    });
  });

  describe('Corner Case 2: review_flowchart on complex / edge-case AST diffs', () => {
    it('handles empty diff gracefully without crashing', () => {
      const diagram = generateMermaidDiagram('');
      expect(diagram).toBe('');

      const analysis = analyzeDiffComplexity('');
      expect(analysis.isComplex).toBe(false);
      expect(analysis.components).toHaveLength(0);
      expect(analysis.functions).toHaveLength(0);
    });

    it('analyzes complex AST diff with multi-file, async functions, interfaces, try-catch, and event dispatch', () => {
      const complexDiff = `
diff --git a/src/services/paymentProcessor.ts b/src/services/paymentProcessor.ts
index 1234567..89abcdef 100644
--- a/src/services/paymentProcessor.ts
+++ b/src/services/paymentProcessor.ts
@@ -10,6 +10,25 @@ import { StripeGateway } from '../gateways/stripeGateway';
+export class PaymentProcessor {
+  private gateway: StripeGateway;
+  async processTransaction(amount: number, currency: string): Promise<boolean> {
+    try {
+      const response = await fetch('https://api.stripe.com/v1/charges');
+      dispatch('payment:success', { amount });
+      return true;
+    } catch (err) {
+      if (amount > 1000) {
+        execute('flagHighValueFailure', err);
+      }
+      return false;
+    }
+  }
+}
diff --git a/src/gateways/stripeGateway.ts b/src/gateways/stripeGateway.ts
--- a/src/gateways/stripeGateway.ts
+++ b/src/gateways/stripeGateway.ts
@@ -1,5 +1,10 @@
+export class StripeGateway {
+  async requestCharge(payload: any) {
+    return fetch('/charge', { method: 'POST', body: JSON.stringify(payload) });
+  }
+}
      `;

      const analysis = analyzeDiffComplexity(complexDiff);
      expect(analysis.isComplex).toBe(true);
      expect(analysis.type).toBe('sequenceDiagram');
      expect(analysis.components).toContain('PaymentProcessor');
      expect(analysis.components).toContain('StripeGateway');

      const diagram = generateMermaidDiagram(complexDiff);
      expect(diagram).toContain('```mermaid');
      expect(diagram).toContain('sequenceDiagram');
      expect(diagram).toContain('participant PaymentProcessor');
      expect(diagram).toContain('participant StripeGateway');
    });

    it('FINDING/BUG DEMONSTRATION: file paths with multi-part extensions produce unquoted dot/hyphen participant names in sequence diagrams', () => {
      const edgeDiff = `
diff --git a/src/services/user-auth.service.ts b/src/services/user-auth.service.ts
--- a/src/services/user-auth.service.ts
+++ b/src/services/user-auth.service.ts
@@ -1,3 +1,6 @@
+export function authenticateUser() {
+  if (true) return fetch('/api');
+}
diff --git a/src/controllers/api-gateway.ts b/src/controllers/api-gateway.ts
--- a/src/controllers/api-gateway.ts
+++ b/src/controllers/api-gateway.ts
@@ -1,3 +1,6 @@
+export function routeRequest() {
+  return dispatch('route');
+}
      `;

      const analysis = analyzeDiffComplexity(edgeDiff);
      expect(analysis.isComplex).toBe(true);
      expect(analysis.components).toContain('User-auth.service');

      const diagram = generateMermaidDiagram(edgeDiff);
      // Empirical verification: participant User-auth.service is output unquoted
      expect(diagram).toContain('participant User-auth.service');
      // Notice: In standard Mermaid syntax, dots in unquoted participant names break Mermaid rendering engines.
    });

    it('FINDING/BUG DEMONSTRATION: single-component diff with interaction creates orphaned participant in sequence diagram', () => {
      const singleFileDiff = `
diff --git a/src/services/commentPublisher.ts b/src/services/commentPublisher.ts
--- a/src/services/commentPublisher.ts
+++ b/src/services/commentPublisher.ts
@@ -1,5 +1,8 @@
+export async function publishComment(text: string) {
+  await fetch('https://api.github.com/comments', { body: text });
+}
      `;

      const diagram = generateMermaidDiagram(singleFileDiff);
      expect(diagram).toContain('sequenceDiagram');
      // Participant header includes CommentPublisher
      expect(diagram).toContain('participant CommentPublisher');
      // But interaction arrows only connect Client -> ReviewBot -> GitHubAPI!
      expect(diagram).toContain('Client->>ReviewBot: Send Webhook Event');
      expect(diagram).not.toContain('CommentPublisher->>');
      expect(diagram).not.toContain('->>CommentPublisher');
    });
  });

  describe('Corner Case 3: Mermaid Syntax Correctness & Parsing Validation', () => {
    it('validates syntax structure of generated sequence diagrams', () => {
      const diff = `
diff --git a/src/controller.ts b/src/controller.ts
--- a/src/controller.ts
+++ b/src/controller.ts
@@ -1,3 +1,5 @@
+export function handleRequest() { fetch(); }
diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,3 +1,5 @@
+export function process() { dispatch(); }
      `;
      const diagram = generateMermaidDiagram(diff);

      const lines = diagram.split('\n');
      expect(lines[0]).toBe('```mermaid');
      expect(lines[1]).toBe('sequenceDiagram');
      expect(lines[lines.length - 1]).toBe('```');

      // Ensure participants line up cleanly
      const participantLines = lines.filter((l) => l.trim().startsWith('participant '));
      expect(participantLines.length).toBeGreaterThan(0);
    });

    it('validates syntax structure of generated flowchart TD diagrams', () => {
      const diff = `
diff --git a/src/utils/calculator.ts b/src/utils/calculator.ts
--- a/src/utils/calculator.ts
+++ b/src/utils/calculator.ts
@@ -1,3 +1,6 @@
+export function add(a: number, b: number) {
+  if (a > 0) return a + b;
+}
      `;
      const diagram = generateMermaidDiagram(diff);

      const lines = diagram.split('\n');
      expect(lines[0]).toBe('```mermaid');
      expect(lines[1]).toBe('flowchart TD');
      expect(lines[lines.length - 1]).toBe('```');

      // Check node definitions
      const nodeLines = lines.filter((l) => l.includes('-->') || l.includes('['));
      expect(nodeLines.length).toBeGreaterThan(0);
    });
  });
});
