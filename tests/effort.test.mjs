import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Controller} from '../src/controller.mjs';
import {commandFor,extractResult} from '../src/providers.mjs';
import {resolveClaudeModel,validateEfforts} from '../src/models.mjs';
function fixture(t,overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'dual-effort-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const calls=[];
 const c=new Controller(dir,()=>{},{listModels:async()=>[{id:'gpt-test',isDefault:true,defaultEffort:'low',efforts:['low','medium','high']}],check:async()=>({}),answer:async(p,prompt,options)=>{calls.push({p,prompt,...options});return {text:'ok'};},...overrides});
 return {c,dir,calls};
}
test('versionless Claude selections migrate to pinned IDs; GPT default is resolved from CLI catalog',async t=>{
 const {dir,c}=fixture(t);writeFileSync(join(dir,'settings.json'),JSON.stringify({models:{gpt:'',claude:'opus'},storage:'local'}));
 assert.equal(new Controller(dir,()=>{}).models.claude,'claude-opus-5-5');
 assert.equal(resolveClaudeModel('sonnet'),'claude-sonnet-5-5');
 await c.dispatch({action:'models-list'});assert.equal(c.models.gpt,'gpt-test');
});
test('efforts persist independently and unsupported model-effort combinations fail atomically',async t=>{
 const {c,dir}=fixture(t);await c.dispatch({action:'models-list'});
 await c.dispatch({action:'models-save',models:c.models,efforts:{gpt:'high',claude:'max'}});
 assert.deepEqual(new Controller(dir,()=>{}).efforts,{gpt:'high',claude:'max'});
 await c.dispatch({action:'storage',mode:'session'});
 assert.deepEqual(new Controller(dir,()=>{}).efforts,{gpt:'high',claude:'max'});
 await assert.rejects(c.dispatch({action:'models-save',models:c.models,efforts:{gpt:'ultra',claude:'low'}}));
 assert.deepEqual(c.efforts,{gpt:'high',claude:'max'});
 assert.throws(()=>validateEfforts({claude:'ultra'}));
});
test('summary and answer calls use provider-specific effort, and old round retries retain it',async t=>{
 const {c,calls}=fixture(t,{contextOptions:{budget:180,chunkSize:2000,keep:0}});await c.dispatch({action:'models-list'});
 await c.dispatch({action:'models-save',models:c.models,efforts:{gpt:'high',claude:'low'}});
 const id=await c.dispatch({action:'ask',question:'first'.repeat(50)});await c.pending;
 await c.dispatch({action:'ask',id,question:'next'});await c.pending;
 assert.ok(calls.length>4);assert.ok(calls.every(call=>call.effort===(call.p==='gpt'?'high':'low')));
 const round=c.history[0].rounds.at(-1);round.answers.gpt={status:'error',error:'test',text:''};
 await c.dispatch({action:'models-save',models:c.models,efforts:{gpt:'low',claude:'max'}});
 await c.dispatch({action:'retry',id,roundId:round.id,provider:'gpt'});await c.pending;
 assert.equal(calls.at(-1).effort,'high');
 await c.dispatch({action:'feedback',id});await c.pending;
 assert.equal(c.history[0].rounds.at(-1).answers.claude.requestedEffort,'max');
});
test('effort is passed through real CLI options, not prompt instructions; model reports retain all used IDs',()=>{
 assert.ok(commandFor('gpt','gpt-test','high').includes('model_reasoning_effort="high"'));
 const claude=commandFor('claude','claude-opus-5-5','max');assert.equal(claude[claude.indexOf('--effort')+1],'max');
 assert.throws(()=>commandFor('claude','claude-opus-5-5','ultra'));
 const result=extractResult('claude',[{type:'result',subtype:'success',result:'ok',modelUsage:{'claude-opus-5-5':{},'claude-opus-5':{}}}]);
 assert.equal(result.model,'claude-opus-5-5, claude-opus-5');
});
