export interface PersonaFinding {
  persona: 'security' | 'architecture' | 'performance' | 'quality';
  severity: 'critical' | 'major' | 'minor' | 'nit';
  filePath: string;
  lineNumber: number;
  endLineNumber?: number;
  comment: string;
  codeSnippet?: string;
  suggestion?: string;
  ruleId?: string;
  coSponsoringPersonas?: Array<'security' | 'architecture' | 'performance' | 'quality'>;
}

export interface QuorumEvaluationInput {
  minApprovals: number;
  configuredPersonas: Array<'security' | 'architecture' | 'performance' | 'quality'>;
  personaFindings: Record<string, PersonaFinding[]>;
}

export interface QuorumEvaluationResult {
  decision: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  approvingPersonas: string[];
  requestingChangesPersonas: string[];
  activeFindings: PersonaFinding[];
  filteredNits: PersonaFinding[];
}

export function evaluateQuorum(input: QuorumEvaluationInput): QuorumEvaluationResult {
  const approvingPersonas: string[] = [];
  const requestingChangesPersonas: string[] = [];
  const activeFindings: PersonaFinding[] = [];
  const filteredNits: PersonaFinding[] = [];

  for (const persona of input.configuredPersonas) {
    const findings = input.personaFindings[persona] || [];
    let hasBlockingFinding = false;

    for (const f of findings) {
      if (f.severity === 'nit') {
        filteredNits.push(f);
      } else {
        activeFindings.push(f);
        if (f.severity === 'critical' || f.severity === 'major') {
          hasBlockingFinding = true;
        }
      }
    }

    if (hasBlockingFinding) {
      requestingChangesPersonas.push(persona);
    } else {
      approvingPersonas.push(persona);
    }
  }

  const decision = approvingPersonas.length >= input.minApprovals && requestingChangesPersonas.length === 0
    ? 'APPROVE'
    : 'REQUEST_CHANGES';

  return {
    decision,
    approvingPersonas,
    requestingChangesPersonas,
    activeFindings,
    filteredNits,
  };
}
