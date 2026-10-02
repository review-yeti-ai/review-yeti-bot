// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompactionSavingsCard } from '../../../src/components/analytics/CompactionSavingsCard';
import { FindingSeverityChart } from '../../../src/components/analytics/FindingSeverityChart';
import { QualityPolicyMatrix } from '../../../src/components/analytics/QualityPolicyMatrix';
import { TokenBurnChart } from '../../../src/components/analytics/TokenBurnChart';
import { RepoSpendBarChart } from '../../../src/components/analytics/RepoSpendBarChart';

describe('Analytics Dashboard Tremor Suite', () => {
  describe('CompactionSavingsCard', () => {
    it('renders compaction ratio, tokens avoided, and category breakdown', () => {
      const mockSummary = {
        totalReviews: 50,
        totalSpendUsd: 12.5,
        totalTokens: 120000,
        avgLatencyMs: 3200,
      } as any;

      render(<CompactionSavingsCard summary={mockSummary} />);

      expect(screen.getByText(/Cloudflare Edge Context Compaction & Efficiency/i)).toBeInTheDocument();
      expect(screen.getByText('4.2x Compaction')).toBeInTheDocument();
      expect(screen.getByText('4.2x Reduction')).toBeInTheDocument();
      expect(screen.getByText('Tokens Avoided')).toBeInTheDocument();
      expect(screen.getByText('Diff Payload Reduction')).toBeInTheDocument();
      expect(screen.getByText('Lockfiles Bypassed')).toBeInTheDocument();
      expect(screen.getByText('PR Review Context Allocation Breakdown')).toBeInTheDocument();
    });
  });

  describe('FindingSeverityChart', () => {
    it('calculates correct percentages instead of 400% bug', () => {
      render(
        <FindingSeverityChart
          severityCounts={{ P0: 4, P1: 28, P2: 52 }}
          severityRatio={{ p0: 4, p1: 28, p2: 52 }} // Pass integers like the backend was passing
          totalFindings={84}
          acceptanceRate={92.5}
          dismissalRate={7.5}
        />
      );

      expect(screen.getByText(/Finding Severity & Quality Ratio/i)).toBeInTheDocument();
      expect(screen.getByText('P0 Critical (Blocker)')).toBeInTheDocument();
      // 4 / 84 = 4.76% ~ 5%
      expect(screen.getByText('(5%)')).toBeInTheDocument();
      // 28 / 84 = 33.3% ~ 33%
      expect(screen.getByText('(33%)')).toBeInTheDocument();
      // 52 / 84 = 61.9% ~ 62%
      expect(screen.getByText('(62%)')).toBeInTheDocument();

      // No 400% anywhere!
      expect(screen.queryByText('(400%)')).not.toBeInTheDocument();
      expect(screen.getByText(/Accepted \(92.5%\)/i)).toBeInTheDocument();
    });
  });

  describe('QualityPolicyMatrix', () => {
    it('renders all 5 active policy rules and gate metrics', () => {
      render(<QualityPolicyMatrix />);

      expect(screen.getByText('High-Signal Policy & Gate Matrix')).toBeInTheDocument();
      expect(screen.getByText('5 Active Gates')).toBeInTheDocument();
      expect(screen.getByText('AST Token Bound (±3 Lines)')).toBeInTheDocument();
      expect(screen.getByText('Lockfile Noise Bypass')).toBeInTheDocument();
      expect(screen.getByText('Security Arbiter CVE Floor')).toBeInTheDocument();
      expect(screen.getByText('Deterministic Nit Suppression')).toBeInTheDocument();
      expect(screen.getByText('25-Findings Early Exit Gate')).toBeInTheDocument();
      expect(screen.getByText('Avg Gate Precision:')).toBeInTheDocument();
    });
  });

  describe('TokenBurnChart & RepoSpendBarChart', () => {
    it('renders TokenBurnChart with cumulative series header', () => {
      render(
        <TokenBurnChart
          totalTokens={250000}
          promptTokens={180000}
          completionTokens={70000}
          data={[{ timestamp: '2026-10-01', promptTokens: 180000, completionTokens: 70000, totalTokens: 250000, cumulativeTokens: 250000, label: 'Day 1' }]}
        />
      );

      expect(screen.getByText('Token Burn Curves & Accumulation')).toBeInTheDocument();
      expect(screen.getByText('Cumulative Series')).toBeInTheDocument();
    });

    it('renders RepoSpendBarChart with USD ranking and repo bars', () => {
      const mockRepos = [
        { repo: 'reviewyeti-ai/review-yeti-bot', spendUsd: 14.2, reviewCount: 42, avgSpendPerPR: 0.33, totalTokens: 85000 },
        { repo: 'calltelemetry/cisco-cdr', spendUsd: 8.5, reviewCount: 20, avgSpendPerPR: 0.42, totalTokens: 45000 },
      ];

      render(<RepoSpendBarChart data={mockRepos} totalSpendUsd={22.7} monthlyBudgetUsd={500} />);

      expect(screen.getByText('Repository Spend Breakdown')).toBeInTheDocument();
      expect(screen.getByText('USD Ranking')).toBeInTheDocument();
      expect(screen.getByText('$22.70')).toBeInTheDocument();
      expect(screen.getByText('$500')).toBeInTheDocument();
    });
  });
});
