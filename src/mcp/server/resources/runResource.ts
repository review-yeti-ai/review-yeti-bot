import type { ResourceDbClient, ReviewRunResourceData } from './resourceTypes';
import {
  projectReviewStatusPhase,
  projectReviewStatusVerdict,
  matchesReviewStatusIdentity,
} from '../reviewStatusVerdict';

export async function fetchRunResource(
  owner: string,
  repo: string,
  prNumber: number,
  db?: ResourceDbClient
): Promise<ReviewRunResourceData> {
  const uri = `review-yeti://runs/${owner}/${repo}/${prNumber}`;

  if (!db) {
    return {
      uri,
      owner,
      repo,
      pr_number: prNumber,
      found: false,
      run_id: null,
      head_sha: null,
      phase: 'unknown',
      verdict: 'PENDING',
      attempt_id: null,
      check_run: null,
    };
  }

  let result: { rows: any[] };
  try {
    const sql = `
      SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
             r.stage AS run_stage, r.attempt, r.lease_owner, r.lease_expires_at,
             r.created_at, r.updated_at, g.attempt_id, g.check_id, g.desired_state,
             g.decision, g.current_attempt
        FROM review_runs r
        LEFT JOIN review_gate_attempts g ON g.run_id = r.run_id AND g.current_attempt = true
       WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
       ORDER BY r.created_at DESC
       LIMIT 1
    `;
    result = await db.query(sql, [owner, repo, prNumber]);
  } catch {
    // Fallback if review_gate_attempts does not exist in schema
    try {
      const sql = `
        SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
               r.stage AS run_stage, r.attempt, r.lease_owner, r.lease_expires_at,
               r.created_at, r.updated_at, r.artifacts
          FROM review_runs r
         WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
         ORDER BY r.created_at DESC
         LIMIT 1
      `;
      result = await db.query(sql, [owner, repo, prNumber]);
    } catch {
      result = { rows: [] };
    }
  }

  if (!result || !matchesReviewStatusIdentity(result.rows[0], { owner, repo, pullNumber: prNumber })) {
    return {
      uri,
      owner,
      repo,
      pr_number: prNumber,
      found: false,
      run_id: null,
      head_sha: null,
      phase: 'unknown',
      verdict: 'PENDING',
      attempt_id: null,
      check_run: null,
    };
  }

  const row = result.rows[0];

  const phase = projectReviewStatusPhase({
    desiredState: row.desired_state,
    runStatus: row.run_status,
    runStage: row.run_stage,
  });
  const verdict = projectReviewStatusVerdict({
    decision: row.decision,
    desiredState: row.desired_state,
    runStatus: row.run_status,
  });

  const attemptId = row.attempt_id || (row.run_id ? `review-attempt-${prNumber}-${row.attempt || 1}` : null);
  const checkId = row.check_id ? Number(row.check_id) : null;
  const checkRun = checkId
    ? {
        id: checkId,
        url: `https://github.com/${owner}/${repo}/runs/${checkId}`,
        conclusion: ['success', 'failure', 'cancelled', 'timed_out'].includes(row.desired_state)
          ? row.desired_state
          : row.run_status === 'succeeded' || row.run_status === 'complete'
          ? 'success'
          : row.run_status === 'failed'
          ? 'failure'
          : null,
      }
    : null;

  return {
    uri,
    owner,
    repo,
    pr_number: prNumber,
    found: true,
    run_id: row.run_id ? String(row.run_id) : null,
    head_sha: row.head_sha ? String(row.head_sha) : null,
    phase,
    verdict,
    attempt_id: attemptId,
    check_run: checkRun,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
