'use client';

import * as React from 'react';
import { GitCommit, Tag, Info, Server, Cpu, Layers } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/components/ui/dialog';

export interface VersionInfoData {
  name: string;
  version: string;
  commitHash: string;
  fullCommitHash: string;
  buildTimestamp: string;
  environment: string;
  cluster: string;
  runner: string;
  memoryEngine: string;
}

export function VersionBadge() {
  const [info, setInfo] = React.useState<VersionInfoData>({
    name: 'Review Yeti',
    version: 'v2.4.0',
    commitHash: '3a377ff',
    fullCommitHash: '3a377ff1287e09641170b04a8e3f84814d420177',
    buildTimestamp: '2026-10-02T12:00:00Z',
    environment: 'production',
    cluster: 'Cloudflare Edge (Workers & Workflows)',
    runner: 'Cloudflare Containers & MicroVMs',
    memoryEngine: 'R2 Context Compaction & AST Hunk Cache',
  });

  React.useEffect(() => {
    fetch('/version')
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.about) {
          setInfo(data.about);
        } else if (data.version) {
          setInfo(data);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/60 bg-muted/40 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-all cursor-pointer group"
          title="Click to view full build & commit metadata"
        >
          <Tag className="h-3 w-3 text-indigo-400 group-hover:scale-110 transition-transform" />
          <span className="font-semibold text-foreground">{info.version}</span>
          <span className="text-muted-foreground font-mono">({info.commitHash.slice(0, 7)})</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md bg-background/95 border-border/80 backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Info className="h-4 w-4 text-indigo-400" />
            System Version & Commit Metadata
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Current deployed build commit details and execution environment
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-2 text-xs">
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/40 border border-border/40">
            <span className="text-muted-foreground font-medium flex items-center gap-2">
              <Tag className="h-3.5 w-3.5 text-indigo-400" /> Version Tag
            </span>
            <span className="font-mono font-bold text-foreground text-sm">{info.version}</span>
          </div>

          <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/40 border border-border/40">
            <span className="text-muted-foreground font-medium flex items-center gap-2">
              <GitCommit className="h-3.5 w-3.5 text-emerald-400" /> Git Commit Hash
            </span>
            <span className="font-mono text-emerald-400 font-semibold">{info.commitHash.slice(0, 7)}</span>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40 space-y-1">
            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Full Commit SHA</div>
            <div className="font-mono text-[11px] text-foreground select-all break-all bg-background/60 p-1.5 rounded border border-border/30">
              {info.fullCommitHash}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
              <div className="text-[10px] text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
                <Server className="h-3 w-3 text-sky-400" /> Target Cluster
              </div>
              <div className="font-medium text-foreground text-[11px] truncate">{info.cluster}</div>
            </div>

            <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40">
              <div className="text-[10px] text-muted-foreground font-medium flex items-center gap-1.5 mb-1">
                <Cpu className="h-3 w-3 text-amber-400" /> CI/CD Runner
              </div>
              <div className="font-medium text-foreground text-[11px] truncate">{info.runner}</div>
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-muted/40 border border-border/40 flex items-center justify-between">
            <span className="text-muted-foreground font-medium flex items-center gap-2">
              <Layers className="h-3.5 w-3.5 text-purple-400" /> Memory Engine
            </span>
            <span className="font-mono text-[11px] text-purple-300">{info.memoryEngine}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
