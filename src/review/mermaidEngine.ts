import { parseDiffModules } from './summaryEngine';

export type DiagramType = 'sequenceDiagram' | 'flowchart TD';

export interface DiagramAnalysis {
  isComplex: boolean;
  type: DiagramType;
  files: string[];
  components: string[];
  functions: string[];
  layers: {
    ui: string[];
    api: string[];
    logic: string[];
    data: string[];
  };
  summaryIntent: string;
}

/**
 * Clean sanitization for Mermaid node IDs (alphanumeric only).
 */
function sanitizeMermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Clean label formatting for Mermaid node text.
 */
function sanitizeMermaidLabel(raw: string): string {
  return raw.replace(/["\\[\](){}]/g, '').trim();
}

/**
 * Analyzes PR diff to extract file paths, modified functions, layer subgraphs, and intent.
 */
export function analyzeDiffComplexity(diff: string): DiagramAnalysis {
  if (!diff || typeof diff !== 'string' || diff.trim().length === 0) {
    return {
      isComplex: false,
      type: 'flowchart TD',
      files: [],
      components: [],
      functions: [],
      layers: { ui: [], api: [], logic: [], data: [] },
      summaryIntent: 'Minor patch update',
    };
  }

  const moduleMap = parseDiffModules(diff);
  const files = Array.from(moduleMap.values()).flatMap((m) => m.files);

  // Extract modified file paths from diff headers (e.g. +++ b/src/components/...)
  const fileHeaderRegex = /^\+\+\+\s+b\/(.+)$/gm;
  let fileMatch: RegExpExecArray | null;
  const parsedFiles: string[] = [];
  while ((fileMatch = fileHeaderRegex.exec(diff)) !== null) {
    if (fileMatch[1] && !parsedFiles.includes(fileMatch[1])) {
      parsedFiles.push(fileMatch[1]);
    }
  }

  const fileList = parsedFiles.length > 0 ? parsedFiles : files;

  // Extract function / class / method additions from diff addition lines (+ function ...)
  const functions: string[] = [];
  const functionsSet = new Set<string>();
  const addLineRegex = /^\+\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let)\s+([a-zA-Z0-9_]+)/gm;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = addLineRegex.exec(diff)) !== null) {
    const fnName = fnMatch[1];
    if (fnName && !functionsSet.has(fnName) && fnName.length > 2 && !['string', 'boolean', 'number', 'object', 'void', 'any'].includes(fnName)) {
      functionsSet.add(fnName);
      functions.push(fnName);
    }
  }

  // Categorize modified files into Architecture Subgraphs (UI, API, Logic, Data)
  const layers = {
    ui: [] as string[],
    api: [] as string[],
    logic: [] as string[],
    data: [] as string[],
  };

  const components: string[] = [];
  for (const file of fileList) {
    const filename = file.split('/').pop()?.replace(/\.[a-zA-Z0-9]+$/, '') || file;
    const pascalName = filename.charAt(0).toUpperCase() + filename.slice(1);
    if (!components.includes(pascalName)) {
      components.push(pascalName);
    }

    if (/component|page|view|modal|tab|panel|step|ui/i.test(file)) {
      layers.ui.push(pascalName);
    } else if (/api|route|endpoint|controller|webhook|router/i.test(file)) {
      layers.api.push(pascalName);
    } else if (/schema|store|db|postgres|sqlite|migration|model|repository/i.test(file)) {
      layers.data.push(pascalName);
    } else {
      layers.logic.push(pascalName);
    }
  }

  // Determine primary intent based on diff keywords
  let summaryIntent = 'System Component Update';
  if (/security|auth|jwt|secret|tenant|owasp/i.test(diff)) {
    summaryIntent = 'Security & Authentication Governance';
  } else if (/synthetic|omniRoute|provider|model|llm|kimi/i.test(diff)) {
    summaryIntent = 'AI Provider Routing & Model Ensemble';
  } else if (/database|migration|schema|table|sql/i.test(diff)) {
    summaryIntent = 'Database Schema & Persistence';
  } else if (/ui|dashboard|component|table|modal|theme/i.test(diff)) {
    summaryIntent = 'UI Dashboard & Interaction Polish';
  }

  const isInteraction =
    /fetch|publish|dispatch|completeCheck|execute|postComment|request|reply|eventHandler|handler/i.test(diff) ||
    components.length >= 2;

  const isComplex = fileList.length > 0 || functions.length > 0;
  const type: DiagramType = isInteraction ? 'sequenceDiagram' : 'flowchart TD';

  return { isComplex, type, files: fileList, components, functions, layers, summaryIntent };
}

/**
 * Generates CodeRabbit/Greptile-style dynamic Mermaid architecture diagram mapped directly to the PR's AST changes.
 */
export function generateMermaidDiagram(diff: string): string {
  const analysis = analyzeDiffComplexity(diff);

  if (!analysis.isComplex) {
    return '';
  }

  if (analysis.type === 'sequenceDiagram') {
    // Generate PR-Specific Sequence Diagram
    const participants = analysis.components.length >= 2
      ? analysis.components.slice(0, 4)
      : [...analysis.components, 'Client', 'ReviewBot', 'GitHubAPI'].slice(0, 4);
    const lines: string[] = [
      '```mermaid',
      'sequenceDiagram',
      '    autonumber',
      `    %% PR Goal: ${sanitizeMermaidLabel(analysis.summaryIntent)}`,
    ];

    for (const p of participants) {
      lines.push(`    participant ${p}`);
    }

    if (analysis.components.length < 2) {
      lines.push(`    Client->>ReviewBot: Send Webhook Event`);
      lines.push(`    ReviewBot->>GitHubAPI: Post Review Feedback`);
    } else {
      const p0 = sanitizeMermaidId(participants[0]);
      const p1 = sanitizeMermaidId(participants[1]);

      lines.push(`    ${p0}->>${p1}: Invoke PR Modifications (${sanitizeMermaidLabel(analysis.functions[0] || 'Execute')})`);

      if (participants.length >= 3) {
        const p2 = sanitizeMermaidId(participants[2]);
        lines.push(`    ${p1}->>${p2}: Forward State Change / Payload`);
        lines.push(`    ${p2}-->>${p1}: Confirm Execution / Return Data`);
      }

      lines.push(`    ${p1}-->>${p0}: Complete PR Workflow (${sanitizeMermaidLabel(analysis.summaryIntent)})`);
    }
    lines.push('```');
    return lines.join('\n');
  } else {
    // Generate CodeRabbit / Greptile Style Dynamic Subgraph Flowchart TD
    const lines: string[] = [
      '```mermaid',
      'flowchart TD',
      '    classDef prNode fill:#312e81,stroke:#818cf8,stroke-width:2px,color:#fff;',
      '    classDef modifiedNode fill:#4f46e5,stroke:#a5b4fc,stroke-width:2px,color:#fff;',
      '    classDef dataNode fill:#064e3b,stroke:#34d399,stroke-width:1.5px,color:#fff;',
      '',
      `    PR_Entry["🚀 PR Scope: ${sanitizeMermaidLabel(analysis.summaryIntent)}"]:::prNode`,
    ];

    let lastNodeId = 'PR_Entry';
    const createdNodeIds: string[] = ['PR_Entry'];

    // Layer 1: API / Ingress
    if (analysis.layers.api.length > 0) {
      lines.push('    subgraph API_Layer["🔌 API & Webhook Ingress"]');
      for (const comp of analysis.layers.api.slice(0, 3)) {
        const nodeId = `api_${sanitizeMermaidId(comp)}`;
        lines.push(`        ${nodeId}["${sanitizeMermaidLabel(comp)}"]:::modifiedNode`);
        createdNodeIds.push(nodeId);
      }
      lines.push('    end');
      lines.push(`    ${lastNodeId} --> ${`api_${sanitizeMermaidId(analysis.layers.api[0])}`}`);
      lastNodeId = `api_${sanitizeMermaidId(analysis.layers.api[0])}`;
    }

    // Layer 2: Core Logic / Engines
    if (analysis.layers.logic.length > 0) {
      lines.push('    subgraph Logic_Layer["⚙️ Modified Core Logic"]');
      for (const comp of analysis.layers.logic.slice(0, 4)) {
        const nodeId = `logic_${sanitizeMermaidId(comp)}`;
        const fnLabel = analysis.functions.length > 0 ? ` (${analysis.functions[0]})` : '';
        lines.push(`        ${nodeId}["${sanitizeMermaidLabel(comp)}${fnLabel}"]:::modifiedNode`);
        createdNodeIds.push(nodeId);
      }
      lines.push('    end');
      lines.push(`    ${lastNodeId} --> ${`logic_${sanitizeMermaidId(analysis.layers.logic[0])}`}`);
      lastNodeId = `logic_${sanitizeMermaidId(analysis.layers.logic[0])}`;
    }

    // Layer 3: Persistence / Data
    if (analysis.layers.data.length > 0) {
      lines.push('    subgraph Data_Layer["🗄️ Persistence & State Store"]');
      for (const comp of analysis.layers.data.slice(0, 3)) {
        const nodeId = `data_${sanitizeMermaidId(comp)}`;
        lines.push(`        ${nodeId}["${sanitizeMermaidLabel(comp)}"]:::dataNode`);
        createdNodeIds.push(nodeId);
      }
      lines.push('    end');
      lines.push(`    ${lastNodeId} --> ${`data_${sanitizeMermaidId(analysis.layers.data[0])}`}`);
      lastNodeId = `data_${sanitizeMermaidId(analysis.layers.data[0])}`;
    }

    // Layer 4: UI / Dashboard
    if (analysis.layers.ui.length > 0) {
      lines.push('    subgraph UI_Layer["🖥️ UI & Dashboard View"]');
      for (const comp of analysis.layers.ui.slice(0, 3)) {
        const nodeId = `ui_${sanitizeMermaidId(comp)}`;
        lines.push(`        ${nodeId}["${sanitizeMermaidLabel(comp)}"]:::prNode`);
        createdNodeIds.push(nodeId);
      }
      lines.push('    end');
      lines.push(`    ${lastNodeId} --> ${`ui_${sanitizeMermaidId(analysis.layers.ui[0])}`}`);
    }

    // Fallback if no subgraphs created
    if (createdNodeIds.length === 1) {
      const mainComp = analysis.components[0] || 'CoreModule';
      const secondaryComp = analysis.components[1] || 'StateStore';
      lines.push(`    A["📦 ${sanitizeMermaidLabel(mainComp)}"]:::modifiedNode --> B["🔄 ${sanitizeMermaidLabel(secondaryComp)}"]:::dataNode`);
      lines.push(`    PR_Entry --> A`);
    }

    lines.push('```');
    return lines.join('\n');
  }
}
