import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const { createZoektSearchTool, ZOEKT_SEARCH_TOOL_NAME } = require('../../src/mcp/zoektSearchTool.js');

const identity = {
  repository: 'acme/widgets',
  prNumber: '17',
  headSha: 'a'.repeat(40),
};

function fakeFsAvailable() {
  return {
    existsSync: () => true,
    readdirSync: () => ['shard.zoekt'],
  };
}

function fakeFsUnavailable() {
  return {
    existsSync: () => false,
    readdirSync: () => [],
  };
}

function jsonlLine(path: string, matches: Array<{ line: number; text: string }>) {
  return JSON.stringify({
    FileName: path,
    LineMatches: matches.map((m) => ({
      LineNumber: m.line,
      FileName: false,
      Line: Buffer.from(m.text, 'utf8').toString('base64'),
    })),
  });
}

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit('exit', 137);
  });
  return child;
}

describe('createZoektSearchTool', () => {
  it('is disabled by default and reports unavailable without spawning', async () => {
    const spawnImpl = vi.fn();
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', fsImpl: fakeFsAvailable(), spawnImpl });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('disabled');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects an unregistered tool name', async () => {
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable() });
    const result = await tool.call('shell_exec', { query: 'x' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('tool_not_registered');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'x'.repeat(201)],
    ['leading dash (flag-injection shape)', '-index_dir'],
    ['contains NUL', 'abc\0def'],
  ])('rejects an invalid query: %s', async (_label, query) => {
    const spawnImpl = vi.fn();
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable(), spawnImpl });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('invalid_query');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('fails soft when no index has been built for this review', async () => {
    const spawnImpl = vi.fn();
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsUnavailable(), spawnImpl });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('zoekt_index_unavailable');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('fails soft when the zoekt binary is missing (ENOENT)', async () => {
    const spawnImpl = vi.fn(() => {
      const error: any = new Error('spawn zoekt ENOENT');
      error.code = 'ENOENT';
      throw error;
    });
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable(), spawnImpl });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('zoekt_binary_missing');
  });

  it('enforces the call budget', async () => {
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => { child.stdout.end(); child.emit('exit', 0); });
      return child;
    });
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true, maxCalls: 2 }, fsImpl: fakeFsAvailable(), spawnImpl });
    await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'a' });
    await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'b' });
    const third = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'c' });
    expect(third.status).toBe('unavailable');
    expect(third.reason).toBe('call_budget_exhausted');
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('passes the query only after a literal -- so it can never be read as a flag', async () => {
    let capturedArgs: string[] = [];
    const spawnImpl = vi.fn((_bin: string, args: string[]) => {
      capturedArgs = args;
      const child = makeFakeChild();
      queueMicrotask(() => { child.stdout.end(); child.emit('exit', 0); });
      return child;
    });
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable(), spawnImpl });
    await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    const dashDashIndex = capturedArgs.indexOf('--');
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(capturedArgs[dashDashIndex + 1]).toBe('handle_call');
    expect(capturedArgs.slice(dashDashIndex + 1)).toEqual(['handle_call']);
  });

  it('parses matches, base64-decodes lines, and reports byte counts', async () => {
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.write(jsonlLine('lib/foo.ex', [{ line: 12, text: 'def handle_call(:ping, _from, state) do' }]) + '\n');
        child.stdout.end();
        child.emit('exit', 0);
      });
      return child;
    });
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable(), spawnImpl });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    expect(result.status).toBe('ok');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: 'lib/foo.ex', line: 12, text: 'def handle_call(:ping, _from, state) do' });
    expect(result.byteCount).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.identity).toMatchObject(identity);
  });

  it('truncates and kills the child once maxFindResults is reached instead of buffering everything', async () => {
    let killed = false;
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild();
      child.kill = vi.fn(() => { killed = true; child.emit('exit', 137); });
      queueMicrotask(() => {
        for (let i = 0; i < 10; i += 1) {
          child.stdout.write(jsonlLine(`lib/file${i}.ex`, [{ line: i + 1, text: `match number ${i}` }]) + '\n');
        }
        // Deliberately never end() -- a well-behaved implementation must stop
        // reading and kill the process once bounded, not wait for EOF.
      });
      return child;
    });
    const tool = createZoektSearchTool({
      identity,
      indexDir: '/idx',
      config: { enabled: true, maxFindResults: 3 },
      fsImpl: fakeFsAvailable(),
      spawnImpl,
    });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'match' });
    expect(result.status).toBe('ok');
    expect(result.matches.length).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
    expect(killed).toBe(true);
  });

  it('fails soft on a non-zero exit that was not caused by our own bound-triggered kill', async () => {
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => { child.stdout.end(); child.emit('exit', 2); });
      return child;
    });
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable(), spawnImpl });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('zoekt_query_failed');
  });

  it('fails soft on timeout without hanging the caller', async () => {
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild();
      // Never emits exit on its own -- only our timer's kill() should resolve this.
      return child;
    });
    const tool = createZoektSearchTool({
      identity,
      indexDir: '/idx',
      config: { enabled: true, timeoutMs: 10 },
      fsImpl: fakeFsAvailable(),
      spawnImpl,
    });
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('request_timeout');
  });

  it('respects an already-aborted signal without spawning', async () => {
    const spawnImpl = vi.fn();
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable(), spawnImpl });
    const controller = new AbortController();
    controller.abort();
    const result = await tool.call(ZOEKT_SEARCH_TOOL_NAME, { query: 'handle_call' }, { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('exposes read-only, local-index capabilities and never claims network transport', () => {
    const tool = createZoektSearchTool({ identity, indexDir: '/idx', config: { enabled: true }, fsImpl: fakeFsAvailable() });
    expect(tool.capabilities.readOnly).toBe(true);
    expect(tool.capabilities.transport).toBe('local-zoekt-index');
    expect(tool.capabilities.tools).toEqual([ZOEKT_SEARCH_TOOL_NAME]);
  });
});
