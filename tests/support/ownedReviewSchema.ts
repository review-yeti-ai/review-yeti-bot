import type { Pool } from 'pg';
import { PostgresStore } from '../../src/persistence/postgresStore';

/** Run the actual locked startup migration only inside a uniquely owned test schema. */
export async function initializeOwnedReviewSchema(pool: Pool, schemaName: string): Promise<void> {
  if (!/^(?:review_(?:dispute_test|completed_recheck)|incremental_prior_test|verdict_cache_test)_[a-f0-9]{16}$/u.test(schemaName)) {
    throw new Error('Review fixture schema is not owned by this test');
  }
  const current = (await pool.query('SELECT current_schema() AS schema')).rows[0]?.schema;
  if (current !== schemaName) throw new Error('Review fixture search path is outside its owned schema');
  const store = new class extends PostgresStore {
    override isConfigured(): boolean { return true; }
    override getPool(): Pool { return pool; }
  }();
  await store.initialize();
}
