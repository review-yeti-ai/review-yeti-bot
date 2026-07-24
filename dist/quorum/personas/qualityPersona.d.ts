import { Persona } from '../../config/schema';
import { IPersonaRunner, QuorumReviewContext, PersonaFinding } from './basePersona';
export declare class QualityPersonaRunner implements IPersonaRunner {
    persona: Persona;
    getSystemPrompt(): string;
    buildUserPrompt(context: QuorumReviewContext): string;
    parseResponse(rawContent: string, context: QuorumReviewContext): PersonaFinding[];
}
export declare const qualityPersona: QualityPersonaRunner;
