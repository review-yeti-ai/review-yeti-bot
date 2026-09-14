import { reviewDispatchPrLockKey } from './reviewCiPersistence';

export interface ReviewPrTransactionClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
  release(): void;
}

export interface ReviewPrQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
}

export interface ReviewPrTransactionPool {
  connect(): Promise<ReviewPrTransactionClient>;
}

export interface ReviewPrCoordinates {
  repositoryId: number;
  prNumber: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function assertReviewPrCoordinates(repositoryId: unknown, prNumber: unknown): ReviewPrCoordinates {
  if (!isPositiveSafeInteger(repositoryId) || !isPositiveSafeInteger(prNumber)) {
    throw new Error('Review PR coordinates must be positive safe integers');
  }
  return { repositoryId, prNumber };
}

export function reviewPrLockKey(repositoryId: unknown, prNumber: unknown): string {
  const coordinates = assertReviewPrCoordinates(repositoryId, prNumber);
  return reviewDispatchPrLockKey(coordinates.repositoryId, coordinates.prNumber);
}

export async function lockReviewPr(
  client: ReviewPrQueryable,
  repositoryId: number,
  prNumber: number,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [reviewPrLockKey(repositoryId, prNumber)],
  );
}

export async function tryLockReviewPr(
  client: ReviewPrQueryable,
  repositoryId: number,
  prNumber: number,
): Promise<boolean> {
  const result = await client.query(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
    [reviewPrLockKey(repositoryId, prNumber)],
  );
  return result.rows[0]?.acquired === true;
}

export async function withReviewPrTransaction<T>(
  pool: ReviewPrTransactionPool,
  operation: (client: ReviewPrTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  let failure: unknown;
  let committed = false;
  let result!: T;

  try {
    await client.query('BEGIN');
    result = await operation(client);
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    failed = true;
    failure = error;
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  if (failed) {
    try {
      client.release();
    } catch {
      // Preserve the operation or transaction error over cleanup failures.
    }
    throw failure;
  }

  client.release();
  return result;
}
