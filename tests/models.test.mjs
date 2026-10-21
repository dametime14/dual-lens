import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, STORAGE_LIMIT } from '../src/controller.mjs';
import { commandFor } from '../src/providers.mjs';
import { validateModels } from '../src/models.mjs';

function fixture(t,extra={}){
  const dir=mkdtempSync(join(tmpdir(),'dual-models-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[];
  const c=new Controller(dir,()=>{},{listModels:async()=>[{id:'test-gpt',name:'Test GPT'}],check:async()=>({}),answer:async(p,prompt,options)=>{calls.push({p,prompt,options});return {text:'done'};},...extra});
  return {c,dir,calls};
}
test('separate models persist across restarts, storage mode changes, and storage cap',async t=>{
  const {c,dir}=fixture(t);
  await c.dispatch({action:'models-list'});
  await c.dispatch({action:'models-save',models:{gpt:'test-gpt',claude:'claude-sonnet-5-5'}});
  assert.deepEqual(new Controller(dir,()=>{}).models,{gpt:'test-gpt',claude:'claude-sonnet-5-5'});
  await c.dispatch({action:'storage',mode:'session'});await c.dispatch({action:'storage',mode:'local'});
  assert.equal(new Controller(dir,()=>{}).models.claude,'claude-sonnet-5-5');
  c.projects.push({context:'x'.repeat(STORAGE_LIMIT)});c.persist();
  assert.equal(new Controller(dir,()=>{}).models.gpt,'test-gpt');
});
test('settings apply independently to next questions and feedback but retries keep original model',async t=>{
  let fail=true;const calls=[];
  const {c}=fixture(t,{answer:async(p,prompt,options)=>{calls.push({p,model:options.model});if(p==='claude'&&fail)throw new Error('fail');return {text:'done'};}});
  await c.dispatch({action:'models-list'});
  await c.dispatch({action:'models-save',models:{gpt:'test-gpt',claude:'claude-sonnet-5-5'}});
  const id=await c.dispatch({action:'ask',question:'hello'});await c.pending;
  assert.deepEqual(calls,[{p:'gpt',model:'test-gpt'},{p:'claude',model:'claude-sonnet-5-5'}]);
  await c.dispatch({action:'models-save',models:{gpt:'',claude:'claude-opus-5-5'}});fail=false;
  await c.dispatch({action:'retry',id,roundId:c.history[0].rounds[0].id,provider:'claude'});await c.pending;
  assert.equal(calls.at(-1).model,'claude-sonnet-5-5');
  await c.dispatch({action:'feedback',id});await c.pending;
  assert.deepEqual(calls.slice(-2),[{p:'gpt',model:'test-gpt'},{p:'claude',model:'claude-opus-5-5'}]);
  assert.equal(c.history[0].rounds[0].answers.gpt.requestedModel,'test-gpt');
});
test('summary calls use the selected provider model',async t=>{
  const {c,calls}=fixture(t,{contextOptions:{budget:180,chunkSize:2000,keep:0}});
  await c.dispatch({action:'models-list'});await c.dispatch({action:'models-save',models:{gpt:'test-gpt',claude:'claude-haiku-5-5'}});
  const id=await c.dispatch({action:'ask',target:'claude',question:'first'.repeat(50)});await c.pending;
  await c.dispatch({action:'ask',id,target:'claude',question:'second'});await c.pending;
  assert.ok(calls.length>=3);assert.ok(calls.every(call=>call.options.model==='claude-haiku-5-5'));
});
test('model flags preserve subscription safeguards and reject argument injection/unknown models',async t=>{
  const {c}=fixture(t);
  await assert.rejects(c.dispatch({action:'models-save',models:{gpt:'not-listed',claude:''}}));
  assert.deepEqual(c.models,{gpt:'',claude:'claude-opus-5-5'});
  assert.throws(()=>validateModels({gpt:'--config=bad',claude:''}));
  assert.throws(()=>validateModels({gpt:'',claude:'fable'}));
  for(const provider of ['gpt','claude']){
    const args=commandFor(provider,provider==='gpt'?'test-gpt':'claude-sonnet-5-5');
    assert.equal(args[args.indexOf('--model')+1],provider==='gpt'?'test-gpt':'claude-sonnet-5-5');
    assert.ok(args.includes(provider==='gpt'?'forced_login_method="chatgpt"':'{"forceLoginMethod":"claudeai"}'));
    assert.throws(()=>commandFor(provider,'x; command'));
  }
});
