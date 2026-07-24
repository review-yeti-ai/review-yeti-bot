"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPersonaRunner = getPersonaRunner;
const securityPersona_1 = require("./securityPersona");
const archPersona_1 = require("./archPersona");
const perfPersona_1 = require("./perfPersona");
const qualityPersona_1 = require("./qualityPersona");
__exportStar(require("./basePersona"), exports);
__exportStar(require("./parseHelper"), exports);
__exportStar(require("./securityPersona"), exports);
__exportStar(require("./archPersona"), exports);
__exportStar(require("./perfPersona"), exports);
__exportStar(require("./qualityPersona"), exports);
function getPersonaRunner(persona) {
    switch (persona) {
        case 'security':
            return securityPersona_1.securityPersona;
        case 'architecture':
            return archPersona_1.archPersona;
        case 'performance':
            return perfPersona_1.perfPersona;
        case 'quality':
        default:
            return qualityPersona_1.qualityPersona;
    }
}
//# sourceMappingURL=index.js.map