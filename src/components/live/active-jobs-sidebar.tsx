'use client';

import React from 'react';
import { LiveJobSummary } from '@/types/live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Radio, RefreshCw, GitPullRequest, Clock, Activity, ExternalLink } from 'lucide-react';

export interface ActiveJobsSidebarProps {
  currentJobId: string | null;
  onSelectJob: (jobId: string) => void;
  activeJobs?: LiveJobSummary[];
  onRefresh?: () => void;
  className?: string;
}

export function ActiveJobsSidebar({
  currentJobId,
  onSelectJob,
  activeJobs = [],
  onRefresh,
  className = '',
}: ActiveJobsSidebarProps) {
  return (
    <div
      className={`flex flex-col rounded-xl border border-white/10 bg-slate-900/80 backdrop-blur-md p-4 space-y-4 ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-indigo-400" />
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
            Active Review Jobs
          </h3>
          <Badge variant="secondary" className="text-[10px] bg-indigo-500/20 text-indigo-300 font-mono">
            {activeJobs.length}
          </Badge>
        </div>

        {onRefresh && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            className="h-7 w-7 p-0 text-slate-400 hover:text-white hover:bg-white/10"
            title="Refresh jobs list"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Jobs List */}
      <div id="active-jobs-list" className="space-y-2 max-h-[480px] overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 pr-1">
        {activeJobs.length === 0 ? (
          <div className="py-8 text-center text-slate-500 text-xs space-y-2">
            <Radio className="h-6 w-6 text-slate-600 mx-auto" />
            <p>No active review jobs found.</p>
            <p className="text-[11px] text-slate-600">Select default job or run a review CLI command.</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onSelectJob('default-job')}
              className="text-[11px] h-7 mt-2 border-slate-700 text-slate-300"
            >
              Stream Default Job
            </Button>
          </div>
        ) : (
          activeJobs.map((job) => {
            const isSelected = currentJobId === job.jobId;
            const repoDisplay = job.repo || 'calltelemetry/cisco-cdr';
            const prTitle = job.title || (job.prNumber ? `PR #${job.prNumber}` : job.jobId);
            const startTimeStr = job.startTime
              ? new Date(job.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : 'Recently';

            return (
              <div
                key={job.jobId}
                onClick={() => onSelectJob(job.jobId)}
                className={`p-3 rounded-lg border transition-all cursor-pointer flex flex-col justify-between space-y-2 ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-500/10 shadow-lg shadow-indigo-500/5'
                    : 'border-white/5 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                      <GitPullRequest className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                      <span className="truncate max-w-[160px]">{prTitle}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono">{repoDisplay}</div>
                  </div>

                  <Badge
                    variant={
                      job.status === 'active'
                        ? 'default'
                        : job.status === 'completed'
                        ? 'success'
                        : 'destructive'
                    }
                    className="text-[9px] uppercase px-1.5 py-0 font-mono shrink-0"
                  >
                    {job.status === 'active' ? (
                      <span className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        ACTIVE
                      </span>
                    ) : (
                      job.status
                    )}
                  </Badge>
                </div>

                <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono pt-1 border-t border-white/5">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3 text-slate-500" />
                    <span>{startTimeStr}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span>{job.eventCount || 0} events</span>
                    {isSelected && <ExternalLink className="h-3 w-3 text-indigo-400 ml-1" />}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
