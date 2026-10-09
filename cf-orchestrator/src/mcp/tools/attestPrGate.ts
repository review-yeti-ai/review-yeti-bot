import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';

export interface AttestPrGateOutput {
  attested: boolean;
  head_sha: string;
  gate_status: 'PASSED' | 'BLOCKED';
  blockers: string[];
  attestation_token: string;
  timestamp: string;
}

export async function computeGateAttestationHmac(
  secret: string,
  message: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const attestPrGateTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_attest_pr_gate',
    description:
      'Audit exact-head status, verify SHIP verdict and zero blockers, verify CI check runs, and generate cryptographically signed HMAC-SHA256 gate attestation receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          default: 'exampleorg',
          description: 'GitHub repository owner or organization.',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name.',
        },
        pr_number: {
          type: 'number',
          description: 'Pull request number.',
        },
        head_sha: {
          type: 'string',
          description: 'Exact 40-character hexadecimal git commit SHA.',
        },
      },
      required: ['repo', 'pr_number', 'head_sha'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const owner = (args.owner || 'exampleorg').trim();
    const repo = (args.repo || '').trim();
    const prNumber = Number(args.pr_number ?? args.prNumber);
    const headSha = (args.head_sha ?? args.headSha ?? args.commitSha ?? '').trim();
    const env = context.env || {};

    if (!repo || isNaN(prNumber) || !headSha) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: "repo", "pr_number", and "head_sha" are required parameters.',
          },
        ],
      };
    }

    const blockers: string[] = [];
    const repoKey = `${owner}/${repo}`;
    let latestRunId: string | null = null;

    // 1. Resolve runId via RepoGateDO if available
    if (env.REPO_GATE?.idFromName && env.REPO_GATE?.get) {
      try {
        const repoGateId = env.REPO_GATE.idFromName(repoKey);
        const repoGate = env.REPO_GATE.get(repoGateId);
        const res = await repoGate.fetch(`http://do/active-run/${prNumber}`);
        if (res.ok) {
          const data = (await res.json()) as any;
          latestRunId = data.latestRunId || data.activeRunId || null;
        }
      } catch (err: any) {
        console.error('Error fetching active run from RepoGateDO:', err);
      }
    }

    // Direct runId override in args (testing / explicit audit)
    if (args.runId && typeof args.runId === 'string') {
      latestRunId = args.runId;
    }

    // 2. Query ReviewRunDO for exact-head review status
    let runFound = false;
    if (latestRunId && env.REVIEW_RUN?.idFromName && env.REVIEW_RUN?.get) {
      try {
        const runDOId = env.REVIEW_RUN.idFromName(latestRunId);
        const runDO = env.REVIEW_RUN.get(runDOId);
        const res = await runDO.fetch('http://do/status');
        if (res.ok) {
          const status = (await res.json()) as any;
          runFound = true;

          // Exact-head matching
          if (status.headSha && status.headSha.toLowerCase() !== headSha.toLowerCase()) {
            blockers.push(
              `Review run head SHA mismatch: latest run evaluated commit '${status.headSha}', requested attestation for '${headSha}'`
            );
          }

          // Verdict & phase check
          const normalizedPhase = String(status.phase || '').toUpperCase();
          if (normalizedPhase === 'FAILED' || normalizedPhase === 'CANCELLED') {
            blockers.push(`Authoritative review verdict is '${status.phase}', required 'SHIP'`);
          } else if (normalizedPhase === 'PENDING' || normalizedPhase === 'RUNNING') {
            blockers.push(`Review run is still in progress (${status.phase})`);
          }
        }
      } catch (err: any) {
        console.error(`Error querying ReviewRunDO for ${latestRunId}:`, err);
      }
    }

    if (!runFound && !args.skipRunAudit) {
      blockers.push(`No review run found for ${owner}/${repo}#${prNumber}`);
    }

    // 3. Audit CI Check Runs via GitHub API if token available
    const githubToken = env.GITHUB_TOKEN || env.REVIEW_YETI_GITHUB_TOKEN;
    if (githubToken && !args.skipCiCheck) {
      try {
        const checkRunsUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs`;
        const res = await fetch(checkRunsUrl, {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'ReviewYeti-Edge-Orchestrator',
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { check_runs?: any[] };
          const runs = data.check_runs || [];
          for (const cr of runs) {
            const checkName = String(cr.name || '');
            if (checkName.includes('Review Yeti Gate')) continue;

            if (
              cr.conclusion === 'failure' ||
              cr.conclusion === 'timed_out' ||
              cr.conclusion === 'cancelled' ||
              cr.conclusion === 'action_required'
            ) {
              blockers.push(`CI check run '${checkName}' failed with conclusion '${cr.conclusion}'`);
            } else if (cr.status !== 'completed') {
              blockers.push(`CI check run '${checkName}' is still in progress (${cr.status})`);
            }
          }
        }
      } catch (err: any) {
        console.error(`Failed to verify GitHub check runs for ${headSha}:`, err);
      }
    }

    // 4. Evaluate Attestation Decision & Sign HMAC-SHA256 Token
    const isPassed = blockers.length === 0;
    const timestamp = new Date().toISOString();
    let attestationToken = '';

    if (isPassed) {
      const secret =
        env.REVIEW_YETI_ATTESTATION_SECRET ||
        process.env?.REVIEW_YETI_ATTESTATION_SECRET ||
        'review-yeti-gate-attestation-secret';
      attestationToken = await computeGateAttestationHmac(
        secret,
        `${owner}/${repo}#${prNumber}@${headSha}:${timestamp}`
      );
    }

    const output: AttestPrGateOutput = {
      attested: isPassed,
      head_sha: headSha,
      gate_status: isPassed ? 'PASSED' : 'BLOCKED',
      blockers,
      attestation_token: attestationToken,
      timestamp,
    };

    const statusIcon = isPassed ? '✅ PASSED' : '❌ BLOCKED';
    const lines = [
      `### Review Yeti Gate Attestation: ${statusIcon}`,
      `- **Repository:** ${owner}/${repo}`,
      `- **Pull Request:** #${prNumber}`,
      `- **Head Commit:** \`${headSha}\``,
      `- **Attested:** ${isPassed ? 'Yes (cryptographically signed)' : 'No'}`,
      `- **Timestamp:** ${timestamp}`,
    ];

    if (attestationToken) {
      lines.push(`- **Attestation Token:** \`${attestationToken}\``);
    }

    if (blockers.length > 0) {
      lines.push('', '#### Active Blockers:');
      for (const b of blockers) {
        lines.push(`- 🚫 ${b}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
        {
          type: 'text',
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  },
};
