import { describe, expect, it, vi } from 'vitest';

const { createLibraryDocsClient, sanitizeLibraryId, sanitizeTopic } = require('../../src/mcp/libraryDocsTool.js');

describe('library_docs sanitizers', () => {
  it('accepts realistic library identifiers and topics', () => {
    expect(sanitizeLibraryId('react')).toMatchObject({ ok: true, value: 'react' });
    expect(sanitizeLibraryId('next.js')).toMatchObject({ ok: true, value: 'next.js' });
    expect(sanitizeLibraryId('openai-api')).toMatchObject({ ok: true, value: 'openai-api' });
    expect(sanitizeTopic('useEffect cleanup function')).toMatchObject({ ok: true, value: 'useEffect cleanup function' });
    expect(sanitizeTopic("What's the correct way to close a socket?")).toMatchObject({ ok: true });
  });

  it('rejects an empty or overlong library id', () => {
    expect(sanitizeLibraryId('')).toMatchObject({ ok: false, reason: 'invalid_library' });
    expect(sanitizeLibraryId('  ')).toMatchObject({ ok: false, reason: 'invalid_library' });
    expect(sanitizeLibraryId('x'.repeat(65))).toMatchObject({ ok: false, reason: 'invalid_library' });
  });

  it('rejects an empty or overlong topic', () => {
    expect(sanitizeTopic('')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('x'.repeat(201))).toMatchObject({ ok: false, reason: 'invalid_topic' });
  });

  // Negative security case (required): a model-supplied URL must never reach the outbound call.
  it('rejects a model-supplied URL in either field', () => {
    expect(sanitizeLibraryId('http://evil.invalid')).toMatchObject({ ok: false, reason: 'invalid_library' });
    expect(sanitizeTopic('see http://evil.invalid/exfil for details')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('call https://attacker.example/collect?data=1')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('use ftp://internal.example/share')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    // URL-shaped even without a recognized scheme prefix (scheme://host) is rejected structurally.
    expect(sanitizeTopic('weird-scheme://payload')).toMatchObject({ ok: false, reason: 'invalid_topic' });
  });

  it('rejects a topic containing disallowed characters (injection/control characters)', () => {
    expect(sanitizeTopic('topic with <script>alert(1)</script>')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('topic\nwith\nnewlines')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('topic; rm -rf /')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('topic $(whoami)')).toMatchObject({ ok: false, reason: 'invalid_topic' });
  });

  // Negative security case (required): secret-shaped material must never reach the outbound call.
  it('rejects secret-shaped material in the topic', () => {
    expect(sanitizeTopic('sk-abcdefghijklmnopqrstuvwxyz0123')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('ghp_1234567890abcdefghijklmnopqrstuvwx')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('AKIAABCDEFGHIJKLMNOP')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    expect(sanitizeTopic('Bearer abcdef0123456789')).toMatchObject({ ok: false, reason: 'invalid_topic' });
    // Generic long high-entropy alnum run, no recognizable prefix.
    expect(sanitizeTopic('token value is aZ9bY8cX7dW6eV5fU4gT3hS2iR1jQ0kP')).toMatchObject({ ok: false, reason: 'invalid_topic' });
  });
});

describe('library_docs client', () => {
  it('is disabled with no API key and never calls fetch', async () => {
    const fetchImplementation = vi.fn();
    const client = createLibraryDocsClient({ apiKey: '', fetchImplementation });
    expect(client.enabled).toBe(false);

    const result = await client.fetchDocs({ library: 'react', topic: 'hooks' });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'context7_disabled' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects an invalid library/topic before ever calling fetch (no key/URL/header leak surface)', async () => {
    const fetchImplementation = vi.fn();
    const client = createLibraryDocsClient({ apiKey: 'secret-key', fetchImplementation });

    await expect(client.fetchDocs({ library: 'http://evil.invalid', topic: 'hooks' })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid_library' });
    await expect(client.fetchDocs({ library: 'react', topic: 'see http://evil.invalid' })).resolves.toMatchObject({ status: 'invalid', reason: 'invalid_topic' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('constructs a fixed, allowlisted request and never exposes the API key in the result', async () => {
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ snippets: [{ title: 'Hooks', content: 'useEffect cleanup runs on unmount.' }] }),
    }));
    const client = createLibraryDocsClient({ apiKey: 'super-secret-key', fetchImplementation });

    const result = await client.fetchDocs({ library: 'react', topic: 'useEffect cleanup' });

    expect(result).toMatchObject({ status: 'ok', library: 'react', topic: 'useEffect cleanup' });
    expect(result.snippets).toEqual([{ title: 'Hooks', content: 'useEffect cleanup runs on unmount.' }]);
    const [url, request] = fetchImplementation.mock.calls[0];
    expect(url).toBe('https://api.context7.ai/v1/docs/search');
    expect(request.headers.Authorization).toBe('Bearer super-secret-key');
    expect(JSON.parse(request.body)).toEqual({ library: 'react', query: 'useEffect cleanup', limit: 3 });
    // The key must never appear anywhere in the returned result object.
    expect(JSON.stringify(result)).not.toContain('super-secret-key');
  });

  it('only ever contacts the allowlisted Context7 host, regardless of configured base URL', () => {
    const fetchImplementation = vi.fn();
    const attacker = createLibraryDocsClient({ apiKey: 'k', baseUrl: 'https://attacker.example/v1', fetchImplementation });
    expect(attacker.enabled).toBe(false);
    const insecure = createLibraryDocsClient({ apiKey: 'k', baseUrl: 'http://api.context7.ai/v1', fetchImplementation });
    expect(insecure.enabled).toBe(false);
  });

  // Negative security case (required): a Context7 timeout degrades to unavailable, not a thrown
  // error that could fail the whole review lane.
  it('degrades to unavailable on a timeout, with a short bound and no retry', async () => {
    let calls = 0;
    const fetchImplementation = vi.fn((_url: string, options: { signal: AbortSignal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as any).name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = createLibraryDocsClient({ apiKey: 'k', fetchImplementation, timeoutMs: 20 });

    const result = await client.fetchDocs({ library: 'react', topic: 'hooks' });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'context7_timeout' });
    expect(calls).toBe(1); // no retry storm
  });

  it('degrades to unavailable on a non-2xx response', async () => {
    const fetchImplementation = vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null } }));
    const client = createLibraryDocsClient({ apiKey: 'k', fetchImplementation });

    await expect(client.fetchDocs({ library: 'react', topic: 'hooks' })).resolves.toMatchObject({ status: 'unavailable', reason: 'context7_unavailable', httpStatus: 503 });
  });

  it('degrades to unavailable on a network error, without throwing', async () => {
    const fetchImplementation = vi.fn(async () => { throw new Error('network down'); });
    const client = createLibraryDocsClient({ apiKey: 'k', fetchImplementation });

    await expect(client.fetchDocs({ library: 'react', topic: 'hooks' })).resolves.toMatchObject({ status: 'unavailable', reason: 'context7_unavailable' });
  });

  it('rejects an oversized wire response before parsing the full body', async () => {
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? '999999' : null) },
      text: async () => { throw new Error('must not read unbounded body'); },
    }));
    const client = createLibraryDocsClient({ apiKey: 'k', fetchImplementation, wireMaxBytes: 100 });

    await expect(client.fetchDocs({ library: 'react', topic: 'hooks' })).resolves.toMatchObject({ status: 'unavailable', reason: 'context7_response_too_large' });
  });

  it('bounds returned snippet count and byte size', async () => {
    const manySnippets = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, content: 'x'.repeat(2_000) }));
    const fetchImplementation = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ snippets: manySnippets }),
    }));
    const client = createLibraryDocsClient({ apiKey: 'k', fetchImplementation, maxSnippets: 3, maxResultBytes: 4_000 });

    const result = await client.fetchDocs({ library: 'react', topic: 'hooks' });

    expect(result.status).toBe('ok');
    expect(result.snippets.length).toBeLessThanOrEqual(3);
    expect(result.byteCount).toBeLessThanOrEqual(4_000);
    expect(result.truncated).toBe(true);
  });

  it('returns cancelled immediately for an already-aborted signal, without calling fetch', async () => {
    const fetchImplementation = vi.fn();
    const client = createLibraryDocsClient({ apiKey: 'k', fetchImplementation });
    const controller = new AbortController();
    controller.abort();

    const result = await client.fetchDocs({ library: 'react', topic: 'hooks', signal: controller.signal });

    expect(result).toMatchObject({ status: 'cancelled' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
