// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSE, createInitialPersonaProgress, DEFAULT_PERSONAS } from '../../src/lib/useSSE';
import { LiveStreamEvent } from '../../src/types/live';

// Mock EventSource for Vitest environment
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 10);
  }

  emitMessage(data: any) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  close() {
    this.readyState = 2;
  }
}

describe('useSSE Custom Hook Unit Tests', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createInitialPersonaProgress returns state for all default personas in PENDING status', () => {
    const initial = createInitialPersonaProgress();
    expect(Object.keys(initial)).toHaveLength(DEFAULT_PERSONAS.length);
    expect(DEFAULT_PERSONAS).toContain('security');
    expect(DEFAULT_PERSONAS).toContain('quality');

    for (const personaKey of DEFAULT_PERSONAS) {
      expect(initial[personaKey]).toBeDefined();
      expect(initial[personaKey].status).toBe('PENDING');
      expect(initial[personaKey].progress).toBe(0);
    }
  });

  it('initializes with default options and connects to unauthenticated URL stream', () => {
    const { result } = renderHook(() => useSSE({ jobId: 'test-job-123' }));

    expect(result.current.jobId).toBe('test-job-123');
    expect(result.current.selectedPersona).toBe('all');
    expect(result.current.events).toEqual([]);
    expect(result.current.tokenMetrics.promptTokens).toBe(0);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain('/api/live/stream?jobId=test-job-123');
  });

  it('includes query token parameter when token option is provided', () => {
    renderHook(() => useSSE({ jobId: 'auth-job', token: 'secret-token-123' }));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toContain('/api/live/stream?jobId=auth-job&token=secret-token-123');
  });

  it('receives SSE messages and updates events, persona progress, and Recharts token metrics', async () => {
    const { result } = renderHook(() => useSSE({ jobId: 'live-stream-job' }));

    const mockEvent1: LiveStreamEvent = {
      jobId: 'live-stream-job',
      timestamp: new Date().toISOString(),
      type: 'persona:start',
      persona: 'security',
      data: { message: 'Security persona audit starting...' },
    };

    const mockEvent2: LiveStreamEvent = {
      jobId: 'live-stream-job',
      timestamp: new Date().toISOString(),
      type: 'llm:token',
      persona: 'security',
      data: { promptTokens: 150, completionTokens: 40, totalTokens: 190, costUSD: 0.002, latencyMs: 450 },
    };

    const mockEvent3: LiveStreamEvent = {
      jobId: 'live-stream-job',
      timestamp: new Date().toISOString(),
      type: 'persona:complete',
      persona: 'security',
      data: { findingsCount: 3, message: 'Security review finished with 3 findings' },
    };

    await act(async () => {
      const mockEs = MockEventSource.instances[0];
      mockEs.emitMessage(mockEvent1);
      mockEs.emitMessage(mockEvent2);
      mockEs.emitMessage(mockEvent3);
      // Allow timer fallback / rAF to flush queue
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.events).toHaveLength(3);
    expect(result.current.personaProgress.security.status).toBe('COMPLETED');
    expect(result.current.personaProgress.security.progress).toBe(100);
    expect(result.current.personaProgress.security.findingsCount).toBe(3);

    expect(result.current.tokenMetrics.promptTokens).toBe(150);
    expect(result.current.tokenMetrics.completionTokens).toBe(40);
    expect(result.current.tokenMetrics.totalTokens).toBe(190);
    expect(result.current.tokenMetrics.estimatedCostUSD).toBeCloseTo(0.002);
    expect(result.current.tokenHistory.length).toBeGreaterThan(0);
  });

  it('filters events by selected persona', async () => {
    const { result } = renderHook(() => useSSE({ jobId: 'filter-job' }));

    const secEvent: LiveStreamEvent = {
      jobId: 'filter-job',
      timestamp: new Date().toISOString(),
      type: 'persona:chunk',
      persona: 'security',
      data: { chunk: 'Checking SQL injection vulnerabilities' },
    };

    const perfEvent: LiveStreamEvent = {
      jobId: 'filter-job',
      timestamp: new Date().toISOString(),
      type: 'persona:chunk',
      persona: 'performance',
      data: { chunk: 'Analyzing database query execution plan' },
    };

    await act(async () => {
      const mockEs = MockEventSource.instances[0];
      mockEs.emitMessage(secEvent);
      mockEs.emitMessage(perfEvent);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.events).toHaveLength(2);

    act(() => {
      result.current.setSelectedPersona('security');
    });

    expect(result.current.filteredEvents).toHaveLength(1);
    expect(result.current.filteredEvents[0].persona).toBe('security');

    act(() => {
      result.current.setSelectedPersona('all');
    });

    expect(result.current.filteredEvents).toHaveLength(2);
  });

  it('updates personaProgress lastMessage on job:queued and job:dispatched without changing status (REL-573)', async () => {
    const { result } = renderHook(() => useSSE({ jobId: 'lifecycle-job' }));

    // Sanity: initial state is PENDING with the generic waiting message.
    expect(result.current.personaProgress.security.status).toBe('PENDING');
    expect(result.current.personaProgress.security.lastMessage).toBe('Waiting for execution...');

    const queuedEvent: LiveStreamEvent = {
      jobId: 'lifecycle-job',
      timestamp: new Date().toISOString(),
      type: 'job:queued',
      persona: 'all',
      data: { message: 'Review job queued for calltelemetry/cisco-cdr #99', status: 'queued' },
    };

    await act(async () => {
      const mockEs = MockEventSource.instances[0];
      mockEs.emitMessage(queuedEvent);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Every default persona is still PENDING (nothing has started executing),
    // consistent with /api/live/active reporting job.status === 'queued'.
    for (const personaKey of DEFAULT_PERSONAS) {
      expect(result.current.personaProgress[personaKey].status).toBe('PENDING');
      expect(result.current.personaProgress[personaKey].lastMessage).toBe(
        'Review job queued for calltelemetry/cisco-cdr #99'
      );
    }

    const dispatchedEvent: LiveStreamEvent = {
      jobId: 'lifecycle-job',
      timestamp: new Date().toISOString(),
      type: 'job:dispatched',
      persona: 'all',
      data: { message: 'Review job dispatched for calltelemetry/cisco-cdr #99', status: 'dispatched' },
    };

    await act(async () => {
      const mockEs = MockEventSource.instances[0];
      mockEs.emitMessage(dispatchedEvent);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    for (const personaKey of DEFAULT_PERSONAS) {
      expect(result.current.personaProgress[personaKey].status).toBe('PENDING');
      expect(result.current.personaProgress[personaKey].lastMessage).toBe(
        'Review job dispatched for calltelemetry/cisco-cdr #99'
      );
    }

    // Both lifecycle events land in the raw event feed too.
    expect(result.current.events.map((e) => e.type)).toEqual(['job:queued', 'job:dispatched']);
  });

  it('does not overwrite lastMessage via job:queued/job:dispatched for a persona that already started (REL-573)', async () => {
    const { result } = renderHook(() => useSSE({ jobId: 'lifecycle-job-2' }));

    const startEvent: LiveStreamEvent = {
      jobId: 'lifecycle-job-2',
      timestamp: new Date().toISOString(),
      type: 'persona:start',
      persona: 'security',
      data: { message: 'Security persona audit starting...' },
    };

    const dispatchedEvent: LiveStreamEvent = {
      jobId: 'lifecycle-job-2',
      timestamp: new Date().toISOString(),
      type: 'job:dispatched',
      persona: 'all',
      data: { message: 'Review job dispatched', status: 'dispatched' },
    };

    await act(async () => {
      const mockEs = MockEventSource.instances[0];
      mockEs.emitMessage(startEvent);
      mockEs.emitMessage(dispatchedEvent);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // security already transitioned to IN PROGRESS via persona:start, so the
    // later job:dispatched event must not clobber its own message.
    expect(result.current.personaProgress.security.status).toBe('IN PROGRESS');
    expect(result.current.personaProgress.security.lastMessage).toBe('Security persona audit starting...');

    // A persona untouched by persona:start still picks up the job-level message.
    expect(result.current.personaProgress.architecture.status).toBe('PENDING');
    expect(result.current.personaProgress.architecture.lastMessage).toBe('Review job dispatched');
  });

  it('clears events and resets token metrics when clearEvents is called', async () => {
    const { result } = renderHook(() => useSSE({ jobId: 'clear-job' }));

    await act(async () => {
      const mockEs = MockEventSource.instances[0];
      mockEs.emitMessage({
        jobId: 'clear-job',
        timestamp: new Date().toISOString(),
        type: 'ast:lookup',
        persona: 'architecture',
        data: { promptTokens: 100, completionTokens: 50 },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.events).toHaveLength(1);

    act(() => {
      result.current.clearEvents();
    });

    expect(result.current.events).toHaveLength(0);
    expect(result.current.tokenMetrics.promptTokens).toBe(0);
    expect(result.current.tokenMetrics.completionTokens).toBe(0);
  });
});
