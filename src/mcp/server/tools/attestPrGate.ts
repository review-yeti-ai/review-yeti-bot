/**
 * Tool: attest_pr_gate
 *
 * Audit exact-head status, verify SHIP verdict and 0 blockers, verify passing CI check runs,
 * and generate a cryptographically signed HMAC-SHA256 gate attestation receipt.
 */

import { z } from 'zod';
import { createHmac } from 'node:crypto';
import {
  type ToolDefinition,
  type ToolResult,
  type McpExecutionContext,
  buildToolResultJson,
} from '../mcpTypes';
import { canAccessRepository, McpRbacError } from '../mcpRbac';

export const AttestPrGateInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pr_number: z.number().int().positive('pr_number must be a positive integer').safe(),
  head_sha: z.string().trim().regex(/^[a-f0-9]{40}$/i, 'head_sha must be a 40-character hex commit SHA'),
}).strict();

export type AttestPrGateInput = z.infer<typeof AttestPrGateInputSchema>;

export interface AttestPrGateOutput {
  attested: boolean;
  head_sha: string;
  gate_status: 'PASSED' | 'BLOCKED';
  blockers: string[];
  attestation_token: string;
  timestamp: string;
}

export const attestPrGateDefinition: ToolDefinition = {
  name: 'attest_pr_gate',
  description: 'Audit exact-head status, verify SHIP verdict and zero blockers, and generate cryptographic attestation token.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner or organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pr_number: { type: 'number', description: 'Pull request number.' },
      head_sha: { type: 'string', description: 'Exact 40-character hexadecimal git commit SHA.' },
    },
    required: ['owner', 'repo', 'pr_number', 'head_sha'],
    additionalProperties: false,
  },
};

export interface CheckRunItem {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface AttestPrGateDependencies {
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  checkRunsClient?: {
    listCheckRunsForCommit(
      owner: string,
      repo: string,
      commitSha: string
    ): Promise<CheckRunItem[]>;
  };
  attestationSecret?: string;
  now?: () => number;
}

export function createAttestPrGateTool(deps: AttestPrGateDependencies = {}) {
  return {
    definition: attestPrGateDefinition,
    schema: AttestPrGateInputSchema,
    execute: async (
      rawArgs: Record<string, unknown>,
      context?: McpExecutionContext
    ): Promise<ToolResult> => {
      const parsed = AttestPrGateInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pr_number, head_sha } = parsed.data;

      if (context?.caller && !canAccessRepository(context.caller, owner, repo)) {
        throw new McpRbacError(owner, repo);
      }

      const blockers: string[] = [];
      const now = deps.now ? deps.now() : Date.now();
      const timestamp = new Date(now).toISOString();

      let latestRun: any = null;
      let reviewPayload: any = null;

      if (deps.queryableDatabase) {
        try {
          const sql = `
            SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
                   r.stage AS run_stage, g.decision, g.desired_state, c.payload
              FROM review_runs r
              LEFT JOIN review_gate_attempts g ON g.run_id = r.run_id AND g.current_attempt = true
              LEFT JOIN review_worker_completions c ON c.run_id = r.run_id
             WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
             ORDER BY r.created_at DESC, c.execution_attempt DESC
             LIMIT 1
          `;
          const res = await deps.queryableDatabase.query(sql, [owner, repo, pr_number]);
          if (res.rows && res.rows.length > 0) {
            latestRun = res.rows[0];
            reviewPayload = typeof latestRun.payload === 'string'
              ? JSON.parse(latestRun.payload)
              : latestRun.payload;
          }
        } catch {
          // Table fallback
          try {
            const sql = `
              SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
                     r.stage AS run_stage, r.artifacts
                FROM review_runs r
               WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
               ORDER BY r.created_at DESC
               LIMIT 1
            `;
            const res = await deps.queryableDatabase.query(sql, [owner, repo, pr_number]);
            if (res.rows && res.rows.length > 0) {
              latestRun = res.rows[0];
              reviewPayload = typeof latestRun.artifacts === 'string'
                ? JSON.parse(latestRun.artifacts)
                : latestRun.artifacts;
            }
          } catch {
            // Ignore
          }
        }
      }

      // 1. Exact-head matching
      if (!latestRun) {
        blockers.push(`No review run found for ${owner}/${repo}#${pr_number}`);
      } else if (
        String(latestRun.head_sha || '').toLowerCase() !== head_sha.toLowerCase()
      ) {
        blockers.push(
          `Review run head SHA mismatch: latest run evaluated commit '${latestRun.head_sha}', requested attestation for '${head_sha}'`
        );
      }

      // 2. Authoritative verdict verification
      let verdict = 'PENDING';
      let decisionObj: any = null;
      if (latestRun?.decision) {
        if (typeof latestRun.decision === 'string') {
          try {
            decisionObj = JSON.parse(latestRun.decision);
          } catch {
            decisionObj = null;
          }
        } else if (typeof latestRun.decision === 'object') {
          decisionObj = latestRun.decision;
        }
      }
      if (decisionObj?.verdict) {
        verdict = decisionObj.verdict;
      } else if (reviewPayload?.result?.verdict) {
        verdict = reviewPayload.result.verdict;
      } else if (reviewPayload?.verdict) {
        verdict = reviewPayload.verdict;
      } else if (latestRun?.desired_state) {
        verdict = latestRun.desired_state;
      }

      if (verdict !== 'SHIP') {
        blockers.push(`Authoritative review verdict is '${verdict}', required 'SHIP'`);
      }

      // 3. Unresolved P0/P1 blockers audit
      if (reviewPayload) {
        const candidateFindings: any[] = [];
        if (Array.isArray(reviewPayload.findings)) {
          candidateFindings.push(...reviewPayload.findings);
        }
        const personas = reviewPayload.result?.personas || reviewPayload.personas || [];
        for (const p of personas) {
          if (Array.isArray(p.findings)) {
            candidateFindings.push(...p.findings);
          }
        }

        for (const f of candidateFindings) {
          const sev = String(f.severity || '').toUpperCase();
          const isBlockerSev = sev === 'P0' || sev === 'P1' || sev === 'CRITICAL' || sev === 'HIGH';
          const isOverruled = f.status === 'OVERRULED' || f.verdict === 'overruled';
          const isResolved = f.resolved === true || f.status === 'RESOLVED';
          if (isBlockerSev && !isOverruled && !isResolved && f.unresolved !== false) {
            const title = String(f.title || 'Unresolved blocker');
            const file = String(f.path || f.file_path || f.file || 'unknown');
            const line = f.line_start || f.startLine || f.line || 1;
            blockers.push(`[${sev}] ${title} (${file}:${line})`);
          }
        }
      }

      // 4. CI check runs verification
      if (deps.checkRunsClient) {
        try {
          const checkRuns = await deps.checkRunsClient.listCheckRunsForCommit(owner, repo, head_sha);
          for (const cr of checkRuns) {
            if (
              cr.conclusion === 'failure' ||
              cr.conclusion === 'timed_out' ||
              cr.conclusion === 'cancelled' ||
              cr.conclusion === 'action_required'
            ) {
              blockers.push(`CI check run '${cr.name}' failed with conclusion '${cr.conclusion}'`);
            } else if (cr.status !== 'completed') {
              blockers.push(`CI check run '${cr.name}' is still in progress (${cr.status})`);
            }
          }
        } catch (err: any) {
          blockers.push(`Failed to verify CI check runs: ${err.message || String(err)}`);
        }
      }

      // 5. Attestation decision and signing
      const isPassed = blockers.length === 0;
      let attestationToken = '';

      if (isPassed) {
        const secret =
          deps.attestationSecret ||
          process.env.REVIEW_YETI_ATTESTATION_SECRET ||
          'review-yeti-gate-attestation-secret';
        attestationToken = createHmac('sha256', secret)
          .update(`${owner}/${repo}#${pr_number}@${head_sha}:${timestamp}`)
          .digest('hex');
      }

      const result: AttestPrGateOutput = {
        attested: isPassed,
        head_sha,
        gate_status: isPassed ? 'PASSED' : 'BLOCKED',
        blockers,
        attestation_token: attestationToken,
        timestamp,
      };

      return buildToolResultJson(result);
    },
  };
}
