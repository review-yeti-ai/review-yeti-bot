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
} from 'lucide-react';
import Link from 'next/link';
import { PRReviewDetailModal } from './pr-review-detail-modal';

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
      const repoStr = j.repo || (j as any).repository;
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

    // Search query filter (repo, title, prNumber, headSha)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((j) => {
        const repoStr = (j.repo || (j as any).repository || '').toLowerCase();
        const titleStr = (j.title || '').toLowerCase();
        const prStr = (j.prNumber ? String(j.prNumber) : '').toLowerCase();
        const shaStr = (j.headSha || '').toLowerCase();
        return (
          repoStr.includes(q) ||
          titleStr.includes(q) ||
          prStr.includes(q) ||
          shaStr.includes(q)
        );
      });
    }

    // Verdict filter
    if (verdictFilter !== 'ALL') {
      result = result.filter((j) => (j.verdict || 'SHIP') === verdictFilter);
    }

    // Repo filter
    if (repoFilter !== 'ALL') {
      result = result.filter(
        (j) => (j.repo || (j as any).repository) === repoFilter
      );
    }

    // Sorting
    result.sort((a, b) => {
      let valA: any;
      let valB: any;

      switch (sortField) {
        case 'repo':
          valA = (a.repo || (a as any).repository || '').toLowerCase();
          valB = (b.repo || (b as any).repository || '').toLowerCase();
          break;
        case 'title':
          valA = (a.title || '').toLowerCase();
          valB = (b.title || '').toLowerCase();
          break;
        case 'verdict':
          valA = (a.verdict || '').toLowerCase();
          valB = (b.verdict || '').toLowerCase();
          break;
        case 'latencyMs':
          valA = a.latencyMs || 0;
          valB = b.latencyMs || 0;
          break;
        case 'cost':
          valA = (a as any).costUSD || a.cost || 0;
          valB = (b as any).costUSD || b.cost || 0;
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
          valA = parseTime(a.timestamp);
          valB = parseTime(b.timestamp);
          break;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [jobs, searchQuery, verdictFilter, repoFilter, sortField, sortOrder]);

  // Pagination calculation
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
    <div className="space-y-3">
      {/* Header Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-indigo-400" />
            Recent PR Review Executions
          </h3>
          <Badge variant="outline" className="text-[10px] font-mono border-indigo-500/30 text-indigo-300">
            {totalItems} {totalItems === 1 ? 'Job' : 'Jobs'}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className="h-8 text-xs gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh Table
            </Button>
          )}
          <Button asChild variant="outline" size="sm" className="h-8 text-xs gap-1">
            <Link href="/live">
              View Live Stream <ExternalLink className="h-3 w-3" />
            </Link>
          </Button>
        </div>
      </div>

      {/* Search and Filters Bar */}
      <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border border-border/70 bg-card/40">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by repo, PR #, title, or commit SHA..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-xs bg-background/80"
          />
        </div>

        {/* Verdict Filter Dropdown */}
        <Select value={verdictFilter} onValueChange={setVerdictFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs bg-background/80">
            <SelectValue placeholder="Verdict" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Verdicts</SelectItem>
            <SelectItem value="SHIP">SHIP</SelectItem>
            <SelectItem value="NACK">NACK</SelectItem>
            <SelectItem value="COMMENT">COMMENT</SelectItem>
          </SelectContent>
        </Select>

        {/* Repo Filter Dropdown */}
        {distinctRepos.length > 0 && (
          <Select value={repoFilter} onValueChange={setRepoFilter}>
            <SelectTrigger className="h-8 w-[160px] text-xs bg-background/80">
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Repositories</SelectItem>
              {distinctRepos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Clear Filters Button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setVerdictFilter('ALL');
              setRepoFilter('ALL');
            }}
            className="h-8 text-xs text-muted-foreground hover:text-foreground gap-1"
          >
            <FilterX className="h-3.5 w-3.5" />
            Reset
          </Button>
        )}
      </div>

      {/* Table Container */}
      <div className="rounded-lg border border-border/80 bg-card/60 overflow-x-auto scrollbar-thin">
        {safeJobs.length === 0 ? (
          <div className="p-8 text-center space-y-4">
            <div className="p-3 rounded-full bg-muted/30 w-fit mx-auto">
              <GitPullRequest className="h-8 w-8 text-muted-foreground opacity-60" />
            </div>
            <div className="max-w-sm mx-auto space-y-1">
              <p className="text-sm font-semibold text-foreground">No recent PR review executions</p>
              <p className="text-xs text-muted-foreground">
                GitHub pull request webhooks and review scans will populate this table automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
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
                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
              >
                <Play className="h-3.5 w-3.5" />
                Trigger Review Scan
              </Button>
              <Button asChild size="sm" variant="outline" className="text-xs gap-1.5">
                <Link href="/settings">
                  <Webhook className="h-3.5 w-3.5" />
                  Configure Webhook
                </Link>
              </Button>
            </div>
          </div>
        ) : paginatedJobs.length === 0 ? (
          <div className="p-8 text-center space-y-4">
            <div className="p-3 rounded-full bg-muted/30 w-fit mx-auto">
              <GitPullRequest className="h-8 w-8 text-muted-foreground opacity-60" />
            </div>
            <div className="max-w-sm mx-auto space-y-1">
              <p className="text-sm font-semibold text-foreground">No matching reviews found</p>
              <p className="text-xs text-muted-foreground">
                Try adjusting your search criteria or clearing filters.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead
                  className="w-[180px] cursor-pointer select-none group"
                  onClick={() => handleSort('repo')}
                >
                  <div className="flex items-center gap-1 font-semibold">
                    Repository
                    {renderSortIcon('repo')}
                  </div>
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none group"
                  onClick={() => handleSort('title')}
                >
                  <div className="flex items-center gap-1 font-semibold">
                    PR Title
                    {renderSortIcon('title')}
                  </div>
                </TableHead>
                <TableHead
                  className="w-[100px] cursor-pointer select-none group"
                  onClick={() => handleSort('verdict')}
                >
                  <div className="flex items-center gap-1 font-semibold">
                    Verdict
                    {renderSortIcon('verdict')}
                  </div>
                </TableHead>
                <TableHead className="w-[180px]">Personas Evaluated</TableHead>
                <TableHead
                  className="text-right w-[100px] cursor-pointer select-none group"
                  onClick={() => handleSort('latencyMs')}
                >
                  <div className="flex items-center justify-end gap-1 font-semibold">
                    Latency
                    {renderSortIcon('latencyMs')}
                  </div>
                </TableHead>
                <TableHead
                  className="text-right w-[90px] cursor-pointer select-none group"
                  onClick={() => handleSort('cost')}
                >
                  <div className="flex items-center justify-end gap-1 font-semibold">
                    Cost
                    {renderSortIcon('cost')}
                  </div>
                </TableHead>
                <TableHead
                  className="text-right w-[140px] cursor-pointer select-none group"
                  onClick={() => handleSort('timestamp')}
                >
                  <div className="flex items-center justify-end gap-1 font-semibold">
                    Time
                    {renderSortIcon('timestamp')}
                  </div>
                </TableHead>
                <TableHead className="text-right w-[140px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedJobs.map((job) => {
                const repoStr = job.repo || (job as any).repository || 'calltelemetry/cisco-cdr';
                const fullRepo = repoStr.includes('/')
                  ? repoStr
                  : (job as any).owner
                  ? `${(job as any).owner}/${repoStr}`
                  : repoStr;
                const prNumStr = job.prNumber || 3514;
                const githubPrUrl = `https://github.com/${fullRepo}/pull/${prNumStr}`;
                const personasList = Array.isArray(job.personas)
                  ? job.personas
                  : ['security', 'architecture', 'quality'];

                const costFormatted = `$${((job as any).costUSD || job.cost || 0.326).toFixed(3)}`;

                let formattedTime = job.timestamp || 'Just now';
                if (job.timestamp && job.timestamp !== 'Just now' && !job.timestamp.includes('ago')) {
                  try {
                    const d = new Date(job.timestamp);
                    if (!isNaN(d.getTime())) {
                      formattedTime = new Intl.DateTimeFormat(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: 'numeric',
                        timeZoneName: 'short',
                      }).format(d);
                    }
                  } catch {}
                }

                return (
                  <TableRow
                    key={job.id || `job-${prNumStr}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedJob(job)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedJob(job);
                      }
                    }}
                    className="hover:bg-muted/30 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <TableCell className="font-mono text-xs font-medium text-indigo-300">
                      {repoStr} <span className="text-muted-foreground">#{prNumStr}</span>
                    </TableCell>
                    <TableCell className="text-xs font-medium text-foreground max-w-[260px] truncate">
                      {job.title || 'PR Review Evaluation'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          job.verdict === 'SHIP'
                            ? 'success'
                            : job.verdict === 'NACK'
                            ? 'destructive'
                            : 'warning'
                        }
                        className="text-[10px] font-bold"
                      >
                        {job.verdict || 'SHIP'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {personasList.slice(0, 3).map((p) => (
                          <Badge key={p} variant="outline" className="text-[9px] py-0 px-1 border-border/60">
                            {p}
                          </Badge>
                        ))}
                        {personasList.length > 3 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{personasList.length - 3}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {job.latencyMs || 1840}ms
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold text-emerald-400">
                      {costFormatted}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                      {formattedTime}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <a
                        href={githubPrUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="github-pr-link-table"
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 hover:underline"
                      >
                        View PR on GitHub ↗
                      </a>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination Controls */}
      {totalItems > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Rows per page:</span>
            <Select
              value={pageSize.toString()}
              onValueChange={(v) => setPageSize(Number(v))}
            >
              <SelectTrigger className="h-7 w-[70px] text-xs bg-background/80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
            <span className="font-mono">
              Showing {startIndex + 1}–{Math.min(startIndex + pageSize, totalItems)} of {totalItems}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono">
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Full PR Details Modal */}
      <PRReviewDetailModal
        job={selectedJob}
        open={!!selectedJob}
        onOpenChange={(open) => !open && setSelectedJob(null)}
      />
    </div>
  );
}
