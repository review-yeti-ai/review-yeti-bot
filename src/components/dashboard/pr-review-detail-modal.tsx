'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MermaidViewer } from './mermaid-viewer';
import { PipelineFlowViewer } from './pipeline-flow-viewer';
import { ReviewJob, PersonaLogEntry } from '@/types/dashboard';
import {
  GitPullRequest,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Coins,
  Cpu,
  ShieldCheck,
  GitCommit,
  Bot,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  FileCode,
  AlertCircle,
  Terminal,
  ListChecks,
} from 'lucide-react';
import { formatRelativeTime } from '@/lib/utils';

class ModalErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onReset: () => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ModalErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-center space-y-4 bg-card border border-destructive/40 rounded-lg text-foreground">
          <div className="p-3 rounded-full bg-destructive/10 w-fit mx-auto text-destructive">
            <AlertCircle className="w-8 h-8" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-bold">Unable to render PR review details</h3>
            <p className="text-xs text-muted-foreground">
              {this.state.error?.message || 'A safe rendering fallback was activated for this review log.'}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              this.setState({ hasError: false, error: null });
              this.props.onReset();
            }}
            className="text-xs"
          >
            Close Dialog
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface PRReviewDetailModalProps {
  job: ReviewJob | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PRReviewDetailModal({
  job,
  open,
  onOpenChange,
}: PRReviewDetailModalProps) {
  const [expandedPersonas, setExpandedPersonas] = React.useState<Record<string, boolean>>({});

  const personaLogs = React.useMemo(() => {
    if (!job) return [];

    const rawLogs: PersonaLogEntry[] = (job.personaLogs && job.personaLogs.length > 0)
      ? job.personaLogs
      : [];

    return rawLogs.map((entry) => {
      const personaStr = (entry && entry.persona) ? String(entry.persona) : 'unknown';
      const model = (entry && entry.model) || 'unknown';
      const reasoningChain = (entry && entry.reasoningChain && entry.reasoningChain.length > 0)
        ? entry.reasoningChain
        : [];
      const nits = (entry && entry.nits && entry.nits.length > 0)
        ? entry.nits
        : [];
      const outputLog = (entry && entry.outputLog) || (entry?.apiError
        ? `[API_ERROR] ${entry.apiError}`
        : `[PERSONA] ${entry?.displayName || personaStr} (${model}) — ${entry?.decision || 'N/A'}`);

      return {
        ...entry,
        persona: personaStr,
        model,
        reasoningChain,
        nits,
        outputLog,
      };
    });
  }, [job]);

  if (!job) return null;

  const togglePersona = (personaKey: string) => {
    setExpandedPersonas((prev) => ({
      ...prev,
      [personaKey]: !prev[personaKey],
    }));
  };

  const getVerdictBadge = (verdict?: string) => {
    const v = (verdict || 'SHIP').toUpperCase();
    switch (v) {
      case 'SHIP':
        return (
          <Badge variant="success" className="gap-1 px-3 py-1 font-mono text-xs">
            <CheckCircle2 className="w-3.5 h-3.5" /> SHIP
          </Badge>
        );
      case 'NACK':
        return (
          <Badge variant="destructive" className="gap-1 px-3 py-1 font-mono text-xs">
            <XCircle className="w-3.5 h-3.5" /> NACK
          </Badge>
        );
      case 'COMMENT':
      default:
        return (
          <Badge variant="warning" className="gap-1 px-3 py-1 font-mono text-xs">
            <AlertTriangle className="w-3.5 h-3.5" /> COMMENT
          </Badge>
        );
    }
  };

  const getStatusBadge = (status?: string) => {
    const s = (status || 'completed').toLowerCase();
    switch (s) {
      case 'completed':
        return <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">Completed</Badge>;
      case 'running':
        return <Badge variant="outline" className="text-indigo-400 border-indigo-500/30 animate-pulse">Running</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="secondary">Pending</Badge>;
    }
  };



  const promptTokens = job.tokenDetails?.prompt ?? (job.tokens ? Math.round(job.tokens * 0.7) : 0);
  const completionTokens = job.tokenDetails?.completion ?? (job.tokens ? Math.round(job.tokens * 0.3) : 0);
  const totalTokens = job.tokenDetails?.total ?? job.tokens ?? 0;
  const quorum = job.quorum || '—';
  const headSha = job.headSha || '—';
  const repoStr = job.repo || (job as any).repository || 'unknown/repo';
  const prNumStr = job.prNumber ?? 0;
  const githubPrUrl = `https://github.com/${repoStr}/pull/${prNumStr}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-card border-border p-6 text-foreground">
        <ModalErrorBoundary onReset={() => onOpenChange(false)}>
          <DialogHeader className="space-y-3 pb-4 border-b border-border/60">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <GitPullRequest className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-muted-foreground">{repoStr}</span>
                  <span className="font-mono text-sm font-bold text-primary">#{prNumStr}</span>
                </div>
                <DialogTitle className="text-xl font-bold text-foreground mt-0.5">
                  {job.title || 'PR Review Evaluation'}
                </DialogTitle>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={githubPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="github-pr-link-modal"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs shadow-sm transition-colors"
              >
                View PR on GitHub ↗
              </a>
              {getStatusBadge(job.status)}
              {getVerdictBadge(job.verdict)}
            </div>
          </div>
          <DialogDescription className="text-xs text-muted-foreground flex items-center gap-4 flex-wrap">
            <span className="flex items-center gap-1">
              <GitCommit className="w-3.5 h-3.5 text-muted-foreground" />
              Commit: <code className="font-mono text-indigo-400">{headSha}</code>
            </span>
            <span>•</span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              Executed: <Badge variant="outline" className="text-[10px] font-mono py-0 px-1.5 border-border/80 text-foreground">⏱️ {formatRelativeTime(job.timestamp)}</Badge>
              <span className="text-[11px] text-muted-foreground/70">({job.timestamp})</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* Core Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
          <div className="p-3.5 rounded-lg border border-border bg-muted/20 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
              <span>Tokens Used</span>
              <Cpu className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <div className="text-lg font-bold font-mono text-foreground">
              {totalTokens.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              In: {promptTokens.toLocaleString()} | Out: {completionTokens.toLocaleString()}
            </div>
          </div>

          <div className="p-3.5 rounded-lg border border-border bg-muted/20 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
              <span>Execution Cost</span>
              <Coins className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div className="text-lg font-bold font-mono text-emerald-400">
              ${job.cost.toFixed(4)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Est. API usage cost
            </div>
          </div>

          <div className="p-3.5 rounded-lg border border-border bg-muted/20 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
              <span>Total Wall Time</span>
              <Clock className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="text-lg font-bold font-mono text-foreground">
              {(((job as any).durationMs ?? job.latencyMs ?? 0) / 1000).toFixed(2)}s
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              {(job as any).durationMs ?? job.latencyMs ?? 0} ms wall-clock
            </div>
          </div>

          <div className="p-3.5 rounded-lg border border-border bg-muted/20 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
              <span>Quorum Consensus</span>
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
            </div>
            <div className="text-lg font-bold font-mono text-indigo-400">
              {quorum}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Personas agreed
            </div>
          </div>
        </div>

        {/* Persona Output Logs & Code Nits Inspector */}
        <div className="space-y-3 my-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Bot className="w-4 h-4 text-indigo-400" /> Full Reviewer Output Logs & Code Nits
            </h4>
            <span className="text-xs text-muted-foreground">
              {(() => {
                const successCount = personaLogs.filter(p => p.status !== 'error' && p.status !== 'timeout').length;
                const errorCount = personaLogs.filter(p => p.status === 'error' || p.status === 'timeout').length;
                if (errorCount > 0) {
                  return `${successCount} active, ${errorCount} failed persona agent${errorCount !== 1 ? 's' : ''} (Click to inspect)`;
                }
                return `${successCount} active persona agent${successCount !== 1 ? 's' : ''} (Click persona to inspect full logs & nits)`;
              })()}
            </span>
          </div>

          <div className="grid gap-2.5">
            {personaLogs.map((entry, idx) => {
              const personaKey = entry.persona || `persona-${idx}`;
              const isExpanded = !!expandedPersonas[personaKey];
              const isError = entry.status === 'error' || entry.status === 'timeout';
              const borderClass = isError
                ? 'border-red-500/40 bg-red-950/10'
                : 'border-border/80 bg-muted/10';

              return (
                <div
                  key={idx}
                  className={`rounded-lg border ${borderClass} overflow-hidden text-xs transition-colors`}
                >
                  <div
                    onClick={() => togglePersona(personaKey)}
                    className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:bg-muted/30"
                  >
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        )}
                        <span className="font-semibold text-foreground text-sm">
                          {entry.displayName || entry.persona}
                        </span>
                        {entry.model && (
                          <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                            {entry.model}
                          </span>
                        )}
                        {/* Error/Status badge */}
                        {isError && (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                            entry.status === 'timeout'
                              ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                              : 'bg-red-500/20 text-red-400 border-red-500/30'
                          }`}>
                            {entry.status === 'timeout' ? '⏱ TIMEOUT' : `⚠ API ERROR${entry.apiStatusCode ? ` ${entry.apiStatusCode}` : ''}`}
                          </span>
                        )}
                        {entry.status === 'success' && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            ✓
                          </span>
                        )}
                      </div>
                      {/* Error message display */}
                      {isError && entry.apiError ? (
                        <p className="text-red-400/80 leading-normal pl-6 font-mono text-[11px]">
                          {entry.apiError.slice(0, 200)}{entry.apiError.length > 200 ? '…' : ''}
                        </p>
                      ) : entry.summary ? (
                        <p className="text-muted-foreground leading-normal pl-6">
                          {entry.summary}
                        </p>
                      ) : null}
                    </div>

                    {!isError ? (
                      <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap flex-shrink-0 border-t sm:border-t-0 border-border/40 pt-2 sm:pt-0 pl-6 sm:pl-0">
                        <div className="text-right">
                          <div className="text-[10px] text-muted-foreground uppercase font-mono">Agent Harness</div>
                          <div className="font-mono text-xs font-medium text-indigo-300">
                            🔄 {entry.turnsCount ?? 1} {(entry.turnsCount ?? 1) === 1 ? 'turn' : 'turns'}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] text-muted-foreground uppercase font-mono">Tokens (In / Out)</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            📥 {entry.promptTokens ?? 0} / 📤 {entry.completionTokens ?? 0}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] text-muted-foreground uppercase font-mono">Cost</div>
                          <div className="font-mono text-xs font-semibold text-emerald-400">
                            ${(entry.costUSD ?? 0).toFixed(5)}
                          </div>
                        </div>
                        {entry.confidence !== undefined && entry.confidence > 0 && (
                          <div className="text-right">
                            <div className="text-[10px] text-muted-foreground uppercase font-mono">Confidence</div>
                            <div className="font-mono font-bold text-foreground">
                              {Math.round(entry.confidence * 100)}%
                            </div>
                          </div>
                        )}
                        {entry.latencyMs && (
                          <div className="text-right">
                            <div className="text-[10px] text-muted-foreground uppercase font-mono">Latency</div>
                            <div className="font-mono text-muted-foreground">
                              {entry.latencyMs}ms
                            </div>
                          </div>
                        )}
                        <div>
                          {getVerdictBadge(entry.decision)}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 pl-6 sm:pl-0">
                        <div>
                          <span className="font-mono text-[10px] px-2 py-1 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                            No API response
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Expanded Full Logs, Reasoning Chain & Code Nits Inspector */}
                  {isExpanded && (
                    <div className="p-4 bg-black/40 border-t border-border/60 space-y-4">
                      {/* Review Flowchart Persona — Render Mermaid Codebase Diagram */}
                      {(entry.persona === 'review_flowchart' || entry.persona === 'flowchart-lane') && entry.outputLog && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-xs text-sky-400 font-semibold">
                            📊 Codebase Architectural Flowchart
                          </div>
                          <MermaidViewer diagram={entry.outputLog} />
                        </div>
                      )}

                      {/* Raw Reviewer Output Log */}
                      <div className="space-y-1.5 font-mono">
                        <div className="flex items-center justify-between text-muted-foreground text-[11px]">
                          <span className="flex items-center gap-1.5 font-semibold text-indigo-300">
                            <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                            Reviewer Output Log (Model Tag: {entry.model || 'claude-haiku-4.5'})
                          </span>
                          <span>Persona: {entry.persona}</span>
                        </div>
                        <pre className="p-3 rounded bg-black/60 border border-border/40 text-foreground/90 text-[11px] whitespace-pre-wrap leading-relaxed">
                          {entry.outputLog}
                        </pre>
                      </div>

                      {/* Detailed Reasoning Chain */}
                      {entry.reasoningChain && entry.reasoningChain.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-border/30">
                          <div className="flex items-center gap-1.5 text-xs text-indigo-400 font-semibold">
                            <ListChecks className="w-4 h-4 text-indigo-400" />
                            Detailed Reasoning Chain & Step-by-Step Evaluation
                          </div>
                          <div className="space-y-1.5">
                            {entry.reasoningChain.map((step, sIdx) => (
                              <div
                                key={sIdx}
                                className="flex items-start gap-2.5 text-xs text-foreground/90 p-2.5 rounded bg-muted/20 border border-border/30"
                              >
                                <span className="font-mono text-[11px] text-indigo-400 font-bold flex-shrink-0">
                                  Step {sIdx + 1}:
                                </span>
                                <span className="leading-relaxed">{step}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Code Nits & Line-by-Line Findings Inspector */}
                      {entry.nits && entry.nits.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-border/30">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-xs text-amber-400 font-semibold">
                              <FileCode className="w-4 h-4 text-amber-400" />
                              Code Nits & Line-by-Line Inspector
                            </div>
                            <span className="font-mono text-[11px] text-amber-400/80">
                              {entry.nits.length} Nit{entry.nits.length > 1 ? 's' : ''} Identified
                            </span>
                          </div>

                          <div className="space-y-2.5">
                            {entry.nits.map((nit, nIdx) => {
                              const severityBadge =
                                nit.severity === 'P0' ? (
                                  <Badge variant="destructive" className="font-mono text-[10px]">P0 - Critical</Badge>
                                ) : nit.severity === 'P1' ? (
                                  <Badge variant="warning" className="font-mono text-[10px]">P1 - Warning</Badge>
                                ) : (
                                  <Badge variant="outline" className="font-mono text-[10px] border-indigo-500/40 text-indigo-300">P2 - Nit</Badge>
                                );

                              return (
                                <div
                                  key={nIdx}
                                  className="p-3 rounded-lg bg-black/40 border border-border/50 space-y-2 text-xs"
                                >
                                  <div className="flex items-center justify-between gap-2 flex-wrap font-mono">
                                    <div className="flex items-center gap-2">
                                      {severityBadge}
                                      <span className="font-semibold text-foreground">{nit.filePath}</span>
                                      <span className="text-muted-foreground">: Line {nit.lineNumber}</span>
                                    </div>
                                  </div>

                                  {nit.title && (
                                    <div className="font-semibold text-foreground text-xs">
                                      {nit.title}
                                    </div>
                                  )}

                                  {nit.description && (
                                    <p className="text-muted-foreground text-xs leading-normal">
                                      {nit.description}
                                    </p>
                                  )}

                                  {nit.suggestion && (
                                    <div className="p-2.5 rounded bg-emerald-950/30 border border-emerald-500/30 font-mono text-[11px] space-y-1">
                                      <div className="text-emerald-400 font-semibold flex items-center gap-1">
                                        <span>Code Fix Suggestion:</span>
                                      </div>
                                      <pre className="text-emerald-300/90 whitespace-pre-wrap font-mono leading-relaxed">
                                        {nit.suggestion}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Agent Pipeline Workflow Diagram */}
          <div className="space-y-3 my-4" data-testid="pr-detail-pipeline-section">
            <h4 className="text-sm font-semibold text-foreground">
              Agent Pipeline Workflow
            </h4>
            <PipelineFlowViewer job={job} personaLogs={personaLogs} />
          </div>
        </div>

        </ModalErrorBoundary>
      </DialogContent>
    </Dialog>
  );
}

