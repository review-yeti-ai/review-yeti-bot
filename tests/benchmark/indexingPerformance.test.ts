import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

describe('Milestone 7: Indexer Performance Benchmark (< 5s for 10k+ LOC)', () => {
  let store: SymbolGraphStore;
  let syntheticRepoPath: string;
  let totalGeneratedLines = 0;

  beforeAll(() => {
    store = new SymbolGraphStore(':memory:');

    syntheticRepoPath = path.join(
      process.cwd(),
      '.tmp_benchmark_repo_' + Math.random().toString(36).substring(7)
    );
    fs.mkdirSync(syntheticRepoPath, { recursive: true });

    // Generate 50 synthetic TypeScript files, each ~220 lines = ~11,000 LOC total
    const numFiles = 50;
    const linesPerFile = 220;

    for (let fileIdx = 0; fileIdx < numFiles; fileIdx++) {
      const fileName = `module_${fileIdx}.ts`;
      const filePath = path.join(syntheticRepoPath, fileName);

      const codeLines: string[] = [
        `import { logger } from '../utils/logger';`,
        `import fs from 'node:fs';`,
        ``,
        `/**`,
        ` * Synthetic Module ${fileIdx} for Benchmark Testing`,
        ` */`,
        `export class BenchmarkService_${fileIdx} {`,
        `  private id: string = "service_${fileIdx}";`,
        ``,
      ];

      // Add methods to reach ~220 LOC per file
      const numMethods = 15;
      for (let m = 0; m < numMethods; m++) {
        codeLines.push(`  /**`);
        codeLines.push(`   * Executes synthetic benchmark operation ${m}`);
        codeLines.push(`   */`);
        codeLines.push(`  public async performOperation_${m}(inputData: string): Promise<string> {`);
        codeLines.push(`    const step1 = "processed_" + inputData + "_${m}";`);
        codeLines.push(`    const step2 = step1.toUpperCase();`);
        codeLines.push(`    logger.info("Executing step", step2);`);
        codeLines.push(`    if (step2.length > 100) {`);
        codeLines.push(`      return step2.slice(0, 100);`);
        codeLines.push(`    }`);
        codeLines.push(`    return step2;`);
        codeLines.push(`  }`);
        codeLines.push(``);
      }

      codeLines.push(`}`);
      codeLines.push(``);
      codeLines.push(`export interface IBenchmarkInterface_${fileIdx} {`);
      codeLines.push(`  performOperation_0(input: string): Promise<string>;`);
      codeLines.push(`}`);
      codeLines.push(``);

      const content = codeLines.join('\n');
      fs.writeFileSync(filePath, content, 'utf8');

      totalGeneratedLines += codeLines.length;
    }
  });

  afterAll(async () => {
    await store.close();
    if (fs.existsSync(syntheticRepoPath)) {
      fs.rmSync(syntheticRepoPath, { recursive: true, force: true });
    }
  });

  it('verifies 10,000+ LOC is indexed, parsed, and embedded in under 5.0 seconds', async () => {
    expect(totalGeneratedLines).toBeGreaterThanOrEqual(10000);

    const startTime = performance.now();

    const stats = await store.indexRepository(syntheticRepoPath);

    const durationMs = performance.now() - startTime;

    console.log(`[Benchmark] Indexed ${stats.totalLines} LOC (${stats.filesIndexed} files, ${stats.symbolsExtracted} symbols) in ${durationMs.toFixed(2)} ms`);

    expect(stats.totalLines).toBeGreaterThanOrEqual(10000);
    expect(stats.filesIndexed).toBe(50);
    expect(stats.symbolsExtracted).toBeGreaterThan(500);

    // SLA Assertion: Total execution must be under 5,000 ms (5 seconds)
    expect(durationMs).toBeLessThan(5000);
  });

  it('queries exact symbol definitions within < 50ms', async () => {
    await store.indexRepository(syntheticRepoPath);

    const startTime = performance.now();
    const result = await store.querySymbols('BenchmarkService_10');
    const queryDurationMs = performance.now() - startTime;

    expect(queryDurationMs).toBeLessThan(50);
    expect(result.definitions.length).toBeGreaterThan(0);
    expect(result.definitions[0].name).toBe('BenchmarkService_10');
  });

  it('performs vector semantic search within < 100ms', async () => {
    await store.indexRepository(syntheticRepoPath);

    const startTime = performance.now();
    const searchResults = await store.semanticSearch('execute synthetic benchmark operation', 5);
    const searchDurationMs = performance.now() - startTime;

    expect(searchDurationMs).toBeLessThan(100);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].score).toBeGreaterThan(0);
  });
});
