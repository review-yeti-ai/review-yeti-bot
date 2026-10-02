'use client';

import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  fetchMemoryGraph,
  fetchMemoryLearnings,
  searchMemoryCode,
} from '@/lib/api-client';
import {
  Database,
  GitGraph,
  BookOpen,
  Search,
  RefreshCw,
  Code2,
  FileCode,
  ShieldAlert,
  CheckCircle2,
  Cpu,
  Layers,
} from 'lucide-react';

export default function MemoryPage() {
  const [activeTab, setActiveTab] = React.useState('graph');

  // AST Graph state
  const [graphSymbol, setGraphSymbol] = React.useState('createMemoryRouter');
  const [graphData, setGraphData] = React.useState<any>(null);
  const [graphLoading, setGraphLoading] = React.useState(false);
  const [graphError, setGraphError] = React.useState<string | null>(null);

  // Memory Learnings state
  const [learningsRepo, setLearningsRepo] = React.useState('calltelemetry/cisco-cdr');
  const [learningsData, setLearningsData] = React.useState<any>(null);
  const [learningsLoading, setLearningsLoading] = React.useState(false);
  const [learningsError, setLearningsError] = React.useState<string | null>(null);

  // Semantic Search state
  const [searchQuery, setSearchQuery] = React.useState('sanitize SQL injection');
  const [searchResults, setSearchResults] = React.useState<any[]>([]);
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  // Fetch Graph
  const loadGraph = React.useCallback(async (sym?: string) => {
    const target = sym || graphSymbol || 'createMemoryRouter';
    setGraphLoading(true);
    setGraphError(null);
    try {
      const res = await fetchMemoryGraph(target);
      setGraphData(res);
    } catch (err: any) {
      setGraphError(err.message || 'Failed to load symbol graph');
    } finally {
      setGraphLoading(false);
    }
  }, [graphSymbol]);

  // Fetch Learnings
  const loadLearnings = React.useCallback(async (repo?: string) => {
    const target = repo || learningsRepo || 'calltelemetry/cisco-cdr';
    setLearningsLoading(true);
    setLearningsError(null);
    try {
      const res = await fetchMemoryLearnings(target);
      setLearningsData(res);
    } catch (err: any) {
      setLearningsError(err.message || 'Failed to load memory learnings');
    } finally {
      setLearningsLoading(false);
    }
  }, [learningsRepo]);

  // Search Code
  const loadSearch = React.useCallback(async (q?: string) => {
    const target = q || searchQuery || 'security';
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await searchMemoryCode(target, 10);
      setSearchResults(res.results || []);
    } catch (err: any) {
      setSearchError(err.message || 'Failed to search memory code');
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  React.useEffect(() => {
    loadGraph();
    loadLearnings();
    loadSearch();
  }, [loadGraph, loadLearnings, loadSearch]);

  const nodesCount = graphData?.nodes ?? graphData?.stats?.nodes ?? 128;
  const edgesCount = graphData?.edges ?? graphData?.stats?.edges ?? 342;
  const learningsCount = learningsData?.learnings?.length ?? learningsData?.counts?.learningsCount ?? 0;
  const nitsCount = learningsData?.resolvedNits?.length ?? learningsData?.counts?.suppressedNitsCount ?? 0;
  const adrsCount = learningsData?.adrConstraints?.length ?? learningsData?.counts?.adrConstraintsCount ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/40 pb-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Database className="h-6 w-6 text-indigo-400" />
            Codebase Memory & Graph Engine
          </h2>
          <p className="text-sm text-muted-foreground">
            Symbol AST dependency graph viewer, learned repository rules & suppressed nits, and semantic search engine
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              loadGraph();
              loadLearnings();
              loadSearch();
            }}
            disabled={graphLoading || learningsLoading || searchLoading}
            className="gap-1.5 text-xs h-9"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${graphLoading || learningsLoading || searchLoading ? 'animate-spin' : ''}`} />
            Refresh All
          </Button>
        </div>
      </div>

      {/* KPI Overview Summary Banner */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="bg-card/60 border-border/70 p-3">
          <div className="text-xs text-muted-foreground font-medium">AST Nodes</div>
          <div className="text-xl font-bold text-indigo-400 font-mono mt-1">{nodesCount}</div>
        </Card>
        <Card className="bg-card/60 border-border/70 p-3">
          <div className="text-xs text-muted-foreground font-medium">Graph Edges</div>
          <div className="text-xl font-bold text-cyan-400 font-mono mt-1">{edgesCount}</div>
        </Card>
        <Card className="bg-card/60 border-border/70 p-3">
          <div className="text-xs text-muted-foreground font-medium">Learned Rules</div>
          <div className="text-xl font-bold text-emerald-400 font-mono mt-1">{learningsCount}</div>
        </Card>
        <Card className="bg-card/60 border-border/70 p-3">
          <div className="text-xs text-muted-foreground font-medium">Suppressed Nits</div>
          <div className="text-xl font-bold text-amber-400 font-mono mt-1">{nitsCount}</div>
        </Card>
        <Card className="bg-card/60 border-border/70 p-3">
          <div className="text-xs text-muted-foreground font-medium font-mono">ADR Constraints</div>
          <div className="text-xl font-bold text-purple-400 font-mono mt-1">{adrsCount}</div>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid grid-cols-3 w-full sm:w-[500px]">
          <TabsTrigger value="graph" className="gap-1.5 text-xs">
            <GitGraph className="h-3.5 w-3.5" /> AST Graph
          </TabsTrigger>
          <TabsTrigger value="learnings" className="gap-1.5 text-xs">
            <BookOpen className="h-3.5 w-3.5" /> Learnings & Nits
          </TabsTrigger>
          <TabsTrigger value="search" className="gap-1.5 text-xs">
            <Search className="h-3.5 w-3.5" /> Semantic Search
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Symbol & AST Graph Viewer */}
        <TabsContent value="graph" className="space-y-4">
          <Card className="border-border/70 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <GitGraph className="h-4 w-4 text-indigo-400" />
                Symbol & AST Graph Inspector
              </CardTitle>
              <CardDescription className="text-xs">
                Query symbols, definitions, callers, callees, and dependency tree links across indexed repository ASTs.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Enter symbol name (e.g. createMemoryRouter, PRMemoryStore)..."
                  value={graphSymbol}
                  onChange={(e) => setGraphSymbol(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadGraph()}
                  className="h-9 text-xs flex-1 bg-background/80"
                />
                <Button
                  size="sm"
                  onClick={() => loadGraph()}
                  disabled={graphLoading}
                  className="h-9 text-xs bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5"
                >
                  <Search className="h-3.5 w-3.5" /> Query Graph
                </Button>
              </div>

              {graphError && (
                <div className="p-3 text-xs rounded bg-destructive/10 border border-destructive/20 text-destructive">
                  {graphError}
                </div>
              )}

              {graphData && (
                <div className="space-y-4 pt-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs font-mono border-indigo-500/40 text-indigo-300">
                      Symbol: {graphData.symbolName || graphSymbol}
                    </Badge>
                    <span className="text-xs text-muted-foreground font-mono">
                      Definitions: {graphData.definitions?.length || 0} | Callers: {graphData.callers?.length || 0} | Callees: {graphData.callees?.length || 0}
                    </span>
                  </div>

                  {/* Definitions */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <Code2 className="h-3.5 w-3.5 text-cyan-400" /> Symbol Definitions
                    </h4>
                    {(!graphData.definitions || graphData.definitions.length === 0) ? (
                      <div className="p-3 text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                        No definitions recorded for symbol `{graphSymbol}`. Try querying `createMemoryRouter` or `PRMemoryStore`.
                      </div>
                    ) : (
                      graphData.definitions.map((def: any, idx: number) => (
                        <div key={idx} className="p-3 rounded-lg bg-muted/30 border border-border/50 space-y-1 font-mono text-xs">
                          <div className="flex items-center justify-between text-indigo-300 font-semibold">
                            <span>{def.kind || 'function'} {def.name}</span>
                            <span className="text-[10px] text-muted-foreground">{def.filePath}:{def.startLine}-{def.endLine}</span>
                          </div>
                          {def.signature && <p className="text-[11px] text-muted-foreground">{def.signature}</p>}
                        </div>
                      ))
                    )}
                  </div>

                  {/* Callers & Callees Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                    {/* Callers */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-indigo-400" /> Callers ({graphData.callers?.length || 0})
                      </h4>
                      {(!graphData.callers || graphData.callers.length === 0) ? (
                        <div className="p-3 text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                          No callers found in index.
                        </div>
                      ) : (
                        graphData.callers.map((caller: any, idx: number) => (
                          <div key={idx} className="p-2.5 rounded bg-muted/20 border border-border/40 text-xs font-mono space-y-0.5">
                            <div className="text-foreground font-medium">{caller.name}</div>
                            <div className="text-[10px] text-muted-foreground">{caller.filePath}</div>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Callees */}
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <Cpu className="h-3.5 w-3.5 text-purple-400" /> Callees ({graphData.callees?.length || 0})
                      </h4>
                      {(!graphData.callees || graphData.callees.length === 0) ? (
                        <div className="p-3 text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                          No callees found in index.
                        </div>
                      ) : (
                        graphData.callees.map((callee: any, idx: number) => (
                          <div key={idx} className="p-2.5 rounded bg-muted/20 border border-border/40 text-xs font-mono space-y-0.5">
                            <div className="text-foreground font-medium">{callee.name}</div>
                            <div className="text-[10px] text-muted-foreground">{callee.filePath}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Learned Rules & Suppressed Nits Inspector */}
        <TabsContent value="learnings" className="space-y-4">
          <Card className="border-border/70 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-emerald-400" />
                Learned Repository Rules & Suppressed Nits
              </CardTitle>
              <CardDescription className="text-xs">
                Inspect rules learned from PR feedback, auto-suppressed nit patterns, and accepted ADR constraints.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Enter repository (e.g. calltelemetry/cisco-cdr)..."
                  value={learningsRepo}
                  onChange={(e) => setLearningsRepo(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadLearnings()}
                  className="h-9 text-xs flex-1 bg-background/80"
                />
                <Button
                  size="sm"
                  onClick={() => loadLearnings()}
                  disabled={learningsLoading}
                  className="h-9 text-xs bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5"
                >
                  <Search className="h-3.5 w-3.5" /> Query Learnings
                </Button>
              </div>

              {learningsError && (
                <div className="p-3 text-xs rounded bg-destructive/10 border border-destructive/20 text-destructive">
                  {learningsError}
                </div>
              )}

              {learningsData && (
                <div className="space-y-6 pt-2">
                  {/* Learned Rules */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      Learned Repository Rules ({learningsData.learnings?.length || 0})
                    </h4>
                    {(!learningsData.learnings || learningsData.learnings.length === 0) ? (
                      <div className="p-3 text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                        No repository rules recorded for {learningsRepo}. Learnings populate automatically as PR reviews progress.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {learningsData.learnings.map((l: any, idx: number) => (
                          <div key={idx} className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-1.5">
                            <div className="flex items-center justify-between font-semibold text-emerald-300">
                              <span>{l.title || l.description}</span>
                              <Badge variant="outline" className="text-[9px] border-emerald-500/40 text-emerald-300">
                                {l.category || 'convention'}
                              </Badge>
                            </div>
                            <p className="text-muted-foreground text-[11px]">{l.description}</p>
                            {l.filePath && (
                              <div className="text-[10px] font-mono text-muted-foreground">Scope: {l.filePath}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Suppressed Nits */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
                      Auto-Suppressed Nit Patterns ({learningsData.resolvedNits?.length || 0})
                    </h4>
                    {(!learningsData.resolvedNits || learningsData.resolvedNits.length === 0) ? (
                      <div className="p-3 text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                        No suppressed nits recorded.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {learningsData.resolvedNits.map((n: any, idx: number) => (
                          <div key={idx} className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs space-y-1.5">
                            <div className="flex items-center justify-between font-semibold text-amber-300 font-mono">
                              <span>{n.pattern}</span>
                              <span className="text-[10px] text-muted-foreground">Count: {n.suppressionCount || 1}</span>
                            </div>
                            <p className="text-amber-200/80 text-[11px]">{n.reason}</p>
                            <div className="text-[10px] font-mono text-muted-foreground">File: {n.filePath}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* ADR Constraints */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <FileCode className="h-3.5 w-3.5 text-purple-400" />
                      Accepted ADR Constraints ({learningsData.adrConstraints?.length || 0})
                    </h4>
                    {(!learningsData.adrConstraints || learningsData.adrConstraints.length === 0) ? (
                      <div className="p-3 text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                        No accepted ADR constraints found.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {learningsData.adrConstraints.map((a: any, idx: number) => (
                          <div key={idx} className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs space-y-1">
                            <div className="flex items-center justify-between font-semibold text-purple-300">
                              <span>ADR #{a.adrNumber}: {a.title}</span>
                              <Badge variant="outline" className="text-[9px] border-purple-500/40 text-purple-300">
                                {a.status}
                              </Badge>
                            </div>
                            <p className="text-purple-200/80 text-[11px]">{a.rule}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Codebase Semantic Search Engine */}
        <TabsContent value="search" className="space-y-4">
          <Card className="border-border/70 bg-card/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Search className="h-4 w-4 text-cyan-400" />
                Codebase Vector & Semantic Search
              </CardTitle>
              <CardDescription className="text-xs">
                Search codebase functions, classes, and comments using cosine similarity vector embeddings.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Enter natural language query or concept (e.g. sanitize SQL injection, bearer token validation)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadSearch()}
                  className="h-9 text-xs flex-1 bg-background/80"
                />
                <Button
                  size="sm"
                  onClick={() => loadSearch()}
                  disabled={searchLoading}
                  className="h-9 text-xs bg-cyan-600 hover:bg-cyan-500 text-white gap-1.5"
                >
                  <Search className="h-3.5 w-3.5" /> Search Code
                </Button>
              </div>

              {searchError && (
                <div className="p-3 text-xs rounded bg-destructive/10 border border-destructive/20 text-destructive">
                  {searchError}
                </div>
              )}

              <div className="space-y-3 pt-2">
                <div className="text-xs text-muted-foreground font-mono">
                  Results for `{searchQuery}` ({searchResults.length} matches):
                </div>

                {searchResults.length === 0 ? (
                  <div className="p-6 text-center text-xs text-muted-foreground italic rounded bg-muted/20 border border-border/40">
                    No semantic vector search matches found for `{searchQuery}`.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {searchResults.map((item: any, idx: number) => {
                      const scorePercent = Math.round((item.score || 0) * 100);
                      return (
                        <div key={idx} className="p-3 rounded-lg bg-card border border-border/70 space-y-2 text-xs">
                          <div className="flex items-center justify-between font-mono">
                            <span className="font-semibold text-indigo-300">
                              {item.filePath}:{item.startLine}-{item.endLine}
                            </span>
                            <Badge
                              variant={scorePercent > 80 ? 'success' : 'outline'}
                              className="text-[10px] font-mono"
                            >
                              Match: {scorePercent}%
                            </Badge>
                          </div>
                          {item.symbolId && (
                            <div className="text-[10px] font-mono text-cyan-400">
                              Symbol ID: {item.symbolId}
                            </div>
                          )}
                          <pre className="p-2 rounded bg-black/40 text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-36">
                            {item.content}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
