import { describe, it, expect } from 'vitest';
import {
  createDefaultV3Config,
  normalizeRawConfigToV3,
  isTriggerActionAllowed,
} from '../../src/config/configLoader';
import { DEFAULT_AUTO_REVIEW_TRIGGERS } from '../../src/config/schema';

describe('configLoader — auto_review.triggers & isTriggerActionAllowed', () => {
  describe('createDefaultV3Config', () => {
    it('includes default-on triggers in auto_review', () => {
      const config = createDefaultV3Config();
      expect(config.auto_review.triggers).toEqual(DEFAULT_AUTO_REVIEW_TRIGGERS);
      expect(config.auto_review.triggers).toContain('pr_opened');
      expect(config.auto_review.triggers).toContain('pr_synchronize');
      expect(config.auto_review.triggers).toContain('@ct-review');
    });
  });

  describe('normalizeRawConfigToV3', () => {
    it('preserves custom triggers array when specified', () => {
      const raw = {
        version: 3,
        auto_review: {
          triggers: ['pr_ready'],
        },
      };
      const normalized = normalizeRawConfigToV3(raw);
      expect(normalized.auto_review.triggers).toEqual(['pr_ready']);
    });

    it('falls back to default triggers when auto_review.triggers is omitted', () => {
      const raw = {
        version: 3,
        auto_review: {
          enabled: true,
        },
      };
      const normalized = normalizeRawConfigToV3(raw);
      expect(normalized.auto_review.triggers).toEqual(DEFAULT_AUTO_REVIEW_TRIGGERS);
    });

    it('supports tag-only triggers array', () => {
      const raw = {
        version: 3,
        auto_review: {
          triggers: ['tag'],
        },
      };
      const normalized = normalizeRawConfigToV3(raw);
      expect(normalized.auto_review.triggers).toEqual(['tag']);
    });
  });

  describe('isTriggerActionAllowed', () => {
    describe('default triggers: pr_opened, pr_synchronize, @ct-review', () => {
      const defaultTriggers = DEFAULT_AUTO_REVIEW_TRIGGERS;

      it('allows synchronize action', () => {
        expect(isTriggerActionAllowed(defaultTriggers, 'synchronize')).toBe(true);
        expect(isTriggerActionAllowed(defaultTriggers, 'pr_synchronize')).toBe(true);
      });

      it('allows opened and reopened actions', () => {
        expect(isTriggerActionAllowed(defaultTriggers, 'opened')).toBe(true);
        expect(isTriggerActionAllowed(defaultTriggers, 'pr_opened')).toBe(true);
        expect(isTriggerActionAllowed(defaultTriggers, 'reopened')).toBe(true);
      });

      it('allows ready_for_review action', () => {
        expect(isTriggerActionAllowed(defaultTriggers, 'ready_for_review')).toBe(true);
      });

      it('allows on-demand comment commands', () => {
        expect(isTriggerActionAllowed(defaultTriggers, 'issue_comment', { isCommand: true })).toBe(true);
        expect(isTriggerActionAllowed(defaultTriggers, 'comment')).toBe(true);
      });

      it('allows opt-in label triggers', () => {
        expect(isTriggerActionAllowed(defaultTriggers, 'labeled', { isTag: true })).toBe(true);
      });

      it('falls back to default triggers when triggers parameter is undefined or empty', () => {
        expect(isTriggerActionAllowed(undefined, 'synchronize')).toBe(true);
        expect(isTriggerActionAllowed([], 'synchronize')).toBe(true);
        expect(isTriggerActionAllowed(undefined, 'opened')).toBe(true);
      });
    });

    describe('pr_ready only mode: triggers: [pr_ready]', () => {
      const readyOnlyTriggers = ['pr_ready'];

      it('allows ready_for_review and pr_ready actions', () => {
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'ready_for_review')).toBe(true);
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'pr_ready')).toBe(true);
      });

      it('rejects synchronize and opened actions', () => {
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'synchronize')).toBe(false);
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'opened')).toBe(false);
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'reopened')).toBe(false);
      });

      it('rejects unconfigured comment commands or labels unless specified', () => {
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'issue_comment', { isCommand: true })).toBe(false);
        expect(isTriggerActionAllowed(readyOnlyTriggers, 'labeled', { isTag: true })).toBe(false);
      });
    });

    describe('tag-only mode: triggers: [tag]', () => {
      const tagOnlyTriggers = ['tag'];

      it('allows labeled action with isTag: true', () => {
        expect(isTriggerActionAllowed(tagOnlyTriggers, 'labeled', { isTag: true })).toBe(true);
      });

      it('rejects automatic PR events', () => {
        expect(isTriggerActionAllowed(tagOnlyTriggers, 'synchronize')).toBe(false);
        expect(isTriggerActionAllowed(tagOnlyTriggers, 'opened')).toBe(false);
        expect(isTriggerActionAllowed(tagOnlyTriggers, 'reopened')).toBe(false);
        expect(isTriggerActionAllowed(tagOnlyTriggers, 'ready_for_review')).toBe(false);
      });
    });

    describe('custom action string matching', () => {
      it('allows exact custom action matches', () => {
        expect(isTriggerActionAllowed(['custom_hook_action'], 'custom_hook_action')).toBe(true);
        expect(isTriggerActionAllowed(['custom_hook_action'], 'other_action')).toBe(false);
      });
    });
  });
});
