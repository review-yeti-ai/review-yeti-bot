/**
 * REL-1057: a superseded publishing worker exits cleanly (so its Job succeeds
 * and the PRReviewJob is not Failed) and leaves the superseded marker in its
 * termination message for the operator. Any other error still fails the pod.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewSupersededError, WORKER_SUPERSEDED_TERMINATION_MARKER } from '../../src/review/reviewSupersession';
import { recordSupersededWorkerExit, DEFAULT_TERMINATION_MESSAGE_PATH } from '../../src/cli/workerSupersededExit';
import { logger } from '../../src/utils/logger';

const publishing = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/cli/publishingReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/publishingReview')>();
  return { ...actual, runPublishingReviewWorker: publishing.run };
});

const HEAD = 'a'.repeat(40);
const NEWER_HEAD = 'e'.repeat(40);

function workerEnv(terminationPath: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    GITHUB_PUBLISH_TOKEN: 'ghs_test',
    REVIEW_WORKER_TERMINATION_MESSAGE_PATH: terminationPath,
  };
}

afterEach(() => {
  publishing.run.mockReset();
  vi.restoreAllMocks();
});

describe('superseded publishing worker exit', () => {
  it('resolves (exit 0) and writes the superseded termination marker', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const path = join(mkdtempSync(join(tmpdir(), 'rel-1057-')), 'termination-log');
    publishing.run.mockRejectedValue(new ReviewSupersededError('pre_review', HEAD, NEWER_HEAD));
    const { runWorker } = await import('../../src/cli/runLiveReview');

    await expect(runWorker(workerEnv(path))).resolves.toBeUndefined();

    const message = readFileSync(path, 'utf8');
    expect(message.startsWith(`${WORKER_SUPERSEDED_TERMINATION_MARKER} stage=pre_review head=${HEAD}`)).toBe(true);
    expect(message).toContain(`current=${NEWER_HEAD}`);
  });

  it('still fails the worker on any other error and writes no marker', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rel-1057-')), 'termination-log');
    publishing.run.mockRejectedValue(new Error('GitHub qualification read failed HTTP 502'));
    const { runWorker } = await import('../../src/cli/runLiveReview');

    await expect(runWorker(workerEnv(path))).rejects.toThrow('GitHub qualification read failed HTTP 502');
    expect(existsSync(path)).toBe(false);
  });

  it('defaults to the Kubernetes termination-message path and never throws on a write failure', () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const write = vi.fn(() => { throw new Error('EROFS'); });
    expect(() => recordSupersededWorkerExit(
      new ReviewSupersededError('completion', HEAD, NEWER_HEAD), { NODE_ENV: 'test' }, write,
    )).not.toThrow();
    expect(write).toHaveBeenCalledWith(DEFAULT_TERMINATION_MESSAGE_PATH, expect.stringContaining(WORKER_SUPERSEDED_TERMINATION_MARKER));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
