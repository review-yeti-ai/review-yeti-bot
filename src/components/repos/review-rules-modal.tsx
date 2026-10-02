'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchRepositoryReviewRules, updateRepositoryReviewRules } from '@/lib/api-client';
import { RepositoryReviewRules } from '@/types/dashboard';
import { Sliders, ShieldCheck, Zap, GitBranch, Save, Loader2, AlertCircle } from 'lucide-react';

export interface ReviewRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  onRulesSaved?: (rules: RepositoryReviewRules) => void;
}

export function ReviewRulesModal({
  isOpen,
  onClose,
  owner,
  repo,
  onRulesSaved,
}: ReviewRulesModalProps) {
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  // Form State
  const [profile, setProfile] = React.useState<'chill' | 'balanced' | 'assertive'>('balanced');
  const [reviewerEffort, setReviewerEffort] = React.useState<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('low');
  const [confidenceThreshold, setConfidenceThreshold] = React.useState<number>(70);
  const [sequenceDiagrams, setSequenceDiagrams] = React.useState<boolean>(true);
  const [highLevelSummary, setHighLevelSummary] = React.useState<boolean>(true);
  const [requestChangesWorkflow, setRequestChangesWorkflow] = React.useState<boolean>(true);
  const [ticketEnforcement, setTicketEnforcement] = React.useState<boolean>(false);
  const [collapseWalkthrough, setCollapseWalkthrough] = React.useState<boolean>(false);

  // Auto-Review State
  const [autoReviewEnabled, setAutoReviewEnabled] = React.useState<boolean>(true);
  const [triggers, setTriggers] = React.useState<string[]>(['pr_opened', 'pr_synchronize', '@ct-review']);
  const [ignoreDrafts, setIgnoreDrafts] = React.useState<boolean>(true);
  const [ignorePatternsInput, setIgnorePatternsInput] = React.useState<string>('*.md, docs/**');
  const [labelsInput, setLabelsInput] = React.useState<string>('');

  // Enforcement Policy State
  const [failureAction, setFailureAction] = React.useState<'fail_closed' | 'fail_open' | 'quarantine'>('fail_closed');
  const [requireAllReviews, setRequireAllReviews] = React.useState<boolean>(true);
  const [requireTicketLink, setRequireTicketLink] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (!isOpen || !owner || !repo) return;
    if (typeof fetchRepositoryReviewRules !== 'function') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    fetchRepositoryReviewRules(owner, repo)
      .then((rules) => {
        if (rules.reviews) {
          setProfile(rules.reviews.profile || 'balanced');
          setReviewerEffort(rules.reviews.reviewer_effort || 'low');
          setConfidenceThreshold(rules.reviews.confidence_threshold ?? 70);
          setSequenceDiagrams(rules.reviews.sequence_diagrams ?? true);
          setHighLevelSummary(rules.reviews.high_level_summary ?? true);
          setRequestChangesWorkflow(rules.reviews.request_changes_workflow ?? true);
          setTicketEnforcement(rules.reviews.ticket_enforcement ?? false);
          setCollapseWalkthrough(rules.reviews.collapse_walkthrough ?? false);
        }
        if (rules.auto_review) {
          setAutoReviewEnabled(rules.auto_review.enabled ?? true);
          setTriggers(rules.auto_review.triggers || ['pr_opened', 'pr_synchronize', '@ct-review']);
          setIgnoreDrafts(rules.auto_review.ignore_drafts ?? true);
          setIgnorePatternsInput((rules.auto_review.ignore_patterns || []).join(', '));
          setLabelsInput((rules.auto_review.labels || []).join(', '));
        }
        if (rules.enforcement_policy) {
          setFailureAction(rules.enforcement_policy.failure_action || 'fail_closed');
          setRequireAllReviews(rules.enforcement_policy.require_all_reviews ?? true);
          setRequireTicketLink(rules.enforcement_policy.require_ticket_link ?? false);
        }
        setLoading(false);
      })
      .catch((err) => {
        setErrorMessage(err?.message || 'Failed to load repository rules');
        setLoading(false);
      });
  }, [isOpen, owner, repo]);

  const toggleTrigger = (trig: string) => {
    setTriggers((prev) =>
      prev.includes(trig) ? prev.filter((t) => t !== trig) : [...prev, trig]
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const payload: Partial<RepositoryReviewRules> = {
      reviews: {
        profile,
        reviewer_effort: reviewerEffort,
        confidence_threshold: Number(confidenceThreshold),
        sequence_diagrams: sequenceDiagrams,
        high_level_summary: highLevelSummary,
        request_changes_workflow: requestChangesWorkflow,
        ticket_enforcement: ticketEnforcement,
        collapse_walkthrough: collapseWalkthrough,
      },
      auto_review: {
        enabled: autoReviewEnabled,
        triggers,
        ignore_drafts: ignoreDrafts,
        ignore_patterns: ignorePatternsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        labels: labelsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
      enforcement_policy: {
        failure_action: failureAction,
        require_all_reviews: requireAllReviews,
        require_ticket_link: requireTicketLink,
      },
    };

    try {
      const saved = await updateRepositoryReviewRules(owner, repo, payload);
      setSuccessMessage('Review rules saved successfully');
      setSaving(false);
      if (onRulesSaved) {
        onRulesSaved(saved);
      }
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to save review rules');
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <Sliders className="h-5 w-5 text-indigo-400" />
            <span>Repository Review Rules — {owner}/{repo}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Configure reviewer persona behaviors, automatic trigger conditions, and gate enforcement policies.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
            <span className="text-xs">Loading review rules...</span>
          </div>
        ) : (
          <Tabs defaultValue="reviews" className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-4">
              <TabsTrigger value="reviews" className="text-xs flex items-center gap-1.5">
                <Sliders className="h-3.5 w-3.5" />
                <span>Reviews</span>
              </TabsTrigger>
              <TabsTrigger value="triggers" className="text-xs flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5" />
                <span>Auto-Review Triggers</span>
              </TabsTrigger>
              <TabsTrigger value="enforcement" className="text-xs flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Enforcement Policy</span>
              </TabsTrigger>
            </TabsList>

            {/* TAB 1: REVIEWS */}
            <TabsContent value="reviews" className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">Strictness Profile</label>
                  <Select
                    value={profile}
                    onValueChange={(val: any) => setProfile(val)}
                  >
                    <SelectTrigger className="text-xs h-9">
                      <SelectValue placeholder="Select profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="chill">Chill (Lenient, architectural)</SelectItem>
                      <SelectItem value="balanced">Balanced (Default, pragmatic)</SelectItem>
                      <SelectItem value="assertive">Assertive (Strict, exhaustive)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">Reviewer Effort Level</label>
                  <Select
                    value={reviewerEffort}
                    onValueChange={(val: any) => setReviewerEffort(val)}
                  >
                    <SelectTrigger className="text-xs h-9">
                      <SelectValue placeholder="Select effort" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low (Fast feedback)</SelectItem>
                      <SelectItem value="medium">Medium (Standard depth)</SelectItem>
                      <SelectItem value="high">High (Deep inspection)</SelectItem>
                      <SelectItem value="xhigh">X-High (Thorough audit)</SelectItem>
                      <SelectItem value="max">Max (Full AST reasoning)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-semibold text-foreground">Confidence Threshold</label>
                  <span className="text-xs font-mono font-bold text-indigo-400">{confidenceThreshold}%</span>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={confidenceThreshold}
                  onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
                  className="text-xs h-9"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="flex items-center justify-between p-2.5 rounded-lg border border-border/60 bg-muted/20">
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-foreground">Architectural Diagrams</span>
                    <p className="text-[11px] text-muted-foreground">Generate Mermaid flowcharts</p>
                  </div>
                  <Switch checked={sequenceDiagrams} onCheckedChange={setSequenceDiagrams} />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg border border-border/60 bg-muted/20">
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-foreground">High-Level Summary</span>
                    <p className="text-[11px] text-muted-foreground">Summarize diff hunks</p>
                  </div>
                  <Switch checked={highLevelSummary} onCheckedChange={setHighLevelSummary} />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg border border-border/60 bg-muted/20">
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-foreground">Request Changes Workflow</span>
                    <p className="text-[11px] text-muted-foreground">Block PR merge on P0/P1</p>
                  </div>
                  <Switch checked={requestChangesWorkflow} onCheckedChange={setRequestChangesWorkflow} />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg border border-border/60 bg-muted/20">
                  <div className="space-y-0.5">
                    <span className="text-xs font-medium text-foreground">Ticket Enforcement</span>
                    <p className="text-[11px] text-muted-foreground">Verify issue/ticket link</p>
                  </div>
                  <Switch checked={ticketEnforcement} onCheckedChange={setTicketEnforcement} />
                </div>
              </div>
            </TabsContent>

            {/* TAB 2: AUTO-REVIEW TRIGGERS */}
            <TabsContent value="triggers" className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/80 bg-muted/30">
                <div className="space-y-0.5">
                  <span className="text-xs font-semibold text-foreground">Automatic Pull Request Reviews</span>
                  <p className="text-[11px] text-muted-foreground">Enable or pause Review Yeti bot for this repository</p>
                </div>
                <Switch checked={autoReviewEnabled} onCheckedChange={setAutoReviewEnabled} />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-foreground">Review Event Triggers</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'pr_opened', label: 'PR Opened (new PRs)' },
                    { id: 'pr_synchronize', label: 'PR Synchronize (pushes)' },
                    { id: 'pr_ready', label: 'Ready for Review' },
                    { id: '@ct-review', label: '@ct-review /review tag' },
                    { id: 'tag', label: 'Review Yeti Labels' },
                  ].map((trig) => (
                    <label
                      key={trig.id}
                      className="flex items-center gap-2 p-2 rounded border border-border/60 bg-card/60 text-xs cursor-pointer hover:bg-muted/30"
                    >
                      <input
                        type="checkbox"
                        checked={triggers.includes(trig.id)}
                        onChange={() => toggleTrigger(trig.id)}
                        className="rounded border-border text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>{trig.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg border border-border/60 bg-muted/20">
                <div className="space-y-0.5">
                  <span className="text-xs font-medium text-foreground">Ignore Draft Pull Requests</span>
                  <p className="text-[11px] text-muted-foreground">Skip reviews while PR is marked draft</p>
                </div>
                <Switch checked={ignoreDrafts} onCheckedChange={setIgnoreDrafts} />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Ignored File Patterns (comma-separated)</label>
                <Input
                  value={ignorePatternsInput}
                  onChange={(e) => setIgnorePatternsInput(e.target.value)}
                  placeholder="*.md, docs/**, vendor/**"
                  className="text-xs h-9 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Required Trigger Labels (optional)</label>
                <Input
                  value={labelsInput}
                  onChange={(e) => setLabelsInput(e.target.value)}
                  placeholder="review-yeti, ai-review"
                  className="text-xs h-9 font-mono"
                />
              </div>
            </TabsContent>

            {/* TAB 3: ENFORCEMENT POLICY */}
            <TabsContent value="enforcement" className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Gate Failure Action</label>
                <Select
                  value={failureAction}
                  onValueChange={(val: any) => setFailureAction(val)}
                >
                  <SelectTrigger className="text-xs h-9">
                    <SelectValue placeholder="Select failure action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fail_closed">Fail Closed (Blocks PR check run on failure)</SelectItem>
                    <SelectItem value="fail_open">Fail Open (Advisory notice, allows merge)</SelectItem>
                    <SelectItem value="quarantine">Quarantine (Requires manual HITL approval)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20">
                <div className="space-y-0.5">
                  <span className="text-xs font-medium text-foreground">Require All Persona Reviews</span>
                  <p className="text-[11px] text-muted-foreground">Every active persona must approve before gate passes</p>
                </div>
                <Switch checked={requireAllReviews} onCheckedChange={setRequireAllReviews} />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border/60 bg-muted/20">
                <div className="space-y-0.5">
                  <span className="text-xs font-medium text-foreground">Require Issue / Ticket Link</span>
                  <p className="text-[11px] text-muted-foreground">Reject PR if Jira/Linear/GitHub issue link is missing</p>
                </div>
                <Switch checked={requireTicketLink} onCheckedChange={setRequireTicketLink} />
              </div>
            </TabsContent>
          </Tabs>
        )}

        {errorMessage && (
          <div className="flex items-center gap-2 p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div className="flex items-center gap-2 p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        <DialogFooter className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving} className="text-xs h-8">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={loading || saving}
            className="text-xs h-8 bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            <span>Save Rules</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
