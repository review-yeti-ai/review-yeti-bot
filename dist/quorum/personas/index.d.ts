import { Persona } from '../../config/schema';
import { IPersonaRunner } from './basePersona';
export * from './basePersona';
export * from './parseHelper';
export * from './securityPersona';
export * from './archPersona';
export * from './perfPersona';
export * from './qualityPersona';
export declare function getPersonaRunner(persona: Persona): IPersonaRunner;
