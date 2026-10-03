import type { Env } from './types.js';

export interface PendingQueueItem {
  runId: string;
  headSha: string;
  prNumber?: number;
  enqueuedAt: number;
}

export interface AcquireSlotResult {
  granted: boolean;
  queuePosition?: number;
  evicted?: boolean;
}

export interface ReleaseSlotResult {
  released: boolean;
  nextRunId?: string;
}

export interface EvictQueueResult {
  evicted: boolean;
  count: number;
  evictedRunIds: string[];
}

export interface RepoGateStatus {
  activeCount: number;
  activeJobs: string[];
  queueLength: number;
  activeRunsByPr?: Record<number, string>;
}

export class RepoGateDO {
  private state: DurableObjectState;
  private env: Env;
  private activeJobs: Set<string> = new Set();
  private maxConcurrency: number = 1;
  private queue: PendingQueueItem[] = [];
  private activeRunsByPr: Map<number, string> = new Map();
  private prByRunId: Map<string, number> = new Map();
  private evictedRunIds: Set<string> = new Set();
  private latestRunIdByPr: Map<number, string> = new Map();
  private prRunsSeen: Map<number, Set<string>> = new Map();
  private initialized: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    if (this.env.MAX_CONCURRENT_JOBS) {
      const parsed = parseInt(this.env.MAX_CONCURRENT_JOBS, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.maxConcurrency = parsed;
      }
    }

    this.initialized = this.state.blockConcurrencyWhile(async () => {
      const storedActive = await this.state.storage.get<string[]>('activeJobs');
      if (storedActive) {
        this.activeJobs = new Set(storedActive);
      }
      const storedQueue = await this.state.storage.get<PendingQueueItem[]>('queue');
      if (storedQueue) {
        this.queue = storedQueue;
      }
      const storedActiveRuns = await this.state.storage.get<[number, string][]>('activeRunsByPr');
      if (storedActiveRuns) {
        this.activeRunsByPr = new Map();
        for (const [pr, rId] of storedActiveRuns) {
          if (this.activeJobs.has(rId)) {
            this.activeRunsByPr.set(pr, rId);
            this.prByRunId.set(rId, pr);
          }
        }
      }
      const storedEvicted = await this.state.storage.get<string[]>('evictedRunIds');
      if (storedEvicted) {
        this.evictedRunIds = new Set(storedEvicted);
      }
      const storedLatest = await this.state.storage.get<[number, string][]>('latestRunIdByPr');
      if (storedLatest) {
        this.latestRunIdByPr = new Map(storedLatest);
      }
      const storedRunsSeen = await this.state.storage.get<[number, string[]][]>('prRunsSeen');
      if (storedRunsSeen) {
        this.prRunsSeen = new Map(
          storedRunsSeen.map(([pr, runs]) => [pr, new Set(runs)])
        );
      }
    });
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }

  private trackEvicted(runId: string): void {
    this.evictedRunIds.add(runId);
    if (this.evictedRunIds.size > 1000) {
      const first = this.evictedRunIds.values().next().value;
      if (first) {
        this.evictedRunIds.delete(first);
      }
    }
  }

  getActiveRun(prNumber: number): string | undefined {
    return this.activeRunsByPr.get(prNumber);
  }

  async acquireSlot(
    runId: string,
    headSha: string,
    prNumber?: number
  ): Promise<AcquireSlotResult> {
    await this.ensureInitialized();

    // 1. If run is already active, return granted idempotently
    if (this.activeJobs.has(runId)) {
      if (prNumber !== undefined) {
        this.activeRunsByPr.set(prNumber, runId);
        this.prByRunId.set(runId, prNumber);
        this.latestRunIdByPr.set(prNumber, runId);
        if (!this.prRunsSeen.has(prNumber)) {
          this.prRunsSeen.set(prNumber, new Set());
        }
        this.prRunsSeen.get(prNumber)!.add(runId);
        await this.state.storage.put('activeRunsByPr', Array.from(this.activeRunsByPr.entries()));
        await this.state.storage.put('latestRunIdByPr', Array.from(this.latestRunIdByPr.entries()));
        await this.state.storage.put(
          'prRunsSeen',
          Array.from(this.prRunsSeen.entries()).map(([pr, set]) => [pr, Array.from(set)])
        );
      }
      return { granted: true };
    }

    // 2. If this run was previously evicted, reject re-entry
    if (this.evictedRunIds.has(runId)) {
      return { granted: false, evicted: true };
    }

    // 2a. Explicit check for tombstoned closed PRs:
    if (prNumber !== undefined && this.latestRunIdByPr.get(prNumber) === '__EVICTED__') {
      return { granted: false, evicted: true };
    }

    // 2b. Permanent per-PR stale run rejection (1000-eviction boundary & closed PR protection):
    // If this run was already seen for this PR, but is not the latest known runId for this PR,
    // it is a stale superseded or pre-closure run re-polling. Immediately reject without modifying queue.
    if (
      prNumber !== undefined &&
      this.prRunsSeen.get(prNumber)?.has(runId) &&
      this.latestRunIdByPr.get(prNumber) !== runId
    ) {
      return { granted: false, evicted: true };
    }

    // 3. Concurrency slot available: grant immediately
    if (this.activeJobs.size < this.maxConcurrency) {
      this.queue = this.queue.filter((item) => item.runId !== runId);
      this.activeJobs.add(runId);
      if (prNumber !== undefined) {
        this.activeRunsByPr.set(prNumber, runId);
        this.prByRunId.set(runId, prNumber);
        this.latestRunIdByPr.set(prNumber, runId);
        if (!this.prRunsSeen.has(prNumber)) {
          this.prRunsSeen.set(prNumber, new Set());
        }
        this.prRunsSeen.get(prNumber)!.add(runId);
      }
      await this.persistState();
      return { granted: true };
    }

    // 4. Slot is busy (queue branch):
    // Check if runId is already queued
    const existingIdx = this.queue.findIndex((item) => item.runId === runId);
    if (existingIdx !== -1) {
      // Re-polling while already in queue: do NOT evict anything!
      // Update headSha and prNumber in place, preserving existing queue position and enqueuedAt seniority
      this.queue[existingIdx].headSha = headSha;
      if (prNumber !== undefined) {
        this.queue[existingIdx].prNumber = prNumber;
        this.latestRunIdByPr.set(prNumber, runId);
        if (!this.prRunsSeen.has(prNumber)) {
          this.prRunsSeen.set(prNumber, new Set());
        }
        this.prRunsSeen.get(prNumber)!.add(runId);
      }
      await this.persistState();
      return { granted: false, queuePosition: existingIdx + 1 };
    }

    // 5. This is a NEW run arriving for this PR (not currently in queue):
    // Evict any older queued items for the same PR number (stale commit supersession)
    if (prNumber !== undefined) {
      const olderItems = this.queue.filter((item) => item.prNumber === prNumber);
      for (const old of olderItems) {
        this.trackEvicted(old.runId);
      }
      this.queue = this.queue.filter((item) => item.prNumber !== prNumber);

      // Register new run as the latest for this PR
      this.latestRunIdByPr.set(prNumber, runId);
      if (!this.prRunsSeen.has(prNumber)) {
        this.prRunsSeen.set(prNumber, new Set());
      }
      this.prRunsSeen.get(prNumber)!.add(runId);
    }

    // Add new run to the tail of the FIFO queue
    this.queue.push({ runId, headSha, prNumber, enqueuedAt: Date.now() });
    const queuePosition = this.queue.length;
    await this.persistState();
    return { granted: false, queuePosition };
  }

  async releaseSlot(runId: string): Promise<ReleaseSlotResult> {
    await this.ensureInitialized();
    const wasActive = this.activeJobs.delete(runId);
    if (!wasActive) {
      // Also remove from queue if it was pending
      const initialQueueLength = this.queue.length;
      this.queue = this.queue.filter((item) => item.runId !== runId);
      if (this.queue.length !== initialQueueLength) {
        this.trackEvicted(runId);
        await this.persistState();
      }
      return { released: false };
    }

    const prNumber = this.prByRunId.get(runId);
    if (prNumber !== undefined) {
      this.prByRunId.delete(runId);
      if (this.activeRunsByPr.get(prNumber) === runId) {
        this.activeRunsByPr.delete(prNumber);
      }
    } else {
      for (const [pr, rId] of this.activeRunsByPr.entries()) {
        if (rId === runId) {
          this.activeRunsByPr.delete(pr);
        }
      }
    }

    let nextRunId: string | undefined;
    if (this.queue.length > 0 && this.activeJobs.size < this.maxConcurrency) {
      const next = this.queue.shift()!;
      this.activeJobs.add(next.runId);
      nextRunId = next.runId;
      if (next.prNumber !== undefined) {
        this.activeRunsByPr.set(next.prNumber, next.runId);
        this.prByRunId.set(next.runId, next.prNumber);
        this.latestRunIdByPr.set(next.prNumber, next.runId);
      }
    }

    await this.persistState();
    return { released: true, nextRunId };
  }

  async evictQueue(options: { runId?: string; prNumber?: number; tombstone?: boolean }): Promise<EvictQueueResult> {
    await this.ensureInitialized();
    const beforeCount = this.queue.length;
    const evictedRunIds: string[] = [];

    if (options.runId) {
      this.trackEvicted(options.runId);
      evictedRunIds.push(options.runId);
      this.queue = this.queue.filter((item) => item.runId !== options.runId);
    }

    const isTombstoned = options.prNumber !== undefined && options.tombstone !== false;

    if (options.prNumber !== undefined) {
      const toEvict = this.queue.filter((item) => item.prNumber === options.prNumber);
      for (const item of toEvict) {
        this.trackEvicted(item.runId);
        if (!evictedRunIds.includes(item.runId)) {
          evictedRunIds.push(item.runId);
        }
      }
      this.queue = this.queue.filter((item) => item.prNumber !== options.prNumber);
      if (isTombstoned) {
        this.latestRunIdByPr.set(options.prNumber, '__EVICTED__');
      }
    }

    const count = beforeCount - this.queue.length;
    if (count > 0 || evictedRunIds.length > 0 || isTombstoned) {
      await this.persistState();
    }
    return {
      evicted: count > 0 || evictedRunIds.length > 0 || isTombstoned,
      count,
      evictedRunIds,
    };
  }

  async clearEviction(prNumber: number): Promise<{ cleared: boolean }> {
    await this.ensureInitialized();
    if (this.latestRunIdByPr.get(prNumber) === '__EVICTED__') {
      this.latestRunIdByPr.delete(prNumber);
      await this.persistState();
    }
    return { cleared: true };
  }

  async registerRun(runId: string, prNumber: number): Promise<void> {
    await this.ensureInitialized();
    if (!this.prRunsSeen.has(prNumber)) {
      this.prRunsSeen.set(prNumber, new Set());
    }
    this.prRunsSeen.get(prNumber)!.add(runId);
    this.latestRunIdByPr.set(prNumber, runId);
    await this.persistState();
  }

  async getStatus(): Promise<RepoGateStatus> {
    await this.ensureInitialized();
    return {
      activeCount: this.activeJobs.size,
      activeJobs: Array.from(this.activeJobs),
      queueLength: this.queue.length,
      activeRunsByPr: Object.fromEntries(this.activeRunsByPr.entries()),
    };
  }

  private async persistState(): Promise<void> {
    await Promise.all([
      this.state.storage.put('activeJobs', Array.from(this.activeJobs)),
      this.state.storage.put('queue', this.queue),
      this.state.storage.put('activeRunsByPr', Array.from(this.activeRunsByPr.entries())),
      this.state.storage.put('evictedRunIds', Array.from(this.evictedRunIds)),
      this.state.storage.put('latestRunIdByPr', Array.from(this.latestRunIdByPr.entries())),
      this.state.storage.put(
        'prRunsSeen',
        Array.from(this.prRunsSeen.entries()).map(([pr, set]) => [pr, Array.from(set)])
      ),
    ]);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/acquire') {
      try {
        const body = (await request.json()) as { runId: string; headSha: string; prNumber?: number };
        if (!body.runId || !body.headSha) {
          return new Response('Bad Request: Missing runId or headSha', { status: 400 });
        }
        const res = await this.acquireSlot(body.runId, body.headSha, body.prNumber);
        return Response.json(res);
      } catch {
        return new Response('Bad Request: Invalid JSON body', { status: 400 });
      }
    }

    if (request.method === 'POST' && path === '/release') {
      try {
        const body = (await request.json()) as { runId: string };
        if (!body.runId) {
          return new Response('Bad Request: Missing runId', { status: 400 });
        }
        const res = await this.releaseSlot(body.runId);
        return Response.json(res);
      } catch {
        return new Response('Bad Request: Invalid JSON body', { status: 400 });
      }
    }

    if (request.method === 'POST' && path === '/evict') {
      try {
        const body = (await request.json()) as { runId?: string; prNumber?: number; tombstone?: boolean };
        const res = await this.evictQueue(body);
        return Response.json(res);
      } catch {
        return new Response('Bad Request: Invalid JSON body', { status: 400 });
      }
    }

    if (request.method === 'POST' && path === '/clear-eviction') {
      try {
        const body = (await request.json()) as { prNumber: number };
        if (body?.prNumber !== undefined) {
          await this.clearEviction(body.prNumber);
          return Response.json({ cleared: true });
        }
        return new Response('Bad Request: Missing prNumber', { status: 400 });
      } catch {
        return new Response('Bad Request: Invalid JSON body', { status: 400 });
      }
    }

    if (request.method === 'POST' && path === '/register-run') {
      try {
        const body = (await request.json()) as { prNumber: number; runId: string };
        if (body?.prNumber !== undefined && body?.runId) {
          await this.registerRun(body.runId, body.prNumber);
          return Response.json({ registered: true });
        }
        return new Response('Bad Request: Missing prNumber or runId', { status: 400 });
      } catch {
        return new Response('Bad Request: Invalid JSON body', { status: 400 });
      }
    }

    const activeRunMatch = path.match(/^\/active-run\/([^/]+)$/);
    if (request.method === 'GET' && activeRunMatch) {
      const prNumber = parseInt(activeRunMatch[1], 10);
      if (Number.isNaN(prNumber)) {
        return Response.json({ error: 'invalid_pr_number' }, { status: 400 });
      }
      const activeRunId = this.getActiveRun(prNumber);
      const latestRunId = this.latestRunIdByPr.get(prNumber);
      return Response.json({
        activeRunId: activeRunId ?? null,
        latestRunId: latestRunId ?? null,
      });
    }

    if (request.method === 'GET' && path === '/status') {
      const res = await this.getStatus();
      return Response.json(res);
    }

    return new Response('Not Found', { status: 404 });
  }
}

