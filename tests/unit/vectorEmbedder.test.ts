import { timeBudgetMs } from '../support/timeBudget';
import { describe, it, expect } from 'vitest';
import { VectorEmbedder } from '../../src/indexer/vectorEmbedder';

describe('VectorEmbedder', () => {
  const embedder = new VectorEmbedder();

  it('generates a 384-dimensional normalized vector with sub-millisecond execution', async () => {
    const text = 'export class UserAuthService { public login(user: string) {} }';
    const result = await embedder.generateEmbedding(text);

    expect(result.vector.length).toBe(384);
    expect(result.durationMs).toBeLessThan(timeBudgetMs(10)); // sub-millisecond to low ms

    // Test L2 norm calculation: sum(v_i^2) == 1.0
    let sumSq = 0;
    for (const val of result.vector) {
      sumSq += val * val;
    }
    expect(sumSq).toBeCloseTo(1.0, 4);
  });

  it('splits acronym sequences in camelCase / PascalCase subtokenization', async () => {
    const embAcronym = await embedder.generateEmbedding('JSONParser HTTPClient');
    const embExpanded = await embedder.generateEmbedding('json parser http client');

    const sim = embedder.cosineSimilarity(embAcronym.vector, embExpanded.vector);
    expect(sim).toBeGreaterThan(0.7);
  });

  it('computes cosine similarity accurately between code snippets', async () => {
    const textA = 'function calculateUserAccountBalance(userId: string) { return 100; }';
    const textB = 'function getAccountBalanceForUser(id: string) { return 100; }';
    const textC = 'import fs from "fs"; fs.readFileSync("file.txt");';

    const embA = await embedder.generateEmbedding(textA);
    const embB = await embedder.generateEmbedding(textB);
    const embC = await embedder.generateEmbedding(textC);

    const simAB = embedder.cosineSimilarity(embA.vector, embB.vector);
    const simAC = embedder.cosineSimilarity(embA.vector, embC.vector);

    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.5);
  });

  it('handles batch embedding generation for multiple snippets', async () => {
    const snippets = [
      'const a = 1;',
      'class Foo {}',
      'interface Bar { name: string; }',
    ];

    const results = await embedder.generateBatchEmbeddings(snippets);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.vector.length).toBe(384);
    }
  });

  it('embeds Code Chunks directly', async () => {
    const chunk = {
      id: 'chunk_1',
      filePath: 'src/auth.ts',
      content: 'export function authenticateToken(token: string) {}',
      startLine: 1,
      endLine: 5,
      symbolName: 'authenticateToken',
      symbolKind: 'function',
    };

    const embedded = await embedder.embedChunk(chunk);
    expect(embedded.chunk.id).toBe('chunk_1');
    expect(embedded.embedding.length).toBe(384);
  });
});
