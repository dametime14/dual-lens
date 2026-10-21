import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanFolder, selectReferences, validateFiles, LIBRARY_LIMIT } from '../src/library.mjs';
import { Controller } from '../src/controller.mjs';

function directory(t){const dir=mkdtempSync(join(tmpdir(),'dual-library-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('folder scanner reads nested UTF8 files but excludes hidden files, dependencies, links, binaries and oversized text',async t=>{
  const dir=directory(t);mkdirSync(join(dir,'docs'));mkdirSync(join(dir,'node_modules'));
  writeFileSync(join(dir,'docs','계획.md'),'예산 37,000원');
  writeFileSync(join(dir,'.env'),'PRIVATE');writeFileSync(join(dir,'credentials.json'),'PRIVATE');
  writeFileSync(join(dir,'node_modules','index.js'),'PRIVATE');
  writeFileSync(join(dir,'large.txt'),'x'.repeat(100001));
  writeFileSync(join(dir,'binary.txt'),Buffer.from([0,255,250]));
  writeFileSync(join(dir,'photo.png'),'image');
  symlinkSync(join(dir,'docs'),join(dir,'linked'));
  const result=await scanFolder(dir);
  assert.deepEqual(result.files,[{path:'docs/계획.md',text:'예산 37,000원'}]);
  assert.ok(result.skipped['심볼릭 링크']);assert.ok(result.skipped['파일 크기 한도']);
  assert.ok(result.skipped['지원하지 않는 형식']);
});
test('scan caps are explicit and never silently truncate an accepted file',async t=>{
  const dir=directory(t);
  for(let i=0;i<15;i++)writeFileSync(join(dir,i+'.txt'),'가'.repeat(30000));
  const result=await scanFolder(dir);
  assert.ok(result.bytes<=LIBRARY_LIMIT);assert.ok(result.skipped['프로젝트 자료 1MB 한도']);
  assert.ok(result.files.every(f=>f.text==='가'.repeat(30000)));
  assert.throws(()=>validateFiles([{path:'../secret',text:'x'}]));
  assert.throws(()=>validateFiles([{path:'x',text:'x'},{path:'x',text:'y'}]));
  assert.throws(()=>validateFiles([{path:'x',text:'가'.repeat(40000)}]));
});
test('retrieval finds a relevant passage beyond the initial context and marks partial evidence',()=>{
  const files=[{path:'unrelated.md',text:'무관한 이야기 '.repeat(2500)},{path:'budget.md',text:'서문 '.repeat(6000)+'\n달빛 프로젝트의 확정 예산은 37,000원입니다.'}];
  const refs=selectReferences({name:'연구',files},'달빛 프로젝트의 예산은?');
  assert.ok(refs.partial);assert.ok(refs.matched);assert.ok(JSON.stringify(refs.excerpts).length<=16000);
  assert.match(refs.excerpts[0].text,/37,000/);
  assert.equal(selectReferences(null,'x'),null);
  assert.equal(selectReferences({files:[{path:'a.txt',text:'small'}]},'no match').partial,false);
});
test('folder scanning does not call models; checked files persist and reach only their project with identical evidence for both',async t=>{
  const dir=directory(t),calls=[],events=[];
  const c=new Controller(join(dir,'store'),e=>events.push(e),{check:async()=>({}),answer:async(p,prompt)=>{calls.push({p,prompt});return {text:'answer'};}});
  const folder=join(dir,'input');mkdirSync(folder);writeFileSync(join(folder,'budget.md'),'확정 예산 37,000원');
  await c.dispatch({action:'scan-folder',path:folder,requestId:'one'});
  assert.equal(calls.length,0);const scanned=events.find(e=>e.type==='folderFiles');assert.equal(scanned.requestId,'one');
  const id=await c.dispatch({action:'project-save',name:'Files',files:scanned.files});
  await c.dispatch({action:'ask',projectId:id,question:'예산은?'});await c.pending;
  assert.match(calls[0].prompt,/37,000/);assert.equal(calls[0].prompt,calls[1].prompt);
  assert.equal(new Controller(join(dir,'store'),()=>{}).projects[0].files[0].text,'확정 예산 37,000원');
  await c.dispatch({action:'project-save',id,name:'Renamed'});assert.equal(c.projects[0].files.length,1);
  await c.dispatch({action:'ask',question:'unrelated',target:'gpt'});await c.pending;
  assert.doesNotMatch(calls.at(-1).prompt,/37,000/);
  await c.dispatch({action:'project-save',id,name:'Renamed',files:[]});assert.equal(c.projects[0].files.length,0);
});
test('retry uses the evidence actually sent even after the project files change',async t=>{
  const dir=directory(t),calls=[];let failed=true;
  const c=new Controller(dir,()=>{},{check:async()=>({}),answer:async(p,prompt)=>{
    calls.push(prompt);if(p==='gpt'&&failed)throw new Error('temporary');return {text:'done'};
  }});
  const projectId=await c.dispatch({action:'project-save',name:'P',files:[{path:'a.txt',text:'ORIGINAL_EVIDENCE'}]});
  const id=await c.dispatch({action:'ask',projectId,question:'q'});await c.pending;
  await c.dispatch({action:'project-save',id:projectId,name:'P',files:[{path:'a.txt',text:'CHANGED_EVIDENCE'}]});
  failed=false;await c.dispatch({action:'retry',id,roundId:c.history[0].rounds[0].id,provider:'gpt'});await c.pending;
  assert.match(calls.at(-1),/ORIGINAL_EVIDENCE/);assert.doesNotMatch(calls.at(-1),/CHANGED_EVIDENCE/);
});
