import { CtReviewConfig } from './schema';

export const DEFAULT_ORG_CONFIG: CtReviewConfig = {
  version: '1.0',
  quorum: {
    minApprovals: 2,
    personas: ['security', 'architecture', 'performance', 'quality'],
    effortLevel: 'medium',
  },
  ticketEnforcement: {
    required: true,
    providers: ['linear', 'jira', 'github'],
    patterns: [],
  },
  constitution: {
    enabled: true,
    path: '.github/constitution.md',
  },
};
