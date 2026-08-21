export const PI_STAGES = ['admission', 'snapshot', 'config', 'submodules', 'review', 'arbiter', 'publish', 'complete'] as const;
export type PiStage = typeof PI_STAGES[number];
export type ExecutablePiStage = Exclude<PiStage, 'complete'>;

export interface PiStageContract<Input = unknown, Output = unknown> {
  readonly stage: ExecutablePiStage;
  readonly retryable: boolean;
  readonly validateInput: (input: unknown) => input is Input;
  readonly validateOutput: (output: unknown) => output is Output;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const PI_STAGE_CONTRACTS: Record<ExecutablePiStage, PiStageContract<Record<string, unknown>, Record<string, unknown>>> = {
  admission: { stage: 'admission', retryable: false, validateInput: isRecord, validateOutput: isRecord },
  snapshot: { stage: 'snapshot', retryable: true, validateInput: isRecord, validateOutput: isRecord },
  config: { stage: 'config', retryable: true, validateInput: isRecord, validateOutput: isRecord },
  submodules: { stage: 'submodules', retryable: true, validateInput: isRecord, validateOutput: isRecord },
  review: { stage: 'review', retryable: true, validateInput: isRecord, validateOutput: isRecord },
  arbiter: { stage: 'arbiter', retryable: true, validateInput: isRecord, validateOutput: isRecord },
  publish: { stage: 'publish', retryable: false, validateInput: isRecord, validateOutput: isRecord },
};

const TERMINAL_STAGES = new Set<PiStage>(['complete']);

export function assertStageTransition(current: PiStage, next: PiStage): void {
  const currentIndex = PI_STAGES.indexOf(current);
  const nextIndex = PI_STAGES.indexOf(next);
  if (currentIndex < 0 || nextIndex !== currentIndex + 1) {
    throw new Error(`invalid Pi stage transition ${current} -> ${next}`);
  }
}

export function isTerminalStage(stage: PiStage): boolean {
  return TERMINAL_STAGES.has(stage);
}
