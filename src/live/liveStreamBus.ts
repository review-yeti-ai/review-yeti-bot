import { EventEmitter } from 'events';
import { Response } from 'express';
import { logger } from '../utils/logger';

export type LiveStreamEventType =
  | 'persona:start'
  | 'persona:chunk'
  | 'persona:complete'
  | 'llm:prompt'
  | 'llm:token'
  | 'omniroute:metric'
  | 'openrouter:metric'
  | 'ast:lookup'
  | 'nit:suppression'
  | 'job:queued'
  | 'job:dispatched'
  | 'job:complete'
  // Legacy event type shims
  | 'agent_start'
  | 'llm_chunk'
  | 'agent_done'
  | 'indexer_lookup'
  | 'quorum_verdict';

export type LiveStreamPersona =
  | 'security'
  | 'correctness'
  | 'architecture'
  | 'performance'
  | 'quality'
  | 'compliance'
  | 'quorum'
  | string;

export interface LiveStreamEventData {
  personaId?: string;
  charter?: string;
  paths?: string[];
  required?: boolean;
  chunk?: string;
  decision?: string;
  findingsCount?: number;
  durationMs?: number;
  tokensUsed?: number | { prompt: number; completion: number; total: number };
  costUSD?: number | null;
  provider?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  promptSnippet?: string;
  token?: string;
  accumulatedLength?: number;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  symbolName?: string;
  filePath?: string;
  callersCount?: number;
  calleesCount?: number;
  riskScore?: number;
  findingTitle?: string;
  pattern?: string;
  rationale?: string;
  verdict?: string;
  quorumSatisfied?: boolean;
  distinctProviders?: string[];
  totalPersonasExecuted?: number;
  totalFindings?: number;
  totalDurationMs?: number;
  totalCostUSD?: number | null;
  message?: string;
  confidenceScore?: number;
  path?: string;
  [key: string]: any;
}

export interface LiveStreamEvent {
  jobId: string;
  timestamp: string;
  type: LiveStreamEventType;
  persona: LiveStreamPersona;
  data: LiveStreamEventData;
}

export interface PersonaProgress {
  persona: LiveStreamPersona;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  findingsCount?: number;
  lastMessage?: string;
}

export interface TokenMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD?: number;
}

export interface LiveQueueMetrics {
  activeJobsCount: number;
  queuedJobsCount: number;
  maxConcurrentJobs: number;
}

export interface LiveJobSummary {
  jobId: string;
  repo?: string;
  prNumber?: number;
  status: 'queued' | 'active' | 'completed' | 'failed' | 'dispatched';
  personaProgress: Record<string, PersonaProgress>;
  tokenMetrics: TokenMetrics;
  startTime: string;
  endTime?: string;
  eventCount: number;
  lastEventTime: string;
}

export class LiveStreamBus extends EventEmitter {
  private static instance: LiveStreamBus;
  private clients: Map<string, Set<Response>> = new Map();
  private eventHistory: Map<string, LiveStreamEvent[]> = new Map();
  private pingIntervals: Map<Response, NodeJS.Timeout> = new Map();
  private jobs: Map<string, LiveJobSummary> = new Map();

  private constructor() {
    super();
    this.setMaxListeners(100);
  }

  public static getInstance(): LiveStreamBus {
    if (!LiveStreamBus.instance) {
      LiveStreamBus.instance = new LiveStreamBus();
    }
    return LiveStreamBus.instance;
  }

  /**
   * Publishes a live stream event to all connected SSE clients for a specific jobId.
   * Thread-safe ring buffer maintains up to 500 historical events per job.
   */
  public publishEvent(event: LiveStreamEvent): void {
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }

    this.updateJobSummary(event);

    const history = this.eventHistory.get(event.jobId) || [];
    history.push(event);
    if (history.length > 500) {
      history.shift(); // Keep last 500 events
    }
    this.eventHistory.set(event.jobId, history);

    const globalKeys = ['*', 'all', 'default-job'];
    const targetSets = [
      this.clients.get(event.jobId),
      ...globalKeys.map((k) => this.clients.get(k)),
    ].filter((s): s is Set<Response> => Boolean(s && s.size > 0));

    if (targetSets.length > 0) {
      const dataStr = `data: ${JSON.stringify(event)}\n\n`;
      const notified = new Set<Response>();

      for (const clientSet of targetSets) {
        clientSet.forEach((res) => {
          if (!notified.has(res)) {
            notified.add(res);
            try {
              res.write(dataStr);
            } catch (err: any) {
              logger.warn('Failed writing to SSE client stream, cleaning up', {
                jobId: event.jobId,
                error: err?.message,
              });
              this.removeClient(event.jobId, res);
            }
          }
        });
      }
    }

    this.emit('event', event);
    this.emit(`job:${event.jobId}`, event);
  }

  /**
   * Registers an Express Response object as an SSE client for a specific jobId.
   * Replays cached history events before streaming live updates.
   */
  public addClient(jobId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }

    let clientSet = this.clients.get(jobId);
    if (!clientSet) {
      clientSet = new Set();
      this.clients.set(jobId, clientSet);
    }
    clientSet.add(res);

    // Send historical events to catch up client
    const history = this.eventHistory.get(jobId) || [];
    for (const evt of history) {
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch (err: any) {
        logger.warn('Failed sending SSE history to client', { jobId, error: err.message });
        this.removeClient(jobId, res);
        return;
      }
    }

    // Setup 15-second heartbeat ping comment
    const pingInterval = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (err) {
        this.removeClient(jobId, res);
      }
    }, 15_000);

    this.pingIntervals.set(res, pingInterval);

    res.on('close', () => {
      this.removeClient(jobId, res);
    });
  }

  private removeClient(jobId: string, res: Response): void {
    const ping = this.pingIntervals.get(res);
    if (ping) {
      clearInterval(ping);
      this.pingIntervals.delete(res);
    }

    const currentSet = this.clients.get(jobId);
    if (currentSet) {
      currentSet.delete(res);
      if (currentSet.size === 0) {
        this.clients.delete(jobId);
      }
    }
  }

  public getHistory(jobId: string): LiveStreamEvent[] {
    const history = this.eventHistory.get(jobId);
    if (history && history.length > 0) {
      return history;
    }

    try {
      const { dashboardStore } = require('../persistence/dashboardStore');
      const logs = dashboardStore.getReviewLogs();
      const match = (logs || []).find(
        (l: any) => l.id === jobId || jobId.includes(`pr${l.prNumber}`) || (l.repo && jobId.includes(l.repo.replace(/\//g, '_')))
      );

      if (match) {
        const syntheticEvents: LiveStreamEvent[] = [];
        const timestamp = match.timestamp || new Date().toISOString();
        const repo = match.repo || 'unknown/repo';
        const prNumber = match.prNumber ?? 0;

        syntheticEvents.push({
          jobId,
          timestamp,
          type: 'job:complete',
          persona: 'all',
          data: {
            repo,
            prNumber,
            message: `Review completed for ${repo} #${prNumber}`,
            status: 'completed',
          },
        });

        const personas = match.personaLogs
          ? Object.keys(match.personaLogs)
          : ['security', 'architecture', 'performance', 'quality'];
        const costPerPersona = (match.costUSD || 0.001) / personas.length;
        const promptPerPersona = Math.round((match.tokens?.prompt || 1200) / personas.length);
        const compPerPersona = Math.round((match.tokens?.completion || 400) / personas.length);

        for (const p of personas) {
          const pLog = match.personaLogs?.[p];
          syntheticEvents.push({
            jobId,
            timestamp,
            type: 'persona:start',
            persona: p,
            data: { personaId: p, message: `Evaluating ${repo} #${prNumber} for persona ${p}` },
          });
          syntheticEvents.push({
            jobId,
            timestamp,
            type: 'llm:token',
            persona: p,
            data: {
              promptTokens: promptPerPersona,
              completionTokens: compPerPersona,
              totalTokens: promptPerPersona + compPerPersona,
              costUSD: costPerPersona,
              latencyMs: pLog?.latencyMs || 850,
            },
          });
          syntheticEvents.push({
            jobId,
            timestamp,
            type: 'persona:complete',
            persona: p,
            data: {
              findingsCount: pLog?.nitsCount || pLog?.findingsCount || 0,
              message: pLog?.reasoningChain?.[0] || `Persona ${p} evaluation completed with verdict ${pLog?.verdict || 'SHIP'}`,
            },
          });
        }

        return syntheticEvents;
      }
    } catch {
      // Ignore fallback errors
    }

    return [];
  }

  public getActiveJobs(): LiveJobSummary[] {
    return Array.from(this.jobs.values());
  }

  public getQueueMetrics(): LiveQueueMetrics {
    const envMax = process.env.MAX_CONCURRENT_REVIEW_JOBS;
    const maxConcurrentJobs = envMax && !isNaN(parseInt(envMax, 10)) ? parseInt(envMax, 10) : 3;

    let activeJobsCount = 0;
    let queuedJobsCount = 0;

    for (const job of this.jobs.values()) {
      if (job.status === 'queued') {
        queuedJobsCount++;
      } else if (job.status === 'active' || job.status === 'dispatched') {
        activeJobsCount++;
      }
    }

    return {
      activeJobsCount,
      queuedJobsCount,
      maxConcurrentJobs,
    };
  }

  public getJobStatus(jobId: string): LiveJobSummary | undefined {
    return this.jobs.get(jobId);
  }

  public clearHistory(jobId?: string): void {
    if (jobId) {
      this.eventHistory.delete(jobId);
      this.jobs.delete(jobId);
    } else {
      this.eventHistory.clear();
      this.jobs.clear();
    }
  }

  private updateJobSummary(event: LiveStreamEvent): void {
    let job = this.jobs.get(event.jobId);
    if (!job) {
      let repo: string | undefined = event.data?.repo;
      let prNumber: number | undefined = event.data?.prNumber;

      if (!repo || !prNumber) {
        const match = event.jobId.match(/^job_([^_]+)_([^_]+)_pr(\d+)/i);
        if (match) {
          if (!repo) repo = `${match[1]}/${match[2]}`;
          if (!prNumber) prNumber = parseInt(match[3], 10);
        }
      }

      let initialStatus: LiveJobSummary['status'] = 'active';
      if (event.type === 'job:queued' || event.data?.status === 'queued') {
        initialStatus = 'queued';
      } else if (event.type === 'job:dispatched' || event.data?.status === 'dispatched') {
        initialStatus = 'dispatched';
      } else if (event.data?.status && ['queued', 'active', 'completed', 'failed', 'dispatched'].includes(event.data.status)) {
        initialStatus = event.data.status;
      }

      job = {
        jobId: event.jobId,
        repo,
        prNumber,
        status: initialStatus,
        personaProgress: {},
        tokenMetrics: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUSD: 0,
        },
        startTime: event.timestamp,
        eventCount: 0,
        lastEventTime: event.timestamp,
      };
      this.jobs.set(event.jobId, job);
    }

    job.eventCount += 1;
    job.lastEventTime = event.timestamp;

    if (!job.repo && event.data?.repo) job.repo = event.data.repo;
    if (!job.prNumber && event.data?.prNumber) job.prNumber = event.data.prNumber;

    if (event.type === 'job:queued') {
      job.status = 'queued';
    } else if (event.type === 'job:dispatched') {
      job.status = 'dispatched';
    } else if (
      event.type === 'persona:start' ||
      event.type === 'persona:chunk' ||
      event.type === 'llm:prompt' ||
      event.type === 'llm:token' ||
      event.type === 'agent_start' ||
      event.type === 'llm_chunk'
    ) {
      if (job.status === 'queued' || job.status === 'dispatched') {
        job.status = 'active';
      }
    }

    const personaKey = String(event.persona);
    if (personaKey && personaKey !== 'all') {
      let progress = job.personaProgress[personaKey];
      if (!progress) {
        progress = {
          persona: event.persona,
          status: 'pending',
        };
        job.personaProgress[personaKey] = progress;
      }

      if (event.type === 'persona:start' || event.type === 'agent_start') {
        progress.status = 'in_progress';
        if (!progress.startedAt) progress.startedAt = event.timestamp;
      } else if (event.type === 'persona:chunk' || event.type === 'llm_chunk' || event.type === 'llm:token') {
        if (progress.status === 'pending') {
          progress.status = 'in_progress';
          if (!progress.startedAt) progress.startedAt = event.timestamp;
        }
      } else if (event.type === 'persona:complete' || event.type === 'agent_done' || event.type === 'quorum_verdict') {
        progress.status = 'completed';
        progress.completedAt = event.timestamp;
        if (typeof event.data?.findingsCount === 'number') {
          progress.findingsCount = event.data.findingsCount;
        }
      }

      if (event.data?.message) {
        progress.lastMessage = event.data.message;
      }
    }

    if (event.data) {
      const pTokens = event.data.promptTokens || (typeof event.data.tokensUsed === 'object' ? event.data.tokensUsed?.prompt : 0) || 0;
      const cTokens = event.data.completionTokens || (typeof event.data.tokensUsed === 'object' ? event.data.tokensUsed?.completion : 0) || 0;
      const tTokens = event.data.totalTokens || (typeof event.data.tokensUsed === 'number' ? event.data.tokensUsed : (typeof event.data.tokensUsed === 'object' ? event.data.tokensUsed?.total : 0)) || (pTokens + cTokens);

      job.tokenMetrics.promptTokens += pTokens;
      job.tokenMetrics.completionTokens += cTokens;
      job.tokenMetrics.totalTokens += tTokens;

      const cost = typeof event.data.costUSD === 'number' ? event.data.costUSD : (typeof event.data.totalCostUSD === 'number' ? event.data.totalCostUSD : 0);
      if (cost) {
        job.tokenMetrics.estimatedCostUSD = (job.tokenMetrics.estimatedCostUSD || 0) + cost;
      }
    }

    if (event.type === 'job:complete') {
      job.status = 'completed';
      job.endTime = event.timestamp;
    } else if (event.data?.status && ['queued', 'active', 'completed', 'failed', 'dispatched'].includes(event.data.status)) {
      job.status = event.data.status;
      if (job.status === 'completed' || job.status === 'failed') {
        job.endTime = event.timestamp;
      }
    } else if (event.persona === 'quorum' && (event.type === 'quorum_verdict' || event.type === 'persona:complete')) {
      job.status = 'completed';
      job.endTime = event.timestamp;
    }
  }
}
