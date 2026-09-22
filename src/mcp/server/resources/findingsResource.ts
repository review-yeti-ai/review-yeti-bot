import { createHash } from 'node:crypto';
import type { ResourceDbClient, ReviewFindingResourceItem, ReviewFindingsResourceData } from './resourceTypes';

export async function fetchFindingsResource(
  owner: string,
  repo: string,
  prNumber: number,
  db?: ResourceDbClient
): Promise<ReviewFindingsResourceData> {
  const uri = `review-yeti://findings/${owner}/${repo}/${prNumber}`;

  if (!db) {
    return {
      uri,
      owner,
      repo,
      pr_number: prNumber,
      total_count: 0,
      unresolved_count: 0,
      findings: [],
    };
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
    const res = await db.query(sql, [owner, repo, prNumber]);
    rows = res.rows;
  } catch {
    // review_worker_completions table might not exist in local dev/tests
  }

  // 2. Fallback to review_run_artifacts
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
      const res = await db.query(sql, [owner, repo, prNumber]);
      rows = res.rows;
    } catch {
      // Ignore
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
      const res = await db.query(sql, [owner, repo, prNumber]);
      rows = res.rows;
    } catch {
      // Ignore
    }
  }

  if (rows.length === 0 || !rows[0].payload) {
    return {
      uri,
      owner,
      repo,
      pr_number: prNumber,
      total_count: 0,
      unresolved_count: 0,
      findings: [],
    };
  }

  const row = rows[0];
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const runId = String(row.run_id || 'run-1');

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
  const extractedFindings: ReviewFindingResourceItem[] = [];

  for (const { finding: f, personaId } of rawFindingsList) {
    const title = String(f.title || '');
    const body = String(f.body || f.rationale || '');
    const filePath = String(f.path || f.file_path || f.file || '');
    const lineEnd = Number(f.line_end || f.line || 1);
    const lineStart = Number(f.line_start || f.startLine || lineEnd);

    // Severity normalization
    let sev: 'P0' | 'P1' | 'P2' = 'P2';
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
    let category = 'Architecture';
    if (f.category && typeof f.category === 'string') {
      category = f.category;
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
        .update(`${runId}:${filePath}:${lineStart}:${title}`)
        .digest('hex')
        .slice(0, 16);

    const isOverruled = f.status === 'OVERRULED' || f.verdict === 'overruled';
    const isResolved = f.resolved === true || f.status === 'RESOLVED';
    const unresolved = !(isOverruled || isResolved);

    extractedFindings.push({
      finding_id: findingId,
      severity: sev,
      category,
      title,
      file_path: filePath,
      line_start: lineStart,
      line_end: lineEnd,
      violated_adrs: adrs.size > 0 ? Array.from(adrs) : undefined,
      rationale: body,
      suggested_fix: f.suggested_fix || f.suggestion || f.replacementCode || undefined,
      unresolved,
      status: f.status || (unresolved ? 'OPEN' : 'RESOLVED'),
    });
  }

  const unresolvedCount = extractedFindings.filter((f) => f.unresolved).length;

  return {
    uri,
    owner,
    repo,
    pr_number: prNumber,
    total_count: extractedFindings.length,
    unresolved_count: unresolvedCount,
    findings: extractedFindings,
  };
}
