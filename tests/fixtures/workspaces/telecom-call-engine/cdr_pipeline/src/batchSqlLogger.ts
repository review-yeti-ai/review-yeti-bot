/**
 * Asynchronous Batch SQL Statement Generator & Partition Flusher
 */

import { RatedCdr } from './models/ratePlan';

export interface BatchSqlLoggerConfig {
  maxBatchSize: number;             // Default: 1000 records
  flushIntervalMs: number;          // Default: 1000 ms
  maxBufferCapacity: number;        // Default: 10,000 records
  retryMaxAttempts: number;         // Default: 3
  retryBaseDelayMs: number;         // Default: 100 ms
  tableNamePrefix: string;          // Default: "tenant_cdrs"
}

export interface SqlQueryExecutor {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number }>;
}

export interface BatchFlushResult {
  flushedCount: number;
  elapsedMs: number;
  tableName: string;
}

export class BufferOverflowError extends Error {
  constructor(public readonly bufferSize: number, public readonly capacity: number) {
    super(`[BufferOverflowError] Logger ring buffer overflow (${bufferSize}/${capacity})`);
    this.name = 'BufferOverflowError';
  }
}

export class BatchSqlLogger {
  private buffer: RatedCdr[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private readonly config: BatchSqlLoggerConfig;

  constructor(
    private readonly db?: SqlQueryExecutor,
    config?: Partial<BatchSqlLoggerConfig>
  ) {
    this.config = {
      maxBatchSize: config?.maxBatchSize ?? 1000,
      flushIntervalMs: config?.flushIntervalMs ?? 1000,
      maxBufferCapacity: config?.maxBufferCapacity ?? 10000,
      retryMaxAttempts: config?.retryMaxAttempts ?? 3,
      retryBaseDelayMs: config?.retryBaseDelayMs ?? 100,
      tableNamePrefix: config?.tableNamePrefix ?? 'tenant_cdrs',
    };
  }

  public start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('Error during scheduled CDR batch flush:', err);
      });
    }, this.config.flushIntervalMs);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  public async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Enqueues a rated CDR for async batch persistence.
   */
  public enqueue(cdr: RatedCdr): void {
    if (this.buffer.length >= this.config.maxBufferCapacity) {
      throw new BufferOverflowError(this.buffer.length, this.config.maxBufferCapacity);
    }
    this.buffer.push(cdr);

    if (this.buffer.length >= this.config.maxBatchSize) {
      this.flush().catch((err) => {
        console.error('Error during size-triggered CDR batch flush:', err);
      });
    }
  }

  /**
   * Flushes the buffer into monthly partitioned table
   */
  public async flush(): Promise<BatchFlushResult | null> {
    if (this.isFlushing || this.buffer.length === 0) {
      return null;
    }

    this.isFlushing = true;
    const startTime = Date.now();
    const recordsToFlush = this.buffer.splice(0, this.config.maxBatchSize);

    try {
      const firstRecordDate = new Date(recordsToFlush[0].startIso);
      const tableName = this.getPartitionTableName(firstRecordDate);
      const { sql, values } = this.buildBatchInsertSql(recordsToFlush, tableName);

      if (this.db) {
        let attempt = 0;
        let success = false;
        let lastError: unknown;

        while (attempt < this.config.retryMaxAttempts && !success) {
          try {
            await this.db.query(sql, values);
            success = true;
          } catch (err) {
            attempt++;
            lastError = err;
            if (attempt < this.config.retryMaxAttempts) {
              const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }

        if (!success) {
          // Re-insert un-flushed records at the head of buffer
          this.buffer.unshift(...recordsToFlush);
          throw lastError;
        }
      }

      return {
        flushedCount: recordsToFlush.length,
        elapsedMs: Date.now() - startTime,
        tableName,
      };
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Partition naming resolver based on CDR start timestamp: tenant_cdrs_YYYY_MM
   */
  public getPartitionTableName(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${this.config.tableNamePrefix}_${year}_${month}`;
  }

  /**
   * Generates parameterized multi-value INSERT statement with placeholders $1, $2...
   */
  public buildBatchInsertSql(records: RatedCdr[], tableName: string): { sql: string; values: unknown[] } {
    if (records.length === 0) {
      return { sql: '', values: [] };
    }

    const columns = [
      'id',
      'tenant_id',
      'call_id',
      'direction',
      'caller',
      'callee',
      'ingress_trunk_id',
      'egress_trunk_id',
      'disposition',
      'sip_response_code',
      'q850_code',
      'start_time',
      'answer_time',
      'end_time',
      'total_duration_ms',
      'setup_duration_ms',
      'billed_seconds',
      'rate_micros',
      'cost_micros',
      'created_at',
    ];

    const valueRows: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const r of records) {
      const placeholders: string[] = [];
      for (let i = 0; i < columns.length; i++) {
        placeholders.push(`$${paramIndex++}`);
      }
      valueRows.push(`(${placeholders.join(', ')})`);

      values.push(
        r.id,
        r.tenantId,
        r.callId,
        r.direction,
        r.caller,
        r.callee,
        r.ingressTrunkId,
        r.egressTrunkId,
        r.disposition,
        r.sipResponseCode,
        r.q850Reason.code,
        r.startIso,
        r.answerIso,
        r.endIso,
        r.totalDurationMs,
        r.setupDurationMs,
        r.billedDurationSec,
        r.ratePerMinuteMicros,
        r.totalCostMicros,
        r.createdAtIso
      );
    }

    const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valueRows.join(', ')} ON CONFLICT (id) DO NOTHING;`;

    return { sql, values };
  }

  public getPendingCount(): number {
    return this.buffer.length;
  }

  public clear(): void {
    this.buffer = [];
  }
}
