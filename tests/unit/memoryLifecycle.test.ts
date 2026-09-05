import { describe, it, expect, vi } from "vitest";
import { SQLiteMemoryAdapter } from "../../src/memory/adapters/sqliteAdapter";
import { HonchoMemoryAdapter } from "../../src/memory/adapters/honchoAdapter";
import { CompositeMemoryAdapter } from "../../src/memory/adapters/compositeAdapter";

describe("Memory Lifecycle & Invalidation Suite", () => {
  it("forgets patterns and degrades confidence in SQLiteMemoryAdapter", async () => {
    const adapter = new SQLiteMemoryAdapter({ dbPath: ":memory:" });
    await adapter.initialize();

    await adapter.recordLearning("acme/core-repo", 1, {
      category: "convention",
      title: "Avoid deprecated Enum.chunk",
      description: "Use Enum.chunk_every instead",
      filePath: "lib/core.ex",
    });

    await adapter.recordResolvedNit("acme/core-repo", 1, {
      pattern: "prefer pattern matching in function heads",
      filePath: "lib/core/*.ex",
      reason: "Elixir convention",
    });

    let nits = await adapter.getResolvedNits("acme/core-repo");
    expect(nits).toHaveLength(1);

    // Degrade pattern
    await adapter.degradePatternConfidence("acme/core-repo", "Enum.chunk", 0.5);
    let learnings = await adapter.getLearnings("acme/core-repo");
    expect(learnings[0].confidence).toBe(0.5);

    // Forget pattern
    const deleted = await adapter.forgetPattern("acme/core-repo", "pattern matching");
    expect(deleted).toBe(true);

    nits = await adapter.getResolvedNits("acme/core-repo");
    expect(nits).toHaveLength(0);

    await adapter.close();
  });

  it("forgets patterns and deletes conclusions in HonchoMemoryAdapter", async () => {
    const deletedIds: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/conclusions/query")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "concl_123",
              content: JSON.stringify({
                metadata: {
                  learningId: "lrn_abc",
                  title: "Legacy pattern to remove",
                },
              }),
            },
          ],
        };
      }
      if (init?.method === "DELETE" && url.includes("/conclusions/")) {
        const id = url.split("/").pop();
        if (id) deletedIds.push(id);
        return { ok: true, status: 204 };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const adapter = new HonchoMemoryAdapter({
      apiKey: "test-key",
      fetchImpl: mockFetch as any,
    });

    // Seed local cache
    await adapter.recordResolvedNit("acme/core-repo", 1, {
      pattern: "Legacy pattern to remove",
      filePath: "src/**/*.ts",
      reason: "Old rule",
    });

    expect(await adapter.getResolvedNits("acme/core-repo")).toHaveLength(1);

    // Forget pattern calls remote query + delete
    const forgot = await adapter.forgetPattern("acme/core-repo", "Legacy pattern");
    expect(forgot).toBe(true);
    expect(deletedIds).toContain("concl_123");

    // Local cache purged
    expect(await adapter.getResolvedNits("acme/core-repo")).toHaveLength(0);
  });

  it("forgets and degrades patterns across CompositeMemoryAdapter tiers", async () => {
    const sqlite = new SQLiteMemoryAdapter({ dbPath: ":memory:" });
    await sqlite.initialize();

    await sqlite.recordResolvedNit("acme/core-repo", 1, {
      pattern: "avoid console.log",
      filePath: "**",
      reason: "No debug logs in production",
    });

    const honcho = new HonchoMemoryAdapter({ apiKey: "" }); // offline mode

    const composite = new CompositeMemoryAdapter({
      primary: sqlite,
      secondary: honcho,
    });

    expect(await composite.getResolvedNits("acme/core-repo")).toHaveLength(1);

    const deleted = await composite.forgetPattern("acme/core-repo", "console.log");
    expect(deleted).toBe(true);

    expect(await composite.getResolvedNits("acme/core-repo")).toHaveLength(0);
    await composite.close();
  });
});
