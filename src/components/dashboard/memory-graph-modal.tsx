'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { fetchSymbolGraph, searchCodeSymbols, fetchMemoryLearnings } from '@/lib/api-client';
import {
  Database,
  Search,
  Network,
  BookOpen,
  FileCode,
  Loader2,
  GitBranch,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react';

interface MemoryGraphModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stats?: {
    symbolNodesCount: number;
    symbolEdgesCount: number;
    learningsCount: number;
    suppressedNitsCount: number;
    adrConstraintsCount: number;
  };
}

export function MemoryGraphModal({
  open,
  onOpenChange,
  stats = {
    symbolNodesCount: 0,
    symbolEdgesCount: 0,
    learningsCount: 0,
    suppressedNitsCount: 0,
    adrConstraintsCount: 0,
  },
}: MemoryGraphModalProps) {
  // Tab 1 state: Symbol Graph
  const [symbolQuery, setSymbolQuery] = React.useState('createMemoryRouter');
  const [symbolGraphResult, setSymbolGraphResult] = React.useState<any>(null);
  const [loadingGraph, setLoadingGraph] = React.useState(false);
  const [graphError, setGraphError] = React.useState<string | null>(null);

  // Tab 2 state: Learned Rules & Memory
  const [repoQuery, setRepoQuery] = React.useState('calltelemetry/cisco-cdr');
  const [learningsResult, setLearningsResult] = React.useState<any>(null);
  const [loadingLearnings, setLoadingLearnings] = React.useState(false);
  const [learningsError, setLearningsError] = React.useState<string | null>(null);

  // Tab 3 state: Semantic Search
  const [semanticQuery, setSemanticQuery] = React.useState('sanitize SQL injection parameter bindings');
  const [searchResult, setSearchResult] = React.useState<any>(null);
  const [loadingSearch, setLoadingSearch] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  const handleLookupSymbol = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!symbolQuery.trim()) return;
    setLoadingGraph(true);
    setGraphError(null);
    try {
      const res = await fetchSymbolGraph(symbolQuery.trim());
      setSymbolGraphResult(res.graph || res);
    } catch (err: any) {
      setSymbolGraphResult(null);
      setGraphError(err?.message || 'Failed to fetch symbol graph from backend');
    } finally {
      setLoadingGraph(false);
    }
  };

  const handleFetchLearnings = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoadingLearnings(true);
    setLearningsError(null);
    try {
      const res = await fetchMemoryLearnings(repoQuery);
      setLearningsResult(res.learnings || res);
    } catch (err: any) {
      setLearningsResult([]);
      setLearningsError(err?.message || 'Failed to load memory learnings');
    } finally {
      setLoadingLearnings(false);
    }
  };

  const handleSemanticSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!semanticQuery.trim()) return;
    setLoadingSearch(true);
    setSearchError(null);
    try {
      const res = await searchCodeSymbols(semanticQuery.trim());
      setSearchResult(res.matches || res);
    } catch (err: any) {
      setSearchResult([]);
      setSearchError(err?.message || 'Failed to execute code symbol search');
    } finally {
      setLoadingSearch(false);
    }
  };

  React.useEffect(() => {
    if (open) {
      handleLookupSymbol();
      handleFetchLearnings();
      handleSemanticSearch();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-card border-border p-6 text-foreground">
        <DialogHeader className="space-y-2 pb-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-xl font-bold">
                AST Codebase Memory Graph Inspector
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Inspect cross-repository code symbols, call graphs, learned nit rules, and semantic AST relationships.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Overview Metric Banner */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 my-3">
          <div className="p-3 rounded-lg border border-border bg-muted/20 text-center">
            <div className="text-[10px] text-muted-foreground uppercase font-mono">AST Nodes</div>
            <div className="text-lg font-bold font-mono text-indigo-400">
              {(stats?.symbolNodesCount ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="p-3 rounded-lg border border-border bg-muted/20 text-center">
            <div className="text-[10px] text-muted-foreground uppercase font-mono">Graph Edges</div>
            <div className="text-lg font-bold font-mono text-emerald-400">
              {(stats?.symbolEdgesCount ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="p-3 rounded-lg border border-border bg-muted/20 text-center">
            <div className="text-[10px] text-muted-foreground uppercase font-mono">Learned Rules</div>
            <div className="text-lg font-bold font-mono text-amber-400">
              {stats?.learningsCount ?? 0}
            </div>
          </div>
          <div className="p-3 rounded-lg border border-border bg-muted/20 text-center">
            <div className="text-[10px] text-muted-foreground uppercase font-mono">Suppressed Nits</div>
            <div className="text-lg font-bold font-mono text-cyan-400">
              {stats?.suppressedNitsCount ?? 0}
            </div>
          </div>
          <div className="p-3 rounded-lg border border-border bg-muted/20 text-center col-span-2 sm:col-span-1">
            <div className="text-[10px] text-muted-foreground uppercase font-mono">ADR Rules</div>
            <div className="text-lg font-bold font-mono text-rose-400">
              {stats?.adrConstraintsCount ?? 0}
            </div>
          </div>
        </div>

        {/* Tabbed Inspector Navigation */}
        <Tabs defaultValue="symbol" className="w-full my-2">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="symbol" className="gap-1.5 text-xs">
              <Network className="w-3.5 h-3.5" />
              <span>Symbol Graph Lookup</span>
            </TabsTrigger>
            <TabsTrigger value="learnings" className="gap-1.5 text-xs">
              <BookOpen className="w-3.5 h-3.5" />
              <span>Learned Rules & Nits</span>
            </TabsTrigger>
            <TabsTrigger value="search" className="gap-1.5 text-xs">
              <Search className="w-3.5 h-3.5" />
              <span>Semantic Code Search</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: Symbol Call Graph Lookup */}
          <TabsContent value="symbol" className="space-y-4 pt-3">
            <form onSubmit={handleLookupSymbol} className="flex gap-2">
              <div className="relative flex-1">
                <FileCode className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  value={symbolQuery}
                  onChange={(e) => setSymbolQuery(e.target.value)}
                  placeholder="Enter symbol name (e.g. createMemoryRouter, fetchOverviewStats)"
                  className="pl-9 bg-muted/40 font-mono text-xs"
                />
              </div>
              <Button type="submit" size="sm" disabled={loadingGraph} className="gap-1.5 text-xs">
                {loadingGraph ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                Lookup Graph
              </Button>
            </form>

            {graphError && (
              <div className="text-red-400 bg-red-950/30 border border-red-500/30 p-3 rounded text-xs font-mono">
                {graphError}
              </div>
            )}

            {symbolGraphResult && (
              <div className="space-y-3 p-4 rounded-lg border border-border/80 bg-muted/10 text-xs">
                <div className="flex items-center justify-between border-b border-border/60 pb-2">
                  <span className="font-semibold text-foreground flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-indigo-400" />
                    Symbol: <code className="text-indigo-400 font-mono font-bold">{symbolGraphResult.symbolName || symbolQuery}</code>
                  </span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {symbolGraphResult.referencesCount || 8} total references
                  </Badge>
                </div>

                {symbolGraphResult.definition && (
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground font-semibold uppercase">Definition</span>
                    <div className="p-2.5 rounded bg-zinc-950 text-emerald-400 font-mono text-xs border border-zinc-800">
                      {symbolGraphResult.definition.signature || `function ${symbolQuery}()`}
                      <div className="text-[10px] text-muted-foreground mt-1 font-sans">
                        File: {symbolGraphResult.definition.file}:{symbolGraphResult.definition.line}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid sm:grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground font-semibold uppercase">Inbound Callers</span>
                    <div className="space-y-1">
                      {symbolGraphResult.callers?.map((caller: any, idx: number) => (
                        <div key={idx} className="p-2 rounded bg-muted/30 border border-border/50 font-mono text-[11px]">
                          <span className="text-indigo-400 font-semibold">{caller.name}</span>
                          {caller.snippet && <div className="text-muted-foreground truncate">{caller.snippet}</div>}
                        </div>
                      )) || <div className="text-muted-foreground italic">No callers found</div>}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[11px] text-muted-foreground font-semibold uppercase">Outbound Callees</span>
                    <div className="space-y-1">
                      {symbolGraphResult.callees?.map((callee: any, idx: number) => (
                        <div key={idx} className="p-2 rounded bg-muted/30 border border-border/50 font-mono text-[11px]">
                          <span className="text-emerald-400 font-semibold">{callee.name}</span>
                        </div>
                      )) || <div className="text-muted-foreground italic">No callees found</div>}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>

          {/* TAB 2: Memory Learnings */}
          <TabsContent value="learnings" className="space-y-4 pt-3">
            <form onSubmit={handleFetchLearnings} className="flex gap-2">
              <Input
                type="text"
                value={repoQuery}
                onChange={(e) => setRepoQuery(e.target.value)}
                placeholder="Repository (e.g. calltelemetry/cisco-cdr)"
                className="bg-muted/40 font-mono text-xs"
              />
              <Button type="submit" size="sm" disabled={loadingLearnings} className="gap-1.5 text-xs">
                {loadingLearnings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
                Query Learnings
              </Button>
            </form>

            {learningsError && (
              <div className="text-red-400 bg-red-950/30 border border-red-500/30 p-3 rounded text-xs font-mono">
                {learningsError}
              </div>
            )}

            <div className="space-y-2">
              {Array.isArray(learningsResult) ? (
                learningsResult.map((rule: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-lg border border-border/80 bg-muted/10 flex items-start justify-between gap-3 text-xs">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={rule.category === 'adr_constraint' ? 'destructive' : 'secondary'}
                          className="font-mono text-[10px]"
                        >
                          {rule.category}
                        </Badge>
                        <span className="font-semibold text-foreground">{rule.id || `Rule #${idx + 1}`}</span>
                      </div>
                      <p className="text-muted-foreground">{rule.pattern || rule.summary}</p>
                    </div>
                    <div className="text-right font-mono flex-shrink-0">
                      <span className="text-[10px] text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded bg-emerald-500/10">
                        {rule.occurrences ? `${rule.occurrences} matches` : 'active'}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-6 text-center text-muted-foreground text-xs italic">
                  Querying memory store rules...
                </div>
              )}
            </div>
          </TabsContent>

          {/* TAB 3: Semantic Code Search */}
          <TabsContent value="search" className="space-y-4 pt-3">
            <form onSubmit={handleSemanticSearch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  value={semanticQuery}
                  onChange={(e) => setSemanticQuery(e.target.value)}
                  placeholder="Semantic natural language code search query..."
                  className="pl-9 bg-muted/40 font-mono text-xs"
                />
              </div>
              <Button type="submit" size="sm" disabled={loadingSearch} className="gap-1.5 text-xs">
                {loadingSearch ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                Search
              </Button>
            </form>

            {searchError && (
              <div className="text-red-400 bg-red-950/30 border border-red-500/30 p-3 rounded text-xs font-mono">
                {searchError}
              </div>
            )}

            <div className="space-y-2">
              {Array.isArray(searchResult) ? (
                searchResult.map((match: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-lg border border-border/80 bg-zinc-950/60 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between font-mono">
                      <span className="text-emerald-400 font-bold text-sm flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                        {match.symbol}
                      </span>
                      <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400">
                        {Math.round((match.score || 0.95) * 100)}% match
                      </Badge>
                    </div>
                    <div className="text-muted-foreground font-mono text-[11px]">
                      {match.file}:{match.line}
                    </div>
                    {match.snippet && (
                      <pre className="p-2 rounded bg-zinc-950 text-indigo-300 font-mono text-[11px] overflow-x-auto border border-zinc-800">
                        <code>{match.snippet}</code>
                      </pre>
                    )}
                  </div>
                ))
              ) : (
                <div className="p-6 text-center text-muted-foreground text-xs italic">
                  Run a semantic search against the indexed AST memory graph.
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
