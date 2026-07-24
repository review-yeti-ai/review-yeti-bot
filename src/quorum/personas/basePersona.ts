import { Persona } from '../../config/schema';
import { PersonaFinding } from '../quorumEngine';

export { PersonaFinding };

export interface PRDiffFile {
  filePath: string;
  patch?: string;
  oldPath?: string;
  newPath?: string;
  content?: string;
}

export interface QuorumReviewContext {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  prTitle: string;
  prBody: string;
  diffFiles: PRDiffFile[];
}

export interface IPersonaRunner {
  persona: Persona;
  getSystemPrompt(): string;
  buildUserPrompt(context: QuorumReviewContext): string;
  parseResponse(rawContent: string, context: QuorumReviewContext): PersonaFinding[];
}
