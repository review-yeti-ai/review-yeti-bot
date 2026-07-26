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
  | 'ast:lookup'
  | 'nit:suppression'
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

export class LiveStreamBus extends EventEmitter {
  private static instance: LiveStreamBus;
  private clients: Map<string, Set<Response>> = new Map();
  private eventHistory: Map<string, LiveStreamEvent[]> = new Map();
  private pingIntervals: Map<Response, NodeJS.Timeout> = new Map();

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

    const history = this.eventHistory.get(event.jobId) || [];
    history.push(event);
    if (history.length > 500) {
      history.shift(); // Keep last 500 events
    }
    this.eventHistory.set(event.jobId, history);

    const clientSet = this.clients.get(event.jobId);
    if (clientSet && clientSet.size > 0) {
      const dataStr = `data: ${JSON.stringify(event)}\n\n`;
      const deadClients: Response[] = [];

      clientSet.forEach((res) => {
        try {
          res.write(dataStr);
        } catch (err: any) {
          logger.warn('Failed writing to SSE client stream, scheduling cleanup', {
            jobId: event.jobId,
            error: err.message,
          });
          deadClients.push(res);
        }
      });

      deadClients.forEach((res) => this.removeClient(event.jobId, res));
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
    return this.eventHistory.get(jobId) || [];
  }

  public clearHistory(jobId?: string): void {
    if (jobId) {
      this.eventHistory.delete(jobId);
    } else {
      this.eventHistory.clear();
    }
  }
}
