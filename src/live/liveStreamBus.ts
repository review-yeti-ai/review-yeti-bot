import { EventEmitter } from 'events';
import { Response } from 'express';
import { logger } from '../utils/logger';

export interface LiveStreamEvent {
  jobId: string;
  timestamp: string;
  type: 'agent_start' | 'llm_chunk' | 'agent_done' | 'nit_suppression' | 'indexer_lookup' | 'quorum_verdict';
  persona: 'security' | 'architecture' | 'performance' | 'quality' | 'quorum';
  data: {
    message?: string;
    promptSnippet?: string;
    model?: string;
    chunk?: string;
    tokensUsed?: number;
    confidenceScore?: number;
    verdict?: string;
    path?: string;
  };
}

export class LiveStreamBus extends EventEmitter {
  private static instance: LiveStreamBus;
  private clients: Map<string, Set<Response>> = new Map();
  private eventHistory: Map<string, LiveStreamEvent[]> = new Map();

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
   */
  public publishEvent(event: LiveStreamEvent): void {
    const history = this.eventHistory.get(event.jobId) || [];
    history.push(event);
    if (history.length > 500) history.shift(); // Keep last 500 events
    this.eventHistory.set(event.jobId, history);

    const clientSet = this.clients.get(event.jobId);
    if (clientSet && clientSet.size > 0) {
      const dataStr = `data: ${JSON.stringify(event)}\n\n`;
      clientSet.forEach((res) => {
        try {
          res.write(dataStr);
        } catch (err: any) {
          logger.warn('Failed writing to SSE client stream', { jobId: event.jobId, error: err.message });
        }
      });
    }

    this.emit('event', event);
  }

  /**
   * Registers an Express Response object as an SSE client for a specific jobId.
   */
  public addClient(jobId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let clientSet = this.clients.get(jobId);
    if (!clientSet) {
      clientSet = new Set();
      this.clients.set(jobId, clientSet);
    }
    clientSet.add(res);

    // Send historical events to catch up client
    const history = this.eventHistory.get(jobId) || [];
    for (const evt of history) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }

    res.on('close', () => {
      const currentSet = this.clients.get(jobId);
      if (currentSet) {
        currentSet.delete(res);
        if (currentSet.size === 0) {
          this.clients.delete(jobId);
        }
      }
    });
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
