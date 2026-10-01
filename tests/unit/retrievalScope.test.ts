import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReadOnlyTool } from '../../src/panel/toolRuntime';
import { REPO_READ_FILE_MAX_CHARS } from '../../src/panel/toolLimits';

afterEach(() => vi.restoreAllMocks());

describe('trusted retrieval scope envelopes', () => {
  it.each([
    ['filtered index', { status: 'ok', exhaustive: false, truncated: false }, false],
    ['verified complete index', { status: 'ok', exhaustive: true, truncated: false }, true],
    ['capped query', { status: 'ok', exhaustive: true, truncated: true }, false],
    ['missing provenance', { status: 'ok' }, false],
  ])('preserves %s at the engine boundary', async (_name, response, expected) => {
    const module = require('../../src/mcp/zoektSearchTool');
    const search = vi.spyOn(module, 'executeZoektSearch').mockResolvedValue(response);
    const signal = new AbortController().signal, session = {};
    const result = await runReadOnlyTool('code_search_zoekt', { query: 'consumer' }, {
      changedFiles: [], zoektConfig: { searchSession: session }, signal,
    });
    expect(result.isExhaustive).toBe(expected);
    expect(search).toHaveBeenCalledWith({ query: 'consumer' }, { searchSession: session }, { signal, session });
  });

  it.each([[10, true], [REPO_READ_FILE_MAX_CHARS + 10, false]])('bounds source read of %i characters honestly', async (length, exhaustive) => {
    const context = { changedFiles: [], repoFileProvider: {
      findFiles: async () => [], readFile: async () => 'x'.repeat(length),
    } };
    const result = await runReadOnlyTool('read_file', { path: 'source.ts' }, context);
    expect(result.isExhaustive).toBe(exhaustive);
    if (!exhaustive) expect(result.toolOutput).toContain('content truncated');
  });

  it('never treats a changed patch as complete repository source', async () => {
    const result = await runReadOnlyTool('get_diff', { path: 'source.ts' }, {
      changedFiles: [{ path: 'source.ts', patch: 'x'.repeat(REPO_READ_FILE_MAX_CHARS + 10) }],
    });
    expect(result.isExhaustive).toBe(false);
  });
});
