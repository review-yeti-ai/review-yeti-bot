"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateQuorum = evaluateQuorum;
function evaluateQuorum(input) {
    const approvingPersonas = [];
    const requestingChangesPersonas = [];
    const activeFindings = [];
    const filteredNits = [];
    for (const persona of input.configuredPersonas) {
        const findings = input.personaFindings[persona] || [];
        let hasBlockingFinding = false;
        for (const f of findings) {
            if (f.severity === 'nit') {
                filteredNits.push(f);
            }
            else {
                activeFindings.push(f);
                if (f.severity === 'critical' || f.severity === 'major') {
                    hasBlockingFinding = true;
                }
            }
        }
        if (hasBlockingFinding) {
            requestingChangesPersonas.push(persona);
        }
        else {
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
//# sourceMappingURL=quorumEngine.js.map