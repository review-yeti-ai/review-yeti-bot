'use client';

import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RotateCcw, Save, Code, CheckCircle, AlertCircle } from 'lucide-react';

interface PromptEditorProps {
  value: string;
  defaultValue?: string;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  onReset: () => void;
  isSaving?: boolean;
  disabled?: boolean;
  title?: string;
}

export function PromptEditor({
  value,
  defaultValue = '',
  onChange,
  onSave,
  onReset,
  isSaving = false,
  disabled = false,
  title = 'System Prompt Editor',
}: PromptEditorProps) {
  const isDirty = value !== defaultValue;
  const charCount = value.length;
  const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;
  const estTokens = Math.ceil(charCount / 4);

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-card/60 p-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2">
          <Code className="h-4 w-4 text-indigo-400" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
          {isDirty ? (
            <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-400 bg-amber-500/10">
              Unsaved Changes
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] border-emerald-500/50 text-emerald-400 bg-emerald-500/10">
              Synced
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={disabled || !isDirty}
            className="h-8 text-xs gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
            Reset
          </Button>

          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={disabled || !isDirty || isSaving}
            className="h-8 text-xs gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? 'Saving...' : 'Save Prompt'}
          </Button>
        </div>
      </div>

      <div className="relative">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="Enter system prompt instructions or override guidelines..."
          className="font-mono text-xs leading-relaxed min-h-[220px] bg-background/80 border-border/80 focus:border-indigo-500/80 resize-y p-3"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
        <div className="flex items-center gap-3">
          <span>
            Characters: <strong className="text-foreground font-mono">{charCount}</strong>
          </span>
          <span>
            Words: <strong className="text-foreground font-mono">{wordCount}</strong>
          </span>
          <span>
            Est. Tokens: <strong className="text-foreground font-mono">~{estTokens}</strong>
          </span>
        </div>
        <div>
          {isDirty && <span className="text-amber-400 flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Modified</span>}
        </div>
      </div>
    </div>
  );
}
