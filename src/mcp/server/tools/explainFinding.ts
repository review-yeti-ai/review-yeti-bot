import { createHash } from 'crypto';
import {
  type ToolDefinition,
  type ToolResult,
  type McpExecutionContext,
  buildToolResultJson,
} from '../mcpTypes';
import { canAccessRepository } from '../mcpRbac';
import {
  ExplainFindingInputSchema,
  type ExplainFindingInput,
  type ExplainFindingOutput,
} from './schemas';
import type { ReviewModelClient } from '../../../gateway/openRouterClient';

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

export interface ExplainFindingModelClient {
  complete?(request: any): Promise<{ content: string }>;
  generate?(prompt: string): Promise<string>;
}

export interface ExplainFindingDependencies {
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  modelClient?: ExplainFindingModelClient | ReviewModelClient;
  model?: string;
  timeoutMs?: number;
  now?: () => number;
}

export const DEFAULT_EXPLAIN_MODEL = 'deepseek/deepseek-v4-flash-0731';

export const EXPLAIN_SYSTEM_PROMPT = `You are Review Yeti's architectural advisor and senior staff engineer powered by DeepSeek.
Your task is to analyze code review findings, explain architectural root causes, and evaluate developer remediation proposals or questions.
You uphold architectural decision records (ADRs), system safety, concurrency boundaries, and resource limits.`;

export function buildExplainPrompt(foundRecord: StoredFindingRecord, question: string): string {
  return `Analyze the following code review finding and developer question/proposal.

FINDING DETAILS:
- ID: ${foundRecord.finding_id}
- Title: ${foundRecord.title}
- Severity: ${foundRecord.severity}
- Category: ${foundRecord.category}
- Location: ${foundRecord.file_path}:${foundRecord.line_start}-${foundRecord.line_end}
- Violated ADRs / Policies: ${foundRecord.violated_adrs.join(', ') || 'None'}
- Finding Rationale: ${foundRecord.rationale}
- Suggested Fix: ${foundRecord.suggested_fix || 'None provided'}

DEVELOPER QUESTION / PROPOSED REMEDIATION:
"${question}"

INSTRUCTIONS:
1. Explain the architectural root cause of why this issue occurs and the risks it poses.
2. Provide concrete remediation options that satisfy the architectural decision records (${foundRecord.violated_adrs.join(', ') || 'governing policies'}).
3. Evaluate whether the developer's question or proposal satisfies the requirements:
   - If the developer is asking an informational/conceptual question (e.g. "What does this mean?", "Why is this an issue?"), set "satisfies_requirement" to null.
   - If the developer proposes a valid fix that eliminates the root cause and complies with ADRs, set "satisfies_requirement" to true.
   - If the developer proposes bypassing, disabling, suppressing, or removing safety checks/validations without fixing the underlying defect, set "satisfies_requirement" to false.
4. List the relevant citations (e.g. violated ADRs or architectural guidelines).

Respond ONLY with valid JSON matching this schema:
{
  "explanation": "Deep architectural root-cause explanation and remediation options...",
  "satisfies_requirement": true | false | null,
  "citations": ["ADR ..."]
}`;
}

export function evaluateWithHeuristics(
  foundRecord: StoredFindingRecord,
  question: string
): { explanation: string; satisfiesRequirement: boolean | null; citations: string[] } {
  const qLower = question.toLowerCase();

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
    const isNonCompliant =
      qLower.includes('remove') ||
      qLower.includes('disable') ||
      qLower.includes('bypass') ||
      qLower.includes('ignore') ||
      qLower.includes('turn off') ||
      qLower.includes('suppress') ||
      qLower.includes('delete');

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

  return {
    explanation,
    satisfiesRequirement,
    citations: foundRecord.violated_adrs,
  };
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

            if (rows.length === 0) {
              try {
                const res = await deps.queryableDatabase.query(
                  pull_number
                    ? `SELECT a.payload, r.owner, r.repo, r.run_id
                         FROM review_runs r
                         JOIN review_run_artifacts a ON a.run_id = r.run_id
                        WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
                        ORDER BY r.created_at DESC
                        LIMIT 10`
                    : `SELECT a.payload, r.owner, r.repo, r.run_id
                         FROM review_runs r
                         JOIN review_run_artifacts a ON a.run_id = r.run_id
                        WHERE r.owner = $1 AND r.repo = $2
                        ORDER BY r.created_at DESC
                        LIMIT 20`,
                  pull_number ? [owner, repo, pull_number] : [owner, repo]
                );
                rows = res.rows;
              } catch {
                // Ignore fallback error
              }
            }

            if (!context?.caller || !canAccessRepository(context.caller, owner, repo)) {
              rows = [];
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
              try {
                const res = await deps.queryableDatabase.query(
                  `SELECT c.payload, r.owner, r.repo, r.run_id
                     FROM review_runs r
                     JOIN review_worker_completions c ON c.run_id = r.run_id
                    ORDER BY r.created_at DESC, c.execution_attempt DESC
                    LIMIT 50`
                );
                rows = res.rows.filter((r) => canAccessRepository(context.caller!, r.owner, r.repo));
              } catch {
                // Table or join may not exist in mock environment
              }
            }
          }

          for (const row of rows) {
            const runId = String(row.run_id || 'run-1');
            const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
            const candidateFindings: any[] = [];

            if (Array.isArray(payload?.findings)) {
              candidateFindings.push(...payload.findings);
            }
            if (Array.isArray(payload?.result?.findings)) {
              candidateFindings.push(...payload.result.findings);
            }
            const personas = payload?.result?.personas || payload?.personas || [];
            for (const p of personas) {
              if (Array.isArray(p.findings)) {
                candidateFindings.push(...p.findings);
              }
            }

            for (const f of candidateFindings) {
              const filePath = String(f.path || f.file_path || f.file || '');
              const lineEnd = Number(f.line_end || f.line || 1);
              const lineStart = Number(f.line_start || f.startLine || lineEnd);
              const title = String(f.title || '');

              const hashId = createHash('sha256')
                .update(`${runId}:${filePath}:${lineStart}:${title}`)
                .digest('hex')
                .slice(0, 16);

              if (f.finding_id === finding_id || f.id === finding_id || hashId === finding_id) {
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
      let output: ExplainFindingOutput | null = null;

      if (deps.modelClient) {
        const model = deps.model || DEFAULT_EXPLAIN_MODEL;
        const timeoutMs = deps.timeoutMs || 10_000;
        const prompt = buildExplainPrompt(foundRecord, question);

        try {
          let rawText: string | undefined;

          if (typeof (deps.modelClient as any).complete === 'function') {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const res = await (deps.modelClient as any).complete({
                model,
                messages: [
                  { role: 'system', content: EXPLAIN_SYSTEM_PROMPT },
                  { role: 'user', content: prompt },
                ],
                temperature: 0.1,
                maxTokens: 1024,
                timeoutMs,
                signal: controller.signal,
              });
              rawText = res.content;
            } finally {
              clearTimeout(timer);
            }
          } else if (typeof (deps.modelClient as any).generate === 'function') {
            rawText = await (deps.modelClient as any).generate(`${EXPLAIN_SYSTEM_PROMPT}\n\n${prompt}`);
          }

          if (rawText) {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed && typeof parsed.explanation === 'string') {
                const satisfies =
                  typeof parsed.satisfies_requirement === 'boolean'
                    ? parsed.satisfies_requirement
                    : null;
                const citations =
                  Array.isArray(parsed.citations) && parsed.citations.length > 0
                    ? parsed.citations
                    : foundRecord.violated_adrs;

                output = {
                  explanation: parsed.explanation,
                  satisfies_requirement: satisfies,
                  citations,
                };
              }
            }
          }
        } catch {
          // Graceful fallback to heuristic evaluation on model failure or timeout
          output = null;
        }
      }

      if (!output) {
        const heuristic = evaluateWithHeuristics(foundRecord, question);
        output = {
          explanation: heuristic.explanation,
          satisfies_requirement: heuristic.satisfiesRequirement,
          citations: heuristic.citations,
        };
      }

      return buildToolResultJson(output satisfies ExplainFindingOutput);
    },
  };
}
