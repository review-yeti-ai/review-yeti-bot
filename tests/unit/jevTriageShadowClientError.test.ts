import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * REL-1081: the `client_error` fail-open path. `jevTransport` already rejects the inputs that make
 * `JevClient`'s constructor throw, so the only way to reach this branch is a constructor that
 * throws for a reason the transport does not check. Mocked in its own file so the module mock
 * cannot leak into the other Jev tests.
 */
vi.mock('../../src/gateway/jevClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway/jevClient')>();
  class ThrowingJevClient {
    constructor() {
      throw new TypeError('constructor exploded');
    }
  }
  return { ...original, JevClient: ThrowingJevClient };
});

import { JEV_TRIAGE_LOG, startJevTriageShadow } from '../../src/review/jevTriageShadow';
import { logger } from '../../src/utils/logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startJevTriageShadow -- JevClient construction failure', () => {
  it('fails open as misconfigured with reason client_error and never throws', async () => {
    const warn = vi.spyOn(logger, 'warn');
    let handle: ReturnType<typeof startJevTriageShadow> | undefined;
    expect(() => {
      handle = startJevTriageShadow({
        env: {
          REVIEW_YETI_JEV_SHADOW: 'true',
          TYPESAFE_BASE_URL: 'https://api.typesafe.example/v1/systemone',
          TYPESAFE_MODEL: 'jev-latest',
          TYPESAFE_API_KEY: 'ts-test-key',
          TYPESAFE_MODEL_PIN: 'jev-1.13.0',
        },
        repository: 'review-yeti-ai/review-yeti-bot',
        runId: 'run_1',
        prNumber: 7,
        headSha: 'a'.repeat(40),
        changedFiles: [{ path: 'src/a.ts', patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n' }],
        personas: [{ id: 'sec-lane', charter: 'builtin:security' }],
      });
    }).not.toThrow();
    await expect(handle!.settled).resolves.toEqual({ status: 'misconfigured', decisions: [] });
    await expect(handle!.join({ findings: [], personas: [], mode: 'panel', verdict: 'SHIP', conclusion: 'success' })).resolves.toBeUndefined();
    const skipped = warn.mock.calls
      .map((call) => call[1] as Record<string, unknown> | undefined)
      .find((meta) => meta?.event === JEV_TRIAGE_LOG.skipped);
    expect(skipped).toMatchObject({ reason: 'client_error', error_class: 'TypeError' });
  });
});
