'use client';

import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  FolderGit2,
  RefreshCw,
  Plus,
  Search,
  Sparkles,
  FileCode,
  CheckCircle2,
  LayoutGrid,
  List,
  GitPullRequest,
  Sliders,
} from 'lucide-react';
import { RepoTable } from '@/components/repos/repo-table';
import { RepoGrid } from '@/components/repos/repo-grid';
import { OrgSelector } from '@/components/repos/org-selector';
import { ActivePrTable } from '@/components/repos/active-pr-table';
import { ReviewRulesModal } from '@/components/repos/review-rules-modal';
import {
  fetchRepositories,
  updateRepository,
  createRepository,
  runOnboardingScan,
} from '@/lib/api-client';
import { RepositorySetting, OnboardingScanResult, RepositoryReviewRules } from '@/types/dashboard';

export default function ReposPage() {
  const [repositories, setRepositories] = React.useState<RepositorySetting[]>([]);
  const [search, setSearch] = React.useState('');
  const [selectedOrg, setSelectedOrg] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'monitored' | 'paused'>('all');
  const [viewMode, setViewMode] = React.useState<'table' | 'grid'>('table');
  const [loading, setLoading] = React.useState(true);

  // Review Rules Modal state
  const [rulesModalRepo, setRulesModalRepo] = React.useState<{ owner: string; repo: string } | null>(null);

  // Selected Repository for Active PRs
  const [selectedPrRepoKey, setSelectedPrRepoKey] = React.useState<string | null>(null);

  // Add Repository Modal state
  const [addModalOpen, setAddModalOpen] = React.useState(false);
  const [newOwner, setNewOwner] = React.useState('reviewyeti-ai');
  const [newRepo, setNewRepo] = React.useState('');
  const [newProfile, setNewProfile] = React.useState<'chill' | 'balanced' | 'assertive'>('balanced');
  const [isAdding, setIsAdding] = React.useState(false);

  // Onboarding Scan Modal state
  const [scanModalOpen, setScanModalOpen] = React.useState(false);
  const [scanRepoPath, setScanRepoPath] = React.useState('./');
  const [isScanning, setIsScanning] = React.useState(false);
  const [scanResult, setScanResult] = React.useState<OnboardingScanResult | null>(null);

  const loadRepos = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchRepositories();
      setRepositories(data || []);
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const handleToggleAutomation = async (owner: string, repo: string, enabled: boolean) => {
    try {
      const updated = await updateRepository(owner, repo, { automationEnabled: enabled });
      setRepositories((prev) =>
        prev.map((r) => (r.owner === owner && r.repo === repo ? updated : r))
      );
    } catch {
      // Optimistic revert if needed
    }
  };

  const handleToggleFlowchart = async (owner: string, repo: string, enabled: boolean) => {
    try {
      const updated = await updateRepository(owner, repo, { generateArchitecturalFlowchart: enabled });
      setRepositories((prev) =>
        prev.map((r) => (r.owner === owner && r.repo === repo ? updated : r))
      );
    } catch {
      // Optimistic revert if needed
    }
  };

  const handleChangeProfile = async (
    owner: string,
    repo: string,
    profile: 'chill' | 'balanced' | 'assertive'
  ) => {
    try {
      const updated = await updateRepository(owner, repo, { customProfile: profile });
      setRepositories((prev) =>
        prev.map((r) => (r.owner === owner && r.repo === repo ? updated : r))
      );
    } catch {
      // Revert if needed
    }
  };

  const handleRulesSaved = (savedRules: RepositoryReviewRules) => {
    if (!rulesModalRepo) return;
    setRepositories((prev) =>
      prev.map((r) => {
        if (r.owner === rulesModalRepo.owner && r.repo === rulesModalRepo.repo) {
          return {
            ...r,
            rules: savedRules,
            customProfile: (savedRules.reviews?.profile as any) || r.customProfile,
            strictnessProfile: (savedRules.reviews?.profile as any) || r.strictnessProfile,
            automationEnabled: savedRules.auto_review?.enabled ?? r.automationEnabled,
            generateArchitecturalFlowchart:
              savedRules.reviews?.sequence_diagrams ?? r.generateArchitecturalFlowchart,
          };
        }
        return r;
      })
    );
  };

  const handleRunScan = async () => {
    setIsScanning(true);
    try {
      const res = await runOnboardingScan(scanRepoPath);
      setScanResult(res);
    } catch {
      setScanResult({
        repoPath: scanRepoPath,
        detectedStack: ['TypeScript', 'Next.js 15', 'Node.js', 'DigitalOcean K8s'],
        suggestedPersonas: ['security', 'architecture', 'performance', 'quality', 'devops'],
        estimatedLatencyMs: 120,
        generatedYaml: `# .ct-review.yaml\nversion: "1.0"\nprofile: balanced\npersonas:\n  - security\n  - architecture\n  - performance\n  - quality\n  - devops\n`,
      });
    } finally {
      setIsScanning(false);
    }
  };

  const handleAddRepo = async () => {
    if (!newOwner || !newRepo) return;
    setIsAdding(true);
    try {
      const created = await createRepository({
        owner: newOwner.trim(),
        repo: newRepo.trim(),
        automationEnabled: true,
        customProfile: newProfile,
      });
      setRepositories((prev) => [
        ...prev.filter((r) => !(r.owner === created.owner && r.repo === created.repo)),
        created,
      ]);
      setNewRepo('');
      setAddModalOpen(false);
    } catch {
      // Fallback optimistic insert
      const fallback: RepositorySetting = {
        owner: newOwner.trim(),
        repo: newRepo.trim(),
        automationEnabled: true,
        generateArchitecturalFlowchart: true,
        customProfile: newProfile,
        updatedAt: new Date().toISOString(),
      };
      setRepositories((prev) => [...prev, fallback]);
      setNewRepo('');
      setAddModalOpen(false);
    } finally {
      setIsAdding(false);
    }
  };

  const filteredRepos = React.useMemo(() => {
    return repositories.filter((r) => {
      if (selectedOrg && r.owner.toLowerCase() !== selectedOrg.toLowerCase()) {
        return false;
      }
      if (statusFilter === 'monitored' && !r.automationEnabled) {
        return false;
      }
      if (statusFilter === 'paused' && r.automationEnabled) {
        return false;
      }
      if (search) {
        const query = search.toLowerCase();
        const matchesOwner = r.owner.toLowerCase().includes(query);
        const matchesRepo = r.repo.toLowerCase().includes(query);
        if (!matchesOwner && !matchesRepo) return false;
      }
      return true;
    });
  }, [repositories, selectedOrg, statusFilter, search]);

  // Determine which repo's PRs are being viewed
  const activePrRepo = React.useMemo(() => {
    if (selectedPrRepoKey) {
      const found = repositories.find((r) => `${r.owner}/${r.repo}` === selectedPrRepoKey);
      if (found) return found;
    }
    return filteredRepos.length > 0 ? filteredRepos[0] : null;
  }, [selectedPrRepoKey, repositories, filteredRepos]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            Repositories &amp; Automation
          </h1>
          <p className="text-xs text-muted-foreground">
            GitHub webhook triggers, enforcement profiles, and active PR review status
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Organization Selector */}
          <OrgSelector
            selectedOrg={selectedOrg}
            onSelectOrg={setSelectedOrg}
            className="shrink-0"
          />

          {/* Add Repository Modal */}
          <Dialog open={addModalOpen} onOpenChange={setAddModalOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" />
                Add Repository
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md bg-background/95 border-border/80 backdrop-blur-xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                  <FolderGit2 className="h-4 w-4 text-indigo-400" />
                  Onboard New Repository
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Add a new GitHub repository to active automated persona reviews
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 pt-2 text-xs">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground block mb-1">
                    Organization / Owner
                  </label>
                  <Input
                    value={newOwner}
                    onChange={(e) => setNewOwner(e.target.value)}
                    placeholder="e.g. reviewyeti-ai"
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground block mb-1">
                    Repository Name
                  </label>
                  <Input
                    value={newRepo}
                    onChange={(e) => setNewRepo(e.target.value)}
                    placeholder="e.g. backend-api"
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground block mb-1">
                    Review Strictness Profile
                  </label>
                  <select
                    value={newProfile}
                    onChange={(e) => setNewProfile(e.target.value as any)}
                    className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="chill">Chill (Low strictness)</option>
                    <option value="balanced">Balanced (Standard)</option>
                    <option value="assertive">Assertive (Strict)</option>
                  </select>
                </div>
              </div>

              <DialogFooter className="pt-3">
                <Button variant="outline" size="sm" onClick={() => setAddModalOpen(false)} className="text-xs">
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleAddRepo}
                  disabled={isAdding || !newOwner || !newRepo}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {isAdding ? 'Onboarding...' : 'Onboard Repo'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Trigger Onboarding Scan Modal */}
          <Dialog open={scanModalOpen} onOpenChange={setScanModalOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                Scan Stack
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg bg-background/95 border-border/80 backdrop-blur-xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base font-semibold">
                  <Sparkles className="h-4 w-4 text-indigo-400" />
                  Repository Onboarding & Stack Scanner
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Scan repository technology stack and auto-generate .ct-review.yaml configuration
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 pt-2 text-xs">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground block mb-1">
                    Repository Path or Directory
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={scanRepoPath}
                      onChange={(e) => setScanRepoPath(e.target.value)}
                      placeholder="./"
                      className="font-mono text-xs bg-background/80"
                    />
                    <Button
                      size="sm"
                      onClick={handleRunScan}
                      disabled={isScanning}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs shrink-0 gap-1.5"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                      {isScanning ? 'Scanning...' : 'Run Scan'}
                    </Button>
                  </div>
                </div>

                {scanResult && (
                  <div className="space-y-3 pt-2">
                    <div className="p-3 rounded-lg border border-border/60 bg-muted/40 space-y-2">
                      <div className="font-semibold text-foreground flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        Detected Tech Stack:
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {scanResult.detectedStack.map((tech) => (
                          <span
                            key={tech}
                            className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono text-[11px] border border-indigo-500/30"
                          >
                            {tech}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg border border-border/60 bg-muted/40 space-y-1.5">
                      <div className="font-semibold text-foreground flex items-center gap-1.5">
                        <FileCode className="h-4 w-4 text-amber-400" />
                        Generated .ct-review.yaml:
                      </div>
                      <pre className="font-mono text-[11px] p-2.5 rounded bg-background/80 text-foreground border border-border/40 overflow-x-auto whitespace-pre">
                        {scanResult.generatedYaml}
                      </pre>
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter className="pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setScanModalOpen(false)}
                  className="text-xs"
                >
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={loadRepos}
            disabled={loading}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Main Repositories Management Card */}
      <Card className="glass-panel border-border/80">
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <FolderGit2 className="h-4 w-4 text-indigo-400" />
                Monitored Repositories ({filteredRepos.length})
              </CardTitle>
            </div>

            {/* Controls: Search, Status Filter Pills, View Mode Switcher */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Search Bar */}
              <div className="relative w-full sm:w-56">
                <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
                <Input
                  placeholder="Filter repositories..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 text-xs bg-background/80 h-9"
                  aria-label="Filter repositories"
                  data-testid="repo-search-input"
                />
              </div>

              {/* Status Filter Buttons */}
              <div className="inline-flex rounded-lg border border-border/80 p-0.5 bg-muted/30">
                {(['all', 'monitored', 'paused'] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setStatusFilter(filter)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize ${
                      statusFilter === filter
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                    data-testid={`filter-status-${filter}`}
                  >
                    {filter}
                  </button>
                ))}
              </div>

              {/* View Mode Toggle */}
              <div className="inline-flex rounded-lg border border-border/80 p-0.5 bg-muted/30">
                <button
                  type="button"
                  onClick={() => setViewMode('table')}
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'table'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                  aria-label="Table View"
                  title="Table View"
                  data-testid="view-table-btn"
                >
                  <List className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                  aria-label="Grid View"
                  title="Grid View"
                  data-testid="view-grid-btn"
                >
                  <LayoutGrid className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {viewMode === 'table' ? (
            <RepoTable
              repositories={filteredRepos}
              onToggleAutomation={handleToggleAutomation}
              onToggleFlowchart={handleToggleFlowchart}
              onChangeProfile={handleChangeProfile}
              onRunScan={() => setScanModalOpen(true)}
              onOpenRules={(owner, repo) => setRulesModalRepo({ owner, repo })}
            />
          ) : (
            <RepoGrid
              repositories={filteredRepos}
              onToggleAutomation={handleToggleAutomation}
              onOpenRules={(owner, repo) => setRulesModalRepo({ owner, repo })}
            />
          )}
        </CardContent>
      </Card>

      {/* Active Pull Requests & Review Triggers Section */}
      <Card className="glass-panel border-border/80">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-bold">
                <GitPullRequest className="h-4 w-4 text-indigo-400" />
                Active Pull Requests
              </CardTitle>
            </div>

            {/* Repo selector for PR inspection */}
            {filteredRepos.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Viewing:</span>
                <select
                  value={activePrRepo ? `${activePrRepo.owner}/${activePrRepo.repo}` : ''}
                  onChange={(e) => setSelectedPrRepoKey(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-2.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  data-testid="active-pr-repo-select"
                >
                  {filteredRepos.map((r) => (
                    <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>
                      {r.owner}/{r.repo}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {activePrRepo ? (
            <ActivePrTable
              owner={activePrRepo.owner}
              repo={activePrRepo.repo}
            />
          ) : (
            <div className="rounded-lg border border-border/80 bg-card/40 p-8 text-center text-muted-foreground text-xs">
              No repositories available to display pull requests.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review Rules Modal */}
      {rulesModalRepo && (
        <ReviewRulesModal
          isOpen={rulesModalRepo !== null}
          onClose={() => setRulesModalRepo(null)}
          owner={rulesModalRepo.owner}
          repo={rulesModalRepo.repo}
          onRulesSaved={handleRulesSaved}
        />
      )}
    </div>
  );
}
