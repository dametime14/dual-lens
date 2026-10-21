import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {commandFor,extractWebEvidence,resolveCitations,extractResult} from '../src/providers.mjs';
import {Controller} from '../src/controller.mjs';
import '../web/message-utils.js';

test('search grants only web tools and preserves subscription and execution restrictions',()=>{
  const gpt=commandFor('gpt','','',true),claude=commandFor('claude','','',true);
  assert.ok(gpt.includes('web_search="live"'));
  for(const value of ['forced_login_method="chatgpt"','features.shell_tool=false','features.remote_plugin=false','approval_policy="never"','read-only'])assert.ok(gpt.includes(value));
  assert.equal(claude[claude.indexOf('--tools')+1],'WebSearch,WebFetch');
  assert.equal(claude[claude.indexOf('--allowedTools')+1],'WebSearch,WebFetch');
  for(const value of ['--safe-mode','--restricted','dontAsk','{"forceLoginMethod":"claudeai"}','{"mcpServers":{}}'])assert.ok(claude.includes(value));
  assert.ok(commandFor('gpt').includes('web_search="disabled"'));
  const noSearch=commandFor('claude');assert.equal(noSearch[noSearch.indexOf('--tools')+1],'');
});
test('GPT evidence comes from completed search events, not model claims or URLs',()=>{
  const result=extractWebEvidence('gpt',[
    {type:'item.completed',item:{type:'agent_message',text:'I searched https://invented.example'}},
    {type:'item.started',item:{type:'web_search',id:'a'}},
    {type:'item.completed',item:{type:'web_search',id:'a',results:[{url:'https://example.org/paper',title:'Paper',ref_id:'turn0search0'},{url:'javascript:alert(1)'},{url:'file:///tmp/private'}]}},
    {type:'item.completed',item:{type:'web_search',id:'b',results:[{url:'https://example.org/paper',title:'Paper',ref_id:'turn1search0'}]}}
  ]);
  assert.equal(result.status,'searched');assert.equal(result.calls,2);assert.equal(result.sources.length,1);
  assert.deepEqual(result.sources[0].refs,['turn0search0','turn1search0']);
  assert.equal(resolveCitations('Claim \uE200cite\uE202turn0search0\uE201',result.sources),'Claim [Paper](https://example.org/paper)');
  assert.match(resolveCitations('\uE200cite\uE202unknown\uE201',result.sources),/확인 불가/);
  assert.equal(extractWebEvidence('gpt',[{type:'item.completed',item:{type:'agent_message',text:'https://example.org'}}]).status,'not_used');
});
test('Claude results must match web tool calls; failed and unknown results are honest',()=>{
  const call=(id,name='WebSearch')=>({type:'assistant',message:{content:[{type:'tool_use',id,name}]}});
  const result=(id,is_error=false)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error}]},tool_use_result:{results:[{content:[{title:'Paper',url:'https://example.org/paper'}]}]}});
  assert.equal(extractWebEvidence('claude',[result('unknown')]).status,'not_used');
  assert.equal(extractWebEvidence('claude',[call('a','Read'),result('a')]).sources.length,0);
  assert.equal(extractWebEvidence('claude',[call('a'),result('a',true)]).status,'failed');
  assert.equal(extractWebEvidence('claude',[call('a')]).status,'failed');
  assert.equal(extractWebEvidence('claude',[call('a'),{type:'user',message:{content:[{type:'tool_result',tool_use_id:'a'}]}}]).status,'no_sources');
  const web=extractWebEvidence('claude',[call('a'),result('a'),call('b'),result('b',true)]);
  assert.equal(web.status,'searched');assert.equal(web.failed,1);assert.equal(web.sources.length,1);
  assert.match(DualLensUI.searchLabel(web),/일부 검색 실패/);
  assert.match(DualLensUI.answerText({text:'Answer',web}),/https:\/\/example.org\/paper/);
});
test('response model excludes models used only by search helpers',()=>{
  const result=extractResult('claude',[
    {type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'text',text:'Answer'}]}},
    {type:'result',subtype:'success',result:'Answer',modelUsage:{'claude-opus-5-5':{},'claude-haiku-5-5':{}}}
  ]);
  assert.equal(result.model,'claude-opus-5-5');
  const web=extractWebEvidence('claude',[
    {type:'assistant',message:{content:[{type:'tool_use',id:'fetch',name:'WebFetch'}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'fetch'}]},tool_use_result:{url:'https://example.org',code:403}}
  ]);
  assert.equal(web.status,'failed');assert.equal(web.sources.length,0);
});
test('search source storage stays bounded',()=>{
  const sources=Array.from({length:100},(_,i)=>({url:'https://example.org/'+i,title:'x'.repeat(1000)}));
  const web=extractWebEvidence('gpt',[{type:'item.completed',item:{id:'a',type:'web_search',results:sources}}]);
  assert.equal(web.sources.length,40);assert.equal(web.sources[0].title.length,300);
});
test('questions and explicit feedback search, compaction does not; evidence persists',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dual-search-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[],web={status:'searched',calls:1,failed:0,sources:[{url:'https://example.org/paper',title:'Paper'}]};
  const c=new Controller(dir,()=>{},{contextOptions:{budget:800,keep:1},check:async()=>({authenticated:true}),answer:async(p,prompt,options)=>{
    calls.push({p,prompt,options});return {text:options.webSearch?'Answer '.repeat(200):'Short summary',durationMs:1,...(options.webSearch?{web}:{})};
  }});
  const id=await c.dispatch({action:'ask',question:'Public fact'});await c.pending;
  assert.ok(calls.every(c=>c.options.webSearch));
  await c.dispatch({action:'ask',id,question:'Follow up'});await c.pending;
  assert.ok(calls.some(c=>!c.options.webSearch));
  const count=calls.length;
  await c.dispatch({action:'feedback',id});await c.pending;
  assert.equal(calls.slice(count).filter(c=>c.options.webSearch).length,2);
  assert.ok(calls.slice(count).filter(c=>c.options.webSearch).every(c=>c.prompt.includes('반드시 웹 검색')));
  assert.deepEqual(new Controller(dir,()=>{}).history[0].rounds[0].answers.gpt.web,web);
});
