import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, STORAGE_LIMIT } from '../src/controller.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'dual-projects-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[],events=[];
  const c=new Controller(dir,e=>events.push(e),{check:async()=>({}),answer:async(p,prompt)=>{calls.push({p,prompt});return {text:p+' ANSWER',durationMs:1};}});
  return {c,dir,calls,events};
}
test('project instructions and context reach both providers and feedback, never other projects',async t=>{
  const {c,calls}=fixture(t);
  const a=await c.dispatch({action:'project-save',name:'Alpha',instructions:'ALPHA_RULE',context:'ALPHA_REFERENCE'});
  const b=await c.dispatch({action:'project-save',name:'Beta',instructions:'BETA_RULE',context:'BETA_REFERENCE'});
  const id=await c.dispatch({action:'ask',projectId:a,question:'q'});await c.pending;
  for(const call of calls){assert.match(call.prompt,/ALPHA_RULE/);assert.match(call.prompt,/ALPHA_REFERENCE/);assert.doesNotMatch(call.prompt,/BETA_/);}
  await c.dispatch({action:'feedback',id});await c.pending;
  assert.match(calls.at(-1).prompt,/ALPHA_RULE/);
  await c.dispatch({action:'ask',projectId:b,question:'unrelated'});await c.pending;
  for(const call of calls.slice(-2)){assert.match(call.prompt,/BETA_RULE/);assert.doesNotMatch(call.prompt,/ALPHA_|gpt ANSWER|claude ANSWER/);}
});
test('project edits apply on next turn; title rename never changes original question',async t=>{
  const {c,calls}=fixture(t);
  const p=await c.dispatch({action:'project-save',name:'Old',instructions:'OLD_RULE',context:'old reference'});
  const id=await c.dispatch({action:'ask',projectId:p,question:'ORIGINAL_QUESTION'});await c.pending;
  await c.dispatch({action:'chat-update',id,title:'My renamed chat',starred:true,archived:true});
  assert.equal(c.history[0].title,'My renamed chat');assert.equal(c.history[0].question,'ORIGINAL_QUESTION');
  await c.dispatch({action:'project-save',id:p,name:'New',instructions:'NEW_RULE',context:'new reference'});
  await c.dispatch({action:'ask',id,question:'next'});await c.pending;
  assert.match(calls.at(-1).prompt,/NEW_RULE/);assert.doesNotMatch(calls.at(-1).prompt,/OLD_RULE/);
  assert.equal(c.history[0].archived,false);assert.equal(c.history[0].starred,true);
});
test('moving a chat out removes project context and preserves it when the empty project is deleted',async t=>{
  const {c,calls}=fixture(t);
  const p=await c.dispatch({action:'project-save',name:'A',context:'PROJECT_NOTE'});
  const id=await c.dispatch({action:'ask',question:'q'});await c.pending;
  await c.dispatch({action:'chat-update',id,projectId:p});
  await c.dispatch({action:'ask',id,target:'claude',question:'next'});await c.pending;
  assert.match(calls.at(-1).prompt,/PROJECT_NOTE/);
  await c.dispatch({action:'chat-update',id,projectId:null});
  await c.dispatch({action:'project-delete',id:p});assert.equal(c.projects.length,0);assert.equal(c.history[0].projectId,null);
  assert.equal(c.history[0].rounds.length,2);
  await c.dispatch({action:'ask',id,question:'again'});await c.pending;
  assert.doesNotMatch(calls.at(-1).prompt,/PROJECT_NOTE/);
});
test('deleting a project removes only its current chats, including archived chats, after restart',async t=>{
  const {c,dir,events}=fixture(t);
  const p=await c.dispatch({action:'project-save',name:'Delete me'});
  const other=await c.dispatch({action:'project-save',name:'Keep me'});
  async function chat(projectId,question){
    const id=await c.dispatch({action:'ask',projectId,question});await c.pending;return id;
  }
  const active=await chat(p,'active');
  const archived=await chat(p,'archived');
  await c.dispatch({action:'chat-update',id:archived,archived:true});
  const moved=await chat(p,'moved out');
  await c.dispatch({action:'chat-update',id:moved,projectId:other});
  const unrelated=await chat(other,'other project');
  const standalone=await chat(null,'standalone');
  const survivors=structuredClone(c.history.filter(r=>r.projectId!==p));
  await c.dispatch({action:'project-delete',id:p});
  assert.deepEqual(c.history,survivors);
  assert.deepEqual(new Set(c.history.map(r=>r.id)),new Set([moved,unrelated,standalone]));
  assert.deepEqual(c.projects.map(p=>p.id),[other]);
  assert.deepEqual(new Set(events.findLast(e=>e.type==='projectDeleted').deletedChatIds),new Set([active,archived]));
  const reopened=new Controller(dir,()=>{});
  assert.deepEqual(reopened.history,JSON.parse(JSON.stringify(survivors)));
  assert.deepEqual(reopened.projects.map(p=>p.id),[other]);
  const before=JSON.stringify({projects:c.projects,history:c.history});
  await assert.rejects(c.dispatch({action:'project-delete',id:p}));
  assert.equal(JSON.stringify({projects:c.projects,history:c.history}),before);
  c.checking=true;
  await assert.rejects(c.dispatch({action:'project-delete',id:other}));
  assert.equal(JSON.stringify({projects:c.projects,history:c.history}),before);
});
test('projects and chat metadata persist together; v1 array is migrated without losing originals',async t=>{
  const {c,dir}=fixture(t);
  const p=await c.dispatch({action:'project-save',name:'Saved',instructions:'rule',context:'note'});
  const id=await c.dispatch({action:'ask',projectId:p,question:'saved q'});await c.pending;
  await c.dispatch({action:'chat-update',id,title:'renamed',starred:true,archived:true});
  const reopened=new Controller(dir,()=>{});
  assert.equal(reopened.projects[0].context,'note');assert.equal(reopened.history[0].projectId,p);
  assert.equal(reopened.history[0].title,'renamed');assert.equal(reopened.history[0].archived,true);
  const v1=[{id:'old',question:'old q',createdAt:'2026-01-01',rounds:[],memory:{},pinned:'keep'}];
  writeFileSync(c.file,JSON.stringify(v1));
  const legacy=new Controller(dir,()=>{});assert.equal(legacy.history[0].pinned,'keep');assert.equal(legacy.history[0].title,'old q');
  assert.equal(legacy.projects.length,0);
});
test('invalid project IDs and oversized settings fail atomically without model calls',async t=>{
  const {c,calls}=fixture(t);
  await assert.rejects(c.dispatch({action:'project-save',name:'',context:'note'}));
  await assert.rejects(c.dispatch({action:'project-save',name:'x',instructions:'x'.repeat(4001)}));
  await assert.rejects(c.dispatch({action:'ask',projectId:'missing',question:'q'}));
  assert.equal(c.history.length,0);assert.equal(c.projects.length,0);assert.equal(calls.length,0);
  const id=await c.dispatch({action:'ask',question:'q'});await c.pending;
  await assert.rejects(c.dispatch({action:'chat-update',id,title:'partial mutation',projectId:'missing'}));
  assert.notEqual(c.history[0].title,'partial mutation');
});
test('storage cap includes projects; switching to session removes on-disk project context',async t=>{
  const {c,dir}=fixture(t);
  await c.dispatch({action:'project-save',name:'Private',context:'project note'});
  await c.dispatch({action:'storage',mode:'session'});
  assert.equal(new Controller(dir,()=>{}).projects.length,0);assert.equal(c.projects.length,1);
  await c.dispatch({action:'storage',mode:'local'});
  const saved=readFileSync(c.file,'utf8');
  c.projects[0].context='x'.repeat(STORAGE_LIMIT);c.persist();
  assert.equal(c.storage,'session');assert.equal(readFileSync(c.file,'utf8'),saved);
});
