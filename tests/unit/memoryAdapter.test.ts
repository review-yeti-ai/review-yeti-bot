import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMemoryAdapter,
  resolveMemoryProvider,
  SQLiteMemoryAdapter,
  HonchoMemoryAdapter,
  CompositeMemoryAdapter,
} from "../../src/memory/adapters";
import { PRMemoryStore } from "../../src/memory/prMemoryStore";

describe("Memory Adapter Pattern Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MEMORY_PROVIDER;
    delete process.env.CT_MEMORY_PROVIDER;
    delete process.env.HONCHO_API_KEY;
    delete process.env.HONCHO_BASE_URL;
    delete process.env.HONCHO_WORKSPACE;
    delete process.env.HONCHO_PEER;
    delete process.env.HONCHO_OBSERVED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("1. Adapter Resolution & Factory", () => {
    it("defaults to sqlite provider when no env or config is set", () => {
      expect(resolveMemoryProvider()).toBe("sqlite");
      const adapter = createMemoryAdapter();
      expect(adapter.providerName).toBe("sqlite");
      expect(adapter).toBeInstanceOf(SQLiteMemoryAdapter);
    });

    it("resolves honcho provider when explicitly requested", () => {
      expect(resolveMemoryProvider({ provider: "honcho" })).toBe("honcho");
      const adapter = createMemoryAdapter({ provider: "honcho" });
      expect(adapter.providerName).toBe("honcho");
      expect(adapter).toBeInstanceOf(HonchoMemoryAdapter);
    });

    it("resolves composite provider when explicitly requested", () => {
      expect(resolveMemoryProvider({ provider: "composite" })).toBe("composite");
      const adapter = createMemoryAdapter({ provider: "composite" });
      expect(adapter.providerName).toBe("composite");
      expect(adapter).toBeInstanceOf(CompositeMemoryAdapter);
    });

    it("auto-detects composite mode when HONCHO_API_KEY is present", () => {
      process.env.HONCHO_API_KEY = "test-honcho-key";
      expect(resolveMemoryProvider()).toBe("composite");
      const adapter = createMemoryAdapter();
      expect(adapter.providerName).toBe("composite");
    });
  });

  describe("2. SQLiteMemoryAdapter Functional Tests", () => {
    let sqlite: SQLiteMemoryAdapter;

    beforeEach(async () => {
      sqlite = new SQLiteMemoryAdapter({ dbPath: ":memory:" });
      await sqlite.initialize();
    });

    afterEach(async () => {
      await sqlite.close?.();
    });

    it("records and retrieves learnings", async () => {
      const recorded = await sqlite.recordLearning("test-org/test-repo", 42, {
        category: "architecture",
        title: "Database Isolation",
        description: "Always scope tenant IDs in repository queries",
        filePath: "src/db/tenant.ts",
      });

      expect(recorded.id).toBeDefined();
      expect(recorded.title).toBe("Database Isolation");

      const learnings = await sqlite.getLearnings("test-org/test-repo");
      expect(learnings).toHaveLength(1);
      expect(learnings[0].title).toBe("Database Isolation");
      expect(learnings[0].category).toBe("architecture");
    });

    it("records and retrieves resolved nits with glob matching", async () => {
      await sqlite.recordResolvedNit("test-org/test-repo", 42, {
        pattern: "trailing whitespace",
        filePath: "src/**/*.ts",
        reason: "Formatted by prettier",
      });

      const matchedNits = await sqlite.getResolvedNits("test-org/test-repo", "src/auth/login.ts");
      expect(matchedNits).toHaveLength(1);
      expect(matchedNits[0].pattern).toBe("trailing whitespace");

      const unmatchedNits = await sqlite.getResolvedNits("test-org/test-repo", "docs/index.md");
      expect(unmatchedNits).toHaveLength(0);
    });

    it("records and retrieves ADR constraints", async () => {
      await sqlite.recordAdrConstraint("test-org/test-repo", {
        adrNumber: 1,
        title: "Use Node Native SQLite",
        status: "accepted",
        rule: "Do not add external SQLite bindings",
        targetPaths: ["src/memory/**"],
      });

      const adrs = await sqlite.getAdrConstraints("test-org/test-repo", "accepted");
      expect(adrs).toHaveLength(1);
      expect(adrs[0].title).toBe("Use Node Native SQLite");
    });
  });

  describe("3. CompositeMemoryAdapter Synchronization", () => {
    it("dual-writes to both primary and secondary adapters", async () => {
      const primary = new SQLiteMemoryAdapter({ dbPath: ":memory:" });
      const secondary = new HonchoMemoryAdapter({
        apiKey: "mock-key",
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as any,
      });

      const composite = new CompositeMemoryAdapter({
        primary,
        secondary,
        writeAsync: false,
      });
      await composite.initialize();

      const nit = await composite.recordResolvedNit("org/repo", 10, {
        pattern: "semi: never",
        filePath: "src/index.ts",
        reason: "Prettier rules",
      });

      expect(nit.pattern).toBe("semi: never");

      const primaryNits = await primary.getResolvedNits("org/repo", "src/index.ts");
      expect(primaryNits).toHaveLength(1);

      const secondaryNits = await secondary.getResolvedNits("org/repo", "src/index.ts");
      expect(secondaryNits).toHaveLength(1);
    });
  });

  describe("4. PRMemoryStore Adapter Integration", () => {
    it("delegates to memory adapter while maintaining PRMemoryStore interface", async () => {
      const customAdapter = new SQLiteMemoryAdapter({ dbPath: ":memory:" });
      const store = new PRMemoryStore(customAdapter);

      expect(store.getAdapter()).toBe(customAdapter);

      const learning = await store.recordLearning("org/repo", 1, {
        title: "Test Learning",
        description: "Test description",
        category: "style",
      });

      expect(learning.title).toBe("Test Learning");
      const learnings = await store.getLearnings("org/repo");
      expect(learnings).toHaveLength(1);
    });
  });
});
