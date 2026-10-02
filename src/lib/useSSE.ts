'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  LiveStreamEvent,
  PersonaProgressState,
  StreamingTokenMetrics,
  TokenMetricHistoryPoint,
  LiveJobSummary,
  PersonaStatus,
} from '@/types/live';
import { AnchoredFinding } from '@/types/diff';

export interface ToolExecutionRecord {
  id: string;
  jobId: string;
  personaId: string;
  tool: string;
  args: Record<string, unknown>;
  output?: string;
  outputLength?: number;
  error?: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  turn?: number;
  timestamp: string;
}

export const DEFAULT_PERSONAS = [
  'security',
  'architecture',
  'performance',
  'quality',
  'database',
  'api_contract',
  'reliability',
  'devops',
  'docs_compliance',
  'finops',
  'red_team',
  'review_flowchart',
];

export interface UseSSEOptions {
  jobId?: string | null;
  token?: string | null;
  autoConnect?: boolean;
  maxBufferHistory?: number;
  flushIntervalMs?: number;
}

export function createInitialPersonaProgress(): Record<string, PersonaProgressState> {
  const initial: Record<string, PersonaProgressState> = {};
  for (const p of DEFAULT_PERSONAS) {
    initial[p] = {
      persona: p,
      status: 'PENDING',
      progress: 0,
      findingsCount: 0,
      lastMessage: 'Waiting for execution...',
      chunkCount: 0,
    };
  }
  return initial;
}

export function useSSE(options: UseSSEOptions = {}) {
  const {
    jobId: initialJobId = null,
    token = null,
    autoConnect = true,
    maxBufferHistory = 500,
  } = options;

  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  >('disconnected');
  const [events, setEvents] = useState<LiveStreamEvent[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<string>('all');
  const [personaProgress, setPersonaProgress] = useState<Record<string, PersonaProgressState>>(
    createInitialPersonaProgress
  );
  const [tokenMetrics, setTokenMetrics] = useState<StreamingTokenMetrics>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: 0,
    tokensPerSec: 0,
    latencyMs: 0,
    astNodes: 0,
    nitsFound: 0,
  });
  const [tokenHistory, setTokenHistory] = useState<TokenMetricHistoryPoint[]>([]);
  const [activeJobs, setActiveJobs] = useState<LiveJobSummary[]>([]);
  const [reasoning, setReasoning] = useState<Record<string, string>>({});
  const [toolExecutions, setToolExecutions] = useState<ToolExecutionRecord[]>([]);
  const [anchoredFindings, setAnchoredFindings] = useState<AnchoredFinding[]>([]);

  // Refs for double-buffered batching queue
  const incomingQueueRef = useRef<LiveStreamEvent[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const timerIdRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const watchdogIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Keep state sync ref for metrics accumulator
  const metricsRef = useRef<StreamingTokenMetrics>(tokenMetrics);
  metricsRef.current = tokenMetrics;

  const personaProgressRef = useRef<Record<string, PersonaProgressState>>(personaProgress);
  personaProgressRef.current = personaProgress;

  // Sync prop changes to jobId state if prop updates
  useEffect(() => {
    if (initialJobId !== undefined && initialJobId !== jobId) {
      setJobId(initialJobId);
    }
  }, [initialJobId]);

  // Fetch active jobs list from /api/live/active
  const fetchActiveJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/live/active');
      if (res.ok) {
        const data = await res.json();
        if (data.jobs && Array.isArray(data.jobs)) {
          setActiveJobs(data.jobs);
          if (data.jobs.length > 0) {
            setJobId((prevJobId) => {
              if (!prevJobId || prevJobId === 'default-job') {
                const autoSelected = data.jobs[0].jobId;
                if (typeof window !== 'undefined') {
                  const url = new URL(window.location.href);
                  url.searchParams.set('jobId', autoSelected);
                  window.history.replaceState({}, '', url.toString());
                }
                return autoSelected;
              }
              return prevJobId;
            });
          }
        }
      }
    } catch {
      // Ignore network errors in polling/fetching active jobs
    }
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setReasoning({});
    setToolExecutions([]);
    setAnchoredFindings([]);
    setPersonaProgress(createInitialPersonaProgress());
    setTokenMetrics({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
      tokensPerSec: 0,
      latencyMs: 0,
      astNodes: 0,
      nitsFound: 0,
    });
    setTokenHistory([]);
  }, []);

  // Process incoming event batch to update persona progress and metrics
  const processBatch = useCallback((batch: LiveStreamEvent[]) => {
    let pTokensDelta = 0;
    let cTokensDelta = 0;
    let tTokensDelta = 0;
    let costDelta = 0;
    let latestLatency = metricsRef.current.latencyMs;
    let astNodesDelta = 0;
    let nitsDelta = 0;

    const nextPersonaProgress = { ...personaProgressRef.current };

    for (const evt of batch) {
      const { type, persona, data } = evt;
      const canonicalPersona = persona ? persona.toLowerCase() : 'all';

      // Ensure persona entry exists
      if (canonicalPersona !== 'all' && !nextPersonaProgress[canonicalPersona]) {
        nextPersonaProgress[canonicalPersona] = {
          persona: canonicalPersona,
          status: 'PENDING',
          progress: 0,
          findingsCount: 0,
          lastMessage: 'Waiting for execution...',
          chunkCount: 0,
        };
      }

      const currentPersona = nextPersonaProgress[canonicalPersona];

      // Update persona progress based on event type
      if (type === 'persona:start' || type === 'agent_start') {
        if (currentPersona) {
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'IN PROGRESS',
            progress: Math.max(currentPersona.progress, 15),
            startedAt: evt.timestamp,
            lastMessage: data?.message || `Persona ${canonicalPersona} evaluation started`,
          };
        }
      } else if (type === 'persona:chunk' || type === 'llm_chunk') {
        if (currentPersona) {
          const chunkMsg = data?.chunk || data?.message || 'Streaming reasoning tokens...';
          const newChunkCount = (currentPersona.chunkCount || 0) + 1;
          const newProgress = Math.min(95, Math.max(currentPersona.progress, 15 + newChunkCount * 5));
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'IN PROGRESS',
            progress: newProgress,
            chunkCount: newChunkCount,
            lastMessage: chunkMsg.length > 80 ? chunkMsg.slice(0, 77) + '...' : chunkMsg,
          };
        }
      } else if (type === 'reasoning:chunk' || type === 'persona:reasoning') {
        const text = data?.reasoning || data?.chunk || data?.message || '';
        if (text && canonicalPersona) {
          setReasoning((prev) => ({
            ...prev,
            [canonicalPersona]: (prev[canonicalPersona] || '') + text,
          }));
        }
        if (currentPersona) {
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'IN PROGRESS',
            progress: Math.min(95, Math.max(currentPersona.progress, 20)),
            lastMessage: 'Deliberating reasoning trace...',
          };
        }
      } else if (type === 'tool:start') {
        const toolName = data?.tool || data?.toolName || 'tool';
        const toolId = `${evt.jobId}_${canonicalPersona}_${toolName}_${evt.timestamp}`;
        const newTool: ToolExecutionRecord = {
          id: toolId,
          jobId: evt.jobId,
          personaId: canonicalPersona,
          tool: toolName,
          args: data?.args || {},
          status: 'running',
          turn: data?.turn,
          timestamp: evt.timestamp,
        };
        setToolExecutions((prev) => [...prev, newTool]);
        if (currentPersona) {
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'IN PROGRESS',
            lastMessage: data?.message || `Executing tool ${toolName}...`,
          };
        }
      } else if (type === 'tool:result') {
        const toolName = data?.tool || data?.toolName || 'tool';
        setToolExecutions((prev) => {
          const idx = [...prev].reverse().findIndex(
            (t) => t.tool === toolName && t.personaId === canonicalPersona && t.status === 'running'
          );
          if (idx !== -1) {
            const actualIdx = prev.length - 1 - idx;
            const updated = [...prev];
            updated[actualIdx] = {
              ...updated[actualIdx],
              output: data?.output,
              outputLength: data?.outputLength ?? data?.output?.length,
              durationMs: data?.durationMs,
              status: 'completed',
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: `${evt.jobId}_${canonicalPersona}_${toolName}_${evt.timestamp}`,
              jobId: evt.jobId,
              personaId: canonicalPersona,
              tool: toolName,
              args: data?.args || {},
              output: data?.output,
              outputLength: data?.outputLength ?? data?.output?.length,
              durationMs: data?.durationMs,
              status: 'completed',
              turn: data?.turn,
              timestamp: evt.timestamp,
            },
          ];
        });
        if (currentPersona) {
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'IN PROGRESS',
            lastMessage: data?.message || `Tool ${toolName} completed in ${data?.durationMs || 0}ms`,
          };
        }
      } else if (type === 'tool:error') {
        const toolName = data?.tool || data?.toolName || 'tool';
        setToolExecutions((prev) => {
          const idx = [...prev].reverse().findIndex(
            (t) => t.tool === toolName && t.personaId === canonicalPersona && t.status === 'running'
          );
          if (idx !== -1) {
            const actualIdx = prev.length - 1 - idx;
            const updated = [...prev];
            updated[actualIdx] = {
              ...updated[actualIdx],
              error: data?.error,
              durationMs: data?.durationMs,
              status: 'error',
            };
            return updated;
          }
          return [
            ...prev,
            {
              id: `${evt.jobId}_${canonicalPersona}_${toolName}_${evt.timestamp}`,
              jobId: evt.jobId,
              personaId: canonicalPersona,
              tool: toolName,
              args: data?.args || {},
              error: data?.error,
              durationMs: data?.durationMs,
              status: 'error',
              turn: data?.turn,
              timestamp: evt.timestamp,
            },
          ];
        });
        if (currentPersona) {
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'IN PROGRESS',
            lastMessage: data?.message || `Tool ${toolName} failed: ${data?.error || ''}`,
          };
        }
      } else if (type === 'persona:finding') {
        const findingData = data?.finding || data || {};
        const fId = data?.findingId || findingData.id || `f_${canonicalPersona}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const finding: AnchoredFinding = {
          id: fId,
          severity: (findingData.severity || data?.severity || 'P1') as 'P0' | 'P1' | 'P2',
          file: findingData.path || findingData.file || data?.path || data?.filePath || '',
          line: findingData.line ?? data?.line ?? 1,
          startLine: findingData.startLine ?? data?.startLine,
          title: findingData.title || data?.title || data?.findingTitle || 'Review Finding',
          description: findingData.description || findingData.body || data?.description || '',
          suggestion: findingData.suggestion || data?.suggestion || findingData.replacementCode || data?.replacementCode,
          suggestedPatch: findingData.suggestedPatch || data?.suggestedPatch,
          status: 'active',
          persona: canonicalPersona,
        };

        setAnchoredFindings((prev) => {
          if (prev.some((f) => f.id === finding.id)) return prev;
          return [...prev, finding];
        });

        if (currentPersona) {
          const currentCount = currentPersona.findingsCount || 0;
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            findingsCount: currentCount + 1,
            lastMessage: `[${finding.severity}] ${finding.title}`,
          };
        }
      } else if (type === 'persona:complete' || type === 'agent_done') {
        if (currentPersona) {
          const findings = data?.findingsCount ?? currentPersona.findingsCount ?? 0;
          nextPersonaProgress[canonicalPersona] = {
            ...currentPersona,
            status: 'COMPLETED',
            progress: 100,
            completedAt: evt.timestamp,
            findingsCount: findings,
            lastMessage: data?.message || `Persona completed with ${findings} findings`,
          };
        }
      } else if (type === 'job:complete') {
        for (const key of Object.keys(nextPersonaProgress)) {
          if (
            nextPersonaProgress[key].status === 'PENDING' ||
            nextPersonaProgress[key].status === 'IN PROGRESS'
          ) {
            nextPersonaProgress[key] = {
              ...nextPersonaProgress[key],
              status: 'COMPLETED',
              progress: 100,
            };
          }
        }
      } else if (type === 'job:queued' || type === 'job:dispatched') {
        // Job-level lifecycle events (persona: 'all'). Mirrors /api/live/active's
        // job.status of 'queued'/'dispatched': no persona has started executing
        // yet, so PersonaStatus stays PENDING (there is no QUEUED/DISPATCHED
        // persona status) and only the informational message is refreshed so
        // it does not disagree with the poll-derived job summary.
        const jobLifecycleMessage =
          data?.message || (type === 'job:queued' ? 'Review job queued' : 'Review job dispatched');
        for (const key of Object.keys(nextPersonaProgress)) {
          if (nextPersonaProgress[key].status === 'PENDING') {
            nextPersonaProgress[key] = {
              ...nextPersonaProgress[key],
              lastMessage: jobLifecycleMessage,
            };
          }
        }
      }

      // Token and cost extraction
      if (data) {
        if (typeof data.promptTokens === 'number') pTokensDelta += data.promptTokens;
        if (typeof data.completionTokens === 'number') cTokensDelta += data.completionTokens;
        if (typeof data.totalTokens === 'number') tTokensDelta += data.totalTokens;

        if (typeof data.tokensUsed === 'object' && data.tokensUsed !== null) {
          if (typeof data.tokensUsed.prompt === 'number') pTokensDelta += data.tokensUsed.prompt;
          if (typeof data.tokensUsed.completion === 'number') cTokensDelta += data.tokensUsed.completion;
          if (typeof data.tokensUsed.total === 'number') tTokensDelta += data.tokensUsed.total;
        } else if (typeof data.tokensUsed === 'number') {
          tTokensDelta += data.tokensUsed;
        }

        if (type === 'llm:token' || type === 'llm_chunk') {
          if (!data.completionTokens && !data.tokensUsed) {
            cTokensDelta += 1;
            tTokensDelta += 1;
          }
        }

        if (typeof data.costUSD === 'number') costDelta += data.costUSD;
        else if (typeof data.totalCostUSD === 'number') costDelta += data.totalCostUSD;

        if (typeof data.latencyMs === 'number') latestLatency = data.latencyMs;
        else if (typeof data.durationMs === 'number') latestLatency = data.durationMs;

        if (type === 'ast:lookup' || type === 'indexer_lookup') {
          astNodesDelta += 1;
        }
        if (type === 'nit:suppression') {
          nitsDelta += 1;
        }
      }
    }

    setPersonaProgress(nextPersonaProgress);

    // Calculate new metrics totals
    setTokenMetrics((prev) => {
      const newPrompt = prev.promptTokens + pTokensDelta;
      const newCompletion = prev.completionTokens + cTokensDelta;
      const newTotal = prev.totalTokens + (tTokensDelta || pTokensDelta + cTokensDelta);
      const newCost = prev.estimatedCostUSD + costDelta;
      const newAst = prev.astNodes + astNodesDelta;
      const newNits = prev.nitsFound + nitsDelta;

      // Approximate tokens per sec based on latency or batch size
      const tps = latestLatency > 0 ? Math.round(((cTokensDelta || 1) / (latestLatency / 1000)) * 10) / 10 : prev.tokensPerSec;

      const newMetrics: StreamingTokenMetrics = {
        promptTokens: newPrompt,
        completionTokens: newCompletion,
        totalTokens: newTotal,
        estimatedCostUSD: Math.round(newCost * 10000) / 10000,
        tokensPerSec: Math.min(250, Math.max(0, tps)),
        latencyMs: latestLatency,
        astNodes: newAst,
        nitsFound: newNits,
      };

      // Append point to Recharts time-series history
      setTokenHistory((prevHistory) => {
        const timeLabel = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        const newPoint: TokenMetricHistoryPoint = {
          timestamp: new Date().toISOString(),
          label: timeLabel,
          promptTokens: newPrompt,
          completionTokens: newCompletion,
          totalTokens: newTotal,
          tokensPerSec: newMetrics.tokensPerSec,
          latencyMs: latestLatency,
        };
        const updatedHistory = [...prevHistory, newPoint];
        return updatedHistory.length > 60 ? updatedHistory.slice(updatedHistory.length - 60) : updatedHistory;
      });

      return newMetrics;
    });
  }, []);

  // Flush incoming queue into React state atomically
  const flushQueue = useCallback(() => {
    const batch = incomingQueueRef.current;
    if (batch.length === 0) return;
    incomingQueueRef.current = [];

    setEvents((prevEvents) => {
      const updated = [...prevEvents, ...batch];
      if (updated.length > maxBufferHistory) {
        return updated.slice(updated.length - maxBufferHistory);
      }
      return updated;
    });

    processBatch(batch);
  }, [maxBufferHistory, processBatch]);

  // Double-buffered rAF scheduler
  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current !== null || timerIdRef.current !== null) return;

    if (typeof requestAnimationFrame !== 'undefined') {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        flushQueue();
      });
    } else {
      timerIdRef.current = setTimeout(() => {
        timerIdRef.current = null;
        flushQueue();
      }, 16);
    }
  }, [flushQueue]);

  // Tab visibility listener to prevent tab idle stalls
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        flushQueue();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
      return () => document.removeEventListener('visibilitychange', handleVisibility);
    }
  }, [flushQueue]);

  // Connect SSE connection with auto-reconnect & watchdog ping handler
  const connect = useCallback(() => {
    if (typeof window === 'undefined' || !window.EventSource) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const currentJobId = jobId || 'default-job';
    const params = new URLSearchParams();
    params.set('jobId', currentJobId);
    if (token) {
      params.set('token', token);
    }

    const url = `/api/live/stream?${params.toString()}`;
    setConnectionStatus((prev) => (prev === 'reconnecting' ? 'reconnecting' : 'connecting'));

    try {
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnectionStatus('connected');
        reconnectAttemptRef.current = 0;
        lastActivityRef.current = Date.now();
      };

      es.onmessage = (event: MessageEvent) => {
        lastActivityRef.current = Date.now();
        if (connectionStatus !== 'connected') {
          setConnectionStatus('connected');
        }

        if (!event.data) return;
        try {
          const parsed: LiveStreamEvent = JSON.parse(event.data);
          incomingQueueRef.current.push(parsed);
          scheduleFlush();
        } catch {
          // Ignore invalid JSON payloads or comment pings
        }
      };

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED || es.readyState === EventSource.CONNECTING) {
          es.close();
          eventSourceRef.current = null;
          handleReconnect();
        }
      };
    } catch {
      handleReconnect();
    }
  }, [jobId, token, scheduleFlush]);

  const handleReconnect = useCallback(() => {
    setConnectionStatus('reconnecting');
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
    reconnectAttemptRef.current += 1;

    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    if (watchdogIntervalRef.current) {
      clearInterval(watchdogIntervalRef.current);
    }
    setConnectionStatus('disconnected');
  }, []);

  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttemptRef.current = 0;
    connect();
  }, [disconnect, connect]);

  // Connection management effect
  useEffect(() => {
    if (autoConnect) {
      clearEvents();
      connect();
    }

    // Watchdog ping checker every 5s
    watchdogIntervalRef.current = setInterval(() => {
      if (
        eventSourceRef.current &&
        eventSourceRef.current.readyState === EventSource.OPEN &&
        Date.now() - lastActivityRef.current > 30000
      ) {
        // 30s timeout without event or heartbeat
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        handleReconnect();
      }
    }, 5000);

    return () => {
      disconnect();
    };
  }, [jobId, autoConnect, clearEvents, connect, disconnect, handleReconnect]);

  // Initial fetch of active jobs
  useEffect(() => {
    fetchActiveJobs();
    const interval = setInterval(fetchActiveJobs, 10000);
    return () => clearInterval(interval);
  }, [fetchActiveJobs]);

  // Filtered events based on selected persona
  const filteredEvents = useMemo(() => {
    if (selectedPersona === 'all') return events;
    return events.filter((e) => {
      const p = e.persona ? e.persona.toLowerCase() : '';
      return p === selectedPersona.toLowerCase();
    });
  }, [events, selectedPersona]);

  return {
    connectionStatus,
    jobId,
    setJobId,
    events,
    selectedPersona,
    setSelectedPersona,
    filteredEvents,
    personaProgress,
    tokenMetrics,
    tokenHistory,
    clearEvents,
    reconnect,
    activeJobs,
    fetchActiveJobs,
    reasoning,
    toolExecutions,
    anchoredFindings,
  };
}
