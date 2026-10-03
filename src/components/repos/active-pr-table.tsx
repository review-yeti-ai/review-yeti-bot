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
import { ActivePullRequestSummary } from '@/types/dashboard';
import { fetchRepoPullRequests, triggerPullRequestReview } from '@/lib/api-client';
import {
  GitPullRequest,
  GitBranch,
  ShieldCheck,
  ShieldAlert,
  Clock,
  Play,
  Loader2,
  RefreshCw,
  ExternalLink,
  Eye,
} from 'lucide-react';

export interface ActivePrTableProps {
  owner: string;
  repo: string;
  onTriggerReview?: (prNumber: number) => void;
}

export function ActivePrTable({ owner, repo, onTriggerReview }: ActivePrTableProps) {
  const [pullRequests, setPullRequests] = React.useState<ActivePullRequestSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [triggeringPr, setTriggeringPr] = React.useState<number | null>(null);

  const loadPulls = React.useCallback(
    async (isRefresh = false) => {
      if (!owner || !repo) return;
      if (typeof fetchRepoPullRequests !== 'function') {
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      try {
        const pulls = await fetchRepoPullRequests(owner, repo, 'open');
        setPullRequests(pulls || []);
      } catch {
        // Keep existing pulls or empty
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [owner, repo]
  );

  React.useEffect(() => {
    loadPulls();
  }, [loadPulls]);

  const handleTrigger = async (prNumber: number) => {
    setTriggeringPr(prNumber);
    try {
      await triggerPullRequestReview(owner, repo, prNumber);
      if (onTriggerReview) {
        onTriggerReview(prNumber);
      }
      // Optimistically update PR review status to running
      setPullRequests((prev) =>
        prev.map((pr) =>
          pr.number === prNumber
            ? {
                ...pr,
                reviewStatus: {
                  status: 'running',
                  findingsCount: 0,
                },
              }
            : pr
        )
      );
    } catch {
      // Trigger error handled gracefully
    } finally {
      setTriggeringPr(null);
    }
  };

  const renderStatusBadge = (reviewStatus?: ActivePullRequestSummary['reviewStatus']) => {
    if (!reviewStatus) {
      return (
        <Badge variant="outline" className="text-[10px] text-muted-foreground border-border/60">
          Unreviewed
        </Badge>
      );
    }

    if (reviewStatus.status === 'running') {
      return (
        <Badge className="text-[10px] bg-indigo-500/20 text-indigo-400 border border-indigo-500/40 flex items-center gap-1 animate-pulse">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>RUNNING</span>
        </Badge>
      );
    }

    if (reviewStatus.status === 'pending') {
      return (
        <Badge className="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          <span>QUEUED</span>
        </Badge>
      );
    }

    if (reviewStatus.verdict === 'SHIP') {
      return (
        <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center gap-1">
          <ShieldCheck className="h-3 w-3" />
          <span>SHIP</span>
        </Badge>
      );
    }

    if (reviewStatus.verdict === 'BLOCK') {
      return (
        <Badge className="text-[10px] bg-rose-500/20 text-rose-400 border border-rose-500/40 flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" />
          <span>BLOCK</span>
        </Badge>
      );
    }

    return (
      <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/30">
        NEUTRAL
      </Badge>
    );
  };

  return (
    <div className="rounded-lg border border-border/80 bg-card/60 overflow-hidden space-y-3">
      <div className="flex items-center justify-between p-4 pb-0">
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-indigo-400" />
          <span className="text-xs font-bold text-foreground font-mono">
            Active Pull Requests ({owner}/{repo})
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadPulls(true)}
          disabled={loading || refreshing}
          className="text-xs h-7 px-2.5 flex items-center gap-1 border-border/80"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          <span>Reload PRs</span>
        </Button>
      </div>

      <div className="overflow-x-auto scrollbar-thin">
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow>
              <TableHead className="w-[80px]">PR #</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-[140px]">Author</TableHead>
              <TableHead className="w-[180px]">Branch Flow</TableHead>
              <TableHead className="w-[120px]">Verdict</TableHead>
              <TableHead className="w-[90px]">Findings</TableHead>
              <TableHead className="text-right w-[160px]">Review Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-xs">
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                    <span>Loading active pull requests...</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : pullRequests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-xs">
                  No open pull requests found for {owner}/{repo}.
                </TableCell>
              </TableRow>
            ) : (
              pullRequests.map((pr) => {
                const isTriggering = triggeringPr === pr.number;
                return (
                  <TableRow key={pr.number} className="hover:bg-muted/20">
                    <TableCell className="font-mono text-xs font-bold text-indigo-400">
                      #{pr.number}
                    </TableCell>
                    <TableCell className="text-xs text-foreground font-medium max-w-[280px] truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{pr.title}</span>
                        {pr.draft && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 text-muted-foreground">
                            Draft
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        {pr.author.avatarUrl ? (
                          <img
                            src={pr.author.avatarUrl}
                            alt={pr.author.login}
                            className="w-4 h-4 rounded-full border border-border/60"
                          />
                        ) : (
                          <div className="w-4 h-4 rounded-full bg-muted flex items-center justify-center text-[9px]">
                            {pr.author.login.slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <span className="truncate">{pr.author.login}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      <div className="flex items-center gap-1 text-[11px] truncate">
                        <span className="text-foreground truncate max-w-[80px]">{pr.headBranch}</span>
                        <span>→</span>
                        <span className="text-muted-foreground truncate max-w-[60px]">{pr.baseBranch}</span>
                      </div>
                    </TableCell>
                    <TableCell>{renderStatusBadge(pr.reviewStatus)}</TableCell>
                    <TableCell className="font-mono text-xs text-foreground">
                      {pr.reviewStatus ? (
                        <span
                          className={`font-semibold ${
                            pr.reviewStatus.findingsCount > 0 ? 'text-amber-400' : 'text-emerald-400'
                          }`}
                        >
                          {pr.reviewStatus.findingsCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleTrigger(pr.number)}
                          disabled={isTriggering || pr.reviewStatus?.status === 'running'}
                          className="text-xs h-7 px-2 border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10 flex items-center gap-1"
                        >
                          {isTriggering ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          <span>Review</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          asChild
                          className="text-xs h-7 px-2 text-muted-foreground hover:text-foreground"
                        >
                          <a
                            href={`/live?repo=${encodeURIComponent(`${owner}/${repo}`)}&pr=${pr.number}`}
                            title="Inspect Live Stream"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
