'use client';

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  Search,
  Plus,
  Minus,
  AlertCircle,
  FilePlus,
  FileX,
  FileEdit,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { FindingDiffCard } from './finding-diff-card';
import type { ChangedFileDiff, DiffHunk, AnchoredFinding } from '@/types/diff';

export interface DiffViewerProps {
  jobId?: string | null;
  files?: ChangedFileDiff[];
  findings?: AnchoredFinding[];
  selectedPersona?: string;
  loading?: boolean;
  onDismissFinding?: (findingId: string, reason: string) => void;
  onAdjustSeverity?: (findingId: string, newSeverity: 'P0' | 'P1' | 'P2') => void;
  className?: string;
}

interface ParsedLine {
  type: 'add' | 'delete' | 'context';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

const EMPTY_FILES: ChangedFileDiff[] = [];
const EMPTY_FINDINGS: AnchoredFinding[] = [];

export function DiffViewer({
  jobId,
  files = EMPTY_FILES,
  findings = EMPTY_FINDINGS,
  selectedPersona = 'all',
  loading = false,
  onDismissFinding,
  onAdjustSeverity,
  className,
}: DiffViewerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  // Filter findings by selected persona if persona is active
  const filteredFindings = useMemo(() => {
    if (!selectedPersona || selectedPersona === 'all') return findings;
    return findings.filter(
      (f) => f.persona && f.persona.toLowerCase() === selectedPersona.toLowerCase()
    );
  }, [findings, selectedPersona]);

  // Filter files by search query
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, searchQuery]);

  const toggleCollapse = (path: string) => {
    setCollapsedFiles((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const expandAll = () => setCollapsedFiles({});
  const collapseAll = () => {
    const allCollapsed: Record<string, boolean> = {};
    for (const f of files) allCollapsed[f.path] = true;
    setCollapsedFiles(allCollapsed);
  };

  // Helper to parse hunk lines with accurate 1-indexed old/new line numbers
  const parseHunkLines = (hunk: DiffHunk): ParsedLine[] => {
    let currentOld = hunk.oldStart;
    let currentNew = hunk.newStart;
    const parsed: ParsedLine[] = [];

    for (const rawLine of hunk.lines as any[]) {
      if (typeof rawLine === 'object' && rawLine !== null) {
        parsed.push({
          type: rawLine.type || 'context',
          oldLineNumber: rawLine.oldLineNumber,
          newLineNumber: rawLine.newLineNumber,
          content: rawLine.content ?? '',
        });
        continue;
      }

      const strLine = String(rawLine ?? '');
      if (strLine.startsWith('\\')) {
        parsed.push({
          type: 'context',
          content: strLine,
        });
        continue;
      }
      if (strLine.startsWith('+')) {
        parsed.push({
          type: 'add',
          newLineNumber: currentNew,
          content: strLine.slice(1),
        });
        currentNew++;
      } else if (strLine.startsWith('-')) {
        parsed.push({
          type: 'delete',
          oldLineNumber: currentOld,
          content: strLine.slice(1),
        });
        currentOld++;
      } else {
        // Context or raw line
        const content = strLine.startsWith(' ') ? strLine.slice(1) : strLine;
        parsed.push({
          type: 'context',
          oldLineNumber: currentOld,
          newLineNumber: currentNew,
          content,
        });
        currentOld++;
        currentNew++;
      }
    }
    return parsed;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'added':
        return <FilePlus className="w-3.5 h-3.5 text-emerald-400" />;
      case 'deleted':
        return <FileX className="w-3.5 h-3.5 text-rose-400" />;
      default:
        return <FileEdit className="w-3.5 h-3.5 text-sky-400" />;
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-slate-400 space-y-3">
        <div className="w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs font-mono">Loading review diff and patch hunks...</p>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-slate-400 space-y-2 border border-dashed border-border/60 rounded-lg">
        <FileCode className="w-8 h-8 text-slate-500 mb-1" />
        <p className="text-xs font-semibold text-slate-300">No Changed Files in Review Snapshot</p>
        <p className="text-[11px] text-slate-500">
          {jobId ? `Job ${jobId} has no modified files recorded.` : 'Select an active or historical review to inspect diffs.'}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Search and Global Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/60 p-2.5 rounded-lg border border-border/60">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter changed files by path..."
            className="h-8 pl-8 text-xs bg-slate-950/80 border-border/60"
          />
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-[11px] text-slate-400 font-mono">
            {filteredFiles.length} {filteredFiles.length === 1 ? 'file' : 'files'}
            {filteredFindings.length > 0 && ` • ${filteredFindings.length} findings`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={expandAll}
            className="h-7 px-2 text-[11px] text-slate-400 hover:text-slate-200"
          >
            Expand All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={collapseAll}
            className="h-7 px-2 text-[11px] text-slate-400 hover:text-slate-200"
          >
            Collapse All
          </Button>
        </div>
      </div>

      {/* File List */}
      <div className="space-y-3">
        {filteredFiles.map((file) => {
          const isCollapsed = Boolean(collapsedFiles[file.path]);
          const fileFindings = filteredFindings.filter((f) => f.file === file.path);
          const renderedLines = (file.hunks || []).flatMap((hunk) => parseHunkLines(hunk));

          return (
            <div
              key={file.path}
              className="rounded-lg border border-border/80 bg-slate-950/80 overflow-hidden shadow-sm"
            >
              {/* File Header */}
              <div
                onClick={() => toggleCollapse(file.path)}
                className="flex items-center justify-between p-2.5 bg-slate-900/80 hover:bg-slate-900 cursor-pointer select-none border-b border-border/40 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  {getStatusIcon(file.status)}
                  <span className="font-mono text-xs font-medium text-slate-200 truncate">
                    {file.path}
                  </span>
                  <Badge variant="outline" className="text-[10px] uppercase font-mono px-1.5 py-0">
                    {file.status}
                  </Badge>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {fileFindings.length > 0 && (
                    <Badge variant="destructive" className="text-[10px] font-mono flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {fileFindings.length} {fileFindings.length === 1 ? 'Finding' : 'Findings'}
                    </Badge>
                  )}
                  <span className="font-mono text-[11px] text-emerald-400 flex items-center">
                    <Plus className="w-3 h-3 inline" />
                    {file.additions}
                  </span>
                  <span className="font-mono text-[11px] text-rose-400 flex items-center">
                    <Minus className="w-3 h-3 inline" />
                    {file.deletions}
                  </span>
                </div>
              </div>

              {/* File Hunks Body */}
              {!isCollapsed && (
                <div className="overflow-x-auto text-[11px] font-mono leading-relaxed">
                  {/* File-level findings (unanchored or outside hunks) */}
                  {fileFindings
                    .filter((f) => !renderedLines.some((rl) => rl.newLineNumber === f.line))
                    .map((unanchoredFinding) => (
                      <div key={unanchoredFinding.id} className="p-2 border-b border-border/40 bg-slate-900/40">
                        <FindingDiffCard
                          finding={unanchoredFinding}
                          onDismiss={onDismissFinding}
                          onAdjustSeverity={onAdjustSeverity}
                        />
                      </div>
                    ))}

                  {file.hunks && file.hunks.length > 0 ? (
                    file.hunks.map((hunk, hunkIdx) => {
                      const lines = parseHunkLines(hunk);

                      return (
                        <div key={hunkIdx} className="border-b last:border-b-0 border-border/30">
                          {/* Hunk Header */}
                          <div className="bg-slate-900/50 text-slate-500 px-3 py-1 text-[10px] font-mono border-y border-border/20 select-none">
                            {hunk.header}
                          </div>

                          {/* Line Rows */}
                          <div className="divide-y divide-border/10">
                            {lines.map((line, lineIdx) => {
                              const matchingFindings = line.newLineNumber
                                ? fileFindings.filter((f) => f.line === line.newLineNumber)
                                : [];

                              return (
                                <React.Fragment key={lineIdx}>
                                  <div
                                    className={cn(
                                      'flex items-stretch hover:bg-slate-800/40 transition-colors',
                                      line.type === 'add' && 'bg-emerald-950/20 text-emerald-300',
                                      line.type === 'delete' && 'bg-rose-950/20 text-rose-300',
                                      line.type === 'context' && 'text-slate-300'
                                    )}
                                  >
                                    {/* Old Line Number */}
                                    <div className="w-12 py-0.5 pr-2 text-right select-none text-slate-600 bg-slate-950/30 border-r border-border/20 shrink-0">
                                      {line.oldLineNumber ?? ''}
                                    </div>
                                    {/* New Line Number */}
                                    <div className="w-12 py-0.5 pr-2 text-right select-none text-slate-600 bg-slate-950/30 border-r border-border/20 shrink-0">
                                      {line.newLineNumber ?? ''}
                                    </div>
                                    {/* Gutter */}
                                    <div className="w-6 py-0.5 text-center select-none font-bold shrink-0">
                                      {line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}
                                    </div>
                                    {/* Code Content */}
                                    <div className="py-0.5 px-2 flex-1 whitespace-pre overflow-x-auto">
                                      {line.content}
                                    </div>
                                  </div>

                                  {/* Line-Anchored Finding Cards */}
                                  {matchingFindings.map((finding) => (
                                    <div
                                      key={finding.id}
                                      className="px-6 py-2 bg-slate-950/90 border-y border-amber-500/20"
                                    >
                                      <FindingDiffCard
                                        finding={finding}
                                        onDismiss={onDismissFinding}
                                        onAdjustSeverity={onAdjustSeverity}
                                      />
                                    </div>
                                  ))}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="p-4 text-center text-slate-500 text-xs">
                      Binary file or empty diff patch.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
