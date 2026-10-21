import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { answer, PROVIDERS } from './providers.mjs';
import { checkSubscription } from './quota.mjs';
import { prepareContext, conversationPrompt, latestAnswers } from './context.mjs';
import { scanFolder, validateFiles, selectReferences } from './library.mjs';
import { listGPTModels, validateModels, CLAUDE_MODELS, resolveClaudeModel, validateEfforts } from './models.mjs';

export const STORAGE_LIMIT = 20 * 1024 * 1024;
export function migrate(record) {
  if (Array.isArray(record.rounds)) return record;
  const rounds = [{id:randomUUID(), kind:'question', target:'both', question:record.question, createdAt:record.createdAt, answers:record.answers || {}}];
  if (Object.keys(record.feedback || {}).length) rounds.push({
    id:randomUUID(), kind:'feedback', target:'both', question:record.focus || '', createdAt:record.createdAt,
    answers:record.feedback, review:Object.fromEntries(PROVIDERS.map(p => [p,{question:record.question, text:record.answers[p]?.text || ''}]))
  });
  return {id:record.id, question:record.question, createdAt:record.createdAt, rounds, memory:{}, pinned:''};
}
export function readStore(file) {
  const saved=JSON.parse(readFileSync(file,'utf8'));
  if(Array.isArray(saved))return {history:saved.map(migrate),projects:[]};
  if(saved.version!==2 || !Array.isArray(saved.history) || !Array.isArray(saved.projects))throw new Error('저장된 데이터 형식을 읽지 못했습니다. 원본은 보존했습니다.');
  return {history:saved.history.map(migrate),projects:saved.projects};
}
function field(value, label, max, required=false) {
  const text=String(value??'').trim();
  if((required&&!text)||text.length>max)throw new Error(label+'은 '+(required?'1~':'최대 ')+max+'자로 입력해 주세요.');
  return text;
}
export class Controller {
  constructor(directory, emit, dependencies = {}) {
    this.directory = directory;
    this.cwd = join(directory, 'runtime');
    this.emit = emit;
    this.answer = dependencies.answer || answer;
    this.check = dependencies.check || checkSubscription;
    this.listModels=dependencies.listModels || listGPTModels;
    this.models={gpt:'',claude:''};
    this.efforts={gpt:'',claude:''};
    this.modelCatalog=[];
    this.layout={sidebarWidth:236,sidebarCollapsed:false};
    this.contextOptions = dependencies.contextOptions || {};
    this.history = [];
    this.projects = [];
    this.active = null;
    this.connections = {};
    this.storage = dependencies.defaultStorage || 'local';
    mkdirSync(this.cwd, {recursive:true, mode:0o700});
    this.file = join(directory, 'history.json');
    this.settingsFile = join(directory, 'settings.json');
    try {
      const saved=JSON.parse(readFileSync(this.settingsFile,'utf8'));
      if (['session','local'].includes(saved.storage)) this.storage=saved.storage;
      if(saved.models)this.models=validateModels(saved.models);
      if(saved.efforts)this.efforts=validateEfforts(saved.efforts);
      if(Number.isInteger(saved.layout?.sidebarWidth)&&saved.layout.sidebarWidth>=220&&saved.layout.sidebarWidth<=420&&typeof saved.layout.sidebarCollapsed==='boolean')this.layout=saved.layout;
    } catch {}
    this.models.claude=resolveClaudeModel(this.models.claude);
    if (this.storage === 'local' && existsSync(this.file)) {
      if (statSync(this.file).size > STORAGE_LIMIT) throw new Error('저장된 대화가 20MB를 넘습니다. 파일을 내보내고 정리해 주세요.');
      Object.assign(this,readStore(this.file));
      this.recover();
    }
  }
  saveSettings(models=this.models,efforts=this.efforts) {
    writeFileSync(this.settingsFile+'.tmp',JSON.stringify({storage:this.storage,models,efforts,layout:this.layout}),{mode:0o600});
    renameSync(this.settingsFile+'.tmp',this.settingsFile);
  }
  recover() {
    for(const record of this.history){
      record.title ||= record.question.slice(0,80);
      if(!this.projects.some(p=>p.id===record.projectId))record.projectId=null;
    }
    for (const record of this.history) for (const round of record.rounds) for (const result of Object.values(round.answers)) {
      if (['checking','running','summarizing'].includes(result.status)) Object.assign(result,{status:'error',error:'이전 실행이 종료되었습니다. 다시 시도해 주세요.',text:''});
    }
  }
  persist() {
    if (this.storage !== 'local') return;
    const data = JSON.stringify({version:2,history:this.history,projects:this.projects});
    if (Buffer.byteLength(data) > STORAGE_LIMIT) {
      this.storage = 'session';
      this.saveSettings();
      this.emit({type:'error',message:'20MB 저장 한도에 도달했습니다. 새 내용은 이번 실행에만 유지됩니다. 내보내기 후 대화를 정리해 주세요.'});
      return;
    }
    writeFileSync(this.file+'.tmp',data,{mode:0o600});
    renameSync(this.file+'.tmp',this.file);
  }
  publish() {
    this.emit({type:'state',history:this.history,projects:this.projects,active:this.active ? {id:this.active.id,roundId:this.active.roundId,stage:this.active.stage}:null,
      layout:this.layout,connections:this.connections,models:this.models,efforts:this.efforts,modelCatalog:this.modelCatalog,storage:this.storage,savedBytes:existsSync(this.file)?statSync(this.file).size:0,
      memoryBytes:Buffer.byteLength(JSON.stringify({history:this.history,projects:this.projects}))});
  }
  async dispatch(message) {
    switch (message.action) {
      case 'init': this.publish(); return;
      case 'layout-save': {
        const {sidebarWidth,sidebarCollapsed}=message.layout||{};
        if(!Number.isInteger(sidebarWidth)||sidebarWidth<220||sidebarWidth>420||typeof sidebarCollapsed!=='boolean')throw new Error('사이드바 설정이 올바르지 않습니다.');
        const previous=this.layout;this.layout={sidebarWidth,sidebarCollapsed};
        try{this.saveSettings();}catch(error){this.layout=previous;throw error;}
        this.publish();return;
      }
      case 'project-rename': {
        this.assertIdle();const project=this.project(message.id);
        project.name=field(message.name,'프로젝트 이름',80,true);project.updatedAt=new Date().toISOString();
        this.persist();this.publish();this.emit({type:'projectRenamed',id:project.id});return;
      }
      case 'models-list': {
        if(this.loadingModels)return;
        this.loadingModels=true;
        try {
          this.modelCatalog=await this.listModels(this.cwd);
          if(!this.models.gpt&&this.modelCatalog.length){this.models.gpt=(this.modelCatalog.find(m=>m.isDefault)||this.modelCatalog[0]).id;this.saveSettings();}
          this.publish();
          this.emit({type:'modelCatalog',gpt:this.modelCatalog,claude:CLAUDE_MODELS});
        } catch(error) { this.emit({type:'modelCatalog',gpt:this.modelCatalog,claude:CLAUDE_MODELS,error:error.message}); }
        finally {this.loadingModels=false;}
        return;
      }
      case 'model-select':
      case 'models-save': {
        this.assertIdle();
        const quick=message.action==='model-select',provider=message.provider;
        if(quick&&!PROVIDERS.includes(provider))throw new Error('알 수 없는 모델입니다.');
        if(quick&&!Object.hasOwn(message,'model')&&!Object.hasOwn(message,'effort'))throw new Error('변경할 설정이 없습니다.');
        const models=quick?{...this.models,...(Object.hasOwn(message,'model')?{[provider]:message.model}:{})}:message.models;
        const changes=quick?{...this.efforts,...(Object.hasOwn(message,'model')?{[provider]:''}:{}),...(Object.hasOwn(message,'effort')?{[provider]:message.effort}:{})}:message.efforts||this.efforts;
        const values=validateModels(models),efforts=validateEfforts(changes);
        values.claude=resolveClaudeModel(values.claude);
        if(!values.gpt)values.gpt=(this.modelCatalog.find(m=>m.isDefault)||this.modelCatalog[0])?.id||'';
        if(efforts.gpt&&!this.modelCatalog.find(m=>m.id===values.gpt)?.efforts?.includes(efforts.gpt))throw new Error('선택한 GPT 모델의 지원 강도를 확인할 수 없습니다. 목록을 새로고침해 주세요.');
        if(values.gpt&&values.gpt!==this.models.gpt&&!this.modelCatalog.some(m=>m.id===values.gpt))throw new Error('GPT 모델 목록을 새로고침한 뒤 선택해 주세요.');
        this.saveSettings(values,efforts);this.models=values;this.efforts=efforts;this.publish();this.emit(quick?{type:'modelSelected',provider}:{type:'modelsSaved'});return;
      }
      case 'storage': {
        this.assertIdle();
        if (!['local','session'].includes(message.mode)) throw new Error('알 수 없는 저장 방식입니다.');
        if (message.mode === 'local' && this.storage !== 'local' && existsSync(this.file)) {
          if (statSync(this.file).size > STORAGE_LIMIT) throw new Error('기존 기록이 20MB를 넘습니다. 먼저 정리해 주세요.');
          const saved = readStore(this.file);
          const ids = new Set(this.history.map(r=>r.id));
          const projectIds = new Set(this.projects.map(p=>p.id));
          this.projects.push(...saved.projects.filter(p=>!projectIds.has(p.id)));
          this.history.push(...saved.history.filter(r=>!ids.has(r.id)));
          this.recover();
        }
        this.storage = message.mode;
        this.saveSettings();
        if (this.storage === 'session') for (const path of [this.file,this.file+'.tmp']) if (existsSync(path)) unlinkSync(path);
        this.persist();this.publish();return;
      }
      case 'scan-folder': {
        this.assertIdle();this.scanning=true;
        try { this.emit({type:'folderFiles',requestId:message.requestId,...await scanFolder(message.path)}); }
        finally { this.scanning=false; }
        return;
      }
      case 'project-save': {
        this.assertIdle();
        const values={name:field(message.name,'프로젝트 이름',80,true),instructions:field(message.instructions,'지침',4000),context:field(message.context,'참고 문맥',16000)};
        let project=message.id?this.project(message.id):null;
        if(message.files!==undefined)values.files=validateFiles(message.files);
        if(project)Object.assign(project,values,{updatedAt:new Date().toISOString()});
        else {project={id:randomUUID(),...values,createdAt:new Date().toISOString()};this.projects.push(project);}
        this.persist();this.publish();this.emit({type:'projectSaved',id:project.id});return project.id;
      }
      case 'project-delete': {
        this.assertIdle();this.project(message.id);
        this.projects=this.projects.filter(p=>p.id!==message.id);
        for(const r of this.history)if(r.projectId===message.id)r.projectId=null;
        this.persist();this.publish();this.emit({type:'projectDeleted',id:message.id});return;
      }
      case 'chat-update': {
        this.assertIdle();const r=this.get(message.id);
        const patch={};
        if(message.title!==undefined)patch.title=field(message.title,'대화 이름',120,true);
        if(message.projectId!==undefined){if(message.projectId!==null)this.project(message.projectId);patch.projectId=message.projectId;}
        if(message.starred!==undefined){if(typeof message.starred!=='boolean')throw new Error('고정 설정이 올바르지 않습니다.');patch.starred=message.starred;}
        if(message.archived!==undefined){if(typeof message.archived!=='boolean')throw new Error('보관 설정이 올바르지 않습니다.');patch.archived=message.archived;}
        Object.assign(r,patch);this.persist();this.publish();this.emit({type:'chatUpdated',id:r.id});return;
      }
      case 'check': {
        this.assertIdle();this.checking=true;this.checkAbort=new AbortController();
        for (const p of PROVIDERS) this.connections[p]={status:'checking'};
        this.publish();
        try { await Promise.all(PROVIDERS.map(async p=>{
          try { this.connections[p]={status:'ready',...(await this.check(p,this.cwd,this.checkAbort.signal))}; }
          catch(error) { this.connections[p]={status:'error',error:error.message}; }
          this.publish();
        })); } finally {this.checking=false;this.publish();}
        return;
      }
      case 'ask': {
        this.assertIdle();
        const question=String(message.question || '').trim();
        if (!question || question.length>16000) throw new Error('질문은 1~16,000자로 입력해 주세요.');
        const target=message.target || 'both';
        if (!['both',...PROVIDERS].includes(target)) throw new Error('받는 모델을 선택해 주세요.');
        let record=message.id?this.get(message.id):null;
        if (!record) {
          if(message.projectId)this.project(message.projectId);
          record={id:randomUUID(),question,title:question.slice(0,80),projectId:message.projectId||null,starred:false,archived:false,createdAt:new Date().toISOString(),rounds:[],memory:{},pinned:''};
          this.history.unshift(record);
        }
        const round={id:randomUUID(),kind:'question',question,target,createdAt:new Date().toISOString(),answers:{}};
        record.rounds.push(round);
        this.start(record,round,target==='both'?PROVIDERS:[target]);return record.id;
      }
      case 'feedback': {
        this.assertIdle();
        const record=this.get(message.id);
        const review=latestAnswers(record);
        if (!PROVIDERS.every(p=>review[p]?.status==='done')) throw new Error('각 모델의 최신 답변이 완료되어야 합니다. 실패한 요청은 먼저 다시 시도해 주세요.');
        const round={id:randomUUID(),kind:'feedback',target:'both',question:String(message.focus||'').trim().slice(0,2000),createdAt:new Date().toISOString(),
          review:Object.fromEntries(PROVIDERS.map(p=>[p,{roundId:review[p].roundId,question:review[p].question,text:review[p].text}])),answers:{}};
        record.rounds.push(round);this.start(record,round,PROVIDERS);return;
      }
      case 'retry': {
        this.assertIdle();const record=this.get(message.id);
        const round=record.rounds.find(r=>r.id===message.roundId);
        if (!round || round!==record.rounds.at(-1) || !PROVIDERS.includes(message.provider) || round.answers[message.provider]?.status!=='error') throw new Error('마지막 요청의 실패한 답변만 다시 시도할 수 있습니다.');
        this.start(record,round,[message.provider]);return;
      }
      case 'pin': {
        this.assertIdle();const record=this.get(message.id);
        record.pinned=String(message.text||'').trim().slice(0,4000);this.persist();this.publish();return;
      }
      case 'cancel': this.active?.abort.abort();return;
      case 'delete': {
        this.assertIdle();this.history=this.history.filter(r=>r.id!==message.id);this.persist();this.publish();return;
      }
      default: throw new Error('지원하지 않는 요청입니다.');
    }
  }
  assertIdle() { if (this.active || this.checking || this.scanning) throw new Error('현재 작업이 끝나거나 중지된 후 다시 시도해 주세요.'); }
  get(id) { const r=this.history.find(r=>r.id===id);if(!r)throw new Error('대화를 찾을 수 없습니다.');return r; }
  project(id) { const p=this.projects.find(p=>p.id===id);if(!p)throw new Error('프로젝트를 찾을 수 없습니다.');return p; }
  start(record, round, targets) {
    record.updatedAt=new Date().toISOString();
    record.archived=false;
    const project=record.projectId?this.project(record.projectId):null;
    // Freeze the same retrieved evidence for both providers and retries of this round.
    if(round.references===undefined)round.references=selectReferences(project,round.kind==='feedback'?Object.values(round.review).map(r=>r.question).join('\n'):round.question);
    round.models ||= {...this.models};
    round.efforts ||= {gpt:this.efforts.gpt||this.modelCatalog.find(m=>m.id===round.models.gpt)?.defaultEffort||'',claude:this.efforts.claude||'medium'};
    const abort=new AbortController();
    this.active={id:record.id,roundId:round.id,stage:round.kind,abort};
    for(const p of targets)round.answers[p]={status:'checking',text:''};
    this.persist();this.publish();
    this.pending=Promise.all(targets.map(async provider=>{
      try {
        const connection=await this.check(provider,this.cwd,abort.signal);
        if(abort.signal.aborted)throw new Error('중지했습니다.');
        this.connections[provider]={status:'ready',...connection};
        const before=record.rounds.indexOf(round);
        const context=await prepareContext(record,provider,before,async prompt=>{
          round.answers[provider].status='summarizing';this.publish();
          await this.check(provider,this.cwd,abort.signal);
          const result=await this.answer(provider,prompt,{cwd:this.cwd,signal:abort.signal,model:round.models[provider],effort:round.efforts[provider]});
          return result.text;
        },{...this.contextOptions,signal:abort.signal});
        if(abort.signal.aborted)throw new Error('중지했습니다.');
        if (round.answers[provider].status==='summarizing') await this.check(provider,this.cwd,abort.signal);
        round.answers[provider].status='running';this.publish();
        const prompt=conversationPrompt(record,round,provider,context,project);
        const result=await this.answer(provider,prompt,{cwd:this.cwd,signal:abort.signal,model:round.models[provider],effort:round.efforts[provider],onText:text=>{
          if(!abort.signal.aborted){round.answers[provider].text=text;this.publish();}
        }});
        if(abort.signal.aborted)throw new Error('중지했습니다.');
        round.answers[provider]={status:'done',text:result.text,durationMs:result.durationMs,model:result.model,requestedModel:round.models[provider],requestedEffort:round.efforts[provider]};
      } catch(error) {round.answers[provider]={status:'error',text:'',error:error.message};}
      this.persist();this.publish();
    })).finally(()=>{this.active=null;this.persist();this.publish();});
  }
}
