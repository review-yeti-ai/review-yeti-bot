// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OrgSelector } from '../../src/components/repos/org-selector';
import { RepoGrid } from '../../src/components/repos/repo-grid';
import { ActivePrTable } from '../../src/components/repos/active-pr-table';
import { ReviewRulesModal } from '../../src/components/repos/review-rules-modal';
import ReposPage from '../../src/app/repos/page';
import * as apiClient from '../../src/lib/api-client';
import { RepositorySetting, GitHubOrganizationSummary, ActivePullRequestSummary, RepositoryReviewRules } from '../../src/types/dashboard';

vi.mock('../../src/lib/api-client', () => ({
  fetchRepositories: vi.fn(),
  updateRepository: vi.fn(),
  createRepository: vi.fn(),
  runOnboardingScan: vi.fn(),
  fetchGitHubOrgs: vi.fn(),
  fetchGitHubRepos: vi.fn(),
  fetchRepoPullRequests: vi.fn(),
  fetchRepositoryPullRequests: vi.fn(),
  triggerPullRequestReview: vi.fn(),
  fetchRepositoryReviewRules: vi.fn(),
  updateRepositoryReviewRules: vi.fn(),
}));

const mockOrgs: GitHubOrganizationSummary[] = [
  {
    id: 1,
    login: 'exampleorg',
    name: 'Exampleorg Org',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1000',
    totalReposCount: 8,
    monitoredCount: 5,
  },
  {
    id: 2,
    login: 'acme-corp',
    name: 'Acme Corp',
    avatarUrl: '',
    totalReposCount: 12,
    monitoredCount: 3,
  },
];

const mockRepos: RepositorySetting[] = [
  {
    owner: 'exampleorg',
    repo: 'example-api',
    automationEnabled: true,
    generateArchitecturalFlowchart: true,
    customProfile: 'balanced',
    lastVerdict: 'SHIP',
    lastReviewAt: '2026-10-01T08:00:00Z',
    updatedAt: '2026-10-01T08:00:00Z',
  },
  {
    owner: 'exampleorg',
    repo: 'review-yeti',
    automationEnabled: false,
    generateArchitecturalFlowchart: false,
    customProfile: 'assertive',
    lastVerdict: 'BLOCK',
    lastReviewAt: '2026-10-01T07:30:00Z',
    updatedAt: '2026-10-01T07:30:00Z',
  },
  {
    owner: 'acme-corp',
    repo: 'billing-engine',
    automationEnabled: true,
    generateArchitecturalFlowchart: true,
    customProfile: 'chill',
    updatedAt: '2026-10-01T06:00:00Z',
  },
];

const mockPulls: ActivePullRequestSummary[] = [
  {
    number: 101,
    title: 'feat: add WebRTC jitter analysis',
    state: 'open',
    author: {
      login: 'alice',
      avatarUrl: 'https://avatars.githubusercontent.com/u/2000',
    },
    headSha: 'sha101',
    headBranch: 'feat/webrtc',
    baseBranch: 'main',
    draft: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    reviewStatus: {
      status: 'completed',
      verdict: 'SHIP',
      findingsCount: 0,
    },
  },
  {
    number: 102,
    title: 'fix: address memory leak in parser',
    state: 'open',
    author: {
      login: 'bob',
      avatarUrl: '',
    },
    headSha: 'sha102',
    headBranch: 'fix/memory-leak',
    baseBranch: 'main',
    draft: true,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    reviewStatus: {
      status: 'completed',
      verdict: 'BLOCK',
      findingsCount: 3,
    },
  },
];

const mockRules: RepositoryReviewRules = {
  reviews: {
    profile: 'assertive',
    reviewer_effort: 'high',
    confidence_threshold: 85,
    sequence_diagrams: true,
    high_level_summary: true,
    request_changes_workflow: true,
    ticket_enforcement: true,
    collapse_walkthrough: false,
  },
  auto_review: {
    enabled: true,
    triggers: ['pr_opened', 'pr_synchronize', '@ct-review'],
    ignore_drafts: true,
    ignore_patterns: ['*.md', 'docs/**'],
    labels: ['review-yeti'],
  },
  enforcement_policy: {
    failure_action: 'fail_closed',
    require_all_reviews: true,
    require_ticket_link: true,
  },
};

describe('Milestone 1 Frontend UI Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.fetchGitHubOrgs).mockResolvedValue(mockOrgs);
    vi.mocked(apiClient.fetchRepositories).mockResolvedValue(mockRepos);
    vi.mocked(apiClient.fetchRepoPullRequests).mockResolvedValue(mockPulls);
    vi.mocked(apiClient.fetchRepositoryReviewRules).mockResolvedValue(mockRules);
  });

  describe('1. OrgSelector Component', () => {
    it('fetches organizations and renders initial selection trigger', async () => {
      render(<OrgSelector selectedOrg="" onSelectOrg={vi.fn()} />);

      await waitFor(() => {
        expect(apiClient.fetchGitHubOrgs).toHaveBeenCalledTimes(1);
      });

      expect(screen.getByText('All Organizations')).toBeInTheDocument();
    });
  });

  describe('2. RepoGrid Component', () => {
    it('renders repository cards with strictness profiles and verdicts', () => {
      const onToggleAutomation = vi.fn();
      const onOpenRules = vi.fn();

      render(
        <RepoGrid
          repositories={mockRepos}
          onToggleAutomation={onToggleAutomation}
          onOpenRules={onOpenRules}
        />
      );

      expect(screen.getByText('example-api')).toBeInTheDocument();
      expect(screen.getByText('review-yeti')).toBeInTheDocument();
      expect(screen.getByText('billing-engine')).toBeInTheDocument();

      // Check verdict badges
      expect(screen.getByText('SHIP')).toBeInTheDocument();
      expect(screen.getByText('BLOCK')).toBeInTheDocument();

      // Check profiles
      expect(screen.getByText('balanced')).toBeInTheDocument();
      expect(screen.getByText('assertive')).toBeInTheDocument();
      expect(screen.getByText('chill')).toBeInTheDocument();

      // Check rule configuration buttons
      const configButtons = screen.getAllByRole('button', { name: /configure rules/i });
      expect(configButtons.length).toBe(3);

      fireEvent.click(configButtons[0]);
      expect(onOpenRules).toHaveBeenCalledWith('exampleorg', 'example-api');
    });

    it('displays empty placeholder when no repositories match', () => {
      render(
        <RepoGrid
          repositories={[]}
          onToggleAutomation={vi.fn()}
          onOpenRules={vi.fn()}
        />
      );

      expect(screen.getByText(/no repositories found matching the selected filters/i)).toBeInTheDocument();
    });
  });

  describe('3. ActivePrTable Component', () => {
    it('renders open PR list with authors, branches, and review verdict badges', async () => {
      render(<ActivePrTable owner="exampleorg" repo="example-api" />);

      await waitFor(() => {
        expect(screen.getByText('feat: add WebRTC jitter analysis')).toBeInTheDocument();
        expect(screen.getByText('#101')).toBeInTheDocument();
        expect(screen.getByText('#102')).toBeInTheDocument();
        expect(screen.getByText('Draft')).toBeInTheDocument();
        expect(screen.getByText('feat/webrtc')).toBeInTheDocument();
        expect(screen.getByText('fix/memory-leak')).toBeInTheDocument();
      });
    });

    it('triggers pull request review on button click', async () => {
      vi.mocked(apiClient.triggerPullRequestReview).mockResolvedValue({
        success: true,
        message: 'Review queued',
        jobId: 'job-new-101',
      });

      render(<ActivePrTable owner="exampleorg" repo="example-api" />);

      await waitFor(() => {
        expect(screen.getByText('feat: add WebRTC jitter analysis')).toBeInTheDocument();
      });

      const reviewButtons = screen.getAllByRole('button', { name: /review/i });
      expect(reviewButtons.length).toBeGreaterThan(0);

      fireEvent.click(reviewButtons[0]);

      await waitFor(() => {
        expect(apiClient.triggerPullRequestReview).toHaveBeenCalledWith('exampleorg', 'example-api', 101);
      });
    });

    it('reloads pull requests on Reload PRs button click', async () => {
      render(<ActivePrTable owner="exampleorg" repo="example-api" />);

      await waitFor(() => {
        expect(screen.getByText('feat: add WebRTC jitter analysis')).toBeInTheDocument();
      });

      const reloadBtn = screen.getByRole('button', { name: /reload prs/i });
      fireEvent.click(reloadBtn);

      await waitFor(() => {
        expect(apiClient.fetchRepoPullRequests).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('4. ReviewRulesModal Component', () => {
    it('loads repository rules and displays tabbed interface', async () => {
      render(
        <ReviewRulesModal
          isOpen={true}
          onClose={vi.fn()}
          owner="exampleorg"
          repo="example-api"
        />
      );

      await waitFor(() => {
        expect(apiClient.fetchRepositoryReviewRules).toHaveBeenCalledWith('exampleorg', 'example-api');
        expect(screen.getByText(/Repository Review Rules — exampleorg\/example-api/i)).toBeInTheDocument();
      });

      expect(screen.getByText('Reviews')).toBeInTheDocument();
      expect(screen.getByText('Auto-Review Triggers')).toBeInTheDocument();
      expect(screen.getByText('Enforcement Policy')).toBeInTheDocument();
    });

    it('saves updated repository review rules on Save Rules button click', async () => {
      const onRulesSaved = vi.fn();
      const onClose = vi.fn();
      vi.mocked(apiClient.updateRepositoryReviewRules).mockResolvedValue(mockRules);

      render(
        <ReviewRulesModal
          isOpen={true}
          onClose={onClose}
          owner="exampleorg"
          repo="example-api"
          onRulesSaved={onRulesSaved}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Repository Review Rules — exampleorg\/example-api/i)).toBeInTheDocument();
      });

      const saveBtn = screen.getByRole('button', { name: /save rules/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(apiClient.updateRepositoryReviewRules).toHaveBeenCalledWith(
          'exampleorg',
          'example-api',
          expect.objectContaining({
            reviews: expect.any(Object),
            auto_review: expect.any(Object),
            enforcement_policy: expect.any(Object),
          })
        );
        expect(onRulesSaved).toHaveBeenCalledWith(mockRules);
      });
    });
  });

  describe('5. ReposPage Full Integration', () => {
    it('switches between Table and Grid view modes via toggle buttons', async () => {
      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('example-api')).toBeInTheDocument();
      });

      // Default is table view
      expect(screen.getByTestId('view-table-btn')).toBeInTheDocument();
      expect(screen.getByTestId('view-grid-btn')).toBeInTheDocument();

      // Switch to Grid view
      fireEvent.click(screen.getByTestId('view-grid-btn'));

      // Check RepoGrid rendered
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /configure rules/i }).length).toBe(3);
      });

      // Switch back to Table view
      fireEvent.click(screen.getByTestId('view-table-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('repo-flowchart-toggle-exampleorg-example-api')).toBeInTheDocument();
      });
    });

    it('filters repository list by status pills (Monitored vs Paused)', async () => {
      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('example-api')).toBeInTheDocument();
        expect(screen.getByText('review-yeti')).toBeInTheDocument();
      });

      // Click "monitored" filter
      fireEvent.click(screen.getByTestId('filter-status-monitored'));

      expect(screen.getByText('example-api')).toBeInTheDocument();
      expect(screen.getByText('billing-engine')).toBeInTheDocument();
      expect(screen.queryByText('review-yeti')).not.toBeInTheDocument();

      // Click "paused" filter
      fireEvent.click(screen.getByTestId('filter-status-paused'));

      expect(screen.getByText('review-yeti')).toBeInTheDocument();
      expect(screen.queryByText('example-api')).not.toBeInTheDocument();
      expect(screen.queryByText('billing-engine')).not.toBeInTheDocument();

      // Click "all" filter
      fireEvent.click(screen.getByTestId('filter-status-all'));

      expect(screen.getByText('example-api')).toBeInTheDocument();
      expect(screen.getByText('review-yeti')).toBeInTheDocument();
      expect(screen.getByText('billing-engine')).toBeInTheDocument();
    });

    it('opens ReviewRulesModal when Rules button is clicked from Table view', async () => {
      render(<ReposPage />);

      await waitFor(() => {
        expect(screen.getByText('example-api')).toBeInTheDocument();
      });

      const rulesBtn = screen.getByTestId('repo-rules-btn-exampleorg-example-api');
      fireEvent.click(rulesBtn);

      await waitFor(() => {
        expect(screen.getByText(/Repository Review Rules — exampleorg\/example-api/i)).toBeInTheDocument();
      });
    });
  });
});
