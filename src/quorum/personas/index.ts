import { Persona } from '../../config/schema';
import { IPersonaRunner } from './basePersona';
import { securityPersona } from './securityPersona';
import { archPersona } from './archPersona';
import { perfPersona } from './perfPersona';
import { qualityPersona } from './qualityPersona';

export * from './basePersona';
export * from './parseHelper';
export * from './securityPersona';
export * from './archPersona';
export * from './perfPersona';
export * from './qualityPersona';

export function getPersonaRunner(persona: Persona): IPersonaRunner {
  switch (persona) {
    case 'security':
      return securityPersona;
    case 'architecture':
      return archPersona;
    case 'performance':
      return perfPersona;
    case 'quality':
    default:
      return qualityPersona;
  }
}
