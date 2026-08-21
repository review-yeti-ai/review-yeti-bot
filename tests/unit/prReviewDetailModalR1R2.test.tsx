// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PRReviewDetailModal } from '../../src/components/dashboard/pr-review-detail-modal';
import { RecentReviewsTable } from '../../src/components/dashboard/recent-reviews-table';
import { ReviewJob } from '../../src/types/dashboard';

const mockJob: ReviewJob = {
  id: 'job-test-3050',
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 3050,
  title: 'feat(ingestion): refactor CDR payload parsing pipeline',
  verdict: 'SHIP',
  status: 'completed',
  personas: ['security', 'architecture', 'performance', 'quality', 'database'],
  tokens: 45000,
  cost: 0.45,
  latencyMs: 3200,
  timestamp: 'Just now',
  headSha: 'a8f192b',
  quorum: '5/5',
  personaLogs: [
    {
      persona: 'security',
      displayName: 'Security Agent',
      decision: 'SHIP',
      confidence: 0.98,
      latencyMs: 640,
      model: 'claude-3-5-sonnet',
      summary: 'Verified zero multi-tenant boundary leaks and token security.',
      reasoningChain: [
        'Inspected pull request diff for memory leaks and token leakage.',
        'Validated zero security boundary leaks across modified modules.',
        'Verified cryptographic timing safety on HMAC signatures.',
      ],
      outputLog: '[PERSONA_START] Security Agent\n[VERDICT] SHIP (Confidence: 98%)\n[STATUS] Passed',
      nits: [
        {
          filePath: 'src/auth/jwt.ts',
          lineNumber: 42,
          severity: 'P1',
          title: 'Timing attack vulnerability in signature verification',
          description: 'Direct string comparison === can leak signature timing details.',
          suggestion: 'Use crypto.timingSafeEqual(bufferA, bufferB) for constant-time comparisons.',
        },
      ],
    },
    {
      persona: 'architecture',
      displayName: 'Architecture Agent',
      decision: 'SHIP',
      confidence: 0.92,
      latencyMs: 710,
      model: 'deepseek-v3',
      summary: 'Validated AST schema compatibility across changed modules.',
      reasoningChain: [
        'Extracted modified AST symbols and checked layer separation.',
        'Confirmed modular structure conforms to architecture guidelines.',
      ],
      outputLog: '[PERSONA_START] Architecture Agent\n[VERDICT] SHIP (Confidence: 92%)',
      nits: [
        {
          filePath: 'src/services/pipeline.ts',
          lineNumber: 88,
          severity: 'P2',
          title: 'Inline transformation breaks single responsibility',
          description: 'Decouple transformation from transport handler.',
          suggestion: 'Refactor inline transformation into a dedicated PipelineMiddleware helper.',
        },
      ],
    },
  ],
};

describe('Requirements R1 & R2: PR Review Detail Modal & GitHub PR Direct Links', () => {
  describe('Requirement R1: Collapsible Logs, Reasoning Chains, Model Tags & Code Nits Inspector', () => {
    it('renders modal with reviewer persona log headers and model tags', () => {
      render(<PRReviewDetailModal job={mockJob} open={true} onOpenChange={() => {}} />);

      expect(screen.getByText('calltelemetry/cisco-cdr')).toBeInTheDocument();
      expect(screen.getByText('#3050')).toBeInTheDocument();
      expect(screen.getAllByText('feat(ingestion): refactor CDR payload parsing pipeline').length).toBeGreaterThan(0);

      // Check model tags are rendered
      expect(screen.getAllByText('claude-3-5-sonnet').length).toBeGreaterThan(0);
      expect(screen.getAllByText('deepseek-v3').length).toBeGreaterThan(0);

      // Check confidence scores are rendered
      expect(screen.getAllByText('98%').length).toBeGreaterThan(0);
      expect(screen.getAllByText('92%').length).toBeGreaterThan(0);
    });

    it('expands collapsible reviewer output logs, reasoning chain, and code nits when clicked', () => {
      render(<PRReviewDetailModal job={mockJob} open={true} onOpenChange={() => {}} />);

      // Initially expanded details should not be visible before click
      expect(screen.queryByText('Timing attack vulnerability in signature verification')).not.toBeInTheDocument();

      // Click security persona card to expand
      const securityCard = screen.getAllByText('Security Agent')[0];
      fireEvent.click(securityCard);

      // Verify raw agent output log is rendered
      expect(screen.getByText(/Reviewer Output Log \(Model Tag: claude-3-5-sonnet\)/i)).toBeInTheDocument();
      expect(screen.getByText(/\[PERSONA_START\] Security Agent/i)).toBeInTheDocument();

      // Verify detailed reasoning chain is rendered
      expect(screen.getByText('Detailed Reasoning Chain & Step-by-Step Evaluation')).toBeInTheDocument();
      expect(screen.getByText('Inspected pull request diff for memory leaks and token leakage.')).toBeInTheDocument();
      expect(screen.getByText('Verified cryptographic timing safety on HMAC signatures.')).toBeInTheDocument();

      // Verify line-by-line Code Nits Inspector is rendered
      expect(screen.getByText('Code Nits & Line-by-Line Inspector')).toBeInTheDocument();
      expect(screen.getByText('src/auth/jwt.ts')).toBeInTheDocument();
      expect(screen.getByText(': Line 42')).toBeInTheDocument();
      expect(screen.getByText('P1 - Warning')).toBeInTheDocument();
      expect(screen.getByText('Timing attack vulnerability in signature verification')).toBeInTheDocument();
      expect(screen.getByText(/crypto\.timingSafeEqual\(bufferA, bufferB\)/)).toBeInTheDocument();
    });

    it('falls back gracefully to default reasoning chains, model tags, and nits when personaLogs is empty', () => {
      const jobWithoutLogs: ReviewJob = {
        ...mockJob,
        personaLogs: undefined,
        personas: ['security', 'architecture', 'performance', 'quality', 'database'],
      };

      render(<PRReviewDetailModal job={jobWithoutLogs} open={true} onOpenChange={() => {}} />);

      // Verify default model tags are rendered for included personas (security, performance, quality, database)
      expect(screen.getAllByText(/claude/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText('glm-5.2').length).toBeGreaterThan(0);
      expect(screen.getAllByText('gpt-4o').length).toBeGreaterThan(0);

      // Expand quality persona
      const qualityCard = screen.getAllByText('Quality')[0];
      fireEvent.click(qualityCard);

      // Verify reasoning chain & nits are populated
      expect(screen.getByText('Detailed Reasoning Chain & Step-by-Step Evaluation')).toBeInTheDocument();
      expect(screen.getByText('Code Nits & Line-by-Line Inspector')).toBeInTheDocument();
    });
  });

  describe('Requirement R2: Direct GitHub PR Links', () => {
    it('renders prominent "View PR on GitHub ↗" button in PRReviewDetailModal header with correct URL', () => {
      render(<PRReviewDetailModal job={mockJob} open={true} onOpenChange={() => {}} />);

      const modalLink = screen.getByTestId('github-pr-link-modal');
      expect(modalLink).toBeInTheDocument();
      expect(modalLink).toHaveAttribute(
        'href',
        'https://github.com/calltelemetry/cisco-cdr/pull/3050'
      );
      expect(modalLink).toHaveAttribute('target', '_blank');
      expect(modalLink.textContent).toContain('View PR on GitHub ↗');
    });

    it('renders "View PR on GitHub ↗" link buttons in RecentReviewsTable rows with correct URL', () => {
      render(<RecentReviewsTable jobs={[mockJob]} />);

      const tableLinks = screen.getAllByTestId('github-pr-link-table');
      expect(tableLinks.length).toBeGreaterThan(0);
      expect(tableLinks[0]).toHaveAttribute(
        'href',
        'https://github.com/calltelemetry/cisco-cdr/pull/3050'
      );
      expect(tableLinks[0]).toHaveAttribute('target', '_blank');
      expect(tableLinks[0].textContent).toContain('View PR on GitHub ↗');
    });

    it('formats github URL correctly when repo parameter contains owner/repo or separate owner', () => {
      const customJob: ReviewJob = {
        ...mockJob,
        repo: 'custom-org/my-app',
        prNumber: 999,
      };

      render(<RecentReviewsTable jobs={[customJob]} />);

      const tableLinks = screen.getAllByTestId('github-pr-link-table');
      expect(tableLinks[0]).toHaveAttribute(
        'href',
        'https://github.com/custom-org/my-app/pull/999'
      );
    });
  });

  describe('Requirement R4: Session Metadata Refactor — Turn Progress Bar, Timeline & Findings Delta', () => {
    it('renders TurnProgressBar and FindingsDeltaCard in PRReviewDetailModal', () => {
      const jobWithMetadata: ReviewJob = {
        ...mockJob,
        findingsDelta: {
          initialFindings: 4,
          latestFindings: 1,
          resolvedFindings: 3,
          newFindings: 0,
          persistentFindings: 1,
          netChange: -3,
        },
        personaLogs: [
          {
            ...mockJob.personaLogs![0],
            turnsCount: 4,
            turns: [
              {
                turn: 1,
                action: 'analyze_diff',
                input: { path: 'src/auth/jwt.ts' },
                output: 'Found 1 timing attack nit',
                timestamp: '2026-07-31T22:00:00Z',
                tokensBurned: 1200,
                latencyMs: 300,
              },
            ],
          },
        ],
      };

      render(<PRReviewDetailModal job={jobWithMetadata} open={true} onOpenChange={() => {}} />);

      // Verify FindingsDeltaCard is rendered
      expect(screen.getByTestId('findings-delta-card')).toBeInTheDocument();
      expect(screen.getByTestId('resolved-findings').textContent).toBe('3');

      // Verify TurnProgressBar is rendered
      const progressBars = screen.getAllByTestId('turn-progress-bar');
      expect(progressBars.length).toBeGreaterThan(0);

      // Expand persona to inspect timeline
      const securityCard = screen.getAllByText('Security Agent')[0];
      fireEvent.click(securityCard);

      // Verify SessionTurnTimeline is rendered inside expanded persona log
      expect(screen.getByTestId('session-turn-timeline')).toBeInTheDocument();
      expect(screen.getByText('Turn #1')).toBeInTheDocument();
      expect(screen.getByText('analyze_diff')).toBeInTheDocument();
    });
  });
});
