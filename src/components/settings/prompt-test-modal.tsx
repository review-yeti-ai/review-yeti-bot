'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Play, Sparkles, AlertTriangle, CheckCircle, MessageSquare, Loader2 } from 'lucide-react';
import { PersonaSetting } from '@/types/dashboard';

interface PromptTestModalProps {
  persona: PersonaSetting;
  customPrompt?: string;
  trigger?: React.ReactNode;
}

interface TestResult {
  verdict: 'SHIP' | 'NACK' | 'COMMENT';
  confidence: number;
  findings: Array<{
    severity: 'CRITICAL' | 'WARNING' | 'NIT';
    file: string;
    line: number;
    message: string;
  }>;
  latencyMs: number;
  tokensUsed: number;
}

export function PromptTestModal({ persona, customPrompt, trigger }: PromptTestModalProps) {
  const [open, setOpen] = React.useState(false);
  const [sampleDiff, setSampleDiff] = React.useState(
    `diff --git a/src/api/auth.ts b/src/api/auth.ts\nindex 83b1c2..92a11b 100644\n--- a/src/api/auth.ts\n+++ b/src/api/auth.ts\n@@ -15,4 +15,6 @@ export function verifyToken(req: Request) {\n-  const authHeader = req.headers['authorization'];\n+  const authHeader = req.headers['authorization'] || req.query.token;\n+  // TODO: Add proper secret rotation check\n+  return jwt.verify(authHeader, process.env.JWT_SECRET);\n }`
  );
  const [isRunning, setIsRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState<TestResult | null>(null);

  const handleRunTest = async () => {
    setIsRunning(true);
    setProgress(20);
    setResult(null);

    const timer1 = setTimeout(() => setProgress(60), 300);
    const timer2 = setTimeout(() => setProgress(90), 600);

    // Simulate analysis using the prompt
    setTimeout(() => {
      setProgress(100);
      setIsRunning(false);

      const hasQueryToken = sampleDiff.includes('req.query.token');
      const hasTodo = sampleDiff.includes('TODO');

      const simulatedFindings: TestResult['findings'] = [];
      if (hasQueryToken) {
        simulatedFindings.push({
          severity: 'CRITICAL',
          file: 'src/api/auth.ts',
          line: 16,
          message: 'Accepting JWT tokens via query parameters exposes tokens in access logs and referrer headers.',
        });
      }
      if (hasTodo) {
        simulatedFindings.push({
          severity: 'WARNING',
          file: 'src/api/auth.ts',
          line: 17,
          message: 'Unresolved TODO comment found in authentication hot path.',
        });
      }

      setResult({
        verdict: simulatedFindings.some((f) => f.severity === 'CRITICAL') ? 'NACK' : 'COMMENT',
        confidence: 88,
        findings: simulatedFindings,
        latencyMs: 480,
        tokensUsed: 340,
      });

      clearTimeout(timer1);
      clearTimeout(timer2);
    }, 900);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="gap-1.5 text-xs">
            <Play className="h-3.5 w-3.5 text-emerald-400" />
            Test Prompt
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto bg-card border-border/80">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-400" />
            Dry-Run Test Evaluation: {persona.displayName || persona.id}
          </DialogTitle>
          <DialogDescription>
            Simulate persona evaluation against a diff snippet using active model ({persona.model})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-semibold text-muted-foreground mb-1 block">
              Sample Code / Git Diff Snippet
            </label>
            <Textarea
              value={sampleDiff}
              onChange={(e) => setSampleDiff(e.target.value)}
              className="font-mono text-xs h-32 bg-background/80"
              placeholder="Paste code or diff to evaluate..."
            />
          </div>

          {isRunning && (
            <div className="space-y-2 p-4 rounded-lg bg-indigo-500/10 border border-indigo-500/30">
              <div className="flex items-center justify-between text-xs text-indigo-300">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
                  Running {persona.displayName} evaluation engine...
                </span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5 bg-indigo-950" />
            </div>
          )}

          {result && (
            <div className="space-y-3 p-4 rounded-lg border border-border/80 bg-background/60">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Verdict:</span>
                  <Badge
                    variant={
                      result.verdict === 'SHIP'
                        ? 'success'
                        : result.verdict === 'NACK'
                        ? 'destructive'
                        : 'secondary'
                    }
                    className="font-bold"
                  >
                    {result.verdict}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>Confidence: <strong className="text-foreground">{result.confidence}%</strong></span>
                  <span>Latency: <strong className="text-foreground">{result.latencyMs}ms</strong></span>
                  <span>Tokens: <strong className="text-foreground">{result.tokensUsed}</strong></span>
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-border/40">
                <span className="text-xs font-semibold text-muted-foreground">Findings Output:</span>
                {result.findings.length === 0 ? (
                  <p className="text-xs text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle className="h-4 w-4" /> No policy or security violations detected.
                  </p>
                ) : (
                  result.findings.map((f, i) => (
                    <div
                      key={i}
                      className="p-2.5 rounded border border-border/60 bg-card/80 flex items-start gap-2.5 text-xs"
                    >
                      {f.severity === 'CRITICAL' ? (
                        <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                      ) : (
                        <MessageSquare className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                          <span>{f.file}:{f.line}</span>
                          <Badge variant="outline" className="text-[9px] py-0 px-1">
                            {f.severity}
                          </Badge>
                        </div>
                        <p className="mt-1 text-foreground">{f.message}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => setOpen(false)} size="sm">
            Close
          </Button>
          <Button
            onClick={handleRunTest}
            disabled={isRunning || !sampleDiff.trim()}
            size="sm"
            className="gap-1.5 bg-indigo-600 hover:bg-indigo-500"
          >
            <Play className="h-3.5 w-3.5" />
            {isRunning ? 'Evaluating...' : 'Run Test Evaluation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
