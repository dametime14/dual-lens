import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Controller} from '../src/controller.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'dual-lens-nav-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {dir,c:new Controller(dir,()=>{})};
}

test('renaming a project preserves its identity, instructions, files and chat membership',async t=>{
  const {dir,c}=fixture(t);
  const id=await c.dispatch({action:'project-save',name:'Before',instructions:'Keep me',context:'Reference',files:[{path:'brief.txt',text:'Source'}]});
  c.history.push({id:'chat',projectId:id,title:'Chat',question:'Question',rounds:[]});c.persist();
  const before=structuredClone(c.projects[0]);
  await c.dispatch({action:'project-rename',id,name:'After'});
  const restored=new Controller(dir,()=>{});
  assert.equal(restored.projects[0].name,'After');
  for(const key of ['id','instructions','context','files'])assert.deepEqual(restored.projects[0][key],before[key]);
  assert.equal(restored.history[0].projectId,id);
  await assert.rejects(()=>c.dispatch({action:'project-rename',id,name:' '}));
  await assert.rejects(()=>c.dispatch({action:'project-rename',id,name:'x'.repeat(81)}));
  await assert.rejects(()=>c.dispatch({action:'project-rename',id:'missing',name:'No'}));
  assert.equal(c.projects[0].name,'After');
});

test('reading preferences persist during generation without changing conversations',async t=>{
  const {dir,c}=fixture(t);
  assert.deepEqual(c.reading,{paragraphSpacing:'compact',composerCollapsed:false});
  c.active={id:'active',roundId:'round',stage:'question'};
  await c.dispatch({action:'reading-save',reading:{paragraphSpacing:'relaxed',composerCollapsed:true}});
  assert.deepEqual(new Controller(dir,()=>{}).reading,{paragraphSpacing:'relaxed',composerCollapsed:true});
  assert.equal(c.active.id,'active');assert.equal(c.history.length,0);
  await c.dispatch({action:'layout-save',layout:{sidebarWidth:300,sidebarCollapsed:true}});
  assert.equal(new Controller(dir,()=>{}).reading.composerCollapsed,true);
  for(const reading of [{},{paragraphSpacing:'huge',composerCollapsed:true},{paragraphSpacing:'compact',composerCollapsed:'yes'}])await assert.rejects(c.dispatch({action:'reading-save',reading}));
  assert.equal(c.reading.paragraphSpacing,'relaxed');
});
test('sidebar size and collapse persist without changing model choices and reject invalid values',async t=>{
  const {dir,c}=fixture(t);
  c.efforts={gpt:'high',claude:'max'};
  await c.dispatch({action:'layout-save',layout:{sidebarWidth:320,sidebarCollapsed:true}});
  let restored=new Controller(dir,()=>{});
  assert.deepEqual(restored.layout,{sidebarWidth:320,sidebarCollapsed:true});
  assert.deepEqual(restored.efforts,{gpt:'high',claude:'max'});
  await c.dispatch({action:'storage',mode:'session'});
  restored=new Controller(dir,()=>{});
  assert.deepEqual(restored.layout,{sidebarWidth:320,sidebarCollapsed:true});
  for(const layout of [{sidebarWidth:0,sidebarCollapsed:false},{sidebarWidth:421,sidebarCollapsed:false},{sidebarWidth:250,sidebarCollapsed:'false'},{}]){
    await assert.rejects(()=>c.dispatch({action:'layout-save',layout}));
    assert.deepEqual(c.layout,{sidebarWidth:320,sidebarCollapsed:true});
  }
});
