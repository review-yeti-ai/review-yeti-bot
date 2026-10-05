import { describe, expect, it, vi } from 'vitest';
import { createPrLifecycleHistoryHandler, PR_LIFECYCLE_HISTORY_SNAPSHOT_REQUEST_VERSION } from '../../src/api/prLifecycleHistoryRoute';

function responseDouble() {
  const response = { status: vi.fn(), json: vi.fn() } as any;
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

describe('PR lifecycle history HTTP boundary', () => {
  it('rejects requests without a worker installation bearer before querying the ledger', async () => {
    const db = { query: vi.fn() };
    const response = responseDouble();
    const handler = createPrLifecycleHistoryHandler(db);

    await handler({ header: () => undefined, body: { version: PR_LIFECYCLE_HISTORY_SNAPSHOT_REQUEST_VERSION,
      runId: `run_${'a'.repeat(32)}`, executionAttempt: 1 } } as any, response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied repository and head selectors before querying the ledger', async () => {
    const db = { query: vi.fn() };
    const response = responseDouble();
    const handler = createPrLifecycleHistoryHandler(db);

    await handler({ header: () => 'Bearer ghs_test-token', body: {
      version: PR_LIFECYCLE_HISTORY_SNAPSHOT_REQUEST_VERSION,
      runId: `run_${'a'.repeat(32)}`, executionAttempt: 1,
      repositoryId: 99, owner: 'someone-else', repo: 'private', prNumber: 7, headSha: 'f'.repeat(40),
    } } as any, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});
