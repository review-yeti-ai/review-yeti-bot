import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSourceDelivery, attachTaskSourceDelivery, renderTaskSourceDelivery, taskSourceReceiptSchema, validateTaskSourceReceipt } from '../../src/review/taskSourceDelivery';
import { createComposedTaskPlan, createComposedTaskOutcome } from '../../src/review/composedTaskLedger';
import { createComposedTaskOutcomeRetentionRequest } from '../../src/panel/composedTaskRetention';
import { parseWorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { parseReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';
import { ledgerFixture } from '../support/composedTaskLedgerFixture';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const files = [{path:'src/large.ts',patch:'abcdefghij'}];
const binding = {taskId:'source-task',paths:['src/large.ts'],files,headSha:HEAD,baseSha:BASE};
const INLINE_PREFIX=`source prefix:${files[0].patch}`;
const tracker = (inline=false) => new TaskSourceDelivery({...binding,prefix:INLINE_PREFIX,inlinedPaths:inline ? binding.paths : []});
const messages = (content:string) => [{role:'user',content}];
function page(start:number,end:number,patch=files[0].patch) {
  return JSON.stringify({status:'ok',path:files[0].path,digest:'c'.repeat(64),pageComplete:true,
    offsetUnit:'utf16-code-units',totalChars:patch.length,startOffset:start,endOffset:end,
    nextOffset:end < patch.length ? end : null,content:patch.slice(start,end)});
}

afterEach(() => vi.unstubAllEnvs());

describe('source delivery receipts', () => {
  it('counts inline source only after its exact prefix is in an acknowledged request', () => {
    const delivery=tracker(true);
    expect(delivery.snapshot().complete).toBe(false);
    expect(delivery.acknowledgeRequest(messages('other context')).complete).toBe(false);
    const receipt=delivery.acknowledgeRequest(messages(INLINE_PREFIX));
    expect(receipt.complete).toBe(true);
    expect(receipt.files[0].ranges).toEqual([[0,10]]);
    expect(receipt.files[0].patchDigest).toBe(createHash('sha256').update(files[0].patch).digest('hex'));
    expect(JSON.stringify(receipt)).not.toContain(files[0].patch);
    expect(validateTaskSourceReceipt(receipt,binding)).toEqual(receipt);
  });

  it('rejects malformed page envelopes without changing or certifying delivery', () => {
    const delivery=tracker();
    for(const output of ['null','true','[]','"text"','{']) {
      expect(() => delivery.stageDiffPage(output,output,'bad page')).not.toThrow();
      expect(delivery.acknowledgeRequest(messages('bad page')).complete).toBe(false);
    }
  });

  it('does not count queued pages, clipped pages, or pages removed before delivery', () => {
    const delivery=tracker();
    const output=page(0,10);
    delivery.stageDiffPage(output,output,'page message');
    expect(delivery.snapshot().complete).toBe(false);
    expect(delivery.acknowledgeRequest(messages('unrelated')).complete).toBe(false);
    delivery.stageDiffPage(output,output.slice(0,-1),'clipped message');
    expect(delivery.acknowledgeRequest(messages('clipped message')).complete).toBe(false);
    delivery.stageDiffPage(output,output,'page message');
    expect(delivery.acknowledgeRequest(messages('page message')).complete).toBe(true);
  });

  it('requires every original character, merges overlaps, and rejects stale or forged bytes', () => {
    const delivery=tracker();
    const first=page(0,4),last=page(6,10);
    delivery.stageDiffPage(first,first,'first'); delivery.stageDiffPage(last,last,'last');
    expect(delivery.acknowledgeRequest(messages('first').concat(messages('last'))).complete).toBe(false);
    const wrong=page(3,7,'0123456789');
    delivery.stageDiffPage(wrong,wrong,'wrong');
    expect(delivery.acknowledgeRequest(messages('wrong')).complete).toBe(false);
    const middle=page(3,7);
    delivery.stageDiffPage(middle,middle,'middle');
    const receipt=delivery.acknowledgeRequest(messages('middle'));
    expect(receipt.complete).toBe(true);
    expect(receipt.files[0].ranges).toEqual([[0,10]]);
  });

  it('requires original pages when inline sanitization removed source characters', () => {
    const original={path:files[0].path,patch:'abc\u001b[31mdef'};
    const delivery=new TaskSourceDelivery({...binding,files:[original],prefix:'abcdef',inlinedPaths:binding.paths});
    expect(delivery.acknowledgeRequest(messages('abcdef')).complete).toBe(false);
    const output=page(0,original.patch.length,original.patch);
    delivery.stageDiffPage(output,output,'original page');
    expect(delivery.acknowledgeRequest(messages('original page')).complete).toBe(true);
  });

  it('does not transfer paged evidence to a fresh retry context', () => {
    const delivery=tracker(), output=page(0,10);
    delivery.stageDiffPage(output,output,'page message');
    expect(delivery.acknowledgeRequest(messages('page message')).complete).toBe(true);
    delivery.beginAttempt();
    expect(delivery.acknowledgeRequest(messages(INLINE_PREFIX)).complete).toBe(false);
    expect(delivery.snapshot().files[0].ranges).toEqual([]);
  });

  it('never certifies a missing or already truncated original patch', () => {
    for (const source of [{path:files[0].path},{...files[0],originalPatchLength:20}]) {
      const delivery=new TaskSourceDelivery({...binding,files:[source],prefix:'prefix',inlinedPaths:binding.paths});
      expect(delivery.acknowledgeRequest(messages('prefix')).complete).toBe(false);
    }
  });

  it('rejects retained receipts bound to a different head, task, path, or patch', () => {
    const receipt=tracker(true).acknowledgeRequest(messages(INLINE_PREFIX));
    for (const changed of [{...binding,headSha:BASE},{...binding,taskId:'other-task'},
      {...binding,paths:['src/other.ts']},{...binding,files:[{...files[0],patch:'ABCDEFGHIJ'}]}]) {
      expect(validateTaskSourceReceipt(receipt,changed)).toBeNull();
    }
    expect(validateTaskSourceReceipt(undefined,binding)).toBeNull();
    expect(taskSourceReceiptSchema.safeParse({...receipt,complete:false}).success).toBe(false);
  });

  it('reports actual delivered task counts and bounds safe disclosure output', () => {
    const full=tracker(true).acknowledgeRequest(messages(INLINE_PREFIX));
    const partial={...tracker().snapshot(),taskId:'missing-task'};
    expect(renderTaskSourceDelivery({taskPlan:[{id:full.taskId}]})).toEqual([]);
    expect(renderTaskSourceDelivery({sourceDelivery:[full]})).toEqual([]);
    const lines=renderTaskSourceDelivery({taskPlan:[{id:full.taskId},{id:partial.taskId}],sourceDelivery:[full,partial]});
    expect(lines[0]).toContain('1/2 assigned task(s)');
    expect(lines[0]).toContain('source delivery complete=false');
    expect(renderTaskSourceDelivery({taskPlan:[{id:full.taskId}],sourceDelivery:[full]})[0])
      .toContain('source delivery complete=true');
    const unsafe={...full,taskId:'`<source>\n'};
    const capped=renderTaskSourceDelivery({taskPlan:[{id:unsafe.taskId}],sourceDelivery:Array.from({length:30},()=>unsafe)});
    expect(capped).toHaveLength(25);
    expect(capped[1]).toContain('Task `  source  `');
    expect(capped[1]).not.toContain('<source>');
    expect(capped[1]).not.toContain('\n');
    expect(capped[1]).toMatch(/receipt SHA256 `[a-f0-9]{64}`/u);
  });

  it('restores a planning reduction only when all assigned tasks have full delivered source', () => {
    const receipt=tracker(true).acknowledgeRequest(messages(INLINE_PREFIX));
    const result={taskPlan:[{id:'source-task',paths:binding.paths}],truncatedFiles:[{path:files[0].path}],
      diffShrink:{notSentInFull:[{path:files[0].path,why:'budget-signatures'}]},reviewBudget:{}};
    expect(attachTaskSourceDelivery(result,[receipt]).truncatedFiles).toBeUndefined();
    expect(attachTaskSourceDelivery(result,[receipt]).diffShrink?.notSentInFull).toEqual([]);
    const missing={...result,taskPlan:[...result.taskPlan,{id:'missing-task',paths:binding.paths}]};
    expect(attachTaskSourceDelivery(missing,[receipt]).truncatedFiles).toEqual(result.truncatedFiles);
    expect(attachTaskSourceDelivery(result,[]).truncatedFiles).toEqual(result.truncatedFiles);
  });
});

describe('closed source delivery wire boundaries', () => {
  it('retains and integrity-binds receipts without retaining source bytes', () => {
    const {trusted,tasks,usage}=ledgerFixture();
    const assigned=tasks[0],prefix=trusted.changedFiles[0].patch!;
    const receipt=new TaskSourceDelivery({taskId:assigned.id,paths:assigned.paths,files:trusted.changedFiles,
      prefix,inlinedPaths:assigned.paths,headSha:trusted.identity.headSha,baseSha:trusted.identity.baseSha})
      .acknowledgeRequest(messages(prefix));
    const plan=createComposedTaskPlan(trusted,tasks);
    const input={planDigest:plan.digest,taskId:assigned.id,status:'complete',findings:[],usage,sourceDelivery:receipt};
    const retained=createComposedTaskOutcome(plan,input,trusted.changedFiles);
    expect(retained.payload.sourceDelivery).toEqual(receipt);
    expect(JSON.stringify(retained.payload)).not.toContain(prefix);
    for(const wrong of [{...receipt,headSha:BASE},{...receipt,taskId:tasks[1].id}]) {
      expect(() => createComposedTaskOutcome(plan,{...input,sourceDelivery:wrong},trusted.changedFiles)).toThrow();
    }
    const sameSize=trusted.changedFiles.map(file => ({...file,patch:file.patch?.replace('after','other')}));
    expect(() => createComposedTaskOutcome(plan,input,sameSize)).toThrow();
    const request=createComposedTaskOutcomeRetentionRequest({...input,status:'complete',taskIndex:0,
      selectors:{repository:'exampleorg/fixture',prNumber:42,headSha:HEAD,baseSha:BASE}});
    expect(request.evidence.sourceDelivery).toEqual(receipt);
    receipt.files[0].ranges.length=0;
    expect(request.evidence.sourceDelivery?.files[0].ranges.length).toBe(1);
    expect(() => createComposedTaskOutcomeRetentionRequest({...input,status:'complete',taskIndex:0,
      selectors:{repository:'exampleorg/fixture',prNumber:42,headSha:HEAD,baseSha:BASE}})).toThrow();
  });

  it('preserves receipts through checkpoint and worker completion parsers, rejecting unknown fields', () => {
    const receipt=tracker(true).acknowledgeRequest(messages(INLINE_PREFIX));
    const coordinates={runId:`run_${'1'.repeat(32)}`,repositoryId:123,owner:'exampleorg',repo:'fixture',prNumber:42,
      headSha:HEAD,baseSha:BASE,policyDigest:'c'.repeat(64),configDigest:'d'.repeat(64),executionAttempt:1};
    const assigned={id:'source-task',dimension:'testing',paths:binding.paths,question:'Review source.',rationale:'Verify delivery.'};
    const checkpoint={version:'ReviewExecutionCheckpoint.v1',...coordinates,revision:1,plan:[assigned],
      completedTasks:[{id:assigned.id,findings:[],sourceDelivery:receipt}]};
    expect(parseReviewExecutionCheckpoint(checkpoint).completedTasks[0].sourceDelivery).toEqual(receipt);
    const completion={version:'WorkerReviewCompletion.v1',...coordinates,result:{version:'WorkerReviewResult.v1',
      completedAt:'2026-10-01T00:00:00.000Z',personas:[{id:assigned.id,decision:'APPROVE',findings:[],sourceDelivery:receipt}],
      taskPlan:[assigned],coverageComplete:true,quorumSatisfied:true}};
    expect(parseWorkerReviewCompletion(completion).result.personas[0].sourceDelivery).toEqual(receipt);
    const leaked={...receipt,rawSource:'must not be retained'};
    expect(() => parseReviewExecutionCheckpoint({...checkpoint,completedTasks:[{id:assigned.id,findings:[],sourceDelivery:leaked}]})).toThrow();
    expect(() => parseWorkerReviewCompletion({...completion,result:{...completion.result,personas:[{id:assigned.id,decision:'APPROVE',findings:[],sourceDelivery:leaked}]}})).toThrow();
  });
});

const config=parseAndValidateConfig(`
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`) as any;
const text=(messages:any[]) => messages.flatMap(message => typeof message.content==='string'
  ? [message.content] : message.content.map((block:any) => block.text ?? '')).join('\n');
const nonce=(prompt:string) => [...prompt.matchAll(/CT_REVIEW_NONCE:([a-f0-9-]+)/g)].at(-1)![1];
const response=(content:object) => ({model:'fixture',content:JSON.stringify(content),usage:{prompt:1,completion:1,total:2},costUSD:0,raw:{}});
const task={id:'source-task',dimension:'testing',paths:binding.paths,question:'Inspect every original changed byte.',rationale:'Source must remain available.'};

describe('composed source delivery boundary', () => {
  it('fails closed when the model completes an oversized assignment without reading its pages', async () => {
    vi.stubEnv('MAX_FILE_DIFF_CHARS','8');
    const complete=vi.fn(async ({messages}:any) => {
      const prompt=text(messages);
      return response(prompt.includes('PLAN TURN') ? {nonce:nonce(prompt),tasks:[task]}
        : {nonce:nonce(prompt),task:task.id,status:'COMPLETE',findings:[]});
    });
    const result=await executeComposedReview({config,changedFiles:files,repository:'exampleorg/project',headSha:HEAD,baseSha:BASE,client:{complete} as any});
    expect(result.quorum.satisfied).toBe(false);
    expect(result.personas).toEqual([]);
    expect(result.sourceDelivery?.[0].complete).toBe(false);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(13);
    expect(result.unreportedLanes?.[0].error).toContain('source_not_delivered');
  });

  it('acknowledges complete original pages only after their real tool results reach the next provider call', async () => {
    vi.stubEnv('MAX_FILE_DIFF_CHARS','8');
    let workCalls=0;
    const complete=vi.fn(async ({messages}:any) => {
      const prompt=text(messages),n=nonce(prompt);
      if (prompt.includes('PLAN TURN')) return response({nonce:n,tasks:[task]});
      workCalls++;
      if(workCalls===1) return response({tool:'get_diff_page',args:{path:files[0].path,startOffset:0,maxChars:6}});
      if(workCalls===2) return response({tool:'get_diff_page',args:{path:files[0].path,startOffset:6,maxChars:6}});
      expect(prompt).toContain('"content":"abcdef"');
      expect(prompt).toContain('"content":"ghij"');
      return response({nonce:n,task:task.id,status:'COMPLETE',findings:[]});
    });
    const snapshots:any[]=[];
    const result=await executeComposedReview({config,changedFiles:files,repository:'exampleorg/project',headSha:HEAD,baseSha:BASE,
      client:{complete} as any,checkpoint:{resumed:null,save:async snapshot => {snapshots.push(snapshot);}}});
    expect(result.quorum.satisfied).toBe(true);
    expect(workCalls).toBe(3);
    expect(result.sourceDelivery?.[0]).toMatchObject({complete:true,files:[{ranges:[[0,10]],inline:false}]});
    expect(snapshots.at(-1).completedTasks[0].sourceDelivery).toEqual(result.sourceDelivery?.[0]);
  });
});
