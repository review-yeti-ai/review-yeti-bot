/** Engine-owned composed review budgets shared with the effective-config receipt. */
export const COMPOSED_ENGINE_MAX_TOTAL_TURNS_HARD_CAP = 200;
export const COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS = 100;
export const COMPOSED_ENGINE_DEFAULT_MAX_TASKS = 8;
export const COMPOSED_PLAN_MAX_TURNS = 4;
export const COMPOSED_TASK_MAX_TURNS = 12;
export const COMPOSED_TASK_MAX_TURNS_HARD_CAP = 18;
export const COMPOSED_TASK_CONCURRENCY_CEILING = 3;

/** Resolve the one shared composed budget; operator overrides remain hard-bounded and policy only lowers. */
export function resolveComposedEngineMaxTurns(
  env: Readonly<Record<string, string | undefined>> = process.env,
  configuredMaxTurnsTotal?: number,
): number {
  const raw = Number(env.COMPOSED_ENGINE_MAX_TURNS);
  if (Number.isSafeInteger(raw) && raw > 0) return Math.min(raw, COMPOSED_ENGINE_MAX_TOTAL_TURNS_HARD_CAP);
  if (Number.isSafeInteger(configuredMaxTurnsTotal) && (configuredMaxTurnsTotal as number) > 0) {
    return Math.min(configuredMaxTurnsTotal as number, COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS);
  }
  return COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS;
}

/** Partition the shared total between investigation work and reserved independent verification. */
export function resolveComposedEngineWorkBudget(
  env: Readonly<Record<string, string | undefined>> = process.env,
  configuredMaxTurnsTotal?: number,
  verificationReserveTurns = 0,
): { totalTurns: number; verificationReserveTurns: number } {
  const configuredTotal = resolveComposedEngineMaxTurns(env, configuredMaxTurnsTotal);
  const reserve = Number.isSafeInteger(verificationReserveTurns) && verificationReserveTurns > 0
    ? Math.min(verificationReserveTurns, Math.max(0, configuredTotal - 1)) : 0;
  return { totalTurns: configuredTotal - reserve, verificationReserveTurns: reserve };
}
