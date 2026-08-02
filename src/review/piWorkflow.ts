export const PI_STAGES = ['admission', 'snapshot', 'config', 'submodules', 'review', 'arbiter', 'publish', 'complete'] as const;
export type PiStage = typeof PI_STAGES[number];

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
