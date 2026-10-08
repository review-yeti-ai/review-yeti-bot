// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RebaseCacheCard } from '../../src/components/analytics/RebaseCacheCard';
import { FindingLifecycleCard } from '../../src/components/analytics/FindingLifecycleCard';
import { ActiveJobsSidebar } from '../../src/components/live/active-jobs-sidebar';
import type { CheckpointMetricsResponse, IncrementalLifecycleResponse } from '../../src/types/analytics';
import type { LiveJobSummary } from '../../src/types/live';

describe('Next-Gen Analytics & Live Telemetry Frontend Components', () => {
  describe('RebaseCacheCard', () => {
    it('renders skeleton pulse when loading or data is null', () => {
      const { container } = render(<RebaseCacheCard data={null} isLoading={true} />);
      expect(container.querySelector('.animate-pulse')).toBeDefined();
    });

    it('renders checkpoint hit rates and zero-token savings', () => {
      const mockData: CheckpointMetricsResponse = {
        success: true,
        range: '7d',
        totalSubtasks: 100,
        cacheHits: 75,
        cacheMisses: 25,
        hitRatePercent: 75.0,
        zeroTokenReplaysCount: 22,
        tokensSavedTotal: 315000,
        estimatedCostSavedUSD: 0.19,
        avgLatencySavedMs: 11500,
        byLane: {
          security: { hits: 21, misses: 6, hitRate: 75 },
          architecture: { hits: 18, misses: 6, hitRate: 75 },
          performance: { hits: 17, misses: 6, hitRate: 75 },
          quality: { hits: 19, misses: 7, hitRate: 75 },
        },
      };

      render(<RebaseCacheCard data={mockData} isLoading={false} />);

      expect(screen.getByText(/Content-Addressed Subtask Checkpoints/i)).toBeDefined();
      expect(screen.getByText(/75% Cache Hit Rate/i)).toBeDefined();
      expect(screen.getByText(/22 Tasks/i)).toBeDefined();
      expect(screen.getByText('315.0k')).toBeDefined();
      expect(screen.getByText('$0.19')).toBeDefined();
      expect(screen.getByText('11.5s')).toBeDefined();
    });
  });

  describe('FindingLifecycleCard', () => {
    it('renders skeleton pulse when loading or data is null', () => {
      const { container } = render(<FindingLifecycleCard data={null} isLoading={true} />);
      expect(container.querySelector('.animate-pulse')).toBeDefined();
    });

    it('renders Catch-22 preventions and auto-resolved findings', () => {
      const mockData: IncrementalLifecycleResponse = {
        success: true,
        range: '7d',
        recheckLaneRuns: 14,
        catch22Preventions: 14,
        findingsAutoResolvedCount: 38,
        findingsRegressedCount: 2,
        resolutionRatePercent: 95.0,
        avgCommitsToResolution: 1.2,
        priorOpenFindingsTracked: 40,
      };

      render(<FindingLifecycleCard data={mockData} isLoading={false} />);

      expect(screen.getByText(/Finding State Machine & Incremental Recheck Lane/i)).toBeDefined();
      expect(screen.getByText(/Catch-22 Eliminated/i)).toBeDefined();
      expect(screen.getByText('14 Runs')).toBeDefined();
      expect(screen.getByText('38 Findings')).toBeDefined();
      expect(screen.getByText('95% Resolved')).toBeDefined();
      expect(screen.getByText('1.2 Commits')).toBeDefined();
    });
  });

  describe('ActiveJobsSidebar Next-Gen Badges', () => {
    it('renders Recheck Lane, Cached Checkpoints, and Blocker Halt badges', () => {
      const activeJobs: LiveJobSummary[] = [
        {
          jobId: 'job-1',
          repo: 'acme/core',
          prNumber: 101,
          status: 'active',
          personaProgress: {},
          tokenMetrics: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          startTime: new Date().toISOString(),
          eventCount: 5,
          lastEventTime: new Date().toISOString(),
          isIncremental: true,
          recheckLane: true,
          checkpointHits: 3,
          blockerFastPathTriggered: false,
          fileCoveragePercent: 85,
        },
        {
          jobId: 'job-2',
          repo: 'acme/k8s',
          prNumber: 202,
          status: 'completed',
          personaProgress: {},
          tokenMetrics: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
          startTime: new Date().toISOString(),
          eventCount: 8,
          lastEventTime: new Date().toISOString(),
          isIncremental: false,
          recheckLane: false,
          checkpointHits: 0,
          blockerFastPathTriggered: true,
          fileCoveragePercent: 100,
        },
      ];

      render(
        <ActiveJobsSidebar
          currentJobId="job-1"
          onSelectJob={() => {}}
          activeJobs={activeJobs}
        />
      );

      // Verify job 1 badges
      expect(screen.getByText(/⚡ Recheck/i)).toBeDefined();
      expect(screen.getByText(/📦 3 hits/i)).toBeDefined();
      expect(screen.getByText(/Cov: 85%/i)).toBeDefined();

      // Verify job 2 blocker halt badge
      expect(screen.getByText(/🛑 Blocker Halt/i)).toBeDefined();
    });
  });
});
