/**
 * Stable identity predicate for the pre-authoritative App-gate path.
 *
 * State-specific callers add their own queued/terminal/succeeded conditions,
 * but both runtime transitions and compatibility migrations must agree on
 * which runs are legacy App-gate runs.
 */
export const LEGACY_APP_GATE_RUN_SQL =
  "runs.publication_mode = 'app-gate' AND runs.authoritative_gate_app_id IS NULL";

/** Ordered after both the dispatch and gate schemas by PostgresStore. */
export const LEGACY_APP_GATE_RECEIPT_BACKFILL_SQL = `
  UPDATE review_dispatch_outbox AS outbox
     SET terminal_receipt_digest = runs.result_digest
    FROM review_runs AS runs
   WHERE outbox.run_id = runs.run_id
     AND outbox.terminal_receipt_digest IS NULL
     AND outbox.status = 'terminal'
     AND runs.status = 'succeeded'
     AND ${LEGACY_APP_GATE_RUN_SQL}
     AND runs.result_digest ~ '^[a-f0-9]{64}$';
`;

export function isLegacyAppGateRun(
  publicationMode: unknown,
  authoritativeGateAppId: unknown,
): boolean {
  return String(publicationMode) === 'app-gate' && authoritativeGateAppId == null;
}
