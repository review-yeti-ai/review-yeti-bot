'use client';

import * as React from 'react';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ReviewJob } from '@/types/dashboard';
import {
  ExternalLink,
  GitPullRequest,
  Play,
  Webhook,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  FilterX,
  CheckCircle2,
  AlertTriangle,
  Clock,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { PRReviewDetailModal } from './pr-review-detail-modal';
import { ReviewSlideoverInspector } from './review-slideover-inspector';
import { FindingsDeltaBadge } from './FindingsDeltaBadge';
import { formatRelativeTime, formatTokenBreakdown } from '@/lib/utils';

type SortField = 'repo' | 'title' | 'verdict' | 'latencyMs' | 'cost' | 'timestamp';
type SortOrder = 'asc' | 'desc';

interface RecentReviewsTableProps {
  jobs?: ReviewJob[];
  loading?: boolean;
  onRefresh?: () => void;
}

export function RecentReviewsTable({
  jobs = [],
  loading = false,
  onRefresh,
}: RecentReviewsTableProps) {
  const [selectedJob, setSelectedJob] = React.useState<ReviewJob | null>(null);
  const [slideoverJob, setSlideoverJob] = React.useState<ReviewJob | null>(null);

  // Filtering & Sorting State
  const [searchQuery, setSearchQuery] = React.useState('');
  const [verdictFilter, setVerdictFilter] = React.useState<string>('ALL');
  const [repoFilter, setRepoFilter] = React.useState<string>('ALL');
  const [sortField, setSortField] = React.useState<SortField>('timestamp');
  const [sortOrder, setSortOrder] = React.useState<SortOrder>('desc');

  // Pagination State
  const [currentPage, setCurrentPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<number>(10);

  const safeJobs = React.useMemo(() => (Array.isArray(jobs) ? jobs : []), [jobs]);

  // Extract distinct repositories for filter dropdown
  const distinctRepos = React.useMemo(() => {
    const repos = new Set<string>();
    safeJobs.forEach((j) => {
      const repoStr = j?.repo || (j as any)?.repository;
      if (repoStr) repos.add(repoStr);
    });
    return Array.from(repos);
  }, [safeJobs]);

  // Reset page when filters or page size change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, verdictFilter, repoFilter, pageSize]);

  // Filter & Sort Logic
  const processedJobs = React.useMemo(() => {
    let result = [...safeJobs];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((j) => {
        const repoStr = (j?.repo || (j as any)?.repository || '').toLowerCase();
        const titleStr = (j?.title || '').toLowerCase();
        const prStr = (j?.prNumber ? String(j.prNumber) : '').toLowerCase();
        const shaStr = (j?.headSha || '').toLowerCase();
        return (
          repoStr.includes(q) ||
          titleStr.includes(q) ||
          prStr.includes(q) ||
          shaStr.includes(q)
        );
      });
    }

    if (verdictFilter !== 'ALL') {
      result = result.filter((j) => (j?.verdict || 'SHIP') === verdictFilter);
    }

    if (repoFilter !== 'ALL') {
      result = result.filter(
        (j) => (j?.repo || (j as any)?.repository) === repoFilter
      );
    }

    result.sort((a, b) => {
      let valA: any;
      let valB: any;

      switch (sortField) {
        case 'repo':
          valA = (a?.repo || (a as any)?.repository || '').toLowerCase();
          valB = (b?.repo || (b as any)?.repository || '').toLowerCase();
          break;
        case 'title':
          valA = (a?.title || '').toLowerCase();
          valB = (b?.title || '').toLowerCase();
          break;
        case 'verdict':
          valA = (a?.verdict || '').toLowerCase();
          valB = (b?.verdict || '').toLowerCase();
          break;
        case 'latencyMs':
          valA = a?.latencyMs || 0;
          valB = b?.latencyMs || 0;
          break;
        case 'cost':
          valA = (a as any)?.costUSD || a?.cost || 0;
          valB = (b as any)?.costUSD || b?.cost || 0;
          break;
        case 'timestamp':
        default:
          const parseTime = (ts?: string) => {
            if (!ts || ts === 'Just now') return Date.now();
            if (ts.includes('m ago')) {
              const mins = parseInt(ts) || 1;
              return Date.now() - mins * 60000;
            }
            if (ts.includes('h ago')) {
              const hrs = parseInt(ts) || 1;
              return Date.now() - hrs * 3600000;
            }
            const parsed = Date.parse(ts);
            return isNaN(parsed) ? 0 : parsed;
          };
          valA = parseTime(a?.timestamp);
          valB = parseTime(b?.timestamp);
          break;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [safeJobs, searchQuery, verdictFilter, repoFilter, sortField, sortOrder]);

  const totalItems = processedJobs.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedJobs = processedJobs.slice(startIndex, startIndex + pageSize);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-3 w-3 opacity-40 group-hover:opacity-100" />;
    }
    return sortOrder === 'asc' ? (
      <ArrowUp className="h-3 w-3 text-indigo-400" />
    ) : (
      <ArrowDown className="h-3 w-3 text-indigo-400" />
    );
  };

  const hasActiveFilters = searchQuery !== '' || verdictFilter !== 'ALL' || repoFilter !== 'ALL';

  return (
    <div className="space-y-2.5">
      {/* Linear Header Bar */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-indigo-500 shadow-sm shadow-indigo-500/50" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 font-mono">
              Review Executions
            </h3>
          </div>
          <span className="linear-kbd font-mono text-[10px]">
            {totalItems} {totalItems === 1 ? 'Job' : 'Jobs'}
          </span>
        </div>

        {/* Linear Action Shortcuts */}
        <div className="flex items-center gap-1.5">
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className="h-7 text-xs gap-1.5 border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:text-white hover:bg-white/[0.05]"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          )}
          <Button asChild variant="outline" size="sm" className="h-7 text-xs gap-1 border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:text-white hover:bg-white/[0.05]">
            <Link href="/live">
              Live Stream <ExternalLink className="h-3 w-3 ml-0.5" />
            </Link>
          </Button>
        </div>
      </div>

      {/* Linear Search & Filter Bar */}
      <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg border border-white/[0.06] bg-[#0c0d11]">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500" />
          <Input
            placeholder="Search by repo, PR #, title, or commit SHA..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-7 text-xs bg-black/40 border-white/[0.06] text-zinc-200 placeholder:text-zinc-500 focus:border-indigo-500/50"
          />
        </div>

        {/* Verdict Filter Segment */}
        <div className="flex items-center gap-1 border-l border-white/[0.06] pl-2">
          {['ALL', 'SHIP', 'NACK', 'COMMENT'].map((v) => (
            <button
              key={v}
              onClick={() => setVerdictFilter(v)}
              className={`h-7 px-2.5 rounded text-[11px] font-mono transition-all ${
                verdictFilter === v
                  ? 'bg-white/[0.08] text-white font-semibold shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02]'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        {/* Repo Filter Dropdown */}
        {distinctRepos.length > 0 && (
          <Select value={repoFilter} onValueChange={setRepoFilter}>
            <SelectTrigger className="h-7 w-[140px] text-xs bg-black/40 border-white/[0.06] text-zinc-300">
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent className="bg-[#14151b] border-white/[0.08] text-zinc-200">
              <SelectItem value="ALL">All Repositories</SelectItem>
              {distinctRepos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setVerdictFilter('ALL');
              setRepoFilter('ALL');
            }}
            className="h-7 text-xs text-zinc-400 hover:text-zinc-100 gap-1 px-2"
          >
            <FilterX className="h-3 w-3" />
            Reset
          </Button>
        )}
      </div>

      {/* Linear Table Surface */}
      <div className="linear-card overflow-hidden">
        {safeJobs.length === 0 ? (
          <div className="p-8 text-center space-y-4">
            <div className="p-3 rounded-full bg-white/[0.04] w-fit mx-auto border border-white/[0.06]">
              <GitPullRequest className="h-7 w-7 text-zinc-500" />
            </div>
            <div className="max-w-sm mx-auto space-y-1">
              <p className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono">No recent PR review executions</p>
              <p className="text-xs text-zinc-400">
                GitHub pull request webhooks and review scans will populate this table automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const res = await fetch('/api/dashboard/trigger-test-review', { method: 'POST' });
                    const data = await res.json();
                    if (data.success && onRefresh) {
                      onRefresh();
                    } else if (data.success) {
                      window.location.reload();
                    }
                  } catch (e) {}
                }}
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs h-7 px-3 gap-1.5"
              >
                <Play className="h-3 w-3" />
                Trigger Review Scan
              </Button>
              <Button asChild size="sm" variant="outline" className="text-xs h-7 px-3 gap-1.5 border-white/[0.08] text-zinc-300">
                <Link href="/settings">
                  <Webhook className="h-3 w-3" />
                  Configure Webhook
                </Link>
              </Button>
            </div>
          </div>
        ) : paginatedJobs.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <GitPullRequest className="h-6 w-6 text-zinc-600 mx-auto" />
            <p className="text-xs font-mono text-zinc-400">No matching reviews found</p>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-white/[0.02] border-b border-white/[0.06]">
              <TableRow className="border-b border-white/[0.06] hover:bg-transparent">
                <TableHead
                  className="w-[180px] cursor-pointer select-none group text-[11px] font-mono uppercase tracking-wider text-zinc-400"
                  onClick={() => handleSort('repo')}
                >
                  <div className="flex items-center gap-1">
                    Repository
                    {renderSortIcon('repo')}
                  </div>
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none group text-[11px] font-mono uppercase tracking-wider text-zinc-400"
                  onClick={() => handleSort('title')}
                >
                  <div className="flex items-center gap-1">
                    PR Title
                    {renderSortIcon('title')}
                  </div>
                </TableHead>
                <TableHead
                  className="w-[90px] cursor-pointer select-none group text-[11px] font-mono uppercase tracking-wider text-zinc-400"
                  onClick={() => handleSort('verdict')}
                >
                  <div className="flex items-center gap-1">
                    Verdict
                    {renderSortIcon('verdict')}
                  </div>
                </TableHead>
                <TableHead className="w-[160px] text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                  Swarm Personas
                </TableHead>
                <TableHead
                  className="text-right w-[100px] cursor-pointer select-none group text-[11px] font-mono uppercase tracking-wider text-zinc-400"
                  onClick={() => handleSort('latencyMs')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Duration
                    {renderSortIcon('latencyMs')}
                  </div>
                </TableHead>
                <TableHead
                  className="text-right w-[90px] cursor-pointer select-none group text-[11px] font-mono uppercase tracking-wider text-zinc-400"
                  onClick={() => handleSort('cost')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Cost
                    {renderSortIcon('cost')}
                  </div>
                </TableHead>
                <TableHead
                  className="text-right w-[110px] cursor-pointer select-none group text-[11px] font-mono uppercase tracking-wider text-zinc-400"
                  onClick={() => handleSort('timestamp')}
                >
                  <div className="flex items-center justify-end gap-1">
                    Time
                    {renderSortIcon('timestamp')}
                  </div>
                </TableHead>
                <TableHead className="text-right w-[130px] text-[11px] font-mono uppercase tracking-wider text-zinc-400">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedJobs.map((job) => {
                const repoStr = job?.repo || (job as any)?.repository || 'unknown/repo';
                const fullRepo = repoStr.includes('/')
                  ? repoStr
                  : (job as any)?.owner
                  ? `${(job as any)?.owner}/${repoStr}`
                  : repoStr;
                const prNumStr = job?.prNumber ?? 0;
                const githubPrUrl = `https://github.com/${fullRepo}/pull/${prNumStr}`;
                const personasList = Array.isArray(job?.personas) ? job.personas : [];
                const costFormatted = `$${((job as any)?.costUSD ?? job?.cost ?? 0).toFixed(3)}`;
                const relativeTime = formatRelativeTime(job?.timestamp);
                const isShip = job?.verdict === 'SHIP';
                const isBlock = job?.verdict === 'NACK' || (job?.verdict as string) === 'BLOCK';

                return (
                  <TableRow
                    key={job?.id || `job-${prNumStr}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedJob(job);
                      setSlideoverJob(job);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedJob(job);
                        setSlideoverJob(job);
                      }
                    }}
                    className="border-b border-white/[0.04] hover:bg-white/[0.035] cursor-pointer transition-colors"
                  >
                    <TableCell className="font-mono text-xs font-medium text-indigo-300">
                      <div className="flex items-center gap-2">
                        {isShip ? (
                          <span className="status-dot-green" />
                        ) : isBlock ? (
                          <span className="status-dot-rose" />
                        ) : (
                          <span className="status-dot-indigo animate-pulse" />
                        )}
                        <span>{repoStr}</span>
                        <span className="text-zinc-500 font-normal">#{prNumStr}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-medium text-zinc-200 max-w-[260px] truncate">
                      {job?.title || 'PR Review Evaluation'}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono ${
                          isShip
                            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                            : isBlock
                            ? 'bg-rose-500/15 text-rose-400 border border-rose-500/25'
                            : 'bg-amber-500/15 text-amber-300 border border-amber-500/25'
                        }`}
                      >
                        {job?.verdict || 'SHIP'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {personasList.slice(0, 2).map((p) => (
                          <span key={p} className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-white/[0.04] text-zinc-400 border border-white/[0.06]">
                            {p}
                          </span>
                        ))}
                        {personasList.length > 2 && (
                          <span className="text-[10px] font-mono text-zinc-500">
                            +{personasList.length - 2}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-xs text-zinc-400 whitespace-nowrap">
                      {(((job as any)?.durationMs ?? job?.latencyMs ?? 0) / 1000).toFixed(1)}s
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-xs text-emerald-400 whitespace-nowrap">
                      {costFormatted}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-zinc-500 whitespace-nowrap">
                      {relativeTime}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setSlideoverJob(job)}
                          className="text-[11px] font-mono text-zinc-400 hover:text-white"
                        >
                          Inspect
                        </button>
                        <a
                          href={githubPrUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="github-pr-link-table"
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
                        >
                          View PR on GitHub ↗
                        </a>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Linear Pagination Controls */}
      {totalItems > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 text-xs text-zinc-400 font-mono">
          <div className="flex items-center gap-2">
            <span>Rows:</span>
            <Select
              value={pageSize.toString()}
              onValueChange={(v) => setPageSize(Number(v))}
            >
              <SelectTrigger className="h-6 w-[65px] text-xs bg-black/40 border-white/[0.06] text-zinc-300">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#14151b] border-white/[0.08] text-zinc-200">
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-zinc-500">
              {startIndex + 1}–{Math.min(startIndex + pageSize, totalItems)} of {totalItems}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-zinc-500">
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-6 w-6 p-0 border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:text-white"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 w-6 p-0 border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:text-white"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-over Review Inspector */}
      {slideoverJob && (
        <ReviewSlideoverInspector
          job={slideoverJob}
          onClose={() => setSlideoverJob(null)}
        />
      )}

      {/* Backwards-Compatible Full PR Details Modal */}
      <PRReviewDetailModal
        job={selectedJob}
        open={!!selectedJob && !slideoverJob}
        onOpenChange={(open) => !open && setSelectedJob(null)}
      />
    </div>
  );
}
