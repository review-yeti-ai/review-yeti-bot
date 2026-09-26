/**
 * REL-1138: one log line when the moderator or arbiter call fails, carrying the sanitized
 * transport cause. Before this, an arbiter `fetch failed` only surfaced folded into
 * `arbiter failed closed: <provider>: fetch failed`, and a moderator failure only as the
 * panel's thrown message, so neither said whether it was a connect timeout, a reset or a
 * stream cut. Lanes log the same fields on their transport-retry lines in `panelEngine`.
 */
import { logger } from '../utils/logger';
import { errorCauseLogFields } from '../utils/errorCause';
import { redactWorkerFailureLogTail } from '../utils/workerFailureLogRedaction';

export type PanelRole = 'moderator' | 'arbiter';

export function logPanelRoleFailure(role: PanelRole, providerId: string, error: unknown): void {
  logger.warn(`Panel ${role} call failed for provider '${providerId}'`, {
    role,
    provider: providerId,
    // Constructor name only: bounded and never free-form provider text.
    errorType: error instanceof Error ? error.constructor.name : typeof error,
    error: redactWorkerFailureLogTail(error instanceof Error ? error.message : String(error)),
    ...errorCauseLogFields(error),
  });
}
