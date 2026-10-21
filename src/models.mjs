import { spawn } from 'node:child_process';
import { binary, cleanEnv } from './providers.mjs';

// Stable official aliases; credit-only models and arbitrary endpoints are not offered.
export const EFFORTS=['low','medium','high','xhigh','max','ultra'];
export const CLAUDE_MODELS=['opus','sonnet','haiku'].map(family=>({id:'claude-'+family+'-5-5',name:family[0].toUpperCase()+family.slice(1)+' 5.5',efforts:EFFORTS.filter(e=>e!=='ultra'),defaultEffort:'medium'}));
export function resolveClaudeModel(value){return !value?'claude-opus-5-5':['opus','sonnet','haiku'].includes(value)?'claude-'+value+'-5-5':value;}
export function validateEfforts(value={}){
  const result={gpt:value.gpt??'',claude:value.claude??''};
  for(const p of ['gpt','claude'])if(!['',...EFFORTS.filter(e=>p==='gpt'||e!=='ultra')].includes(result[p]))throw new Error('지원하지 않는 생각 강도입니다.');
  return result;
}
export function validateModels(value){
  if(!value||typeof value!=='object')throw new Error('모델 설정이 올바르지 않습니다.');
  const gpt=value.gpt??'',claude=value.claude??'';
  if(typeof gpt!=='string'||(gpt&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(gpt)))throw new Error('GPT 모델 이름이 올바르지 않습니다.');
  if(!['','opus','sonnet','haiku',...CLAUDE_MODELS.map(m=>m.id)].includes(claude))throw new Error('Claude 모델을 목록에서 선택해 주세요.');
  return {gpt,claude};
}
export function listGPTModels(cwd){
  return new Promise((resolve,reject)=>{
    const child=spawn(binary('gpt'),['app-server','--listen','stdio://','-c','forced_login_method="chatgpt"','-c','model_provider="openai"'],{cwd,env:cleanEnv(),stdio:['pipe','pipe','pipe']});
    let buffer='',done=false,models=[],requestId=2,pages=0;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve(models);};
    const timer=setTimeout(()=>finish(new Error('GPT 모델 목록을 불러오지 못했습니다. 계정 연결을 확인한 뒤 다시 시도하세요.')),20000);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    const request=cursor=>send({id:requestId,method:'model/list',params:{limit:100,...(cursor?{cursor}:{})}});
    child.stdout.setEncoding('utf8');child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',finish);child.on('exit',()=>{if(!done)finish(new Error('GPT 모델 목록 연결이 종료되었습니다.'));});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>1000000)return finish(new Error('모델 목록 크기가 너무 큽니다.'));
      const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){
        let event;try{event=JSON.parse(line);}catch{continue;}
        if(event.error)return finish(new Error(event.error.message||'모델 목록 요청 실패'));
        if(event.id===1){send({method:'initialized'});request();}
        else if(event.id===requestId){
          if(!Array.isArray(event.result?.data))return finish(new Error('모델 목록 형식을 확인할 수 없습니다.'));
          for(const m of event.result.data){
            const id=m.model||m.id;
            if(!m.hidden&&typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id)&&!models.some(x=>x.id===id))models.push({id,name:m.displayName||id,isDefault:!!m.isDefault,defaultEffort:m.defaultReasoningEffort,efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort).filter(e=>EFFORTS.includes(e))});
          }
          if(event.result.nextCursor){if(++pages>=10)return finish(new Error('모델 목록이 너무 많습니다.'));requestId++;request(event.result.nextCursor);}
          else finish();
        }
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'dual_lens_models',version:'1.4.0'}}});
  });
}
