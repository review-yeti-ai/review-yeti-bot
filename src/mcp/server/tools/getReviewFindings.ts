import { createHash } from 'node:crypto';
import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  GetReviewFindingsInputSchema,
  type GetReviewFindingsInput,
  type ReviewFindingItem,
  type ReviewFindingsOutput,
  type FindingSeverity,
  type FindingCategory,
} from './schemas';

export interface ReviewFindingsDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export const getReviewFindingsDefinition: ToolDefinition = {
  name: 'get_review_findings',
  description: 'Query structured findings from PostgreSQL ledger with severity filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (e.g. calltelemetry)' },
      repo: { type: 'string', description: 'Repository name (e.g. pr-manager-mcp)' },
      pull_number: { type: 'number', description: 'Pull request number' },
      severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'Optional severity filter' },
      unresolved_only: { type: 'boolean', description: 'Filter to unresolved findings only (default: true)' },
    },
    required: ['owner', 'repo', 'pull_number'],
    additionalProperties: false,
  },
};

export function createGetReviewFindingsTool(db?: ReviewFindingsDbClient) {
  return {
    definition: getReviewFindingsDefinition,
    schema: GetReviewFindingsInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetReviewFindingsInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pull_number, severity, unresolved_only = true } = parsed.data;

      if (!db) {
        // Fallback for standalone/in-memory mode
        return buildToolResultJson({
          findings: [],
          total_count: 0,
          unresolved_count: 0,
        } satisfies ReviewFindingsOutput);
      }

      let rows: any[] = [];

      // 1. Try review_worker_completions joined with review_runs
      try {
        const sql = `
          SELECT c.payload, r.run_id, r.head_sha
            FROM review_runs r
            JOIN review_worker_completions c ON c.run_id = r.run_id
           WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
           ORDER BY r.created_at DESC, c.execution_attempt DESC
           LIMIT 1
        `;
        const res = await db.query(sql, [owner, repo, pull_number]);
        rows = res.rows;
      } catch {
        // review_worker_completions table might not exist in local dev/tests
      }

      // 2. Fallback to review_run_artifacts if no rows found
      if (rows.length === 0) {
        try {
          const sql = `
            SELECT a.payload, r.run_id, r.head_sha
              FROM review_runs r
              JOIN review_run_artifacts a ON a.run_id = r.run_id
             WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
               AND a.stage IN ('arbitration', 'publish', 'arbiter', 'review')
             ORDER BY r.created_at DESC
             LIMIT 1
          `;
          const res = await db.query(sql, [owner, repo, pull_number]);
          rows = res.rows;
        } catch {
          // review_run_artifacts table might not exist
        }
      }

      // 3. Fallback to review_runs.artifacts column
      if (rows.length === 0) {
        try {
          const sql = `
            SELECT r.artifacts AS payload, r.run_id, r.head_sha
              FROM review_runs r
             WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
             ORDER BY r.created_at DESC
             LIMIT 1
          `;
          const res = await db.query(sql, [owner, repo, pull_number]);
          rows = res.rows;
        } catch {
          // Ignore
        }
      }

      if (rows.length === 0 || !rows[0].payload) {
        return buildToolResultJson({
          findings: [],
          total_count: 0,
          unresolved_count: 0,
        } satisfies ReviewFindingsOutput);
      }

      const row = rows[0];
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const runId = String(row.run_id || 'run-1');

      // Extract findings list from possible payload structures
      const rawFindingsList: Array<{ finding: any; personaId: string }> = [];

      if (Array.isArray(payload.findings)) {
        for (const f of payload.findings) {
          rawFindingsList.push({ finding: f, personaId: f.personaId || f.persona || 'reviewer' });
        }
      } else if (payload?.result?.personas && Array.isArray(payload.result.personas)) {
        for (const persona of payload.result.personas) {
          const personaId = String(persona.id || 'reviewer');
          const pFindings = Array.isArray(persona.findings) ? persona.findings : [];
          for (const f of pFindings) {
            rawFindingsList.push({ finding: f, personaId });
          }
        }
      } else if (payload?.personas && Array.isArray(payload.personas)) {
        for (const persona of payload.personas) {
          const personaId = String(persona.id || 'reviewer');
          const pFindings = Array.isArray(persona.findings) ? persona.findings : [];
          for (const f of pFindings) {
            rawFindingsList.push({ finding: f, personaId });
          }
        }
      }

      const adrPattern = /\bADR[-_\s]?#?(\d{3,4})\b/gi;
      const extractedFindings: ReviewFindingItem[] = [];

      for (const { finding: f, personaId } of rawFindingsList) {
        const title = String(f.title || '');
        const body = String(f.body || f.rationale || '');
        const filePath = String(f.path || f.file_path || f.file || '');
        const lineEnd = Number(f.line_end || f.line || 1);
        const lineStart = Number(f.line_start || f.startLine || lineEnd);

        // Severity normalization
        let sev: FindingSeverity = 'P2';
        const rawSev = String(f.severity || '').toUpperCase();
        if (rawSev === 'P0' || rawSev === 'CRITICAL') sev = 'P0';
        else if (rawSev === 'P1' || rawSev === 'HIGH') sev = 'P1';
        else sev = 'P2';

        // ADR citations extraction
        const adrs = new Set<string>();
        if (Array.isArray(f.violated_adrs)) {
          for (const adr of f.violated_adrs) {
            adrs.add(String(adr));
          }
        }
        let m: RegExpExecArray | null;
        const scanText = `${title} ${body} ${f.recommendation || f.suggestion || ''}`;
        while ((m = adrPattern.exec(scanText)) !== null) {
          adrs.add(`ADR ${m[1].padStart(4, '0')}`);
        }

        // Category resolution
        let category: FindingCategory = 'Architecture';
        if (f.category && ['Architecture', 'Security', 'Testing', 'Dependencies', 'Contract'].includes(f.category)) {
          category = f.category as FindingCategory;
        } else if (f.isArchitectural || /arch|layer|design/i.test(personaId) || /architecture/i.test(title)) {
          category = 'Architecture';
        } else if (/sec|auth|crypto|leak/i.test(personaId) || /security|auth/i.test(title)) {
          category = 'Security';
        } else if (/test|spec|assert/i.test(personaId) || /test/i.test(title)) {
          category = 'Testing';
        } else if (/dep|npm|package|upgrade/i.test(personaId) || /dependency|package/i.test(title)) {
          category = 'Dependencies';
        } else if (/contract|schema|telecom|api/i.test(personaId) || /contract/i.test(title)) {
          category = 'Contract';
        }

        const findingId =
          f.finding_id ||
          f.id ||
          createHash('sha256')
            .update(`${runId}:${personaId}:${filePath}:${lineStart}:${lineEnd}:${title}`)
            .digest('hex')
            .slice(0, 16);

        const isUnresolved = f.resolved !== true;

        extractedFindings.push({
          finding_id: findingId,
          severity: sev,
          category,
          title,
          file_path: filePath,
          line_start: lineStart,
          line_end: lineEnd,
          violated_adrs: Array.from(adrs).sort(),
          rationale: body,
          suggested_fix: String(f.suggested_fix || f.suggestion || f.replacementCode || f.recommendation || ''),
          unresolved: isUnresolved,
        });
      }

      let filtered = extractedFindings;
      if (unresolved_only) {
        filtered = filtered.filter((item) => item.unresolved !== false);
      }
      if (severity) {
        filtered = filtered.filter((item) => item.severity === severity);
      }

      return buildToolResultJson({
        findings: filtered,
        total_count: filtered.length,
        unresolved_count: filtered.filter((item) => item.unresolved !== false).length,
      } satisfies ReviewFindingsOutput);
    },
  };
}
