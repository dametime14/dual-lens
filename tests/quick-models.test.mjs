import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Controller} from '../src/controller.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'dual-quick-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const events=[];
  const c=new Controller(dir,event=>events.push(event));
  c.modelCatalog=[{id:'gpt-a',efforts:['low','high'],defaultEffort:'low'},{id:'gpt-b',efforts:['medium'],defaultEffort:'medium'}];
  c.models={gpt:'gpt-a',claude:'claude-opus-5-5'};
  c.efforts={gpt:'high',claude:'max'};
  return {c,dir,events};
}

test('quick choices merge independently, persist, reset only changed model effort and do not open shared settings',async t=>{
  const {c,dir,events}=fixture(t);
  await Promise.all([
    c.dispatch({action:'model-select',provider:'gpt',model:'gpt-b'}),
    c.dispatch({action:'model-select',provider:'claude',effort:'low'})
  ]);
  assert.deepEqual(c.models,{gpt:'gpt-b',claude:'claude-opus-5-5'});
  assert.deepEqual(c.efforts,{gpt:'',claude:'low'});
  const saved=new Controller(dir,()=>{});
  assert.deepEqual(saved.models,c.models);assert.deepEqual(saved.efforts,c.efforts);
  assert.equal(events.filter(e=>e.type==='modelSelected').length,2);
  assert.equal(events.filter(e=>e.type==='modelsSaved').length,0);
  await c.dispatch({action:'model-select',provider:'claude',model:'claude-sonnet-5-5'});
  assert.deepEqual(c.efforts,{gpt:'',claude:''});
});

test('invalid and busy quick choices leave both model settings intact',async t=>{
  const {c}=fixture(t),before={models:{...c.models},efforts:{...c.efforts}};
  for(const change of [
    {provider:'unknown',effort:'low'},
    {provider:'gpt'},
    {provider:'gpt',model:'unlisted'},
    {provider:'gpt',effort:'ultra'},
    {provider:'claude',model:'unknown'},
    {provider:'claude',effort:'ultra'}
  ])await assert.rejects(c.dispatch({action:'model-select',...change}));
  c.active={id:'running'};
  await assert.rejects(c.dispatch({action:'model-select',provider:'claude',effort:'low'}));
  assert.deepEqual({models:c.models,efforts:c.efforts},before);
});
