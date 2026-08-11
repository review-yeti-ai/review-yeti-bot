export function writeAtomicOutput(targetPath: string, bytes: Uint8Array | string, dependencies?: Record<string, unknown>): Promise<void>;
export function exitCodeForReview(result: Record<string, unknown>): number;
