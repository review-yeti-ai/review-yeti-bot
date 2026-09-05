import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HonchoMemoryAdapter,
  sanitizeSessionId,
  DEFAULT_HONCHO_BASE_URL,
  DEFAULT_HONCHO_WORKSPACE,
  DEFAULT_HONCHO_PEER,
} from "../../src/memory/adapters/honchoAdapter";

describe("HonchoMemoryAdapter Unit Tests", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HONCHO_API_KEY;
    delete process.env.HONCHO_BASE_URL;
    delete process.env.HONCHO_WORKSPACE;
    delete process.env.HONCHO_PEER;
    delete process.env.HONCHO_OBSERVED;
    mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/peers") || url.includes("/sessions")) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.includes("/conclusions/query")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: "c_1",
                content: JSON.stringify({
                  statement: "Test conclusion",
                  confidence: 1.0,
                  observed_at: "2026-09-05T00:00:00Z",
                  metadata: {
                    nitId: "nit_123",
                    pattern: "use const instead of let",
                    filePath: "src/**/*.ts",
                    reason: "Immutability principle",
                    prNumber: 42,
                  },
                }),
              },
            ],
          }),
        };
      }
      if (url.includes("/conclusions")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            schema: "honcho-write-receipt.v1",
            memory_id: "mem_abc123",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("initializes with default workspace, peer, and base URL", () => {
    const adapter = new HonchoMemoryAdapter();
    expect(adapter.getBaseUrl()).toBe(DEFAULT_HONCHO_BASE_URL);
    expect(adapter.getWorkspace()).toBe(DEFAULT_HONCHO_WORKSPACE);
    expect(adapter.getPeer()).toBe(DEFAULT_HONCHO_PEER);
    expect(adapter.isConfigured()).toBe(false);
  });

  it("sanitizes session IDs cleanly for Honcho pattern requirements", () => {
    expect(sanitizeSessionId("owner/repo#42")).toBe("owner-repo-42");
    expect(sanitizeSessionId("acme:service-repo:pr:123")).toBe("acme-service-repo-pr-123");
    expect(sanitizeSessionId("")).toBe("review-yeti-session");
  });

  it("ensures peers during initialization when apiKey is provided", async () => {
    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-honcho-key",
      fetchImpl: mockFetch as any,
    });
    expect(adapter.isConfigured()).toBe(true);

    await adapter.initialize();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/workspaces/${adapter.getWorkspace()}/peers`),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("formats and writes learnings as typed conclusions", async () => {
    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-honcho-key",
      fetchImpl: mockFetch as any,
    });

    const learning = await adapter.recordLearning("acme/core-repo", 101, {
      category: "security",
      title: "SQL Injection Guard",
      description: "Use Ecto query parameterized bindings",
      filePath: "lib/core/repo.ex",
    });

    expect(learning.title).toBe("SQL Injection Guard");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/workspaces/${adapter.getWorkspace()}/conclusions`),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("SQL Injection Guard"),
      })
    );
  });

  it("formats and writes resolved nits to Honcho session", async () => {
    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-honcho-key",
      fetchImpl: mockFetch as any,
    });

    const nit = await adapter.recordResolvedNit("acme/core-repo", 101, {
      pattern: "prefer pattern matching in function head",
      filePath: "lib/core/*.ex",
      reason: "Elixir convention",
    });

    expect(nit.pattern).toBe("prefer pattern matching in function head");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v3/workspaces/${adapter.getWorkspace()}/conclusions`),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("prefer pattern matching in function head"),
      })
    );
  });

  it("queries and deserializes resolved nits from Honcho query endpoint", async () => {
    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-honcho-key",
      fetchImpl: mockFetch as any,
    });

    const nits = await adapter.getResolvedNits("acme/core-repo", "src/file.ts");
    expect(nits).toHaveLength(1);
    expect(nits[0].pattern).toBe("use const instead of let");
    expect(nits[0].reason).toBe("Immutability principle");
  });

  it("falls back to local in-memory cache gracefully if Honcho fetch fails", async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error("Network connection refused"));
    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-honcho-key",
      fetchImpl: failingFetch as any,
    });

    // Record locally; network write fails gracefully
    const recorded = await adapter.recordResolvedNit("acme/service-repo", 5, {
      pattern: "prefer Enum.map",
      filePath: "lib/**/*.ex",
      reason: "Performance",
    });

    expect(recorded.pattern).toBe("prefer Enum.map");

    // Query falls back to local in-memory cache
    const nits = await adapter.getResolvedNits("acme/service-repo", "lib/service.ex");
    expect(nits).toHaveLength(1);
    expect(nits[0].pattern).toBe("prefer Enum.map");
  });
});
