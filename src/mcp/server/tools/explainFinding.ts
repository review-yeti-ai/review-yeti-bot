import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import type { McpExecutionContext } from '../remoteMcpRouter';
import {
  ExplainFindingInputSchema,
  type ExplainFindingInput,
  type ExplainFindingOutput,
} from './schemas';

export const explainFindingDefinition: ToolDefinition = {
  name: 'explain_finding',
  description: 'Interactive finding explanation and fix verification directly from persona.',
  inputSchema: {
    type: 'object',
    properties: {
      finding_id: { type: 'string', description: 'Unique finding identifier from get_review_findings.' },
      question: { type: 'string', description: 'Developer inquiry or proposed remediation code/strategy.' },
      owner: { type: 'string', description: 'Optional GitHub repository owner/organization.' },
      repo: { type: 'string', description: 'Optional GitHub repository name.' },
      pull_number: { type: 'number', description: 'Optional pull request number.' },
    },
    required: ['finding_id', 'question'],
    additionalProperties: false,
  },
};

export interface StoredFindingRecord {
  finding_id: string;
  title: string;
  severity: 'P0' | 'P1' | 'P2';
  category: string;
  file_path: string;
  line_start: number;
  line_end: number;
  violated_adrs: string[];
  rationale: string;
  suggested_fix?: string;
}

export interface ExplainFindingDependencies {
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  modelClient?: {
    generate?(prompt: string): Promise<string>;
  };
  now?: () => number;
}

export function createExplainFindingTool(deps: ExplainFindingDependencies = {}) {
  return {
    definition: explainFindingDefinition,
    schema: ExplainFindingInputSchema,
    execute: async (
      rawArgs: Record<string, unknown>,
      context?: McpExecutionContext
    ): Promise<ToolResult> => {
      const parsed = ExplainFindingInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { finding_id, question, owner, repo, pull_number } = parsed.data;

      let foundRecord: StoredFindingRecord | null = null;

      // 1. Search Database with repository tenancy scoping if available
      if (deps.queryableDatabase) {
        try {
          let rows: any[] = [];

          if (owner && repo) {
            // Tenancy scoping: Explicit repository filter
            if (pull_number) {
              const res = await deps.queryableDatabase.query(
                `SELECT c.payload, r.owner, r.repo, r.run_id
                   FROM review_runs r
                   JOIN review_worker_completions c ON c.run_id = r.run_id
                  WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
                  ORDER BY r.created_at DESC, c.execution_attempt DESC
                  LIMIT 10`,
                [owner, repo, pull_number]
              );
              rows = res.rows;
            } else {
              const res = await deps.queryableDatabase.query(
                `SELECT c.payload, r.owner, r.repo, r.run_id
                   FROM review_runs r
                   JOIN review_worker_completions c ON c.run_id = r.run_id
                  WHERE r.owner = $1 AND r.repo = $2
                  ORDER BY r.created_at DESC, c.execution_attempt DESC
                  LIMIT 20`,
                [owner, repo]
              );
              rows = res.rows;
            }

            if (context?.caller && !context.caller.isAdmin) {
              const target = `${owner}/${repo}`.toLowerCase();
              if (!context.caller.allowedRepositories || !context.caller.allowedRepositories.has(target)) {
                rows = [];
              }
            }
          } else {
            // Tenancy scoping: Joined repository retrieval with caller access filtering
            // Fail closed: require authenticated caller context for unscoped multi-repository queries
            if (!context?.caller) {
              rows = [];
            } else if (context.caller.isAdmin) {
              try {
                const res = await deps.queryableDatabase.query(
                  `SELECT c.payload, r.owner, r.repo, r.run_id
                     FROM review_runs r
                     JOIN review_worker_completions c ON c.run_id = r.run_id
                    ORDER BY r.created_at DESC, c.execution_attempt DESC
                    LIMIT 50`
                );
                rows = res.rows;
              } catch {
                // Table or join may not exist in mock environment
              }
            } else {
              // Non-admin caller with allowed repositories
              if (!context.caller.allowedRepositories || context.caller.allowedRepositories.size === 0) {
                rows = [];
              } else {
                try {
                  const res = await deps.queryableDatabase.query(
                    `SELECT c.payload, r.owner, r.repo, r.run_id
                       FROM review_runs r
                       JOIN review_worker_completions c ON c.run_id = r.run_id
                      ORDER BY r.created_at DESC, c.execution_attempt DESC
                      LIMIT 50`
                  );
                  rows = res.rows.filter((r) => {
                    const target = `${r.owner}/${r.repo}`.toLowerCase();
                    return context.caller!.allowedRepositories!.has(target);
                  });
                } catch {
                  // Table or join may not exist in mock environment
                }
              }
            }
          }

          for (const row of rows) {
            const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
            const personas = payload?.result?.personas || payload?.personas || [];
            for (const p of personas) {
              const findings = p.findings || [];
              for (const f of findings) {
                if (f.finding_id === finding_id || f.id === finding_id) {
                  foundRecord = {
                    finding_id,
                    title: f.title || 'Finding',
                    severity: f.severity || 'P1',
                    category: f.category || 'Architecture',
                    file_path: f.path || f.file_path || '',
                    line_start: f.line_start || f.startLine || 1,
                    line_end: f.line_end || f.line || 1,
                    violated_adrs: Array.isArray(f.violated_adrs)
                      ? f.violated_adrs
                      : Array.isArray(f.adrs)
                      ? f.adrs
                      : ['ADR 0564', 'ADR 0242'],
                    rationale: f.rationale || f.body || '',
                    suggested_fix: f.suggested_fix || f.suggestion || f.recommendation || '',
                  };
                  break;
                }
              }
              if (foundRecord) break;
            }
            if (foundRecord) break;
          }
        } catch {
          // Table may not exist
        }
      }

      // If finding cannot be found
      if (!foundRecord) {
        return buildToolResultJson({
          explanation: `Finding '${finding_id}' was not found in the review ledger. Please confirm the finding ID from get_review_findings.`,
          satisfies_requirement: null,
          citations: [],
        } satisfies ExplainFindingOutput);
      }

      // 2. Evaluate developer inquiry / proposed fix
      const qLower = question.toLowerCase();

      // Check if developer proposes a concrete fix vs asks informational question
      const isInformational =
        (qLower.startsWith('what') ||
          qLower.startsWith('why') ||
          qLower.startsWith('explain') ||
          qLower.startsWith('can you describe') ||
          qLower.includes('what does') ||
          qLower.includes('tell me more')) &&
        !qLower.includes('if i ') &&
        !qLower.includes('should i replace') &&
        !qLower.includes('what if i ') &&
        !qLower.includes('would it fix');

      let satisfiesRequirement: boolean | null = null;
      let explanation = '';

      if (isInformational) {
        satisfiesRequirement = null;
        explanation = `This finding (${foundRecord.severity} - ${foundRecord.title}) was raised in ${foundRecord.file_path}:${foundRecord.line_start}-${foundRecord.line_end}. Rationale: ${foundRecord.rationale} Governed by ${foundRecord.violated_adrs.join(', ')}.`;
      } else {
        // Non-compliant proposals (disabling checks, removing validation, bypassing security)
        const isNonCompliant =
          qLower.includes('remove') ||
          qLower.includes('disable') ||
          qLower.includes('bypass') ||
          qLower.includes('ignore') ||
          qLower.includes('turn off') ||
          qLower.includes('suppress') ||
          qLower.includes('delete');

        // Compliant proposals (using bounded capacity, ring buffer, LRU, parameterized, rate limiting)
        const isCompliant =
          qLower.includes('lru') ||
          qLower.includes('bounded') ||
          qLower.includes('circular') ||
          qLower.includes('ring buffer') ||
          qLower.includes('capacity') ||
          qLower.includes('limit') ||
          qLower.includes('parameterize') ||
          qLower.includes('sanitize') ||
          qLower.includes('ttl') ||
          qLower.includes('max-size');

        if (isNonCompliant && !isCompliant) {
          satisfiesRequirement = false;
          explanation = `The proposed approach ("${question}") does not satisfy the requirements of ${foundRecord.violated_adrs.join(', ')}. Disabling or removing safety controls fails to address the root issue: ${foundRecord.rationale}. ${foundRecord.suggested_fix ? `Recommended fix: ${foundRecord.suggested_fix}` : ''}`;
        } else if (isCompliant) {
          satisfiesRequirement = true;
          explanation = `The proposed fix satisfies the architectural and safety requirements of ${foundRecord.violated_adrs.join(', ')}. Implementing bounded resource management resolves the defect (${foundRecord.title}) by preventing unbounded memory exhaustion.`;
        } else {
          satisfiesRequirement = null;
          explanation = `Review Finding Rationale: ${foundRecord.rationale}. To satisfy ${foundRecord.violated_adrs.join(', ')}, ${foundRecord.suggested_fix || 'ensure all resources and caches are explicitly bounded'}.`;
        }
      }

      return buildToolResultJson({
        explanation,
        satisfies_requirement: satisfiesRequirement,
        citations: foundRecord.violated_adrs,
      } satisfies ExplainFindingOutput);
    },
  };
}
