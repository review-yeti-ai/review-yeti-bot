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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RepositorySetting } from '@/types/dashboard';
import { FolderGit2, CheckCircle, Sliders, ExternalLink, Sparkles } from 'lucide-react';

interface RepoTableProps {
  repositories: RepositorySetting[];
  onToggleAutomation: (owner: string, repo: string, enabled: boolean) => void;
  onToggleFlowchart?: (owner: string, repo: string, enabled: boolean) => void;
  onChangeProfile: (owner: string, repo: string, profile: 'chill' | 'balanced' | 'assertive') => void;
  onRunScan?: () => void;
}

export function RepoTable({ repositories, onToggleAutomation, onToggleFlowchart, onChangeProfile, onRunScan }: RepoTableProps) {
  const [editingRepo, setEditingRepo] = React.useState<RepositorySetting | null>(null);

  return (
    <div className="rounded-lg border border-border/80 bg-card/60 overflow-x-auto scrollbar-thin">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow>
            <TableHead>Repository Name</TableHead>
            <TableHead className="w-[140px]">Automation</TableHead>
            <TableHead className="w-[160px]">Review Profile</TableHead>
            <TableHead className="w-[180px]">Architectural Diagrams</TableHead>
            <TableHead className="w-[140px]">Model Overrides</TableHead>
            <TableHead className="text-right w-[160px]">Actions / Scan</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {repositories.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">
                No repositories configured yet.
              </TableCell>
            </TableRow>
          ) : (
            repositories.map((r) => {
              const flowchartActive = r.generateArchitecturalFlowchart ?? true;
              return (
                <TableRow key={`${r.owner}/${r.repo}`} className="hover:bg-muted/20">
                  <TableCell className="font-mono text-xs font-semibold text-foreground">
                    <div className="flex items-center gap-2">
                      <FolderGit2 className="h-4 w-4 text-indigo-400" />
                      <span>
                        {r.owner}/<strong className="text-indigo-300">{r.repo}</strong>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onToggleAutomation(r.owner, r.repo, !r.automationEnabled)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                        r.automationEnabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                      }`}
                      role="switch"
                      aria-checked={r.automationEnabled}
                    >
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          r.automationEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                    <span className="ml-2 text-xs font-semibold text-muted-foreground">
                      {r.automationEnabled ? 'Active' : 'Paused'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={r.customProfile || 'balanced'}
                      onValueChange={(val: 'chill' | 'balanced' | 'assertive') =>
                        onChangeProfile(r.owner, r.repo, val)
                      }
                    >
                      <SelectTrigger className="h-7 text-xs bg-background/80 min-w-[130px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chill">Chill (Low strictness)</SelectItem>
                        <SelectItem value="balanced">Balanced (Standard)</SelectItem>
                        <SelectItem value="assertive">Assertive (Strict)</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onToggleFlowchart?.(r.owner, r.repo, !flowchartActive)}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                          flowchartActive ? 'bg-indigo-600' : 'bg-muted-foreground/30'
                        }`}
                        role="switch"
                        aria-checked={flowchartActive}
                        aria-label="Generate Architectural Sequence & Flowchart Diagrams"
                        title="Generate Architectural Sequence & Flowchart Diagrams"
                        data-testid={`repo-flowchart-toggle-${r.owner}-${r.repo}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            flowchartActive ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                      <span className="text-[11px] font-semibold text-muted-foreground">
                        {flowchartActive ? 'Diagrams On' : 'Diagrams Off'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] font-mono border-border/80">
                      {r.modelOverrides && Object.keys(r.modelOverrides).length > 0
                        ? `${Object.keys(r.modelOverrides).length} overrides`
                        : 'Default Models'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingRepo(r)}
                        className="h-7 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                        aria-label={`Settings for ${r.owner}/${r.repo}`}
                        data-testid={`repo-settings-btn-${r.owner}-${r.repo}`}
                      >
                        <Sliders className="h-3 w-3" /> Settings
                      </Button>
                      {onRunScan && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={onRunScan}
                          aria-label="Scan"
                          className="h-7 text-[11px] gap-1 text-indigo-300 hover:text-white"
                        >
                          <Sparkles className="h-3 w-3 text-indigo-400" /> Scan Stack
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {/* Per-Repository Settings Modal */}
      {editingRepo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-background border border-border/80 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-border/40">
              <div className="flex items-center gap-2">
                <FolderGit2 className="h-4 w-4 text-indigo-400" />
                <h3 className="font-semibold text-sm text-foreground">
                  Repository Settings — {editingRepo.owner}/{editingRepo.repo}
                </h3>
              </div>
              <button
                onClick={() => setEditingRepo(null)}
                className="text-muted-foreground hover:text-foreground font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 pt-1">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20">
                <div>
                  <div className="font-semibold text-foreground">Automated PR Review Trigger</div>
                  <p className="text-[11px] text-muted-foreground">Enable or pause automatic persona review execution on pull requests.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onToggleAutomation(editingRepo.owner, editingRepo.repo, !editingRepo.automationEnabled);
                    setEditingRepo((prev) => prev ? { ...prev, automationEnabled: !prev.automationEnabled } : null);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    editingRepo.automationEnabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                  }`}
                  role="switch"
                  aria-checked={editingRepo.automationEnabled}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      editingRepo.automationEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20">
                <div>
                  <div className="font-semibold text-foreground">Generate Architectural Sequence &amp; Flowchart Diagrams</div>
                  <p className="text-[11px] text-muted-foreground">Analyze AST diff changes to generate dynamic Mermaid.js sequence and flowchart diagrams.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const nextState = !(editingRepo.generateArchitecturalFlowchart ?? true);
                    onToggleFlowchart?.(editingRepo.owner, editingRepo.repo, nextState);
                    setEditingRepo((prev) => prev ? { ...prev, generateArchitecturalFlowchart: nextState } : null);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    (editingRepo.generateArchitecturalFlowchart ?? true) ? 'bg-indigo-600' : 'bg-muted-foreground/30'
                  }`}
                  role="switch"
                  aria-checked={editingRepo.generateArchitecturalFlowchart ?? true}
                  aria-label="Generate Architectural Sequence & Flowchart Diagrams"
                  data-testid="modal-repo-flowchart-toggle"
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      (editingRepo.generateArchitecturalFlowchart ?? true) ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-border/40">
              <Button size="sm" onClick={() => setEditingRepo(null)} className="text-xs">
                Close Settings
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

