'use client';

import * as React from 'react';
import { Copy, Check, Eye, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface MermaidViewerProps {
  diagram?: string;
  className?: string;
}

export function MermaidViewer({ diagram, className }: MermaidViewerProps) {
  const [viewMode, setViewMode] = React.useState<'visual' | 'code'>('visual');
  const [copied, setCopied] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = React.useState(false);

  const cleanDiagram = React.useMemo(() => {
    if (!diagram) {
      return `sequenceDiagram
  autonumber
  actor User as PR Author
  participant Bot as CT Review Bot
  participant Security as Security Sentinel
  participant Arch as Arch Auditor
  
  User->>Bot: Submit Pull Request
  Bot->>Security: Trigger Vulnerability Scan
  Security-->>Bot: Clean (0 CVEs)
  Bot->>Arch: Evaluate Boundary Rules
  Arch-->>Bot: Approved
  Bot-->>User: Post Review (SHIP)`;
    }
    // Remove markdown code fences if present
    return diagram
      .replace(/^```mermaid\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```$/, '')
      .trim();
  }, [diagram]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanDiagram);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback copy
      const textArea = document.createElement('textarea');
      textArea.value = cleanDiagram;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Attempt dynamic script rendering if client-side mermaid library is loaded or available
  React.useEffect(() => {
    if (viewMode !== 'visual' || !containerRef.current) return;

    // Parse cleanDiagram steps to render structured visual diagram fallback if mermaid script isn't available
    let isCancelled = false;
    if (typeof window !== 'undefined' && (window as any).mermaid) {
      try {
        (window as any).mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        const id = `mermaid-svg-${Math.random().toString(36).substring(2, 9)}`;
        (window as any).mermaid.render(id, cleanDiagram).then((result: { svg: string }) => {
          if (!isCancelled && containerRef.current) {
            containerRef.current.innerHTML = result.svg;
            setRenderError(false);
          }
        }).catch(() => {
          if (!isCancelled) setRenderError(true);
        });
      } catch {
        setRenderError(true);
      }
    } else {
      setRenderError(true);
    }

    return () => {
      isCancelled = true;
    };
  }, [cleanDiagram, viewMode]);

  // Parse lines for fallback SVG view
  const parsedSteps = React.useMemo(() => {
    const lines = cleanDiagram.split('\n').map((l) => l.trim()).filter(Boolean);
    const steps: Array<{ type: 'arrow' | 'note' | 'box'; from?: string; to?: string; text: string }> = [];
    
    lines.forEach((line) => {
      if (line.includes('->>') || line.includes('-->>') || line.includes('-->')) {
        const parts = line.split(/->>|-->>|-->/);
        const from = parts[0]?.trim();
        const rest = parts[1]?.trim() || '';
        const textParts = rest.split(':');
        const to = textParts[0]?.trim();
        const text = textParts[1]?.trim() || to || '';
        steps.push({ type: 'arrow', from, to: textParts[1] ? to : '', text });
      } else if (line.startsWith('Note') || line.startsWith('rect')) {
        steps.push({ type: 'note', text: line });
      } else if (!line.startsWith('sequenceDiagram') && !line.startsWith('flowchart') && !line.startsWith('autonumber') && !line.startsWith('participant') && !line.startsWith('actor')) {
        steps.push({ type: 'box', text: line });
      }
    });

    return steps;
  }, [cleanDiagram]);

  return (
    <div className={`rounded-lg border border-border bg-card/60 overflow-hidden ${className || ''}`}>
      <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b border-border text-xs">
        <div className="flex items-center gap-2 font-mono font-medium text-muted-foreground">
          <span>Mermaid Sequence / Flowchart</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="inline-flex items-center rounded-md bg-muted p-0.5 text-muted-foreground">
            <button
              type="button"
              onClick={() => setViewMode('visual')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-sm text-xs font-medium transition-colors ${
                viewMode === 'visual'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'hover:text-foreground'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Visual View</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('code')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-sm text-xs font-medium transition-colors ${
                viewMode === 'code'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'hover:text-foreground'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>Raw Code</span>
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="h-7 px-2 text-xs gap-1"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
      </div>

      <div className="p-4">
        {viewMode === 'code' ? (
          <pre className="p-4 rounded-md bg-zinc-950 text-emerald-400 font-mono text-xs overflow-x-auto border border-zinc-800 leading-relaxed">
            <code>{cleanDiagram}</code>
          </pre>
        ) : (
          <div>
            <div ref={containerRef} className="mermaid-container overflow-x-auto flex justify-center" />
            {renderError && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground border-b border-border/40 pb-2">
                  <span className="font-semibold text-foreground">Architectural Flow & Boundary Diagram</span>
                  <span className="text-[10px] bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20">
                    Structured Visual Map
                  </span>
                </div>
                <div className="space-y-2 py-2">
                  {parsedSteps.length > 0 ? (
                    parsedSteps.map((step, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 p-2.5 rounded-md bg-muted/30 border border-border/50 text-xs"
                      >
                        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center font-mono text-[11px] font-bold">
                          {idx + 1}
                        </span>
                        <div className="flex-1 font-mono text-xs">
                          {step.from && step.to ? (
                            <div className="flex items-center gap-2">
                              <span className="text-indigo-400 font-medium">{step.from}</span>
                              <span className="text-muted-foreground">➔</span>
                              <span className="text-emerald-400 font-medium">{step.to}</span>
                              <span className="text-muted-foreground pl-2 border-l border-border/60">
                                {step.text}
                              </span>
                            </div>
                          ) : (
                            <span className="text-foreground">{step.text}</span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <pre className="p-3 rounded bg-zinc-950 text-emerald-400 font-mono text-xs">
                      {cleanDiagram}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
