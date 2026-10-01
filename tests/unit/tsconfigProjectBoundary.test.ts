import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function projectFiles(configPath: string): Set<string> {
  const config = ts.readConfigFile(path.join(root, configPath), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(path.join(root, configPath)));
  expect(parsed.errors).toEqual([]);
  return new Set(parsed.fileNames.map(file => path.relative(root, file).split(path.sep).join('/')));
}

describe('TypeScript project boundaries', () => {
  it('keeps the separately configured Cloudflare sources and tests out of the application program', () => {
    const files = projectFiles('tsconfig.json');
    expect([...files].filter(file => file.startsWith('cf-orchestrator/'))).toEqual([]);
    expect(files.has('src/github/appAuth.ts')).toBe(true);
    expect(files.has('tests/unit/appAuthModuleBoundary.test.ts')).toBe(true);
    expect(files.has('tests/unit/tsconfigProjectBoundary.test.ts')).toBe(true);
  });

  it('retains Cloudflare sources and tests in their own compiler program', () => {
    const files = projectFiles('cf-orchestrator/tsconfig.json');
    expect(files.has('cf-orchestrator/src/worker.ts')).toBe(true);
    expect(files.has('cf-orchestrator/test/worker.test.ts')).toBe(true);
    expect([...files].every(file => file.startsWith('cf-orchestrator/'))).toBe(true);
    expect(files.has('src/github/appAuth.ts')).toBe(false);
  });

  it('retains the server sources without importing Cloudflare runtime globals', () => {
    const files = projectFiles('tsconfig.server.json');
    expect(files.has('src/github/appAuth.ts')).toBe(true);
    expect([...files].filter(file => file.startsWith('cf-orchestrator/'))).toEqual([]);
  });
});
