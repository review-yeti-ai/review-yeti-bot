import crypto from "node:crypto";
import { logger } from "../../utils/logger";
import {
  MemoryAdapter,
  ReviewerLearning,
  ResolvedNitPattern,
  ADRConstraint,
  PathInstructionRule,
  LearningQueryOptions,
  HonchoAdapterConfig,
} from "./types";
import { matchesFilePath } from "./sqliteAdapter";

export const DEFAULT_HONCHO_BASE_URL = "http://localhost:8000";
export const DEFAULT_HONCHO_WORKSPACE = "default";
export const DEFAULT_HONCHO_PEER = "review-yeti";
export const DEFAULT_HONCHO_OBSERVED = "developer";

export function sanitizeSessionId(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 500);
  return sanitized || "review-yeti-session";
}

export class HonchoMemoryAdapter implements MemoryAdapter {
  public readonly providerName = "honcho";
  private baseUrl: string;
  private apiKey: string;
  private workspace: string;
  private peer: string;
  private observed: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private inMemoryCache: {
    learnings: Map<string, ReviewerLearning[]>;
    nits: Map<string, ResolvedNitPattern[]>;
    adrs: Map<string, ADRConstraint[]>;
  };

  constructor(config?: HonchoAdapterConfig) {
    this.baseUrl = (config?.baseUrl || process.env.HONCHO_BASE_URL || DEFAULT_HONCHO_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config?.apiKey || process.env.HONCHO_API_KEY || "";
    this.workspace = config?.workspace || process.env.HONCHO_WORKSPACE || DEFAULT_HONCHO_WORKSPACE;
    this.peer = config?.peer || process.env.HONCHO_PEER || DEFAULT_HONCHO_PEER;
    this.observed = config?.observed || process.env.HONCHO_OBSERVED || DEFAULT_HONCHO_OBSERVED;
    this.fetchImpl = config?.fetchImpl || globalThis.fetch;
    this.timeoutMs = config?.timeoutMs || 5000;

    this.inMemoryCache = {
      learnings: new Map(),
      nits: new Map(),
      adrs: new Map(),
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  public getWorkspace(): string {
    return this.workspace;
  }

  public getPeer(): string {
    return this.peer;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  private async fetchHoncho(endpoint: string, options: RequestInit = {}): Promise<any> {
    if (!this.apiKey) {
      throw new Error("HONCHO_API_KEY is required for HonchoMemoryAdapter");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const url = `${this.baseUrl}${endpoint}`;
    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.headers || {}),
        },
      });

      if (!response.ok) {
        throw new Error(`Honcho API request to ${endpoint} failed with HTTP ${response.status}`);
      }

      if (response.status === 204) {
        return null;
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info("HonchoMemoryAdapter running in unauthenticated mode (local fallback enabled)");
      return;
    }

    try {
      await this.ensurePeer(this.peer);
      await this.ensurePeer(this.observed);
      logger.info("HonchoMemoryAdapter initialized successfully", {
        workspace: this.workspace,
        peer: this.peer,
        baseUrl: this.baseUrl,
      });
    } catch (err: any) {
      logger.warn("Failed to initialize Honcho peers; continuing with best-effort", { error: err?.message });
    }
  }

  private async ensurePeer(peerId: string): Promise<void> {
    try {
      await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/peers`, {
        method: "POST",
        body: JSON.stringify({ peer_id: peerId }),
      });
    } catch (err: any) {
      // 409 Conflict or already exists is normal
    }
  }

  private async ensureSession(sessionId: string): Promise<void> {
    try {
      await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/sessions`, {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      });
    } catch (err: any) {
      // 409 Conflict or already exists is normal
    }
  }

  public async recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, "repo" | "prNumber">
  ): Promise<ReviewerLearning> {
    const id = learning.id || `lrn_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const createdAt = learning.createdAt || now;
    const updatedAt = learning.updatedAt || now;
    const title = learning.title || (learning as any).rule || "Learned Rule";
    const description = learning.description || (learning as any).rule || "Learned from PR review feedback";
    const category = learning.category || "convention";

    const record: ReviewerLearning = {
      id,
      repo,
      prNumber,
      category,
      title,
      description,
      filePath: learning.filePath,
      confidence: learning.confidence ?? 1.0,
      createdAt,
      updatedAt,
    };

    // Cache locally
    const existing = this.inMemoryCache.learnings.get(repo) || [];
    existing.unshift(record);
    this.inMemoryCache.learnings.set(repo, existing);

    if (this.isConfigured()) {
      try {
        const sessionId = sanitizeSessionId(`${repo}-pr-${prNumber}`);
        await this.ensureSession(sessionId);

        const statement = `[${category.toUpperCase()}] ${title}: ${description}` +
          (learning.filePath ? ` (scope: ${learning.filePath})` : "");

        const conclusionPayload = {
          id,
          schema: "ct-honcho-conclusion.v1",
          authority: "advisory",
          kind: "decision_context",
          statement,
          writer_peer: this.peer,
          session_id: sessionId,
          confidence: record.confidence,
          observed_at: createdAt,
          repository: repo,
          domain: category,
          evidence_refs: learning.filePath ? [learning.filePath] : [],
          metadata: {
            learningId: id,
            category,
            title,
            description,
            filePath: learning.filePath,
            prNumber,
          },
        };

        await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/conclusions`, {
          method: "POST",
          body: JSON.stringify({
            conclusions: [{
              content: JSON.stringify(conclusionPayload),
              observer_id: this.peer,
              observed_id: this.observed,
              session_id: sessionId,
            }],
          }),
        });

        logger.info("Synchronized learning to Honcho workspace", {
          id,
          workspace: this.workspace,
          repo,
          prNumber,
        });
      } catch (err: any) {
        logger.warn("Failed to synchronize learning to Honcho workspace", { id, error: err?.message });
      }
    }

    return record;
  }

  public async getLearnings(repo: string, options?: LearningQueryOptions): Promise<ReviewerLearning[]> {
    const cached = this.inMemoryCache.learnings.get(repo) || [];

    if (!this.isConfigured()) {
      let results = [...cached];
      if (options?.category) {
        results = results.filter((l) => l.category === options.category);
      }
      if (options?.filePath) {
        results = results.filter((l) => !l.filePath || matchesFilePath(l.filePath, options.filePath!));
      }
      if (options?.limit) {
        results = results.slice(0, options.limit);
      }
      return results;
    }

    try {
      const queryTopic = [
        "code-review convention learning",
        repo,
        options?.category,
        options?.filePath,
      ].filter(Boolean).join(" ");

      const response = await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/conclusions/query`, {
        method: "POST",
        body: JSON.stringify({
          query: queryTopic,
          top_k: options?.limit || 20,
          distance: 0.5,
          filters: {
            observer_id: this.peer,
            observed_id: this.observed,
          },
        }),
      });

      const items: any[] = response?.items ?? response?.results ?? [];
      const remoteLearnings: ReviewerLearning[] = [];

      for (const item of items) {
        try {
          const parsed = typeof item.content === "string" ? JSON.parse(item.content) : item.content;
          if (parsed?.metadata?.learningId) {
            const m = parsed.metadata;
            remoteLearnings.push({
              id: m.learningId,
              repo,
              prNumber: m.prNumber || 0,
              category: m.category || "convention",
              title: m.title || parsed.statement,
              description: m.description || parsed.statement,
              filePath: m.filePath,
              confidence: parsed.confidence ?? 1.0,
              createdAt: parsed.observed_at || new Date().toISOString(),
              updatedAt: parsed.observed_at || new Date().toISOString(),
            });
          }
        } catch {
          // Non-JSON conclusion format
        }
      }

      // Merge remote and cached
      const mergedMap = new Map<string, ReviewerLearning>();
      for (const item of remoteLearnings) {
        mergedMap.set(item.id || item.title, item);
      }
      for (const item of cached) {
        mergedMap.set(item.id || item.title, item);
      }

      let results = Array.from(mergedMap.values());
      if (options?.category) {
        results = results.filter((l) => l.category === options.category);
      }
      if (options?.filePath) {
        results = results.filter((l) => !l.filePath || matchesFilePath(l.filePath, options.filePath!));
      }
      if (options?.limit) {
        results = results.slice(0, options.limit);
      }

      return results;
    } catch (err: any) {
      logger.warn("Failed querying learnings from Honcho; returning local cache", { error: err?.message });
      return cached;
    }
  }

  public async recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, "repo" | "prNumber">
  ): Promise<ResolvedNitPattern> {
    const id = nit.id || `nit_${crypto.randomUUID().slice(0, 8)}`;
    const resolvedAt = nit.resolvedAt || new Date().toISOString();
    const pattern = nit.pattern.trim();
    const filePath = nit.filePath || "**";
    const reason = nit.reason || "Marked as resolved by developer";
    const suppressionCount = nit.suppressionCount ?? 0;
    const ruleId = nit.ruleId;

    const record: ResolvedNitPattern = {
      id,
      ruleId,
      repo,
      prNumber,
      pattern,
      filePath,
      reason,
      headSha: nit.headSha,
      resolvedAt,
      suppressionCount,
    };

    const existing = this.inMemoryCache.nits.get(repo) || [];
    existing.unshift(record);
    this.inMemoryCache.nits.set(repo, existing);

    if (this.isConfigured()) {
      try {
        const sessionId = sanitizeSessionId(`${repo}-pr-${prNumber}`);
        await this.ensureSession(sessionId);

        const statement = `Dismissed nit on ${filePath}: "${pattern}" - Reason: ${reason}`;
        const conclusionPayload = {
          id,
          schema: "ct-honcho-conclusion.v1",
          authority: "advisory",
          kind: "correction",
          statement,
          writer_peer: this.peer,
          session_id: sessionId,
          confidence: 1.0,
          observed_at: resolvedAt,
          repository: repo,
          domain: "nit-suppression",
          evidence_refs: [filePath],
          metadata: {
            nitId: id,
            ruleId,
            pattern,
            filePath,
            reason,
            prNumber,
            headSha: nit.headSha,
          },
        };

        await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/conclusions`, {
          method: "POST",
          body: JSON.stringify({
            conclusions: [{
              content: JSON.stringify(conclusionPayload),
              observer_id: this.peer,
              observed_id: this.observed,
              session_id: sessionId,
            }],
          }),
        });

        logger.info("Synchronized resolved nit to Honcho workspace", {
          id,
          workspace: this.workspace,
          pattern,
          filePath,
        });
      } catch (err: any) {
        logger.warn("Failed to synchronize resolved nit to Honcho workspace", { id, error: err?.message });
      }
    }

    return record;
  }

  public async getResolvedNits(repo: string, filePath?: string): Promise<ResolvedNitPattern[]> {
    const cached = this.inMemoryCache.nits.get(repo) || [];

    if (!this.isConfigured()) {
      if (filePath) {
        return cached.filter((n) => matchesFilePath(n.filePath, filePath));
      }
      return cached;
    }

    try {
      const response = await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/conclusions/query`, {
        method: "POST",
        body: JSON.stringify({
          query: `Dismissed nit suppression ${repo} ${filePath || ""}`,
          top_k: 50,
          distance: 0.5,
          filters: {
            observer_id: this.peer,
            observed_id: this.observed,
          },
        }),
      });

      const items: any[] = response?.items ?? response?.results ?? [];
      const remoteNits: ResolvedNitPattern[] = [];

      for (const item of items) {
        try {
          const parsed = typeof item.content === "string" ? JSON.parse(item.content) : item.content;
          if (parsed?.metadata?.nitId) {
            const m = parsed.metadata;
            remoteNits.push({
              id: m.nitId,
              ruleId: m.ruleId,
              repo,
              prNumber: m.prNumber || 0,
              pattern: m.pattern,
              filePath: m.filePath,
              reason: m.reason,
              headSha: m.headSha,
              resolvedAt: parsed.observed_at || new Date().toISOString(),
              suppressionCount: 0,
            });
          }
        } catch {
          // Non-JSON conclusion format
        }
      }

      const mergedMap = new Map<string, ResolvedNitPattern>();
      for (const item of remoteNits) {
        mergedMap.set(item.id || item.pattern, item);
      }
      for (const item of cached) {
        mergedMap.set(item.id || item.pattern, item);
      }

      let results = Array.from(mergedMap.values());
      if (filePath) {
        results = results.filter((n) => matchesFilePath(n.filePath, filePath));
      }

      return results;
    } catch (err: any) {
      logger.warn("Failed querying resolved nits from Honcho; returning local cache", { error: err?.message });
      if (filePath) {
        return cached.filter((n) => matchesFilePath(n.filePath, filePath));
      }
      return cached;
    }
  }

  public async incrementNitSuppression(id: string): Promise<void> {
    for (const nits of this.inMemoryCache.nits.values()) {
      const match = nits.find((n) => n.id === id);
      if (match) {
        match.suppressionCount = (match.suppressionCount ?? 0) + 1;
        break;
      }
    }
  }

  public async recordAdrConstraint(
    repo: string,
    constraint: Omit<ADRConstraint, "repo">
  ): Promise<ADRConstraint> {
    const id = constraint.id || `adr_${constraint.adrNumber}_${crypto.randomUUID().slice(0, 4)}`;
    const createdAt = constraint.createdAt || new Date().toISOString();
    const record: ADRConstraint = { id, repo, ...constraint, createdAt };

    const existing = this.inMemoryCache.adrs.get(repo) || [];
    existing.unshift(record);
    this.inMemoryCache.adrs.set(repo, existing);

    if (this.isConfigured()) {
      try {
        const sessionId = sanitizeSessionId(`${repo}-adr`);
        await this.ensureSession(sessionId);

        const statement = `[ADR ${constraint.adrNumber}: ${constraint.title}] Status: ${constraint.status} - Rule: ${constraint.rule}`;
        const conclusionPayload = {
          id,
          schema: "ct-honcho-conclusion.v1",
          authority: "advisory",
          kind: "decision_context",
          statement,
          writer_peer: this.peer,
          session_id: sessionId,
          confidence: 1.0,
          observed_at: createdAt,
          repository: repo,
          domain: "architecture",
          evidence_refs: constraint.targetPaths || [],
          metadata: {
            adrId: id,
            adrNumber: constraint.adrNumber,
            title: constraint.title,
            status: constraint.status,
            rule: constraint.rule,
            targetPaths: constraint.targetPaths,
          },
        };

        await this.fetchHoncho(`/v3/workspaces/${encodeURIComponent(this.workspace)}/conclusions`, {
          method: "POST",
          body: JSON.stringify({
            conclusions: [{
              content: JSON.stringify(conclusionPayload),
              observer_id: this.peer,
              observed_id: this.observed,
              session_id: sessionId,
            }],
          }),
        });

        logger.info("Synchronized ADR constraint to Honcho workspace", {
          id,
          workspace: this.workspace,
          adrNumber: constraint.adrNumber,
        });
      } catch (err: any) {
        logger.warn("Failed to synchronize ADR constraint to Honcho workspace", { id, error: err?.message });
      }
    }

    return record;
  }

  public async getAdrConstraints(
    repo: string,
    status?: "draft" | "accepted" | "deprecated"
  ): Promise<ADRConstraint[]> {
    const cached = this.inMemoryCache.adrs.get(repo) || [];
    if (status) {
      return cached.filter((a) => a.status === status);
    }
    return cached;
  }

  public async clear(repo?: string): Promise<void> {
    if (repo) {
      this.inMemoryCache.learnings.delete(repo);
      this.inMemoryCache.nits.delete(repo);
      this.inMemoryCache.adrs.delete(repo);
    } else {
      this.inMemoryCache.learnings.clear();
      this.inMemoryCache.nits.clear();
      this.inMemoryCache.adrs.clear();
    }
  }
}
