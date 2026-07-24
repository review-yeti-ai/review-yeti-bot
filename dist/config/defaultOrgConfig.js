"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ORG_CONFIG = void 0;
exports.DEFAULT_ORG_CONFIG = {
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
//# sourceMappingURL=defaultOrgConfig.js.map