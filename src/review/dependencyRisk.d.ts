export type DependencySurface = 'manifest-change' | 'lockfile-change' | 'import-contract-change';
export interface DependencyRiskHint { kind: DependencySurface; path: string; unitId?: string; reason: string }
export function classifyDependencySurface(file?: { path?: string; patch?: string }): DependencySurface | null;
export function buildDependencyRiskHints(input?: { files?: Array<{ path?: string; patch?: string }>; unitIdsByPath?: Record<string, string | string[]> | Map<string, string | string[]> }): DependencyRiskHint[];
