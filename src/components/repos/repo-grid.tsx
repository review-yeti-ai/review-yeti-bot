'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RepositorySetting } from '@/types/dashboard';
import { FolderGit2, Sliders, ShieldCheck, ShieldAlert, GitBranch, Sparkles } from 'lucide-react';

export interface RepoGridProps {
  repositories: RepositorySetting[];
  onToggleAutomation: (owner: string, repo: string, enabled: boolean) => void;
  onOpenRules: (owner: string, repo: string) => void;
}

export function RepoGrid({ repositories, onToggleAutomation, onOpenRules }: RepoGridProps) {
  if (repositories.length === 0) {
    return (
      <div className="rounded-lg border border-border/80 bg-card/40 p-12 text-center text-muted-foreground text-xs">
        No repositories found matching the selected filters.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {repositories.map((repo) => {
        const isMonitored = repo.automationEnabled;
        const profile = repo.customProfile || repo.strictnessProfile || 'balanced';
        const hasFlowchart = repo.generateArchitecturalFlowchart ?? true;

        return (
          <Card
            key={`${repo.owner}/${repo.repo}`}
            className="flex flex-col justify-between border-border/80 bg-card/60 hover:border-indigo-500/40 transition-colors duration-200"
          >
            <CardHeader className="p-4 pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 overflow-hidden">
                  <FolderGit2 className="h-4 w-4 text-indigo-400 shrink-0" />
                  <div className="truncate">
                    <span className="text-xs text-muted-foreground">{repo.owner}/</span>
                    <span className="text-xs font-bold text-foreground font-mono">{repo.repo}</span>
                  </div>
                </div>
                <Badge
                  variant={isMonitored ? 'default' : 'secondary'}
                  className={`text-[10px] px-1.5 py-0 h-4 uppercase ${
                    isMonitored ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {isMonitored ? 'Active' : 'Paused'}
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="p-4 pt-2 space-y-3">
              <div className="flex items-center justify-between p-2 rounded bg-muted/20 border border-border/40">
                <span className="text-xs font-medium text-foreground">Auto-Review</span>
                <Switch
                  checked={isMonitored}
                  onCheckedChange={(checked) => onToggleAutomation(repo.owner, repo.repo, checked)}
                />
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Review Profile:</span>
                <Badge
                  variant="outline"
                  className={`text-[10px] capitalize font-mono ${
                    profile === 'assertive'
                      ? 'border-purple-500/40 text-purple-400 bg-purple-500/10'
                      : profile === 'chill'
                      ? 'border-sky-500/40 text-sky-400 bg-sky-500/10'
                      : 'border-indigo-500/40 text-indigo-400 bg-indigo-500/10'
                  }`}
                >
                  {profile}
                </Badge>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Architectural Flowcharts:</span>
                <span className={`text-[11px] font-medium ${hasFlowchart ? 'text-indigo-400' : 'text-muted-foreground'}`}>
                  {hasFlowchart ? 'Enabled' : 'Disabled'}
                </span>
              </div>

              {repo.lastVerdict && (
                <div className="flex items-center justify-between text-xs pt-1 border-t border-border/30">
                  <span className="text-muted-foreground">Last Verdict:</span>
                  <div className="flex items-center gap-1 font-mono text-[11px]">
                    {repo.lastVerdict === 'SHIP' ? (
                      <span className="text-emerald-400 flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" /> SHIP
                      </span>
                    ) : (
                      <span className="text-rose-400 flex items-center gap-1">
                        <ShieldAlert className="h-3 w-3" /> BLOCK
                      </span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>

            <CardFooter className="p-4 pt-0">
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs h-8 border-border/80 hover:bg-muted/40 flex items-center justify-center gap-1.5"
                onClick={() => onOpenRules(repo.owner, repo.repo)}
              >
                <Sliders className="h-3.5 w-3.5 text-indigo-400" />
                <span>Configure Rules</span>
              </Button>
            </CardFooter>
          </Card>
        );
      })}
    </div>
  );
}
