import { Persona } from '../../config/schema';
import { PersonaFinding, QuorumReviewContext } from './basePersona';
export declare function extractAndParseJSONFindings(rawContent: string, persona: Persona, context?: QuorumReviewContext): PersonaFinding[];
