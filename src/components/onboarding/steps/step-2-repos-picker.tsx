'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { GitBranch, Search, Lock, Globe, Sparkles, Plus, Check, HelpCircle } from 'lucide-react';
import { RepositorySetting } from '@/types/dashboard';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

interface Step2ReposPickerProps {
  repositories: RepositorySetting[];
  onUpdateRepo: (owner: string, repo: string, patch: Partial<RepositorySetting>) => void;
  onAddRepo?: (owner: string, repo: string) => void;
}

export function Step2ReposPicker({
  repositories,
  onUpdateRepo,
  onAddRepo,
}: Step2ReposPickerProps) {
  const [searchTerm, setSearchTerm] = React.useState('');
  const [newRepoInput, setNewRepoInput] = React.useState('');

  const filteredRepos = repositories.filter(
    (r) =>
      r.repo.toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.owner.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleCreateRepo = () => {
    if (!newRepoInput.trim()) return;
    const parts = newRepoInput.trim().split('/');
    const owner = parts.length > 1 ? parts[0] : 'calltelemetry';
    const repo = parts.length > 1 ? parts[1] : parts[0];
    if (onAddRepo) {
      onAddRepo(owner, repo);
      setNewRepoInput('');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <GitBranch className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Step 2: Monitored Repositories Picker</h3>
            <p className="text-xs text-muted-foreground">
              Toggle review automation per repository and select strictness profiles (`Chill`, `Balanced`, `Assertive`).
            </p>
          </div>
        </div>

        <Badge variant="outline" className="bg-indigo-500/10 text-indigo-400 border-indigo-500/30 gap-1.5 text-xs">
          <Sparkles className="h-3.5 w-3.5" />
          {repositories.filter((r) => r.automationEnabled).length} / {repositories.length} Active
        </Badge>
      </div>

      {/* Controls Bar: Search & Add Repository */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-2.5" />
          <Input
            placeholder="Search repositories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 bg-card/80 text-xs"
          />
        </div>

        {onAddRepo && (
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Input
              placeholder="org/repository-name"
              value={newRepoInput}
              onChange={(e) => setNewRepoInput(e.target.value)}
              className="bg-card/80 text-xs w-full sm:w-64"
            />
            <Button
              size="sm"
              onClick={handleCreateRepo}
              disabled={!newRepoInput.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5 shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Repo
            </Button>
          </div>
        )}
      </div>

      {/* Repositories List */}
      <div className="space-y-3">
        {filteredRepos.length === 0 ? (
          <div className="text-center p-8 rounded-xl border border-dashed border-border/80 bg-card/20 text-muted-foreground text-xs">
            No repositories found matching search query.
          </div>
        ) : (
          filteredRepos.map((item) => {
            const isEnabled = item.automationEnabled;
            const profile = item.customProfile || 'balanced';

            return (
              <Card
                key={`${item.owner}/${item.repo}`}
                className={`border-border/60 transition-all duration-150 ${
                  isEnabled ? 'bg-card/70 border-indigo-500/30' : 'bg-card/30 opacity-75'
                }`}
              >
                <CardContent className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  {/* Repo Title & Visibility */}
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2 rounded-lg ${
                        isEnabled ? 'bg-indigo-500/10 text-indigo-400' : 'bg-muted/40 text-muted-foreground'
                      }`}
                    >
                      <GitBranch className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">
                          {item.owner} / <strong className="text-indigo-400">{item.repo}</strong>
                        </span>
                        <Badge
                          variant="outline"
                          className="text-[10px] bg-muted/30 text-muted-foreground border-border/40 gap-1"
                        >
                          <Globe className="h-3 w-3" />
                          Public
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Default branch: <code className="font-mono text-foreground">main</code>
                      </p>
                    </div>
                  </div>

                  {/* Actions: Strictness Profile & Active/Paused Toggle */}
                  <TooltipProvider>
                    <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end border-t sm:border-t-0 pt-3 sm:pt-0 border-border/40">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground hidden lg:inline flex items-center gap-1">
                          Strictness:
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-foreground cursor-pointer" />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              Chill: Informational suggestions. Balanced: Standard review. Assertive: Strict blocking comments.
                            </TooltipContent>
                          </Tooltip>
                        </span>
                        <Select
                          value={profile}
                          onValueChange={(val: 'chill' | 'balanced' | 'assertive') =>
                            onUpdateRepo(item.owner, item.repo, { customProfile: val })
                          }
                        >
                          <SelectTrigger className="w-32 h-8 text-xs bg-background/80">
                            <SelectValue placeholder="Profile" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="chill">Chill (Informational)</SelectItem>
                            <SelectItem value="balanced">Balanced (Standard)</SelectItem>
                            <SelectItem value="assertive">Assertive (Strict)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={isEnabled ? 'default' : 'outline'}
                            size="sm"
                            onClick={() =>
                              onUpdateRepo(item.owner, item.repo, { automationEnabled: !isEnabled })
                            }
                            className={`h-8 text-xs font-semibold gap-1.5 ${
                              isEnabled
                                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {isEnabled ? (
                              <>
                                <Check className="h-3.5 w-3.5" />
                                Active
                              </>
                            ) : (
                              'Paused'
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {isEnabled ? 'Automated PR reviews are ACTIVE for this repository' : 'Automated PR reviews are PAUSED'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TooltipProvider>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
