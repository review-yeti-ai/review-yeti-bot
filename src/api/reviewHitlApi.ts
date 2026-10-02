import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { requireAuth, AuthenticatedRequest } from './authMiddleware';
import { dashboardStore } from '../persistence/dashboardStore';
import { postgresStore } from '../persistence/postgresStore';
import { computeFindingId } from '../review/findings';
import type { AnchoredFinding } from '../types/diff';
import type { ReviewAuditEvent, PromptGuidanceItem, VerdictOverrideRecord } from '../types/hitl';

export const VALID_TARGET_PERSONAS = [
  'security',
  'architecture',
  'performance',
  'quality',
  'database',
  'api_contract',
  'reliability',
  'devops',
  'docs_compliance',
  'finops',
  'red_team',
] as const;

export function createReviewHitlRouter(): Router {
  const router = Router();

  function validateReviewId(id: string, res: Response): boolean {
    if (!id || typeof id !== 'string' || id.includes('..') || id.includes('/') || id.includes('\\')) {
      res.status(400).json({ success: false, error: 'Malformed or invalid review ID' });
      return false;
    }
    return true;
  }

  function resolveReview(reviewId: string): boolean {
    if (dashboardStore.getGateAttempt(reviewId)) return true;
    if (dashboardStore.getFindings(reviewId).length > 0) return true;
    if (dashboardStore.getPromptGuidance(reviewId).length > 0) return true;
    if (dashboardStore.getAuditTrail(reviewId).length > 0) return true;
    const reviewLogs = dashboardStore.getReviewLogs();
    if (reviewLogs?.some((l) => l.id === reviewId || l.prRun === reviewId || l.prRun?.includes(reviewId))) return true;
    return false;
  }

  // 1. Finding Dismissal
  router.post('/:id/findings/:findingId/dismiss', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId, findingId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    const { reason, dismissedBy } = req.body || {};
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      return res.status(400).json({ success: false, error: 'Dismissal reason is required' });
    }
    if (!dismissedBy || typeof dismissedBy !== 'string' || dismissedBy.trim() === '') {
      return res.status(400).json({ success: false, error: 'dismissedBy is required and cannot be empty' });
    }

    if (!resolveReview(reviewId)) {
      return res.status(404).json({ success: false, error: `Review ${reviewId} not found` });
    }

    const finding = dashboardStore.getFinding(reviewId, findingId);
    if (!finding) {
      return res.status(404).json({ success: false, error: `Finding ${findingId} not found in review ${reviewId}` });
    }

    const actor = dismissedBy.trim();
    const result = dashboardStore.dismissFinding(reviewId, findingId, reason.trim(), actor);

    return res.status(200).json(result);
  });

  // 2. Severity Adjustment (PATCH and POST)
  const severityHandler = async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId, findingId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    const { severity, updatedBy } = req.body || {};
    if (!['P0', 'P1', 'P2'].includes(severity)) {
      return res.status(400).json({ success: false, error: 'Severity must be P0, P1, or P2' });
    }

    if (!resolveReview(reviewId)) {
      return res.status(404).json({ success: false, error: `Review ${reviewId} not found` });
    }

    const finding = dashboardStore.getFinding(reviewId, findingId);
    if (!finding) {
      return res.status(404).json({ success: false, error: `Finding ${findingId} not found` });
    }

    const actor = (typeof updatedBy === 'string' && updatedBy.trim()) || req.user?.username || 'user';
    const result = dashboardStore.updateFindingSeverity(reviewId, findingId, severity, actor);

    return res.status(200).json(result);
  };

  router.patch('/:id/findings/:findingId/severity', requireAuth, severityHandler);
  router.post('/:id/findings/:findingId/severity', requireAuth, severityHandler);

  // 3. Prompt Guidance Injection
  router.post('/:id/guidance', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    const { guidanceText, createdBy, targetPersonas } = req.body || {};
    if (!guidanceText || typeof guidanceText !== 'string' || guidanceText.trim() === '') {
      return res.status(400).json({ success: false, error: 'guidanceText cannot be empty' });
    }
    if (guidanceText.length > 4000) {
      return res.status(400).json({
        success: false,
        error: 'guidanceText exceeds maximum allowed length of 4000 characters',
      });
    }

    if (targetPersonas && Array.isArray(targetPersonas)) {
      const invalid = targetPersonas.filter(
        (p: string) => !(VALID_TARGET_PERSONAS as readonly string[]).includes(p)
      );
      if (invalid.length > 0) {
        return res.status(400).json({ success: false, error: `Invalid target personas: ${invalid.join(', ')}` });
      }
    }

    if (!resolveReview(reviewId)) {
      return res.status(404).json({ success: false, error: `Review ${reviewId} not found` });
    }

    const author = (typeof createdBy === 'string' && createdBy.trim()) || req.user?.username || 'reviewer';
    const item = dashboardStore.addPromptGuidance(reviewId, guidanceText.trim(), author, targetPersonas || []);

    return res.status(201).json({ success: true, guidance: item });
  });

  router.get('/:id/guidance', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    const guidance = dashboardStore.getPromptGuidance(reviewId);
    return res.status(200).json({ success: true, reviewId, guidance });
  });

  // 4. Authoritative Manual Verdict Overrides
  router.post('/:id/override', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    if (req.user?.role === 'viewer') {
      return res.status(403).json({ success: false, error: 'Forbidden: viewer role cannot submit verdict overrides' });
    }

    const { overrideVerdict, reason, overriddenBy } = req.body || {};
    if (!['SHIP', 'BLOCK'].includes(overrideVerdict)) {
      return res.status(400).json({ success: false, error: 'overrideVerdict must be SHIP or BLOCK' });
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      return res.status(400).json({
        success: false,
        error: 'Valid override reason of at least 5 characters is required',
      });
    }

    const gate = dashboardStore.getGateAttempt(reviewId);
    if (!gate && !resolveReview(reviewId)) {
      return res.status(404).json({ success: false, error: `Review gate attempt ${reviewId} not found` });
    }

    const author = (typeof overriddenBy === 'string' && overriddenBy.trim()) || req.user?.username || 'admin';
    const result = dashboardStore.overrideVerdict(reviewId, overrideVerdict, reason.trim(), author);

    return res.status(200).json({
      success: true,
      reviewId,
      overrideVerdict: result.overrideVerdict,
      previousVerdict: result.previousVerdict,
      gateVersion: result.gateVersion,
      status: result.status,
    });
  });

  // 5. Audit Trail History
  router.get('/:id/audit-trail', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    const events = dashboardStore.getAuditTrail(reviewId);
    return res.status(200).json({ success: true, reviewId, events });
  });

  // 6. Findings List
  router.get('/:id/findings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id: reviewId } = req.params;
    if (!validateReviewId(reviewId, res)) return;

    if (!resolveReview(reviewId)) {
      return res.status(404).json({ success: false, error: `Review ${reviewId} not found` });
    }

    const findings = dashboardStore.getFindings(reviewId);
    return res.status(200).json({ success: true, reviewId, findings });
  });

  return router;
}

export { computeFindingId };
