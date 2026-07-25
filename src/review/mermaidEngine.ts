import { parseDiffModules } from './summaryEngine';

export type DiagramType = 'sequenceDiagram' | 'flowchart TD';

export interface DiagramAnalysis {
  isComplex: boolean;
  type: DiagramType;
  components: string[];
  functions: string[];
}

/**
 * Analyzes diff to determine complexity and diagram type.
 */
export function analyzeDiffComplexity(diff: string): DiagramAnalysis {
  if (!diff || typeof diff !== 'string' || diff.trim().length === 0) {
    return { isComplex: false, type: 'flowchart TD', components: [], functions: [] };
  }

  const moduleMap = parseDiffModules(diff);
  const files = Array.from(moduleMap.values()).flatMap((m) => m.files);

  // Extract function / class / method additions & modifications from diff lines
  const functions: string[] = [];
  const components: string[] = [];

  const funcRegex = /(?:function|class|interface|type|async|const|let|var)\s+([a-zA-Z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(diff)) !== null) {
    if (match[1] && !functions.includes(match[1]) && match[1].length > 2) {
      functions.push(match[1]);
    }
  }

  for (const file of files) {
    const filename = file.split('/').pop()?.replace(/\.[a-zA-Z0-9]+$/, '') || '';
    if (filename && !components.includes(filename)) {
      // Format clean component name (e.g. commentPublisher -> CommentPublisher)
      const pascalName = filename.charAt(0).toUpperCase() + filename.slice(1);
      components.push(pascalName);
    }
  }

  // Detect interaction keywords (HTTP, fetch, event, publish, dispatch, request, reply, call)
  const isInteraction =
    /fetch|publish|dispatch|completeCheck|execute|postComment|request|reply|eventHandler|handler/i.test(
      diff
    ) || components.length >= 2;

  // Detect structural logic (if/else, switch, try/catch, decision, arbiter, status, validate)
  const hasLogicBranches = /if\s*\(|switch\s*\(|try\s*\{|verdict|quorum|status/i.test(diff);

  const isComplex =
    files.length >= 2 ||
    functions.length > 0 ||
    components.length > 0 ||
    diff.includes('class ') ||
    diff.includes('function ') ||
    isInteraction ||
    hasLogicBranches;

  const type: DiagramType = isInteraction ? 'sequenceDiagram' : 'flowchart TD';

  return { isComplex, type, components, functions };
}

/**
 * Generates Mermaid architecture diagram (sequenceDiagram or flowchart TD) wrapped in fenced markdown.
 */
export function generateMermaidDiagram(diff: string): string {
  const analysis = analyzeDiffComplexity(diff);

  if (!analysis.isComplex) {
    return '';
  }

  if (analysis.type === 'sequenceDiagram') {
    const participants =
      analysis.components.length > 0
        ? analysis.components.slice(0, 4)
        : ['Client', 'ReviewBot', 'GitHubAPI'];

    const lines: string[] = ['```mermaid', 'sequenceDiagram', '    autonumber'];

    for (const p of participants) {
      lines.push(`    participant ${p}`);
    }

    if (participants.length >= 2) {
      lines.push(`    ${participants[0]}->>${participants[1]}: Trigger Event / PR Change`);
      if (participants.length >= 3) {
        lines.push(`    ${participants[1]}->>${participants[2]}: Process & Dispatch API Call`);
        lines.push(`    ${participants[2]}-->>${participants[1]}: Return Response Payload`);
      }
      lines.push(`    ${participants[1]}-->>${participants[0]}: Post Review & Status Check`);
    } else {
      lines.push('    Client->>ReviewBot: Send Webhook Event');
      lines.push('    ReviewBot->>GitHubAPI: Post Review Feedback');
    }

    lines.push('```');
    return lines.join('\n');
  } else {
    // flowchart TD
    const nodes =
      analysis.components.length > 0
        ? analysis.components.slice(0, 4)
        : ['PR_Opened', 'Diff_Parsed', 'Persona_Panel', 'Arbiter_Verdict'];

    const lines: string[] = ['```mermaid', 'flowchart TD'];

    if (nodes.length >= 3) {
      lines.push(`    A[${nodes[0]}] --> B[${nodes[1]}]`);
      lines.push(`    B --> C[${nodes[2]}]`);
      if (nodes.length >= 4) {
        lines.push(`    C --> D[${nodes[3]}]`);
      }
    } else {
      lines.push('    A[PR Diff Received] --> B{Complexity Evaluation}');
      lines.push('    B -->|Passed| C[Publish Review]');
      lines.push('    B -->|Failed| D[Fail Closed]');
    }

    lines.push('```');
    return lines.join('\n');
  }
}
