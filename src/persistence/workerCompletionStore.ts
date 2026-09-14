/** One row per accepted execution attempt: the verified worker review payload,
 * bound to the run by (run_id, execution_attempt) and to whatever gate record
 * exists by content_digest. Written by the authoritative completion path inside
 * its transaction (reviewGateRepository) and by the terminal-success path here,
 * after the lifecycle transition committed. Immutable: a repeat is a no-op. */
export interface WorkerCompletionRecord {
  runId: string;
  executionAttempt: number;
  contentDigest: string;
  payload: unknown;
}

export interface WorkerCompletionStore {
  put(record: WorkerCompletionRecord): Promise<'inserted' | 'exists'>;
}

type Queryable = { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> };

export class PostgresWorkerCompletionStore implements WorkerCompletionStore {
  constructor(private readonly db: Queryable) {}

  async put(record: WorkerCompletionRecord): Promise<'inserted' | 'exists'> {
    const json = JSON.stringify(record.payload);
    const result = await this.db.query(
      `INSERT INTO review_worker_completions (run_id, execution_attempt, content_digest, payload, byte_length)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (run_id, execution_attempt) DO NOTHING`,
      [record.runId, record.executionAttempt, record.contentDigest, json, Buffer.byteLength(json, 'utf8')],
    );
    return (result.rowCount ?? 0) > 0 ? 'inserted' : 'exists';
  }
}
