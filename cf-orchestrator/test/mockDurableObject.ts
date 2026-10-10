import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';

export class MockDurableObjectStorage {
  private store: Map<string, any> = new Map();
  private transactionTail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async list(): Promise<Map<string, any>> {
    return new Map(this.store);
  }

  async transaction<T>(callback: (transaction: MockDurableObjectStorage) => Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
}

export class MockDurableObjectState {
  public storage = new MockDurableObjectStorage();

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export function createMockEnv(): any {
  const repoStore = new Map<string, RepoGateDO>();
  const runStore = new Map<string, ReviewRunDO>();

  return {
    REPO_GATE: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!repoStore.has(id)) {
          repoStore.set(id, new RepoGateDO(new MockDurableObjectState() as any, createMockEnv()));
        }
        const instance = repoStore.get(id)!;
        return {
          fetch: async (url: string, init?: any) => {
            const req = new Request(url, init);
            return instance.fetch(req);
          },
        };
      },
    },
    REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!runStore.has(id)) {
          runStore.set(id, new ReviewRunDO(new MockDurableObjectState() as any, createMockEnv()));
        }
        const instance = runStore.get(id)!;
        return {
          fetch: async (url: string, init?: any) => {
            const req = new Request(url, init);
            return instance.fetch(req);
          },
        };
      },
    },
    PARALLEL_CHECK_NAME: 'Review Yeti (Cloudflare Canary)',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
    OPERATOR_GLOBAL_PASSTHROUGH: 'false',
  };
}
