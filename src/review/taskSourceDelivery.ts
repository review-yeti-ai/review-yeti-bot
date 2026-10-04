import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_CHANGED_FILES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import { classifyUnavailablePatch } from './patchAvailability';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const rangeSchema = z.tuple([count, count]);
const fileSchema = z.object({
  path: z.string().min(1).max(MAX_PATH_CHARACTERS),
  patchDigest: hash.nullable(), totalChars: count.nullable(),
  ranges: z.array(rangeSchema).max(64), inline: z.boolean(),
}).strict().superRefine((file, context) => {
  let previousEnd = -1;
  for (const [start, end] of file.ranges) {
    if (file.totalChars === null || file.patchDigest === null || start < 0 || end <= start
      || end > file.totalChars || start <= previousEnd) context.addIssue({
      code: z.ZodIssueCode.custom, message: 'delivery ranges must be bounded, ordered and merged',
    });
    previousEnd = end;
  }
});
export const taskSourceReceiptSchema = z.object({
  version: z.literal('TaskSourceDelivery.v1'), taskId: z.string().min(1).max(128),
  headSha: z.string().min(1).max(64), baseSha: z.string().min(1).max(64).nullable(),
  contextDigests: z.array(hash).max(64), files: z.array(fileSchema).min(1).max(MAX_CHANGED_FILES),
  complete: z.boolean(),
}).strict().superRefine((receipt, context) => {
  const complete = receipt.contextDigests.length > 0 && receipt.files.every(file =>
    file.patchDigest !== null && file.totalChars !== null && (file.totalChars === 0
      ? file.inline : file.ranges.length === 1 && file.ranges[0][0] === 0 && file.ranges[0][1] === file.totalChars));
  if (receipt.complete !== complete || new Set(receipt.files.map(file => file.path)).size !== receipt.files.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'delivery completeness does not match its evidence' });
  }
});
export type TaskSourceReceipt = z.infer<typeof taskSourceReceiptSchema>;
type SourceFile = { path: string; patch?: string; originalPatchLength?: number };

function originalPatch(file: SourceFile | undefined): string | null {
  return typeof file?.patch === 'string' && classifyUnavailablePatch(file.patch) === null
    && (file.originalPatchLength ?? 0) <= file.patch.length ? file.patch : null;
}

/** Rebind a retained receipt to exact original task source before reusing it. */
export function validateTaskSourceReceipt(value: unknown, input: {
  taskId: string; paths: readonly string[]; files: readonly SourceFile[]; headSha: string; baseSha?: string;
}): TaskSourceReceipt | null {
  const parsed = taskSourceReceiptSchema.safeParse(value);
  if (!parsed.success) return null;
  const receipt = parsed.data;
  if (!receipt.complete || receipt.taskId !== input.taskId || receipt.headSha !== input.headSha
    || receipt.baseSha !== (input.baseSha ?? null) || receipt.files.length !== input.paths.length) return null;
  const expected = new Map(input.files.map(file => [file.path, originalPatch(file)]));
  for (const file of receipt.files) {
    const patch = expected.get(file.path);
    if (!input.paths.includes(file.path) || patch === null || patch === undefined
      || file.patchDigest !== digest(patch) || file.totalChars !== patch.length) return null;
  }
  return receipt;
}

function messageStrings(messages: readonly any[]): string[] {
  return messages.flatMap(message => typeof message?.content === 'string' ? [message.content]
    : Array.isArray(message?.content) ? message.content.flatMap((block: any) => typeof block?.text === 'string' ? [block.text] : []) : []);
}

/** Receipts record source delivered on successful calls, never merely staged tools. */
export class TaskSourceDelivery {
  private readonly patches = new Map<string, string>();
  private readonly receipt: TaskSourceReceipt;
  private readonly pending: Array<{ message: string; path: string; start: number; end: number }> = [];
  constructor(private readonly input: {
    taskId: string; paths: readonly string[]; files: readonly SourceFile[];
    prefix: string; inlinedPaths: readonly string[]; headSha: string; baseSha?: string;
  }) {
    const sources = new Map(input.files.map(file => [file.path, file]));
    this.receipt = { version:'TaskSourceDelivery.v1', taskId:input.taskId, headSha:input.headSha,
      baseSha:input.baseSha ?? null, contextDigests:[], complete:false, files:input.paths.map(path => {
        const patch = originalPatch(sources.get(path));
        if (patch !== null) this.patches.set(path, patch);
        return {path, patchDigest:patch === null ? null : digest(patch),
          totalChars:patch === null ? null : patch.length, ranges:[], inline:false};
      }) };
  }

  /** A fresh model context must earn its own source evidence. */
  beginAttempt(): void {
    this.pending.length = 0;
    this.receipt.contextDigests = [];
    this.receipt.complete = false;
    for (const file of this.receipt.files) { file.ranges = []; file.inline = false; }
  }

  stageDiffPage(rawOutput: string, deliveredOutput: string, message: string): void {
    // A clipped envelope is not a delivered page, even when its prefix contains
    // plausible metadata or a matching path/digest.
    if (rawOutput !== deliveredOutput) return;
    let page: any;
    try { page = JSON.parse(rawOutput); } catch { return; }
    const patch = this.patches.get(page.path);
    if (patch === undefined || page.status !== 'ok' || page.pageComplete !== true
      || page.offsetUnit !== 'utf16-code-units' || !/^[a-f0-9]{64}$/u.test(page.digest)
      || !Number.isSafeInteger(page.startOffset) || !Number.isSafeInteger(page.endOffset)
      || page.startOffset < 0 || page.endOffset <= page.startOffset || page.endOffset > patch.length
      || page.totalChars !== patch.length || page.content !== patch.slice(page.startOffset, page.endOffset)) return;
    this.pending.push({message, path:page.path, start:page.startOffset, end:page.endOffset});
  }

  acknowledgeRequest(messages: readonly any[]): TaskSourceReceipt {
    const text = messageStrings(messages);
    const inlineDelivered = this.input.prefix.length > 0 && text.some(value => value.includes(this.input.prefix));
    if (inlineDelivered) {
      for (const file of this.receipt.files) if (this.input.inlinedPaths.includes(file.path) && file.totalChars !== null
        && this.input.prefix.includes(this.patches.get(file.path)!)) {
        file.inline = true;
        file.ranges = file.totalChars === 0 ? [] : [[0,file.totalChars]];
      }
    }
    for (const page of this.pending.splice(0)) {
      if (!text.includes(page.message)) continue;
      const file = this.receipt.files.find(value => value.path === page.path)!;
      const ordered = [...file.ranges, [page.start,page.end] as [number,number]].sort((a,b) => a[0]-b[0]);
      const merged: Array<[number,number]> = [];
      for (const range of ordered) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1],range[1]);
        else merged.push([...range]);
      }
      file.ranges = merged;
    }
    const contextDigest = digest(JSON.stringify(text));
    if (!this.receipt.contextDigests.includes(contextDigest)) this.receipt.contextDigests.push(contextDigest);
    this.receipt.complete = this.receipt.files.every(file => file.patchDigest !== null && file.totalChars !== null
      && (file.totalChars === 0 ? file.inline : file.ranges.length === 1 && file.ranges[0][0] === 0 && file.ranges[0][1] === file.totalChars));
    return this.snapshot();
  }

  snapshot(): TaskSourceReceipt { return structuredClone(this.receipt); }
}

/** Global reductions describe PLAN; restore WORK depth only with delivered evidence. */
export function attachTaskSourceDelivery<T extends {
  taskPlan?: Array<{id:string; paths:string[]}>;
  truncatedFiles?: Array<{path:string}>;
  diffShrink?: {notSentInFull?:Array<{path:string; why:string}>};
  reviewBudget?: object;
}>(result:T, receipts:TaskSourceReceipt[]):T & {sourceDelivery?:TaskSourceReceipt[]} {
  if (!result.taskPlan) return result;
  const byTask = new Map(receipts.map(receipt => [receipt.taskId,receipt]));
  const full = (path:string) => {
    const tasks = result.taskPlan!.filter(task => task.paths.includes(path));
    return tasks.length > 0 && tasks.every(task => {
      const receipt = byTask.get(task.id);
      return receipt?.complete === true && receipt.files.some(file => file.path === path);
    });
  };
  const next:any = {...result,sourceDelivery:receipts};
  if (result.truncatedFiles) {
    const kept = result.truncatedFiles.filter(file => !full(file.path));
    if (kept.length) next.truncatedFiles = kept;
    else delete next.truncatedFiles;
  }
  if (result.diffShrink?.notSentInFull) next.diffShrink = {...result.diffShrink,
    notSentInFull:result.diffShrink.notSentInFull.filter(file =>
      !(['truncated','budget-signatures','budget-listed'].includes(file.why) && full(file.path)))};
  if (result.reviewBudget) next.reviewBudget = {...result.reviewBudget,phase:'plan'};
  return next;
}

export function renderTaskSourceDelivery(input:{taskPlan?:Array<{id:string}>;sourceDelivery?:TaskSourceReceipt[]}):string[] {
  if (!input.taskPlan || !input.sourceDelivery) return [];
  const byTask = new Map(input.sourceDelivery.map(receipt => [receipt.taskId,receipt]));
  const completed = input.taskPlan.filter(task => byTask.get(task.id)?.complete === true).length;
  return [`**WORK source delivery**: ${completed}/${input.taskPlan.length} assigned task(s) received every original diff character; source delivery complete=${completed === input.taskPlan.length}. This records successful provider request delivery; task analysis completion is reported separately.`,
    ...input.sourceDelivery.slice(0,24).map(receipt => `- Task \`${receipt.taskId.replace(/[`<>\r\n]/gu,' ').slice(0,128)}\`: ${receipt.files.length} file(s), complete=${receipt.complete}; receipt SHA256 \`${digest(JSON.stringify(receipt))}\`.`)];
}
