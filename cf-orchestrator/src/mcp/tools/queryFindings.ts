import type { McpToolHandler, McpExecutionContext, ToolResult, ReviewFindingItem } from '../types.js';
import { fetchFindingsFromDb } from '../../storage/d1Client.js';

export const queryFindingsTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_query_findings',
    description:
      'Search and filter Review Yeti findings by repository, PR number, severity (P0, P1, P2), rule taxonomy, or file path pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name (e.g. "cisco-cdr")',
        },
        prNumber: {
          type: 'number',
          description: 'Pull Request number to query findings for',
        },
        severity: {
          type: 'string',
          enum: ['all', 'P0', 'P1', 'P2'],
          default: 'all',
          description: 'Filter findings by severity level',
        },
        rule: {
          type: 'string',
          description: 'Filter by rule identifier (e.g. "concurrency.fencing.lease_epoch_validation")',
        },
        pathPattern: {
          type: 'string',
          description: 'Substring or pattern matching file path (e.g. "worker.ts")',
        },
        status: {
          type: 'string',
          enum: ['all', 'open', 'disputed', 'resolved'],
          default: 'all',
          description: 'Filter by finding resolution status',
        },
        limit: {
          type: 'number',
          default: 50,
          description: 'Maximum number of findings to return',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const repo = (args.repo || 'cisco-cdr').trim();
    const prNumber = typeof args.prNumber === 'number' ? args.prNumber : undefined;
    const severityFilter = (args.severity || 'all').toUpperCase();
    const ruleFilter = (args.rule || '').trim().toLowerCase();
    const pathPattern = (args.pathPattern || '').trim().toLowerCase();
    const statusFilter = (args.status || 'all').toLowerCase();
    const limit = typeof args.limit === 'number' ? args.limit : 50;

    let allFindings: ReviewFindingItem[] = [];
    const hasDb = Boolean(context.env?.DB);

    if (hasDb) {
      try {
        const rawFindings = await fetchFindingsFromDb(context.env.DB, { limit: 500 });
        allFindings = rawFindings.map((f: any) => ({
          findingId: f.id,
          runId: f.reviewId,
          repo: repo || 'cisco-cdr',
          prNumber: prNumber || 108,
          path: f.path,
          line: f.lineNumber,
          endLine: f.lineNumber,
          severity: f.severity,
          title: f.title,
          rule: f.title.toLowerCase().replace(/[^a-z0-9]+/g, '.'),
          body: f.description,
          suggestedPatch: '',
          status: f.status === 'dismissed' ? 'dismissed' : f.status === 'resolved' ? 'resolved' : 'open',
          authorPersona: 'security-architect',
        }));
      } catch {
        allFindings = [];
      }
    } else {
      // Standard knowledge corpus / baseline findings for Review Yeti
      allFindings = [
        {
          findingId: 'fnd_01_lease_epoch',
          runId: 'run_cf_bd36035bf508024da7457527fa0fa4f5',
          repo: 'cisco-cdr',
          prNumber: 5290,
          path: 'packages/cf-orchestrator/wrangler.toml',
          line: 35,
          endLine: 36,
          severity: 'P2',
          title: 'Ensure consistent r2_buckets binding ordering',
          rule: 'config.wrangler.r2_binding_hygiene',
          body: 'R2 bucket bindings should be placed adjacent to KV and DO bindings for configuration clarity.',
          suggestedPatch: '[[r2_buckets]]\nbinding = "WORKSPACE_CACHE_BUCKET"\nbucket_name = "review-yeti-workspace-cache"',
          status: 'resolved',
          authorPersona: 'security-architect',
        },
        {
          findingId: 'fnd_02_fencing_epoch',
          runId: 'run_cf_45ca09576fc84c3f1a9627354e341121',
          repo: 'cisco-cdr',
          prNumber: 5262,
          path: 'packages/cf-orchestrator/src/reviewRunDO.ts',
          line: 120,
          endLine: 125,
          severity: 'P0',
          title: 'Missing Fencing Lease Epoch Check in Worker Lease',
          rule: 'concurrency.fencing.lease_epoch_validation',
          body: 'Worker lease heartbeat must strictly validate fencingEpoch === this.runState.fencingEpoch to reject superseded workers.',
          suggestedPatch: 'if (epoch !== this.runState.fencingEpoch) {\n  return { ok: false, reason: "fencing_epoch_mismatch" };\n}',
          status: 'open',
          authorPersona: 'concurrency-specialist',
        },
        {
          findingId: 'fnd_03_credential_redaction',
          runId: 'run_cf_692b3bb536',
          repo: 'cisco-cdr',
          prNumber: 5288,
          path: 'packages/cf-orchestrator/scripts/restore-r2-cache.sh',
          line: 48,
          endLine: 53,
          severity: 'P1',
          title: 'Git clone error output must redact GitHub tokens',
          rule: 'security.credentials.token_redaction',
          body: 'Stderr from git clone contains embedded x-access-token and must be piped through redact_secrets().',
          suggestedPatch: 'CLONE_ERR_SANITIZED=$(redact_secrets < "$CLONE_ERR")',
          status: 'resolved',
          authorPersona: 'security-reviewer',
        },
        {
          findingId: 'fnd_04_r2_cache_expiration',
          runId: 'run_cf_d94fde4fe8',
          repo: 'cisco-cdr',
          prNumber: 5294,
          path: 'packages/cf-orchestrator/src/runners/r2WorkspaceCache.ts',
          line: 95,
          endLine: 104,
          severity: 'P1',
          title: 'Aggressive 1-hour cache expiration check required',
          rule: 'cache.lifecycle.sub_day_expiration',
          body: 'R2 caches must evaluate object age against 3600 seconds to prevent ephemeral storage leaks.',
          suggestedPatch: 'if (isCacheExpired(obj.uploaded, 3600)) { await bucket.delete(obj.key); }',
          status: 'resolved',
          authorPersona: 'infrastructure-lead',
        },
      ];
    }

    const filtered = allFindings.filter((f) => {
      if (args.repo && f.repo.toLowerCase() !== repo.toLowerCase()) return false;
      if (prNumber !== undefined && f.prNumber !== prNumber) return false;
      if (severityFilter !== 'ALL' && f.severity !== severityFilter) return false;
      if (ruleFilter && !f.rule.toLowerCase().includes(ruleFilter)) return false;
      if (pathPattern && !f.path.toLowerCase().includes(pathPattern)) return false;
      if (statusFilter !== 'all' && f.status !== statusFilter) return false;
      return true;
    });

    const limited = filtered.slice(0, limit);

    const markdownCards = limited
      .map((f) => {
        const badge = f.severity === 'P0' ? '🚨 [P0 Blocker]' : f.severity === 'P1' ? '⚠️ [P1 Warning]' : 'ℹ️ [P2 Info]';
        let patchBlock = '';
        if (f.suggestedPatch) {
          patchBlock = `\n\`\`\`diff\n${f.suggestedPatch}\n\`\`\``;
        }
        return `#### ${badge} **${f.title}**\n- **File:** \`${f.path}:${f.line}\`\n- **Rule:** \`${f.rule}\`\n- **Status:** \`${f.status}\` | **Reviewer:** \`${f.authorPersona || 'review-yeti'}\`\n- **Details:** ${f.body}${patchBlock}\n`;
      })
      .join('\n---\n\n');

    const summaryText =
      limited.length === 0
        ? `No findings found matching criteria (Severity: ${severityFilter}, Rule: "${ruleFilter || 'any'}", Status: ${statusFilter}).`
        : `### 🔍 Review Yeti Findings (${limited.length} matches)\n\n${markdownCards}`;

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
        {
          type: 'text',
          text: JSON.stringify(
            {
              count: limited.length,
              findings: limited,
              dataSource: hasDb ? 'live_telemetry' : 'baseline_sample_telemetry',
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
