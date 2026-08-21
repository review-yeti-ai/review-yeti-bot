import { canonicalJson, sha256 } from '../review/reviewCore';
import type { JsonValue } from '../review/reviewRun';
import type { PiStage } from '../review/piWorkflow';

export const REVIEW_ARTIFACT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_BYTES = REVIEW_ARTIFACT_MAX_BYTES;

interface StoredArtifact {
  digest: string;
  payload: JsonValue;
  byteLength: number;
}

export interface ReviewArtifactStore {
  put(runId: string, stage: PiStage, payload: JsonValue): Promise<string>;
  get(runId: string, stage: PiStage): Promise<JsonValue | null>;
}

function validateArtifact(runId: string, payload: JsonValue, maxBytes: number): StoredArtifact {
  const serialized = canonicalJson(payload);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > maxBytes) throw new Error(`review artifact for ${runId} exceeds ${maxBytes} bytes`);
  return { digest: sha256(serialized), payload: JSON.parse(serialized) as JsonValue, byteLength };
}

function key(runId: string, stage: PiStage): string {
  return `${runId}:${stage}`;
}

export class InMemoryReviewArtifactStore implements ReviewArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();

  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {
    if (maxBytes > REVIEW_ARTIFACT_MAX_BYTES) throw new Error(`maxBytes must not exceed ${REVIEW_ARTIFACT_MAX_BYTES} bytes`);
  }

  async put(runId: string, stage: PiStage, payload: JsonValue): Promise<string> {
    const candidate = validateArtifact(runId, payload, this.maxBytes);
    const artifactKey = key(runId, stage);
    const existing = this.artifacts.get(artifactKey);
    if (existing && existing.digest !== candidate.digest) throw new Error(`review artifact ${runId}/${stage} is immutable`);
    this.artifacts.set(artifactKey, existing || candidate);
    return candidate.digest;
  }

  async get(runId: string, stage: PiStage): Promise<JsonValue | null> {
    const artifact = this.artifacts.get(key(runId, stage));
    if (!artifact) return null;
    const verified = validateArtifact(runId, artifact.payload, this.maxBytes);
    if (verified.digest !== artifact.digest || verified.byteLength !== artifact.byteLength) {
      throw new Error(`review artifact ${runId}/${stage} failed integrity verification`);
    }
    return verified.payload;
  }
}

export class PostgresReviewArtifactStore implements ReviewArtifactStore {
  constructor(
    private readonly db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {
    if (maxBytes > REVIEW_ARTIFACT_MAX_BYTES) throw new Error(`maxBytes must not exceed ${REVIEW_ARTIFACT_MAX_BYTES} bytes`);
  }

  async put(runId: string, stage: PiStage, payload: JsonValue): Promise<string> {
    const artifact = validateArtifact(runId, payload, this.maxBytes);
    const result = await this.db.query(
      `INSERT INTO review_run_artifacts (run_id, stage, content_digest, payload, byte_length)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id, stage) DO NOTHING
       RETURNING content_digest`,
      [runId, stage, artifact.digest, JSON.stringify(artifact.payload), artifact.byteLength],
    );
    if (result.rows[0]) return artifact.digest;
    const existing = await this.db.query(
      'SELECT content_digest FROM review_run_artifacts WHERE run_id=$1 AND stage=$2',
      [runId, stage],
    );
    if (existing.rows[0]?.content_digest !== artifact.digest) throw new Error(`review artifact ${runId}/${stage} is immutable`);
    return artifact.digest;
  }

  async get(runId: string, stage: PiStage): Promise<JsonValue | null> {
    const result = await this.db.query(
      'SELECT content_digest, payload, byte_length FROM review_run_artifacts WHERE run_id=$1 AND stage=$2',
      [runId, stage],
    );
    const row = result.rows[0];
    if (!row) return null;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as JsonValue : row.payload as JsonValue;
    const verified = validateArtifact(runId, payload, this.maxBytes);
    if (row.content_digest !== verified.digest || Number(row.byte_length) !== verified.byteLength) {
      throw new Error(`review artifact ${runId}/${stage} failed integrity verification`);
    }
    return verified.payload;
  }
}
