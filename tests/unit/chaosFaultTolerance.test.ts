import { describe, it, expect } from 'vitest';
import path from 'path';

// Load review-pipeline
const pipelinePath = path.resolve(__dirname, '../../.github/workflows/pipelines/review-pipeline.js');
const { reviewWithModel, RunTransportCircuitBreaker } = require(pipelinePath);

describe('Chaos & Fault Tolerance Suite', () => {
  it('recovers automatically from transient socket resets (ECONNRESET) on retry attempt 2', async () => {
    let callCount = 0;
    const mockFetch = async (url: string, init: any) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('read ECONNRESET (transient socket drop)');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: 'APPROVE',
                  findings: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
        }),
      };
    };

    const persona = { id: 'security', name: 'Security Guardian', charter: 'Check scope' };
    const diffFiles = [{ path: 'lib/auth.ex', patch: '+ def auth do' }];
    const prContext = { repo: 'acme/test', prNumber: 42 };

    const result = await reviewWithModel(persona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [
        {
          name: 'fireworks',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
          apiKey: 'fw-key',
          model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        },
      ],
    });

    expect(result.decision).toBe('APPROVE');
    expect(result.findings).toEqual([]);
    expect(callCount).toBe(2);
  });

  it('trips the circuit breaker on primary failure and bypasses primary transport on subsequent persona lanes', async () => {
    const breaker = new RunTransportCircuitBreaker();
    const calls: { persona: string; url: string }[] = [];

    const mockFetch = async (url: string, init: any) => {
      const body = JSON.parse(init.body || '{}');
      const personaPrompt = body.messages?.[0]?.content || '';
      const personaId = personaPrompt.includes('Security') ? 'security' : 'architecture';

      calls.push({ persona: personaId, url });

      if (url.includes('api.fireworks.ai')) {
        // Fireworks is down with 503
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: 'Service Unavailable: Overloaded' }),
        };
      }

      // Ollama fallback is healthy
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'ollama/deepseek-r1',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
        }),
      };
    };

    const candidateTransports = [
      { name: 'fireworks', baseUrl: 'https://api.fireworks.ai/v1', apiKey: 'fw-key' },
      { name: 'ollama', baseUrl: 'https://ollama.ai/v1', apiKey: 'ollama-key' },
    ];

    const diffFiles = [{ path: 'lib/core.ex', patch: '+ def run do' }];
    const prContext = { repo: 'calltelemetry/cisco-cdr', prNumber: 4452 };

    // Persona 1: Security runs and discovers Fireworks is 503 -> fails over to Ollama
    const res1 = await reviewWithModel(
      { id: 'security', name: 'Security Guardian', charter: 'Security check' },
      diffFiles,
      prContext,
      null,
      {
        fetchImplementation: mockFetch,
        transports: candidateTransports,
        circuitBreaker: breaker,
      }
    );

    expect(res1.decision).toBe('APPROVE');
    expect(res1.transport).toBe('ollama');
    expect(breaker.isTripped('fireworks')).toBe(true);

    // Persona 2: Architecture runs -> Circuit breaker MUST bypass Fireworks completely!
    const res2 = await reviewWithModel(
      { id: 'architecture', name: 'Architecture Specialist', charter: 'Architecture check' },
      diffFiles,
      prContext,
      null,
      {
        fetchImplementation: mockFetch,
        transports: candidateTransports,
        circuitBreaker: breaker,
      }
    );

    expect(res2.decision).toBe('APPROVE');
    expect(res2.transport).toBe('ollama');

    // Verify call counts:
    // Persona 1 called Fireworks (503) then Ollama (200) -> 2 calls
    // Persona 2 called Ollama DIRECTLY (0 calls to Fireworks) -> 1 call
    const persona2FireworksCalls = calls.filter((c) => c.persona === 'architecture' && c.url.includes('fireworks.ai'));
    expect(persona2FireworksCalls.length).toBe(0);

    const persona2OllamaCalls = calls.filter((c) => c.persona === 'architecture' && c.url.includes('ollama.ai'));
    expect(persona2OllamaCalls.length).toBe(1);
  });

  it('cascades across 3 transports when primary and secondary both fail with distinct error shapes', async () => {
    const breaker = new RunTransportCircuitBreaker();
    const visitedTransports: string[] = [];

    const mockFetch = async (url: string, init: any) => {
      if (url.includes('api.fireworks.ai')) {
        visitedTransports.push('fireworks');
        return {
          ok: false,
          status: 429,
          text: async () => 'cancelled: queue saturated',
        };
      }
      if (url.includes('ollama.ai')) {
        visitedTransports.push('ollama');
        return {
          ok: false,
          status: 529,
          text: async () => 'Site is overloaded',
        };
      }
      if (url.includes('openrouter.ai')) {
        visitedTransports.push('openrouter');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'deepseek/deepseek-v4-flash-0731',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    findings: [],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const persona = { id: 'testing', name: 'Testing Specialist', charter: 'QA check' };
    const diffFiles = [{ path: 'test/auth_test.exs', patch: '+ test "valid" do' }];
    const prContext = { repo: 'acme/test', prNumber: 99 };

    const result = await reviewWithModel(persona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [
        { name: 'fireworks', baseUrl: 'https://api.fireworks.ai/v1', apiKey: 'fw-key' },
        { name: 'ollama', baseUrl: 'https://ollama.ai/v1', apiKey: 'ollama-key' },
        { name: 'openrouter-fallback', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
      ],
      circuitBreaker: breaker,
    });

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('openrouter-fallback');
    expect(visitedTransports).toEqual(['fireworks', 'ollama', 'openrouter']);
    expect(breaker.isTripped('fireworks')).toBe(true);
    expect(breaker.isTripped('ollama')).toBe(true);
  });

  it('handles malformed / non-JSON responses gracefully without unhandled exceptions', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'Sorry, I cannot format this as JSON: Here are some conversational thoughts...',
            },
          },
        ],
      }),
    });

    const persona = { id: 'style', name: 'Style Checker', charter: 'Check formatting' };
    const diffFiles = [{ path: 'lib/ui.ex', patch: '+ def render do' }];
    const prContext = { repo: 'acme/test', prNumber: 5 };

    const result = await reviewWithModel(persona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [{ name: 'test', baseUrl: 'https://api.test.ai/v1', apiKey: 'k' }],
    });

    expect(result.decision).toBe('ERROR');
    expect(result.error).toContain('no parseable findings JSON');
  });

  it('forwards optional reasoning_effort per persona when configured without changing default behavior', async () => {
    let capturedBodyWithEffort: any = null;
    let capturedBodyWithoutEffort: any = null;

    const mockFetch = async (_url: string, init: any) => {
      const parsed = JSON.parse(init.body || '{}');
      if (parsed.messages?.[0]?.content?.includes('Security')) {
        capturedBodyWithEffort = parsed;
      } else {
        capturedBodyWithoutEffort = parsed;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
        }),
      };
    };

    const diffFiles = [{ path: 'lib/core.ex', patch: '+ def run do' }];
    const prContext = { repo: 'acme/test', prNumber: 7 };

    // 1. Persona with explicit reasoning_effort: 'high'
    const highEffortPersona = {
      id: 'security',
      name: 'Security Guardian',
      charter: 'Security',
      reasoning_effort: 'high',
    };

    await reviewWithModel(highEffortPersona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [{ name: 'test', baseUrl: 'https://api.test.ai/v1', apiKey: 'k' }],
    });

    expect(capturedBodyWithEffort).not.toBeNull();
    expect(capturedBodyWithEffort.reasoning_effort).toBe('high');

    // 2. Default Persona without reasoning_effort -> must NOT send reasoning_effort
    const defaultPersona = {
      id: 'style',
      name: 'Style Checker',
      charter: 'Style',
    };

    await reviewWithModel(defaultPersona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [{ name: 'test', baseUrl: 'https://api.test.ai/v1', apiKey: 'k' }],
    });

    expect(capturedBodyWithoutEffort).not.toBeNull();
    expect(capturedBodyWithoutEffort.reasoning_effort).toBeUndefined();
  });
});
