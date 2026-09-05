import { describe, it, expect, vi } from "vitest";
import {
  HonchoMemoryAdapter,
  inferDomainFromPath,
  DEFAULT_HONCHO_RECALL_DISTANCE,
} from "../../src/memory/adapters/honchoAdapter";

describe("Cross-Peer Memory Recall & Domain Scoping Suite", () => {
  it("infers domain accurately from file extensions", () => {
    expect(inferDomainFromPath("lib/cdrcisco/repo.ex")).toBe("elixir");
    expect(inferDomainFromPath("lib/cdrcisco/endpoint.exs")).toBe("elixir");
    expect(inferDomainFromPath("src/components/App.tsx")).toBe("typescript");
    expect(inferDomainFromPath("src/services/api.ts")).toBe("typescript");
    expect(inferDomainFromPath("scripts/utils.js")).toBe("javascript");
    expect(inferDomainFromPath("services/agent.py")).toBe("python");
    expect(inferDomainFromPath("terraform/main.tf")).toBe("terraform");
    expect(inferDomainFromPath(".github/workflows/ci.yml")).toBe("infra");
    expect(inferDomainFromPath("Dockerfile")).toBe("infra");
    expect(inferDomainFromPath("README.md")).toBe("general");
    expect(inferDomainFromPath(undefined)).toBe("general");
  });

  it("defaults recall distance to 0.35 for high-precision code review", () => {
    const adapter = new HonchoMemoryAdapter({ apiKey: "test-key" });
    expect(adapter.getRecallDistance()).toBe(DEFAULT_HONCHO_RECALL_DISTANCE);
    expect(adapter.getRecallDistance()).toBe(0.35);

    const customAdapter = new HonchoMemoryAdapter({
      apiKey: "test-key",
      recallDistance: 0.25,
    });
    expect(customAdapter.getRecallDistance()).toBe(0.25);
  });

  it("configures and queries across multiple recall peers", async () => {
    const queriedPeers: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/peers") || url.includes("/sessions")) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.includes("/conclusions/query")) {
        const body = JSON.parse(init?.body as string || "{}");
        const observer = body.filters?.observer_id;
        queriedPeers.push(observer);

        if (observer === "review-yeti") {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: "c_ry_1",
                observer_id: "review-yeti",
                content: JSON.stringify({
                  metadata: {
                    learningId: "lrn_ry_1",
                    category: "convention",
                    title: "Use Ecto parameterized queries",
                    description: "Guard against SQL injection",
                    filePath: "lib/cdrcisco/repo.ex",
                    domain: "elixir",
                  },
                }),
              },
            ],
          };
        }

        if (observer === "codex") {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: "c_codex_1",
                observer_id: "codex",
                content: JSON.stringify({
                  statement: "PostgreSQL upgrade: --skip-logs omits 29 debug log tables",
                  domain: "architecture",
                  confidence: 0.98,
                }),
              },
            ],
          };
        }

        return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-key",
      recallPeers: ["review-yeti", "codex"],
      fetchImpl: mockFetch as any,
    });

    expect(adapter.getRecallPeers()).toEqual(["review-yeti", "codex"]);

    await adapter.initialize();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/peers"),
      expect.objectContaining({
        body: JSON.stringify({ id: "review-yeti" }),
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/peers"),
      expect.objectContaining({
        body: JSON.stringify({ id: "codex" }),
      })
    );

    const learnings = await adapter.getLearnings("acme/core-repo", {
      filePath: "lib/cdrcisco/repo.ex",
    });

    expect(queriedPeers).toContain("review-yeti");
    expect(queriedPeers).toContain("codex");

    expect(learnings).toHaveLength(2);
    const titles = learnings.map((l) => l.title);
    expect(titles).toContain("Use Ecto parameterized queries");
    expect(titles.some((t) => t.includes("Cross-Peer codex"))).toBe(true);
  });
});
