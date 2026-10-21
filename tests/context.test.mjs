import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareContext, visibleEntries, conversationPrompt, latestAnswers } from '../src/context.mjs';
import { Controller, STORAGE_LIMIT } from '../src/controller.mjs';

function record(n=12) {
  return {pinned:'BUDGET 12345',memory:{},rounds:Array.from({length:n},(_,i)=>({
    id:String(i),kind:'question',question:'question '+i+' '.repeat(30),answers:{
      gpt:{status:'done',text:'GPT '+i+'x'.repeat(150)},
      ...(i%2 ? {} : {claude:{status:'done',text:'Claude '+i+'y'.repeat(150)}})
    }
  }))};
}
test('compaction uses only own visible history, keeps recent turns and pins verbatim',async()=>{
  const r=record();const calls=[];
  const context=await prepareContext(r,'gpt',12,async p=>{calls.push(p);return 'Earlier decisions: budget 12345';},{budget:1800,keep:3});
  assert.ok(calls.length>0);assert.ok(calls.every(p=>!p.includes('Claude')));
  assert.deepEqual(context.recent.map(e=>e.index),[9,10,11]);assert.equal(r.memory.claude,undefined);
  assert.equal(r.memory.gpt.through,8);
  const p=conversationPrompt(r,{kind:'question',question:'now'},'gpt',context);
  assert.match(p,/BUDGET 12345/);assert.match(p,/question 11/);assert.doesNotMatch(p,/question 0/);
  const again=await prepareContext(r,'gpt',12,()=>{throw Error('should reuse summary');},{budget:1800,keep:3});
  assert.deepEqual(again,context);
});
test('summary failure or cancellation never advances memory or discards original',async()=>{
  const r=record();const original=JSON.stringify(r.rounds);
  await assert.rejects(prepareContext(r,'gpt',12,async()=>{throw Error('quota');},{budget:700}),/quota/);
  assert.equal(r.memory.gpt,undefined);assert.equal(JSON.stringify(r.rounds),original);
  const abort=new AbortController();
  await assert.rejects(prepareContext(r,'gpt',12,async()=>{abort.abort();return 'summary';},{budget:700,signal:abort.signal}),/중지/);
  assert.equal(r.memory.gpt,undefined);assert.equal(JSON.stringify(r.rounds),original);
});
test('long single entry is summarized in bounded chunks without truncating source',async()=>{
  const r=record(1);r.rounds[0].answers.gpt.text='🌱'.repeat(2000)+'END';
  const chunks=[];
  const context=await prepareContext(r,'gpt',1,async prompt=>{
    const payload=JSON.parse(prompt.slice(prompt.indexOf('{')));chunks.push(payload.source);return 'retained';
  },{budget:500,chunkSize:600});
  assert.ok(chunks.length>1);assert.equal(chunks.join(''),JSON.stringify(visibleEntries(r,'gpt')));
  assert.ok(JSON.stringify(context).length<500);assert.ok(r.rounds[0].answers.gpt.text.endsWith('END'));
});
test('invalid overlong summaries fail rather than silently truncating',async()=>{
  await assert.rejects(prepareContext(record(),'gpt',12,async()=>'x'.repeat(5001),{budget:600}),/너무 깁니다/);
});
test('feedback snapshot contains distinct questions and does not drift on retries',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dual-feedback-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const prompts=[];let fail=false;
  const c=new Controller(dir,()=>{},{check:async()=>({}),answer:async(p,q)=>{
    prompts.push({p,q});if(fail&&p==='claude')throw Error('offline');return {text:q.includes('PRIVATE')?'PRIVATE RESULT':'COMMON RESULT',durationMs:1};
  }});
  const id=await c.dispatch({action:'ask',question:'COMMON'});await c.pending;
  await c.dispatch({action:'ask',id,target:'gpt',question:'PRIVATE'});await c.pending;
  fail=true;await c.dispatch({action:'feedback',id});await c.pending;
  const round=c.history[0].rounds.at(-1);assert.equal(round.review.gpt.question,'PRIVATE');assert.equal(round.review.claude.question,'COMMON');
  const original=prompts.findLast(p=>p.p==='claude').q;fail=false;
  await c.dispatch({action:'retry',id,roundId:round.id,provider:'claude'});await c.pending;
  assert.equal(prompts.at(-1).q,original);
  assert.equal(latestAnswers(c.history[0]).gpt.question,'PRIVATE');
});
test('peer review preserves answers, repeats target answers and carries received critique forward',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dual-peer-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let phase='answer';const prompts=[];
  const c=new Controller(dir,()=>{},{check:async()=>({}),answer:async(p,prompt)=>{prompts.push(prompt);return {text:p+' '+phase,durationMs:1};}});
  const id=await c.dispatch({action:'ask',question:'Plan an experiment'});await c.pending;
  const original=structuredClone(c.history[0].rounds[0]);phase='critique';
  await c.dispatch({action:'feedback',id});await c.pending;
  assert.deepEqual(c.history[0].rounds[0],original);
  const first=c.history[0].rounds[1];assert.equal(first.reviewMode,'peer');
  assert.equal(first.review.gpt.text,'gpt answer');
  assert.equal(first.review.claude.text,'claude answer');
  const entry=visibleEntries(c.history[0],'gpt').at(-1);
  assert.equal(entry.receivedFeedback.text,'claude critique');
  assert.equal(entry.receivedFeedback.onAnswerRoundId,original.id);
  await c.dispatch({action:'feedback',id});await c.pending;
  assert.deepEqual(c.history[0].rounds[2].review,first.review);
  phase='follow-up';await c.dispatch({action:'ask',id,target:'gpt',question:'Use the feedback'});await c.pending;
  assert.match(prompts.at(-1),/claude critique/);
  assert.match(prompts.at(-1),/receivedFeedback/);
  const record=c.history[0];record.rounds[1].answers.gpt={status:'error'};
  assert.equal(visibleEntries(record,'gpt').find(e=>e.index===1).receivedFeedback.text,'claude critique');
});
test('legacy files remain untouched until explicitly loaded or removed',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dual-migrate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const old=[{id:'old',question:'q',createdAt:new Date().toISOString(),answers:{gpt:{status:'done',text:'g'},claude:{status:'done',text:'c'}},feedback:{gpt:{status:'done',text:'review'}},focus:'numbers'}];
  const original=JSON.stringify(old);writeFileSync(join(dir,'history.json'),original);
  const c=new Controller(dir,()=>{},{defaultStorage:'session'});assert.equal(c.history.length,0);assert.equal(readFileSync(c.file,'utf8'),original);
  await c.dispatch({action:'storage',mode:'local'});assert.equal(c.history[0].rounds.length,2);
  assert.equal(c.history[0].rounds[1].review.claude.text,'c');
  assert.equal(new Controller(dir,()=>{}).history[0].rounds[0].answers.gpt.text,'g');
});
test('20MB ceiling preserves last saved file and all in-memory answers',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dual-cap-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const errors=[];
  const c=new Controller(dir,e=>{if(e.type==='error')errors.push(e);});
  await c.dispatch({action:'storage',mode:'local'});
  const before=readFileSync(c.file,'utf8');
  c.history=[{text:'x'.repeat(STORAGE_LIMIT)}];c.persist();
  assert.equal(c.storage,'session');assert.equal(errors.length,1);
  assert.equal(readFileSync(c.file,'utf8'),before);assert.ok(statSync(c.file).size<STORAGE_LIMIT);
  assert.equal(c.history[0].text.length,STORAGE_LIMIT);
});
test('new installations default to bounded local storage',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dual-default-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const c=new Controller(dir,()=>{},{check:async()=>({}),answer:async()=>({text:'saved',durationMs:1})});
  assert.equal(c.storage,'local');
  const id=await c.dispatch({action:'ask',question:'default local'});await c.pending;
  assert.equal(new Controller(dir,()=>{}).history[0].id,id);
});
