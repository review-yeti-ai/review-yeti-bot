export const BUILD_PROVENANCE_SCHEMA_VERSION: 'review-yeti-build-provenance.v1';
export const DIRECT_PI_RUNTIME_PACKAGES: readonly [
  '@quintinshaw/pi-dynamic-workflows',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  'typebox',
];

export interface RuntimeGraphPackage {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string | null;
  readonly contentDigest: string;
  readonly dependencies: readonly { readonly name: string; readonly path: string }[];
}

export interface BuildProvenance {
  readonly schema: 'review-yeti-build-provenance.v1';
  readonly runtimeSourceRevision: string;
  readonly directPackages: Readonly<Record<string, Readonly<{ version: string; integrity: string }>>>;
  readonly roots: readonly string[];
  readonly packages: readonly RuntimeGraphPackage[];
  readonly runtimeGraphDigest: string;
}

export function runtimeGraphFromInstall(options: {
  packageRoot: string;
  requireNested?: boolean;
  requireIntegrities?: boolean;
  integrities?: readonly RuntimeGraphPackage[];
}): Readonly<{ roots: readonly string[]; packages: readonly RuntimeGraphPackage[]; digest: string }>;
export function createBuildProvenance(options: { packageRoot: string; runtimeSourceRevision: string; requireNested?: boolean }): BuildProvenance;
export function verifyBuildProvenance(options: { packageRoot: string; provenance: BuildProvenance; requireNested?: boolean }): BuildProvenance;
export function writeBuildProvenance(filePath: string, provenance: BuildProvenance): void;
export function loadBuildProvenance(filePath: string): BuildProvenance;
