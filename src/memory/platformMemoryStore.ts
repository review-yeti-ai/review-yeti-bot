// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { postgresStore } from '../persistence/postgresStore';

export interface PlatformPattern {
  id?: number;
  category: 'security' | 'architecture' | 'performance' | 'quality';
  pattern: string;
  sanitizedDescription: string;
  sourceRepoCount: number;
  occurrenceCount: number;
  confidenceScore: number; // 0-100
  createdAt: string;
  updatedAt: string;
}

export class PlatformMemoryStore {
  private static sharedDbMap: Map<string, any> = new Map();
  private db: any;
  private dbPathKey: string = '';

  constructor(dbPath?: string) {
    const defaultPath = process.env.CT_REVIEW_PLATFORM_DB || (process.env.VITEST ? ':memory:' : path.join(process.env.CT_REVIEW_DATA_DIR || '/tmp/ct-review-bot', 'platform_memory.db'));
    const targetPath = dbPath || defaultPath;
    try {
      const dir = path.dirname(targetPath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(targetPath) && targetPath !== ':memory:' && !targetPath.startsWith(':memory:')) {
        PlatformMemoryStore.sharedDbMap.delete(targetPath);
      }

      if (PlatformMemoryStore.sharedDbMap.has(targetPath)) {
        this.db = PlatformMemoryStore.sharedDbMap.get(targetPath);
      } else {
        this.db = new DatabaseSync(targetPath);
        if (targetPath !== ':memory:' && !targetPath.startsWith(':memory:')) {
          PlatformMemoryStore.sharedDbMap.set(targetPath, this.db);
        }
      }
      this.dbPathKey = targetPath;
    } catch (err: any) {
      logger.warn('Failed to open database at targetPath, falling back to :memory:', { path: targetPath, error: err?.message });
      this.dbPathKey = ':memory:';
      this.db = new DatabaseSync(':memory:');
    }
    this.initDatabase();
  }

  private initDatabase(): void {
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA temp_store = MEMORY;');
    } catch {
      // In-memory databases or shared handles may ignore WAL mode
    }

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS platform_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          pattern TEXT NOT NULL UNIQUE,
          sanitizedDescription TEXT NOT NULL,
          sourceRepoCount INTEGER DEFAULT 1,
          occurrenceCount INTEGER DEFAULT 1,
          confidenceScore INTEGER DEFAULT 80,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_platform_category ON platform_patterns(category);
        CREATE INDEX IF NOT EXISTS idx_platform_confidence ON platform_patterns(confidenceScore);
      `);
    } catch (err: any) {
      logger.warn('PlatformMemoryStore init warning', { error: err.message });
    }
  }

  /**
   * Generalizes and records a pattern from a specific repository into global platform memory.
   */
  public async recordPlatformPattern(
    category: 'security' | 'architecture' | 'performance' | 'quality',
    rawPattern: string,
    description: string,
    sourceRepo: string
  ): Promise<PlatformPattern> {
    const now = new Date().toISOString();
    const sanitizedPattern = this.sanitizePattern(rawPattern);
    const sanitizedDesc = this.sanitizeDescription(description);

    const existing = this.db.prepare('SELECT * FROM platform_patterns WHERE pattern = ?').get(sanitizedPattern) as any;

    if (existing) {
      const newRepoCount = existing.sourceRepoCount + 1;
      const newOccurrenceCount = existing.occurrenceCount + 1;
      const newConfidence = Math.min(100, existing.confidenceScore + 5);

      this.db.prepare(`
        UPDATE platform_patterns
        SET sourceRepoCount = ?, occurrenceCount = ?, confidenceScore = ?, updatedAt = ?
        WHERE id = ?
      `).run(newRepoCount, newOccurrenceCount, newConfidence, existing.id, now);

      logger.info('Elevated platform memory pattern confidence', {
        category,
        pattern: sanitizedPattern,
        confidenceScore: newConfidence,
        sourceRepoCount: newRepoCount,
      });

      const recordedPattern: PlatformPattern = {
        id: existing.id,
        category,
        pattern: sanitizedPattern,
        sanitizedDescription: sanitizedDesc,
        sourceRepoCount: newRepoCount,
        occurrenceCount: newOccurrenceCount,
        confidenceScore: newConfidence,
        createdAt: existing.createdAt,
        updatedAt: now,
      };

      if (postgresStore.isConfigured()) {
        try {
          await postgresStore.savePlatformPattern({
            id: recordedPattern.id,
            repo: sourceRepo,
            category: recordedPattern.category,
            pattern: recordedPattern.pattern,
            sanitizedDescription: recordedPattern.sanitizedDescription,
            sourceRepoCount: recordedPattern.sourceRepoCount,
            occurrenceCount: recordedPattern.occurrenceCount,
            confidenceScore: recordedPattern.confidenceScore,
            createdAt: recordedPattern.createdAt,
            updatedAt: recordedPattern.updatedAt,
          });
        } catch (err: any) {
          logger.warn('Failed dual-write platform pattern to PostgreSQL', { error: err?.message });
        }
      }

      return recordedPattern;
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO platform_patterns (category, pattern, sanitizedDescription, sourceRepoCount, occurrenceCount, confidenceScore, createdAt, updatedAt)
        VALUES (?, ?, ?, 1, 1, 80, ?, ?)
      `);

      const result = stmt.run(category, sanitizedPattern, sanitizedDesc, now, now);
      logger.info('Learned new global platform pattern across repos', {
        category,
        pattern: sanitizedPattern,
        sourceRepo,
      });

      const recordedPattern: PlatformPattern = {
        id: Number(result.lastInsertRowid),
        category,
        pattern: sanitizedPattern,
        sanitizedDescription: sanitizedDesc,
        sourceRepoCount: 1,
        occurrenceCount: 1,
        confidenceScore: 80,
        createdAt: now,
        updatedAt: now,
      };

      if (postgresStore.isConfigured()) {
        try {
          await postgresStore.savePlatformPattern({
            id: recordedPattern.id,
            repo: sourceRepo,
            category: recordedPattern.category,
            pattern: recordedPattern.pattern,
            sanitizedDescription: recordedPattern.sanitizedDescription,
            sourceRepoCount: recordedPattern.sourceRepoCount,
            occurrenceCount: recordedPattern.occurrenceCount,
            confidenceScore: recordedPattern.confidenceScore,
            createdAt: recordedPattern.createdAt,
            updatedAt: recordedPattern.updatedAt,
          });
        } catch (err: any) {
          logger.warn('Failed dual-write platform pattern to PostgreSQL', { error: err?.message });
        }
      }

      return recordedPattern;
    }
  }

  /**
   * Queries global platform patterns matching category and confidence threshold.
   */
  public async queryPlatformPatterns(
    category?: string,
    minConfidence: number = 75
  ): Promise<PlatformPattern[]> {
    if (postgresStore.isConfigured()) {
      try {
        const pgPatterns = await postgresStore.queryPlatformPatterns(category, minConfidence);
        return pgPatterns;
      } catch (err: any) {
        logger.warn('PostgreSQL queryPlatformPatterns failed, seamlessly falling back to local SQLite', { error: err?.message });
      }
    }
    if (category) {
      const rows = this.db.prepare(`
        SELECT * FROM platform_patterns
        WHERE category = ? AND confidenceScore >= ?
        ORDER BY confidenceScore DESC, occurrenceCount DESC
      `).all(category, minConfidence) as any[];

      return rows.map(this.mapRowToPattern);
    } else {
      const rows = this.db.prepare(`
        SELECT * FROM platform_patterns
        WHERE confidenceScore >= ?
        ORDER BY confidenceScore DESC, occurrenceCount DESC
      `).all(minConfidence) as any[];

      return rows.map(this.mapRowToPattern);
    }
  }

  /**
   * Strips PII, file paths, IPs, tokens, and customer identifiers to generalize patterns.
   */
  private sanitizePattern(pattern: string): string {
    return pattern
      .replace(/(\/|\w+:)[\\/][\w\d_.-]+[\\/][\w\d_.-]+/g, '[FILE_PATH]')
      .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '[IP_ADDRESS]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
      .replace(/(ghp_|ghs_|sk-)[A-Za-z0-9_]{16,}/g, '[SECRET_TOKEN]')
      .trim();
  }

  private sanitizeDescription(desc: string): string {
    return this.sanitizePattern(desc);
  }

  private mapRowToPattern(row: any): PlatformPattern {
    return {
      id: row.id,
      category: row.category,
      pattern: row.pattern,
      sanitizedDescription: row.sanitizedDescription,
      sourceRepoCount: row.sourceRepoCount,
      occurrenceCount: row.occurrenceCount,
      confidenceScore: row.confidenceScore,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public close(): void {
    if (this.dbPathKey) {
      PlatformMemoryStore.sharedDbMap.delete(this.dbPathKey);
    }
    if (this.db && typeof this.db.close === 'function') {
      try {
        this.db.close();
      } catch {
        // Safe close ignore if already closed
      }
    }
  }
}
