import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import fs from 'node:fs';
import path from 'node:path';

describe('SymbolGraphStore', () => {
  let store: SymbolGraphStore;
  let testRepoDir: string;

  beforeEach(() => {
    store = new SymbolGraphStore(':memory:');

    testRepoDir = path.join(process.cwd(), '.tmp_test_repo_' + Math.random().toString(36).substring(7));
    fs.mkdirSync(testRepoDir, { recursive: true });

    // Populate synthetic files
    fs.writeFileSync(
      path.join(testRepoDir, 'userStore.ts'),
      `
      export class UserStore {
        private users: Map<string, string> = new Map();

        public saveUser(id: string, name: string): void {
          this.users.set(id, name);
        }

        public getUser(id: string): string | undefined {
          return this.users.get(id);
        }
      }
      `,
      'utf8'
    );

    fs.writeFileSync(
      path.join(testRepoDir, 'userService.ts'),
      `
      import { UserStore } from './userStore';

      export class UserService {
        private store: UserStore;

        constructor() {
          this.store = new UserStore();
        }

        public registerUser(id: string, name: string): void {
          this.store.saveUser(id, name);
        }
      }
      `,
      'utf8'
    );
  });

  afterEach(async () => {
    await store.close();
    if (fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  it('indexes repository and extracts symbols and references into SQLite', async () => {
    const stats = await store.indexRepository(testRepoDir);

    expect(stats.filesIndexed).toBe(2);
    expect(stats.symbolsExtracted).toBeGreaterThan(0);
    expect(stats.totalLines).toBeGreaterThan(0);
  });

  it('queries exact symbol definitions, callers, callees, and references', async () => {
    await store.indexRepository(testRepoDir);

    const queryResult = await store.querySymbols('UserStore');
    expect(queryResult.definitions.length).toBe(1);
    expect(queryResult.definitions[0].name).toBe('UserStore');
    expect(queryResult.definitions[0].kind).toBe('class');

    // References check
    expect(queryResult.references.length).toBeGreaterThan(0);

    // Callers check on saveUser
    const saveUserResult = await store.querySymbols('saveUser');
    expect(saveUserResult.references.length).toBeGreaterThan(0);
  });

  it('prunes deleted files and their associated symbols/references during incremental indexing', async () => {
    await store.indexRepository(testRepoDir);

    const initialResult = await store.querySymbols('UserService');
    expect(initialResult.definitions.length).toBe(1);

    // Delete userService.ts from disk
    fs.unlinkSync(path.join(testRepoDir, 'userService.ts'));

    // Re-index repository
    await store.indexRepository(testRepoDir);

    const prunedResult = await store.querySymbols('UserService');
    expect(prunedResult.definitions.length).toBe(0);
    expect(prunedResult.references.length).toBe(0);
  });

  it('performs dense vector semantic search across code snippets', async () => {
    await store.indexRepository(testRepoDir);

    const searchResults = await store.semanticSearch('user registration save user', 5);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].score).toBeGreaterThan(0);
    expect(searchResults[0].content).toContain('User');
  });
});
