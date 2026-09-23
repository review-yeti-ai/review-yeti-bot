/**
 * Tool: generate_fix_diff
 *
 * Synthesizes an exact unified git diff patch with precise hunk headers (@@ -start,len +start,len @@)
 * from a Review Yeti finding.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  type ToolDefinition,
  type ToolResult,
  type McpExecutionContext,
  buildToolResultJson,
} from '../mcpTypes';
import { canAccessRepository, McpRbacError } from '../mcpRbac';
import type { ReviewModelClient } from '../../../gateway/openRouterClient';

export const GenerateFixDiffInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pr_number: z.number().int().positive('pr_number must be a positive integer').safe(),
  finding_id: z.string().trim().min(1, 'finding_id must not be empty'),
}).strict();

export type GenerateFixDiffInput = z.infer<typeof GenerateFixDiffInputSchema>;

export interface GenerateFixDiffOutput {
  patch: string;
  file_path: string;
  original_lines: string;
  replacement_lines: string;
  explanation: string;
}

export const generateFixDiffDefinition: ToolDefinition = {
  name: 'generate_fix_diff',
  description: 'Synthesizes an exact unified git diff patch with precise hunk headers from a review finding.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner or organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pr_number: { type: 'number', description: 'Pull request number.' },
      finding_id: { type: 'string', description: 'Unique identifier of the finding to generate fix diff for.' },
    },
    required: ['owner', 'repo', 'pr_number', 'finding_id'],
    additionalProperties: false,
  },
};

export interface GenerateFixDiffDependencies {
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  fetchFileLines?: (
    owner: string,
    repo: string,
    filePath: string,
    startLine: number,
    endLine: number
  ) => Promise<string>;
  modelClient?: ReviewModelClient | {
    complete(options: {
      model?: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<{ content: string }>;
  };
  model?: string;
  timeoutMs?: number;
  validatePatch?: boolean;
}

export function validatePatchWithGitApply(
  patch: string,
  filePath: string,
  originalLines: string
): { valid: boolean; error?: string } {
  if (!originalLines) return { valid: true };
  const normPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  const tempDir = mkdtempSync(join(tmpdir(), 'git-apply-val-'));
  try {
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
      if (process.env[k] === '') delete process.env[k];
    }
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Review Yeti" && git config user.email "bot@calltelemetry.com"', { cwd: tempDir, stdio: 'ignore' });
    const fullTarget = join(tempDir, normPath);
    mkdirSync(dirname(fullTarget), { recursive: true });
    const normOrig = originalLines.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    writeFileSync(fullTarget, normOrig.endsWith('\n') ? normOrig : `${normOrig}\n`);
    execSync(`git add "${normPath}" && git commit -m "init"`, { cwd: tempDir, stdio: 'ignore' });

    const patchFile = join(tempDir, 'fix.patch');
    writeFileSync(patchFile, patch);

    try {
      execSync('git apply --unidiff-zero --check fix.patch', { cwd: tempDir, stdio: 'pipe' });
      return { valid: true };
    } catch {
      execSync('git apply --check fix.patch', { cwd: tempDir, stdio: 'pipe' });
      return { valid: true };
    }
  } catch (err: any) {
    return { valid: false, error: err.message };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Safe ignore
    }
  }
}

export function synthesizeUnifiedDiff(
  filePath: string,
  startLine: number,
  originalLines: string,
  replacementLines: string
): string {
  const normPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  const origNorm = originalLines.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const repNorm = replacementLines.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const origTrimmed = origNorm.endsWith('\n') ? origNorm.slice(0, -1) : origNorm;
  const repTrimmed = repNorm.endsWith('\n') ? repNorm.slice(0, -1) : repNorm;

  const origList = origTrimmed.length > 0 ? origTrimmed.split('\n') : [];
  const repList = repTrimmed.length > 0 ? repTrimmed.split('\n') : [];

  const origCount = origList.length;
  const repCount = repList.length;

  const header = `--- a/${normPath}\n+++ b/${normPath}\n@@ -${startLine},${origCount} +${startLine},${repCount} @@\n`;
  const delLines = origList.map((l) => `-${l}`).join('\n');
  const addLines = repList.map((l) => `+${l}`).join('\n');

  let body = '';
  if (origCount > 0 && repCount > 0) {
    body = `${delLines}\n${addLines}\n`;
  } else if (origCount > 0) {
    body = `${delLines}\n`;
  } else if (repCount > 0) {
    body = `${addLines}\n`;
  }

  return `${header}${body}`;
}

export function createGenerateFixDiffTool(deps: GenerateFixDiffDependencies = {}) {
  return {
    definition: generateFixDiffDefinition,
    schema: GenerateFixDiffInputSchema,
    execute: async (
      rawArgs: Record<string, unknown>,
      context?: McpExecutionContext
    ): Promise<ToolResult> => {
      const parsed = GenerateFixDiffInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pr_number, finding_id } = parsed.data;

      if (context?.caller && !canAccessRepository(context.caller, owner, repo)) {
        throw new McpRbacError(owner, repo);
      }

      let matchedFinding: any = null;
      let runId = 'run-1';

      if (deps.queryableDatabase) {
        let rows: any[] = [];
        try {
          const sql = `
            SELECT c.payload, r.run_id, r.head_sha
              FROM review_runs r
              JOIN review_worker_completions c ON c.run_id = r.run_id
             WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
             ORDER BY r.created_at DESC, c.execution_attempt DESC
             LIMIT 5
          `;
          const res = await deps.queryableDatabase.query(sql, [owner, repo, pr_number]);
          rows = res.rows;
        } catch {
          // Table may not exist or query error
        }

        // Fallback to review_run_artifacts
        if (rows.length === 0) {
          try {
            const sql = `
              SELECT a.payload, r.run_id, r.head_sha
                FROM review_runs r
                JOIN review_run_artifacts a ON a.run_id = r.run_id
               WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
               ORDER BY r.created_at DESC
               LIMIT 5
            `;
            const res = await deps.queryableDatabase.query(sql, [owner, repo, pr_number]);
            rows = res.rows;
          } catch {
            // Ignore
          }
        }

        for (const row of rows) {
          runId = String(row.run_id || runId);
          const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          const candidateFindings: any[] = [];

          if (Array.isArray(payload?.findings)) {
            candidateFindings.push(...payload.findings);
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

            if (
              f.finding_id === finding_id ||
              f.id === finding_id ||
              hashId === finding_id
            ) {
              matchedFinding = f;
              break;
            }
          }
          if (matchedFinding) break;
        }
      }

      if (!matchedFinding) {
        throw new Error(
          `Finding '${finding_id}' was not found in review ledger for ${owner}/${repo}#${pr_number}`
        );
      }

      const filePath = String(
        matchedFinding.path || matchedFinding.file_path || matchedFinding.file || 'unknown'
      );
      const lineEnd = Number(matchedFinding.line_end || matchedFinding.line || 1);
      const lineStart = Number(matchedFinding.line_start || matchedFinding.startLine || lineEnd);

      let originalLines = '';
      if (typeof matchedFinding.originalCode === 'string') {
        originalLines = matchedFinding.originalCode;
      } else if (typeof matchedFinding.original_lines === 'string') {
        originalLines = matchedFinding.original_lines;
      } else if (typeof matchedFinding.codeSnippet === 'string') {
        originalLines = matchedFinding.codeSnippet;
      } else if (deps.fetchFileLines) {
        try {
          originalLines = await deps.fetchFileLines(owner, repo, filePath, lineStart, lineEnd);
        } catch {
          originalLines = '';
        }
      }

      let staticReplacement: string | undefined = undefined;
      if (typeof matchedFinding.replacementCode === 'string') {
        staticReplacement = matchedFinding.replacementCode;
      } else if (typeof matchedFinding.fixOptions?.[0]?.suggestionCode === 'string') {
        staticReplacement = matchedFinding.fixOptions[0].suggestionCode;
      } else if (typeof matchedFinding.suggestion === 'string') {
        staticReplacement = matchedFinding.suggestion;
      } else if (typeof matchedFinding.suggested_fix === 'string') {
        staticReplacement = matchedFinding.suggested_fix;
      }

      const staticExplanation = String(
        matchedFinding.fixOptions?.[0]?.explanation ||
        matchedFinding.body ||
        matchedFinding.rationale ||
        matchedFinding.title ||
        'Automated fix suggested by Review Yeti'
      );

      let replacementLines = staticReplacement ?? '';
      let explanation = staticExplanation;
      let patch = synthesizeUnifiedDiff(filePath, lineStart, originalLines, replacementLines);

      if (deps.modelClient) {
        const timeoutMs = deps.timeoutMs || 10_000;
        const activeModel = deps.model || 'deepseek/deepseek-v4-flash-0731';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const prompt = `You are Review Yeti's automated code fix generator powered by DeepSeek.
Your task is to synthesize a high-quality, minimal, syntax-valid code fix for the specified finding.

Context:
- Repository: ${owner}/${repo} (PR #${pr_number})
- File: ${filePath}
- Target Line Range: ${lineStart}-${lineEnd}
- Finding Title: ${matchedFinding.title || 'Finding'}
- Severity: ${matchedFinding.severity || 'P1'}
- Category: ${matchedFinding.category || 'General'}
- Rationale: ${matchedFinding.rationale || matchedFinding.body || 'No rationale provided'}
- Violated ADRs: ${(matchedFinding.violated_adrs || []).join(', ') || 'None'}
- Prior Suggestion: ${staticReplacement || 'None'}

Original Code snippet (lines ${lineStart}-${lineEnd}):
\`\`\`
${originalLines}
\`\`\`

Instructions:
1. Synthesize the minimal replacement lines of code to fix the issue cleanly, safely, and idiomatically.
2. Preserve exact indentation, whitespace style, and language idioms for ${filePath}.
3. Do NOT include markdown blocks or surrounding commentary in the replacement_lines field itself.
4. Respond ONLY with a valid JSON object matching this schema:
{
  "replacement_lines": "<exact replacement code string>",
  "explanation": "<concise explanation of why this fix resolves the defect>"
}`;

        try {
          const response = await deps.modelClient.complete({
            model: activeModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            maxTokens: 1024,
            timeoutMs,
            signal: controller.signal,
          });

          const content = (response.content || '').trim();
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (typeof parsed.replacement_lines === 'string') {
              const modelRepLines = parsed.replacement_lines;
              const modelExplanation = typeof parsed.explanation === 'string' ? parsed.explanation : staticExplanation;
              const candidatePatch = synthesizeUnifiedDiff(filePath, lineStart, originalLines, modelRepLines);

              let isValid = true;
              if (deps.validatePatch !== false) {
                const valResult = validatePatchWithGitApply(candidatePatch, filePath, originalLines);
                isValid = valResult.valid;
              }

              if (isValid) {
                replacementLines = modelRepLines;
                explanation = modelExplanation;
                patch = candidatePatch;
              }
            }
          }
        } catch {
          // Graceful fallback to static replacement lines on timeout, exception, or rejection
        } finally {
          clearTimeout(timeoutId);
        }
      }

      const result: GenerateFixDiffOutput = {
        patch,
        file_path: filePath,
        original_lines: originalLines,
        replacement_lines: replacementLines,
        explanation,
      };

      return buildToolResultJson(result);
    },
  };
}
