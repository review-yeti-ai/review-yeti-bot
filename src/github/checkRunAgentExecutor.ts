import { CustomCheckDefinition } from '../config/reviewYetiDirLoader';
import { matchesFilePath } from '../memory/prMemoryStore';

export interface CheckRunFindingInput {
  path: string;
  line?: number;
  severity: string;
  title: string;
  body?: string;
  ruleId?: string;
}

export interface CheckRunAgentEvaluation {
  agent: CustomCheckDefinition;
  checkName: string;
  matchedFiles: string[];
  violatingFindings: CheckRunFindingInput[];
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
}

export interface NamedCheckPublisher {
  publishNamedCheck(
    owner: string,
    repo: string,
    headSha: string,
    checkName: string,
    options: {
      conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped';
      title: string;
      summary: string;
    }
  ): Promise<number>;
}

function fileMatchesAgentScope(filePath: string, agent: CustomCheckDefinition): boolean {
  const cleanPath = filePath.replace(/^\.?\//, '');
  if (Array.isArray(agent.exclude) && agent.exclude.some((glob) => matchesFilePath(glob, cleanPath))) {
    return false;
  }
  const scopes = agent.scope && agent.scope.length > 0 ? agent.scope : ['**'];
  return scopes.some((glob) => glob === '**' || glob === '**/*' || matchesFilePath(glob, cleanPath));
}

function findingViolatesAgent(finding: CheckRunFindingInput, agent: CustomCheckDefinition): boolean {
  if (!fileMatchesAgentScope(finding.path, agent)) return false;
  if (finding.ruleId && finding.ruleId.toLowerCase() === agent.id.toLowerCase()) {
    return true;
  }
  const rank: Record<string, number> = { P0: 0, CRITICAL: 0, P1: 1, HIGH: 1, MEDIUM: 1, P2: 2, LOW: 2, P3: 3, NIT: 4 };
  const findingRank = rank[String(finding.severity || 'P2').toUpperCase()] ?? 2;
  const agentRank = rank[agent.severity] ?? 1;
  return findingRank <= agentRank;
}

/**
 * Evaluates each `.reviewyeti/checks/*.md` definition against the PR's changed files and retained findings.
 * Each check definition produces a dedicated Check Run evaluation (`Review Yeti / <agent.name>`).
 */
export function evaluateCheckRunAgents(
  agents: CustomCheckDefinition[],
  changedFilePaths: string[],
  findings: CheckRunFindingInput[]
): CheckRunAgentEvaluation[] {
  const results: CheckRunAgentEvaluation[] = [];

  for (const agent of agents) {
    const checkName = `Review Yeti / ${agent.name}`;
    const matchedFiles = changedFilePaths.filter((p) => fileMatchesAgentScope(p, agent));

    if (matchedFiles.length === 0) {
      results.push({
        agent,
        checkName,
        matchedFiles: [],
        violatingFindings: [],
        conclusion: 'neutral',
        title: `Skipped (0 matching files in scope)`,
        summary: `No changed files matched scope \`${agent.scope.join(', ')}\` for check **${agent.name}** (\`${agent.sourceFile || `.reviewyeti/checks/${agent.id}.md`}\`).`,
      });
      continue;
    }

    const violatingFindings = findings.filter((f) => findingViolatesAgent(f, agent));
    const failed = violatingFindings.length > 0 && agent.action === 'request_changes';
    const conclusion: 'success' | 'failure' = failed ? 'failure' : 'success';
    const title =
      violatingFindings.length === 0
        ? `Passed across ${matchedFiles.length} file(s)`
        : `${violatingFindings.length} finding(s) in ${matchedFiles.length} scoped file(s)`;

    const lines: string[] = [
      `### Check Run Agent: ${agent.name}`,
      `- **Source**: \`${agent.sourceFile || `.reviewyeti/checks/${agent.id}.md`}\``,
      `- **Severity Gate**: \`${agent.severity}\` (${agent.action === 'request_changes' ? 'Blocking' : 'Advisory'})`,
      `- **Matched Files (${matchedFiles.length})**: ${matchedFiles.slice(0, 10).map((f) => `\`${f}\``).join(', ')}`,
      '',
      `**Rule**: ${agent.rule}`,
    ];

    if (violatingFindings.length > 0) {
      lines.push('', '#### Findings');
      for (const f of violatingFindings.slice(0, 10)) {
        lines.push(`- **[${f.severity}]** \`${f.path}${f.line ? `:${f.line}` : ''}\` — ${f.title}`);
      }
    }

    results.push({
      agent,
      checkName,
      matchedFiles,
      violatingFindings,
      conclusion,
      title: title.slice(0, 100),
      summary: lines.join('\n'),
    });
  }

  return results;
}

/**
 * Publishes one GitHub Check Run per active `.reviewyeti/checks/*.md` agent that matched at least one changed file.
 */
export async function publishCheckRunAgents(options: {
  publisher: NamedCheckPublisher;
  owner: string;
  repo: string;
  headSha: string;
  agents: CustomCheckDefinition[];
  changedFilePaths: string[];
  findings: CheckRunFindingInput[];
}): Promise<Array<CheckRunAgentEvaluation & { checkId?: number }>> {
  const evaluations = evaluateCheckRunAgents(options.agents, options.changedFilePaths, options.findings);
  const published: Array<CheckRunAgentEvaluation & { checkId?: number }> = [];

  for (const ev of evaluations) {
    if (ev.matchedFiles.length === 0) {
      published.push(ev);
      continue;
    }
    const checkId = await options.publisher.publishNamedCheck(
      options.owner,
      options.repo,
      options.headSha,
      ev.checkName,
      {
        conclusion: ev.conclusion,
        title: ev.title,
        summary: ev.summary,
      }
    );
    published.push({ ...ev, checkId });
  }

  return published;
}
