/** Durable audit receipts for worker generations reconstructed from the
 * App-owned GitHub check ledger after service-state loss. These rows never
 * authorize work by themselves; admission writes them in the same transaction
 * that allocates the next generation. */
export const REVIEW_GENERATION_RECOVERY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_generation_recoveries (
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    recovered_generation INTEGER NOT NULL CHECK (recovered_generation > 0),
    worker_check_id BIGINT NOT NULL UNIQUE CHECK (worker_check_id > 0),
    external_id TEXT NOT NULL UNIQUE,
    conclusion TEXT NOT NULL CHECK (conclusion IN ('failure', 'action_required')),
    title TEXT NOT NULL,
    evidence JSONB NOT NULL,
    recovered_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (run_id, recovered_generation)
  );
`;
