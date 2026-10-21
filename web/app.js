const $=id=>document.getElementById(id);
let state={history:[],projects:[],active:null,connections:{},storage:'local',savedBytes:0};
let selected=null,target='both',awaiting=false,toastTimer,visibleRounds=20;
let answerView='gpt',composing=false,compositionEndedAt=-Infinity;
let scope='all',showArchive=false,editingProject=null,savingProject=false,searchTimer;
const drafts=new Map();
const expandedProjects=new Set();
let menuChatId=null,menuProjectId=null,menuOrigin=null,renamingChatId=null,renamingProjectId=null;
let deletingChatId=null;
let layout={sidebarWidth:236,sidebarCollapsed:false},resizeDrag=null;
let modelCatalog=[],modelsLoading=false,catalogRequested=false;
const quickPending=new Set();
const effortNames={low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};
const claudeNames={'claude-opus-5-5':'Opus 5.5','claude-sonnet-5-5':'Sonnet 5.5','claude-haiku-5-5':'Haiku 5.5'};
function modelName(p,id){return p==='claude'?(claudeNames[id]||id||'모델 확인 필요'):(modelCatalog.find(m=>m.id===id)?.name||id||'모델 목록 확인 중');}
let projectFiles=[],folderLoading=false,folderRequest=null,setup={},setupReceived=false;
const names={gpt:'GPT',claude:'Claude',both:'GPT + Claude'};
function send(message){
  if(window.webkit?.messageHandlers?.native)window.webkit.messageHandlers.native.postMessage(message);
  else if(window.testBridge)window.testBridge(message);
  else toast('데스크톱 앱에서 열어 주세요.');
}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function escapeHTML(text){return String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
const markdown=DualLensUI.markdown;
function renderAnswerView(){
  $('answer-views').hidden=!current();
  for(const button of document.querySelectorAll('[data-answer-view]')){
    const active=button.dataset.answerView===answerView;
    button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
  }
  $('timeline').setAttribute('aria-labelledby','view-'+answerView);
  for(const grid of document.querySelectorAll('.answer-grid')){
    grid.dataset.view=answerView;
    for(const article of grid.children)article.hidden=answerView!=='both'&&article.dataset.provider!==answerView;
  }
}
function current(){return state.history.find(r=>r.id===selected);}
function currentProject(){const r=current(),id=r?r.projectId:(scope==='all'?null:scope);return state.projects.find(p=>p.id===id);}
function draftKey(){return selected||'new:'+scope;}
function stashDraft(){drafts.set(draftKey(),{text:$('question').value,target});}
function restoreDraft(){const draft=drafts.get(draftKey());$('question').value=draft?.text||'';target=draft?.target||'both';}
function switchScope(id,archived=false){
  stashDraft();scope=id;showArchive=archived;selected=null;visibleRounds=20;$('search').value='';restoreDraft();render();
}
function matchingChats(){
  const query=$('search').value.trim().toLocaleLowerCase();
  return state.history.filter(r=>{
    if(!!r.archived!==showArchive)return false;
    if(!query)return true;
    return [r.title,r.question,...r.rounds.flatMap(t=>[t.question,...Object.values(t.answers).map(a=>a.text)])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  }).sort((a,b)=>Number(!!b.starred)-Number(!!a.starred)||new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));
}
function selectChat(id){
  const r=state.history.find(r=>r.id===id);if(!r)return;
  stashDraft();selected=id;scope=r.projectId||'all';visibleRounds=20;restoreDraft();render();
  $('scroll').scrollTop=$('scroll').scrollHeight;
}
function closeChatMenu(restoreFocus=false){
  $('chat-menu').hidden=true;$('project-menu').hidden=true;menuChatId=null;menuProjectId=null;
  if(restoreFocus&&menuOrigin?.isConnected)menuOrigin.focus();
  menuOrigin=null;
}
function openMenu(event,id,origin,kind){
  event.preventDefault();event.stopPropagation();
  if(busy())return;closeChatMenu();
  if(kind==='chat')menuChatId=id;else menuProjectId=id;
  menuOrigin=origin;
  const menu=$(kind+'-menu');menu.hidden=false;
  const rect=origin.getBoundingClientRect(),keyboard=event.type==='keydown';
  const x=keyboard?rect.left:event.clientX,y=keyboard?rect.bottom:event.clientY;
  menu.style.left=Math.max(8,Math.min(x,window.innerWidth-menu.offsetWidth-8))+'px';
  menu.style.top=Math.max(8,Math.min(y,window.innerHeight-menu.offsetHeight-8))+'px';
  $('rename-'+kind).focus();
}
function openChatMenu(event,r,origin){openMenu(event,r.id,origin,'chat');}
function chatRow(r,nested=false){
  const row=document.createElement('div');row.className='chat-row';
  const b=document.createElement('button');b.className='chat-open'+(r.id===selected?' active':'');
  b.dataset.chatId=r.id;b.title=r.title||r.question;
  const title=document.createElement('span');title.className='history-title';title.textContent=(r.starred?'★ ':'')+(r.title||r.question);
  const small=document.createElement('small');small.textContent=(!nested&&r.projectId?(state.projects.find(p=>p.id===r.projectId)?.name||'')+', ':'')+r.rounds.length+'개 요청, '+new Date(r.createdAt).toLocaleDateString('ko-KR',{month:'short',day:'numeric'});
  b.innerHTML='<svg class="chat-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M20 4H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4v4l5-4h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z"/></svg>';
  b.append(title,small);b.onclick=()=>selectChat(r.id);
  b.onkeydown=e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10'))openChatMenu(e,r,b);};
  row.oncontextmenu=e=>openChatMenu(e,r,b);
  const more=document.createElement('button');more.className='chat-more';more.textContent='⋯';more.setAttribute('aria-label',(r.title||r.question)+' 채팅 메뉴');more.setAttribute('aria-haspopup','menu');more.disabled=busy();
  more.onclick=()=>{openChatMenu({type:'keydown',preventDefault(){},stopPropagation(){}},r,more);};
  row.append(b,more);return row;
}
function openProject(project=null){
  editingProject=project?.id||null;
  projectFiles=(project?.files||[]).map(f=>({...f,selected:true}));folderRequest=null;folderLoading=false;
  $('folder-status').textContent='';renderFiles();
  $('project-dialog-title').textContent=project?'프로젝트 설정':'새 프로젝트';
  $('project-name').value=project?.name||'';$('project-instructions').value=project?.instructions||'';$('project-context').value=project?.context||'';
  $('delete-project').hidden=!project;$('project-dialog').showModal();$('project-name').focus();
}
function renderFiles(){
  $('project-files').replaceChildren();
  $('import-folder').disabled=folderLoading;$('save-project').disabled=folderLoading;
  if(!projectFiles.length){$('project-files').textContent='추가한 파일 없음';return;}
  for(const file of projectFiles){
    const row=document.createElement('label');row.className='file-row';
    const check=document.createElement('input');check.type='checkbox';check.checked=file.selected;check.disabled=folderLoading;
    check.onchange=()=>{file.selected=check.checked;};
    const name=document.createElement('span');name.textContent=file.path;
    const meta=document.createElement('small');meta.textContent=bytes(new TextEncoder().encode(file.text).length);
    row.append(check,name,meta);$('project-files').append(row);
  }
}
function renderSetup(){
  $('runtime-setup').hidden=!!setup.runtime;$('python-setup').hidden=setup.python!==false;
  $('runtime-detail').textContent=setup.nodeInstalled?'프로세스를 시작하지 못했습니다. Node.js 22 이상인지 확인하세요.':'Node.js 22 이상이 필요합니다.';
  for(const p of ['gpt','claude']){
    const c=state.connections[p];
    $('setup-'+p).textContent=!setup[p]?'설치 필요':c?.status==='ready'?c.plan+', 연결됨':c?.status==='checking'?'구독 확인 중':c?.status==='error'?'연결 확인 필요':'설치됨, 로그인 후 연결 확인';
    document.querySelector('[data-login="'+p+'"]').disabled=!setup[p]||busy();
  }
  $('check-connections').disabled=!setup.runtime||busy();
}
function openConnections(){
  if(!$('connection-dialog').open)$('connection-dialog').showModal();
  send({action:'setupStatus'});renderSetup();
}
function fillEfforts(p,value='',prefix=''){
  const model=modelCatalog.find(m=>m.id===$(prefix+'model-gpt').value);
  const supported=p==='gpt'?(model?.efforts||[]):['low','medium','high','xhigh','max'];
  const defaultLevel=p==='gpt'?model?.defaultEffort:'medium';
  const select=$(prefix+'effort-'+p);select.replaceChildren();
  for(const level of supported)select.append(new Option((effortNames[level]||level)+(level===defaultLevel?' (기본)':''),level===defaultLevel?'':level));
  if(!supported.includes(defaultLevel))select.prepend(new Option('기본값 확인 중',''));
  if(value&&!supported.includes(value))select.append(new Option((effortNames[value]||value)+', 지원 확인 필요',value));
  select.value=value===defaultLevel?'':value;select.disabled=p==='gpt'&&!supported.length;
}
function fillModels(values,efforts=state.efforts||{}){
  const select=$('model-gpt');select.replaceChildren();
  if(!modelCatalog.length)select.append(new Option('목록을 불러와 주세요',''));
  for(const model of modelCatalog)select.append(new Option(model.name,model.id));
  if(values.gpt&&!modelCatalog.some(m=>m.id===values.gpt))select.append(new Option(values.gpt+', 저장된 선택',values.gpt));
  select.value=values.gpt||modelCatalog.find(m=>m.isDefault)?.id||modelCatalog[0]?.id||'';
  $('model-claude').value=values.claude||'claude-opus-5-5';
  for(const p of ['gpt','claude'])fillEfforts(p,efforts[p]||'');
}
function renderQuickModels(locked){
  for(const p of ['gpt','claude']){
    const select=$('quick-model-'+p),effort=$('quick-effort-'+p);
    const choices=p==='gpt'?modelCatalog:Object.entries(claudeNames).map(([id,name])=>({id,name}));
    const id=state.models?.[p]||'';
    select.replaceChildren();
    for(const model of choices)select.append(new Option(model.name,model.id));
    if(!choices.some(m=>m.id===id))select.append(new Option(id||'모델 목록 확인 중',id));
    select.value=id;
    fillEfforts(p,state.efforts?.[p]||'','quick-');
    select.disabled=locked||quickPending.has(p)||!choices.length;
    effort.disabled ||= locked||quickPending.has(p);
  }
}
function selectQuickModel(p,change){
  if(busy()||quickPending.has(p))return;
  quickPending.add(p);
  $('quick-model-'+p).disabled=true;$('quick-effort-'+p).disabled=true;
  send({action:'model-select',provider:p,...change});
}
function refreshModels(){
  if(modelsLoading)return;
  modelsLoading=true;catalogRequested=true;$('refresh-models').disabled=true;$('model-list-status').textContent='GPT 모델 목록을 불러오는 중…';
  send({action:'models-list'});
}
function openModels(){
  fillModels(state.models||{});$('model-list-status').textContent='';
  $('models-dialog').showModal();refreshModels();
}
function openChat(){
  const r=current();if(!r)return;
  $('chat-name').value=r.title||r.question;$('chat-project').replaceChildren(new Option('프로젝트 없음',''));
  for(const p of state.projects)$('chat-project').append(new Option(p.name,p.id));
  $('chat-project').value=r.projectId||'';$('chat-starred').checked=!!r.starred;$('chat-archived').checked=!!r.archived;
  $('chat-dialog').showModal();
}
function busy(){return !!state.active||Object.values(state.connections).some(c=>c.status==='checking');}
function latest(record){
  const found={};for(const r of record?.rounds||[])for(const [p,a]of Object.entries(r.answers))found[p]=a;
  return found;
}
function bytes(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';}
window.receive=event=>{
  if(event.type==='error'){awaiting=false;savingProject=false;if(quickPending.size){quickPending.clear();render();}if(folderLoading){folderLoading=false;renderFiles();}toast(event.message);return;}
  if(event.type==='modelCatalog'){
    const values=$('models-dialog').open?{gpt:$('model-gpt').value,claude:$('model-claude').value}:state.models||{};
    const efforts=$('models-dialog').open?{gpt:$('effort-gpt').value,claude:$('effort-claude').value}:state.efforts||{};
    modelCatalog=event.gpt||[];modelsLoading=false;$('refresh-models').disabled=false;fillModels(values,efforts);render();
    $('model-list-status').textContent=event.error||('GPT 모델 '+modelCatalog.length+'개를 불러왔습니다.');return;
  }
  if(event.type==='modelSelected'){quickPending.delete(event.provider);render();return;}
  if(event.type==='modelsSaved'){$('models-dialog').close();toast('모델 설정을 저장했습니다. 다음 요청부터 적용됩니다.');return;}
  if(event.type==='setupStatus'){
    setup=event;renderSetup();
    if(!setupReceived&&(!setup.runtime||!setup.gpt||!setup.claude))openConnections();
    setupReceived=true;return;
  }
  if(event.type==='folderCancelled'){
    if(event.requestId===folderRequest){folderLoading=false;renderFiles();}return;
  }
  if(event.type==='folderFiles'){
    if(event.requestId!==folderRequest||!$('project-dialog').open)return;
    folderLoading=false;
    if(event.files.length)projectFiles=event.files.map(f=>({...f,selected:true}));
    const skipped=Object.entries(event.skipped).map(([why,count])=>why+' '+count+'개').join(', ');
    $('folder-status').textContent=event.name+', '+event.files.length+'개 읽음, '+bytes(event.bytes)+(event.files.length?', 저장하면 현재 파일 목록을 교체합니다.':', 기존 목록을 유지합니다.')+(skipped?'\n제외: '+skipped:'')+(event.stopped?'\n5,000개 탐색 한도에 도달했습니다. 하위 폴더를 선택해 주세요.':'');
    renderFiles();return;
  }
  if(event.type==='contextFile'){
    if(!$('project-dialog').open)return;
    const added=($('project-context').value?'\n\n':'')+'['+event.name+']\n'+event.text;
    if(($('project-context').value+added).length>16000){toast('참고 문맥은 최대 16,000자입니다. 필요한 부분만 붙여 넣어 주세요.');return;}
    $('project-context').value+=added;return;
  }
  if(event.type==='projectSaved'){
    if(savingProject){$('project-dialog').close();expandedProjects.add(event.id);if(!editingProject)switchScope(event.id);else render();savingProject=false;}
    return;
  }
  if(event.type==='projectDeleted'){
    $('delete-project-dialog').close();$('project-dialog').close();
    if(scope===event.id)switchScope('all');
    for(const id of event.deletedChatIds||[])drafts.delete(id);
    drafts.delete('new:'+event.id);expandedProjects.delete(event.id);editingProject=null;projectFiles=[];
    return;
  }
  if(event.type==='projectRenamed'){if(event.id===renamingProjectId){$('rename-dialog').close();renamingProjectId=null;}render();return;}
  if(event.type==='chatUpdated'){
    $('chat-dialog').close();if(event.id===renamingChatId){$('rename-dialog').close();renamingChatId=null;}const r=current();if(r)scope=r.projectId||'all';render();return;
  }
  if(event.type!=='state')return;
  state=event;
  if(state.layout&&!resizeDrag){layout={...state.layout};applyLayout();}
  modelCatalog=state.modelCatalog||modelCatalog;
  if(!catalogRequested)refreshModels();
  if(awaiting&&state.active){drafts.delete(draftKey());selected=state.active.id;awaiting=false;$('question').value='';showArchive=false;}
  if(selected&&!current())selected=null;
  render();
};
function card(round,provider){
  const result=round.answers[provider];
  const article=document.createElement('article');article.className='answer-card '+provider;article.dataset.provider=provider;
  if(!result){article.className='skipped';article.textContent=names[provider]+'에게 보내지 않음';return article;}
  const status={checking:'연결 확인 중',running:'답변 작성 중',summarizing:'이전 대화 요약 중',error:'요청 실패',done:''}[result.status];
  article.innerHTML='<div class="card-head"><img class="provider-logo" src="'+provider+'.svg" alt=""><strong>'+names[provider]+'</strong><small>'+status+'</small><button class="copy" aria-label="'+names[provider]+' 답변 복사" '+(result.status==='done'?'':'disabled')+'>복사</button></div><div class="answer-content"></div>';
  const body=article.querySelector('.answer-content');
  const requested=result.requestedModel??round.models?.[provider];
  const modelLabel=document.createElement('div');modelLabel.className='model-label';
  modelLabel.textContent=result.model?'사용 모델: '+result.model:requested?'요청 모델: '+requested:'기본 모델';
  const effort=result.requestedEffort??round.efforts?.[provider];
  modelLabel.textContent+=(effort?', 요청 강도 '+(effortNames[effort]||effort):', 생각 강도 기본');
  body.before(modelLabel);
  if(result.status==='error'){
    const p=document.createElement('p');p.className='card-error';p.textContent=result.error;body.append(p);
    if(current().rounds.at(-1).id===round.id){const b=document.createElement('button');b.textContent='다시 시도';b.className='retry';b.disabled=busy();b.onclick=()=>send({action:'retry',id:selected,roundId:round.id,provider});body.append(b);}
  }else if(result.text)body.innerHTML=markdown(result.text);
  else body.innerHTML='<div class="card-state"><span class="spinner"></span>'+status+'</div>';
  article.querySelector('.copy').onclick=()=>{send({action:'copy',text:result.text});toast('복사했습니다.');};
  return article;
}
function render(){
  const record=current(),locked=busy();
  const scroll=$('scroll'),oldTop=scroll.scrollTop,atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<70;
  $('history').replaceChildren();
  const chats=matchingChats();
  if(!chats.length){const p=document.createElement('p');p.className='empty-history';p.textContent='대화 없음';$('history').append(p);}
  for(const r of chats)$('history').append(chatRow(r));
  $('projects').replaceChildren();
  for(const project of state.projects){
    const section=document.createElement('div');section.className='project-section';
    const b=document.createElement('button');b.className='project-toggle';
    b.dataset.projectId=project.id;b.setAttribute('aria-expanded',String(expandedProjects.has(project.id)));
    const title=document.createElement('span');title.className='history-title';title.textContent=project.name;
    const arrow=document.createElement('span');arrow.className='project-arrow';arrow.textContent=expandedProjects.has(project.id)?'⌄':'›';arrow.setAttribute('aria-hidden','true');
    const projectChats=state.history.filter(r=>r.projectId===project.id&&!r.archived).sort((a,b)=>Number(!!b.starred)-Number(!!a.starred)||new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));
    const count=document.createElement('small');count.textContent=projectChats.length;
    b.append(arrow,title,count);
    b.onclick=()=>{if(expandedProjects.has(project.id))expandedProjects.delete(project.id);else expandedProjects.add(project.id);render();$('projects').querySelector('[data-project-id="'+project.id+'"]')?.focus();};
    const head=document.createElement('div');head.className='project-head';
    b.oncontextmenu=e=>openMenu(e,project.id,b,'project');
    b.onkeydown=e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10'))openMenu(e,project.id,b,'project');};
    const more=document.createElement('button');more.className='project-more';more.textContent='⋯';more.disabled=locked;more.setAttribute('aria-label',project.name+' 프로젝트 메뉴');more.setAttribute('aria-haspopup','menu');
    more.onclick=()=>openMenu({type:'keydown',preventDefault(){},stopPropagation(){}},project.id,more,'project');
    head.append(b,more);section.append(head);
    if(expandedProjects.has(project.id)){
      const children=document.createElement('div');children.className='project-children';children.setAttribute('aria-label',project.name+' 채팅');
      const actions=document.createElement('div');actions.className='project-tree-actions';
      const add=document.createElement('button');add.textContent='＋ 새 채팅';add.setAttribute('aria-label',project.name+' 새 채팅');add.disabled=locked;add.onclick=()=>{switchScope(project.id);$('question').focus();};
      const settings=document.createElement('button');settings.textContent='설정';settings.setAttribute('aria-label',project.name+' 프로젝트 설정');settings.disabled=locked;settings.onclick=()=>openProject(project);
      actions.append(add,settings);children.append(actions);
      if(!projectChats.length){const empty=document.createElement('p');empty.className='empty-history';empty.textContent='채팅 없음';children.append(empty);}
      for(const r of projectChats)children.append(chatRow(r,true));
      section.append(children);
    }
    $('projects').append(section);
  }
  if(busy()||(menuChatId&&!state.history.some(r=>r.id===menuChatId)))closeChatMenu();
  const project=currentProject();
  $('all-chats').className=!showArchive?'active':'';$('archive-view').className=showArchive?'active':'';
  $('new-project').disabled=locked;$('project-settings').hidden=!project;$('project-settings').disabled=locked;
  $('project-breadcrumb').textContent=project?.name||(showArchive?'보관함':'');
  $('chat-title').textContent=record?.title||record?.question||'새 대화';
  $('workspace').classList.toggle('home',!record);
  $('chat-title').hidden=!record;
  $('timeline').replaceChildren();
  if(record && record.rounds.length>visibleRounds){
    const earlier=document.createElement('button');earlier.textContent='이전 대화 더 보기';earlier.className='earlier';
    earlier.onclick=()=>{const height=scroll.scrollHeight;visibleRounds+=20;render();scroll.scrollTop+=scroll.scrollHeight-height;};
    $('timeline').append(earlier);
  }
  for(const round of (record?.rounds||[]).slice(-visibleRounds)){
    const section=document.createElement('section');section.className='round';
    const heading=document.createElement('div');
    if(round.kind==='feedback'){
      heading.className='feedback-label';heading.textContent='⇄ 피드백';
      const note=document.createElement('small');note.textContent='각 모델의 당시 최신 답변 검토';heading.append(note);
    }else{
      heading.className='user-message';
      const label=document.createElement('small');label.textContent='나 → '+names[round.target];
      const p=document.createElement('p');p.textContent=round.question;heading.append(label,p);
    }
    const grid=document.createElement('div');grid.className='answer-grid';for(const p of ['gpt','claude'])grid.append(card(round,p));
    section.append(heading);
    if(round.references){
      const details=document.createElement('details');details.className='reference-details';
      const summary=document.createElement('summary');
      const refs=round.references,used=new Set(refs.excerpts.map(e=>e.path)).size;
      summary.textContent='참고 자료 '+used+' / '+refs.totalFiles+'개 파일, '+(refs.partial?'일부 구간':'전체 텍스트')+(refs.matched?'':', 검색어 일치 없음');
      const pre=document.createElement('pre');pre.textContent=refs.excerpts.map(e=>'['+e.path+', 문자 '+(e.offset+1)+'–'+(e.offset+e.text.length)+']\n'+e.text).join('\n\n');
      details.append(summary,pre);section.append(details);
    }
    section.append(grid);$('timeline').append(section);
  }
  renderAnswerView();
  scroll.scrollTop=atBottom?scroll.scrollHeight:oldTop;
  const ready=Object.values(state.connections).length===2&&Object.values(state.connections).every(c=>c.status==='ready');
  $('check').textContent=locked&&!state.active?'연결 확인 중…':ready?'구독 연결됨':'연결 확인';
  $('check').disabled=locked;$('new').disabled=locked;$('new-chat').disabled=locked;$('save-rename').disabled=locked;
  $('model-settings').disabled=locked;$('save-models').disabled=locked;
  $('project-new-chat').hidden=!project;$('project-new-chat').disabled=locked;
  renderQuickModels(locked);
  for(const id of ['context','export','chat-settings']){$(id).hidden=!record;$(id).disabled=!record||locked;}
  $('feedback').hidden=!record;
  const last=latest(record);
  $('feedback').disabled=locked||!['gpt','claude'].every(p=>last[p]?.status==='done');
  $('ask').disabled=locked||!$('question').value.trim();$('question').disabled=locked;
  for(const b of document.querySelectorAll('[data-target]')){b.setAttribute('aria-pressed',String(b.dataset.target===target));b.disabled=locked;}
  $('question').placeholder='메시지 입력';
  $('storage').disabled=locked;
  $('storage-label').textContent=state.storage==='local'?'Mac에 보관':'이번 실행만 유지';
  $('storage-size').textContent=state.storage==='local'?bytes(state.savedBytes)+' / 20 MB':state.savedBytes?'이전 저장 파일 '+bytes(state.savedBytes):'앱 종료 시 대화 삭제';
  $('running').hidden=!state.active;
  const active=state.history.find(r=>r.id===state.active?.id)?.rounds.find(r=>r.id===state.active?.roundId);
  $('running-label').textContent=Object.values(active?.answers||{}).some(a=>a.status==='summarizing')?'이전 대화 요약 중':state.active?.stage==='feedback'?'피드백 작성 중':'답변 작성 중';
  $('connection-detail').textContent=['gpt','claude'].map(p=>{
    const c=state.connections[p];return names[p]+': '+(!c?'미확인':c.status==='ready'?c.plan:c.status==='error'?c.error:'확인 중…');
  }).join('\n\n');
  renderSetup();
  if(record)for(const p of ['gpt','claude']){
    const memory=record.memory?.[p];$('memory-'+p).textContent=memory?.text?memory.compactions+'회 요약\n\n'+memory.text:'아직 요약하지 않았습니다. 원문을 전달합니다.';
  }
}
$('question').oncompositionstart=()=>{composing=true;};
$('question').oncompositionend=e=>{composing=false;compositionEndedAt=e.timeStamp;};
$('question').onkeydown=e=>{
  if(!DualLensUI.shouldSend(e,composing,e.timeStamp-compositionEndedAt<60))return;
  e.preventDefault();
  if(!busy()&&!awaiting&&$('question').value.trim())$('ask').click();
};
for(const button of document.querySelectorAll('[data-answer-view]')){
  button.onclick=()=>{answerView=button.dataset.answerView;renderAnswerView();};
  button.onkeydown=e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();const views=['gpt','claude','both'],i=views.indexOf(answerView);
    answerView=views[e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3];
    renderAnswerView();$('view-'+answerView).focus();
  };
}
$('question').oninput=()=>{$('ask').disabled=busy()||!$('question').value.trim();};
$('ask').onclick=()=>{
  if($('ask').disabled||awaiting)return;if(target!=='both')answerView=target;renderAnswerView();awaiting=true;send({action:'ask',id:selected,projectId:scope==='all'?null:scope,question:$('question').value,target});
};
$('feedback').onclick=()=>{if(!$('feedback').disabled)send({action:'feedback',id:selected});};
for(const b of document.querySelectorAll('[data-target]'))b.onclick=()=>{target=b.dataset.target;render();$('question').focus();};
$('new').onclick=$('new-chat').onclick=()=>{switchScope('all');$('question').focus();};
$('rename-chat').onclick=()=>{
  const r=state.history.find(r=>r.id===menuChatId);if(!r||busy())return;
  renamingChatId=r.id;renamingProjectId=null;closeChatMenu();$('rename-dialog-title').textContent='채팅 이름 변경';$('rename-label').textContent='채팅 이름';$('rename-title').maxLength=120;$('rename-title').value=r.title||r.question;
  $('rename-dialog').showModal();$('rename-title').focus();$('rename-title').select();
};
$('delete-chat').onclick=()=>openDeleteChat(menuChatId);
$('manage-chat').onclick=()=>{const id=menuChatId;closeChatMenu();if(!busy()){selectChat(id);openChat();}};
$('rename-project').onclick=()=>{
  const p=state.projects.find(p=>p.id===menuProjectId);if(!p||busy())return;
  renamingProjectId=p.id;renamingChatId=null;closeChatMenu();$('rename-dialog-title').textContent='프로젝트 이름 변경';$('rename-label').textContent='프로젝트 이름';$('rename-title').maxLength=80;$('rename-title').value=p.name;
  $('rename-dialog').showModal();$('rename-title').focus();$('rename-title').select();
};
$('manage-project').onclick=()=>{const p=state.projects.find(p=>p.id===menuProjectId);closeChatMenu();if(p&&!busy())openProject(p);};
$('rename-form').onsubmit=e=>{
  e.preventDefault();const title=$('rename-title').value.trim();
  if(!title||busy())return;
  if(renamingProjectId)send({action:'project-rename',id:renamingProjectId,name:title});
  else if(renamingChatId)send({action:'chat-update',id:renamingChatId,title});
};
document.addEventListener('pointerdown',e=>{if(!$('chat-menu').contains(e.target)&&!$('project-menu').contains(e.target))closeChatMenu();});
document.addEventListener('scroll',e=>{if(!$('chat-menu').contains(e.target)&&!$('project-menu').contains(e.target))closeChatMenu();},true);
window.addEventListener('resize',()=>closeChatMenu());
for(const menu of [$('chat-menu'),$('project-menu')])menu.onkeydown=e=>{
  const buttons=Array.from(menu.querySelectorAll('button'));
  if(e.key==='Escape'){e.preventDefault();closeChatMenu(true);}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
    e.preventDefault();const i=buttons.indexOf(document.activeElement);
    buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
  }else if(e.key==='Tab')closeChatMenu();
};
$('project-new-chat').onclick=()=>{const project=currentProject();if(project){switchScope(project.id);$('question').focus();}};
$('new-project').onclick=()=>openProject();
$('project-settings').onclick=()=>openProject(currentProject());
$('all-chats').onclick=()=>{showArchive=false;render();};
$('archive-view').onclick=()=>{showArchive=true;render();};
$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(render,120);};
$('save-project').onclick=()=>{
  if(savingProject)return;
  if(!$('project-name').value.trim()){toast('프로젝트 이름을 입력해 주세요.');return;}
  savingProject=true;send({action:'project-save',id:editingProject,name:$('project-name').value,instructions:$('project-instructions').value,context:$('project-context').value,files:projectFiles.filter(f=>f.selected).map(({path,text})=>({path,text}))});
};
$('delete-project').onclick=()=>{
  const project=state.projects.find(p=>p.id===editingProject);if(!project||busy())return;
  const count=state.history.filter(r=>r.projectId===project.id).length;
  $('delete-project-summary').textContent='삭제할 프로젝트: '+project.name+' (채팅 '+count+'개)';
  $('delete-project-dialog').showModal();$('delete-project-dialog').querySelector('[data-close]').focus();
};
$('delete-project-confirm').onclick=()=>send({action:'project-delete',id:editingProject});
$('import-context').onclick=()=>send({action:'importContext'});
$('import-folder').onclick=()=>{
  folderRequest=String(Date.now());folderLoading=true;$('folder-status').textContent='폴더를 읽는 중…';renderFiles();
  send({action:'importFolder',requestId:folderRequest});
};
$('chat-settings').onclick=openChat;
$('save-chat').onclick=()=>{
  if(!$('chat-name').value.trim()){toast('대화 이름을 입력해 주세요.');return;}
  send({action:'chat-update',id:selected,title:$('chat-name').value,projectId:$('chat-project').value||null,starred:$('chat-starred').checked,archived:$('chat-archived').checked});
};
$('help').onclick=()=>$('help-dialog').showModal();
$('cancel').onclick=()=>send({action:'cancel'});
$('check').onclick=openConnections;
$('accounts').onclick=openConnections;
$('model-settings').onclick=openModels;
$('refresh-models').onclick=refreshModels;
$('save-models').onclick=()=>send({action:'models-save',models:{gpt:$('model-gpt').value,claude:$('model-claude').value},efforts:{gpt:$('effort-gpt').value,claude:$('effort-claude').value}});
for(const p of ['gpt','claude']){
  $('quick-model-'+p).onchange=()=>selectQuickModel(p,{model:$('quick-model-'+p).value});
  $('quick-effort-'+p).onchange=()=>selectQuickModel(p,{effort:$('quick-effort-'+p).value});
  $('model-'+p).onchange=()=>fillEfforts(p,'');
}
$('check-connections').onclick=()=>send({action:'check'});
$('retry-runtime').onclick=()=>send({action:'retryRuntime'});
for(const b of document.querySelectorAll('[data-guide]'))b.onclick=()=>send({action:'setupGuide',tool:b.dataset.guide});
for(const b of document.querySelectorAll('[data-login]'))b.onclick=()=>{send({action:'login',provider:b.dataset.login});toast('터미널과 브라우저에서 로그인한 뒤 연결 확인을 누르세요.');};
$('context').onclick=()=>{$('pinned').value=current()?.pinned||'';$('context-dialog').showModal();};
$('save-pin').onclick=()=>{send({action:'pin',id:selected,text:$('pinned').value});$('context-dialog').close();};
$('storage').onclick=()=>{
  for(const r of document.querySelectorAll('[name="storage-mode"]'))r.checked=r.value===state.storage;
  $('saved-detail').textContent='저장 파일: '+bytes(state.savedBytes)+'. 이번 실행만 유지를 적용하면 기존 앱 저장 파일도 삭제됩니다.';
  $('storage-dialog').showModal();
};
$('save-storage').onclick=()=>{const mode=document.querySelector('[name="storage-mode"]:checked').value;send({action:'storage',mode});$('storage-dialog').close();};
function openDeleteChat(id){
  const r=state.history.find(r=>r.id===id);if(!r||busy())return;
  deletingChatId=r.id;closeChatMenu();$('chat-dialog').close();
  $('delete-chat-title').textContent='삭제할 채팅: '+(r.title||r.question);
  $('delete-dialog').showModal();$('delete-dialog').querySelector('[data-close]').focus();
}
$('delete').onclick=()=>openDeleteChat(selected);
$('delete-dialog').onclose=()=>{deletingChatId=null;};
$('delete-confirm').onclick=()=>{
  const id=deletingChatId;if(!id||busy())return;
  if(!state.history.some(r=>r.id===id)){$('delete-dialog').close();return;}
  send({action:'delete',id});drafts.delete(id);$('delete-dialog').close();
};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
$('export').onclick=()=>{
  const r=current();if(!r)return;
  let text='# '+(r.title||r.question)+'\n';
  for(const round of r.rounds){
    text+='\n## '+(round.kind==='feedback'?'피드백':'나 → '+names[round.target])+ '\n\n'+round.question+'\n';
    for(const p of ['gpt','claude'])if(round.answers[p])text+='\n### '+names[p]+'\n\n'+(round.answers[p].text||round.answers[p].error||'')+'\n';
  }
  send({action:'export',text});
};
document.addEventListener('keydown',e=>{
  if(e.target!==$('question')&&e.metaKey&&DualLensUI.shouldSend(e)&&!document.querySelector('dialog[open]')){e.preventDefault();$('ask').click();}
  if(e.metaKey&&e.key.toLowerCase()==='n'&&!document.querySelector('dialog[open]')){e.preventDefault();$('new').click();}
});
function maxSidebarWidth(){return Math.max(220,Math.min(420,window.innerWidth-620));}
function applyLayout(){
  const width=Math.min(layout.sidebarWidth,maxSidebarWidth());
  document.documentElement.style.setProperty('--sidebar-width',width+'px');
  document.body.classList.toggle('sidebar-collapsed',layout.sidebarCollapsed);
  $('sidebar-open').hidden=!layout.sidebarCollapsed;
  $('sidebar-resize').setAttribute('aria-valuenow',String(width));
  $('sidebar-resize').setAttribute('aria-valuemax',String(maxSidebarWidth()));
}
function saveLayout(){send({action:'layout-save',layout:{...layout}});}
function toggleSidebar(){
  closeChatMenu();layout.sidebarCollapsed=!layout.sidebarCollapsed;applyLayout();saveLayout();
  $(layout.sidebarCollapsed?'sidebar-open':'sidebar-toggle').focus();
}
$('sidebar-toggle').onclick=$('sidebar-open').onclick=toggleSidebar;
const resizeHandle=$('sidebar-resize');
resizeHandle.onpointerdown=e=>{
  if(e.button!==0)return;
  e.preventDefault();closeChatMenu();resizeHandle.focus();resizeDrag={id:e.pointerId,start:layout.sidebarWidth};
  resizeHandle.setPointerCapture(e.pointerId);document.body.classList.add('resizing-sidebar');
};
resizeHandle.onpointermove=e=>{
  if(resizeDrag?.id!==e.pointerId)return;
  layout.sidebarWidth=Math.round(Math.max(220,Math.min(maxSidebarWidth(),e.clientX)));applyLayout();
};
function finishResize(e,cancel=false){
  if(resizeDrag?.id!==e.pointerId)return;
  if(cancel)layout.sidebarWidth=resizeDrag.start;
  resizeDrag=null;document.body.classList.remove('resizing-sidebar');
  if(resizeHandle.hasPointerCapture(e.pointerId))resizeHandle.releasePointerCapture(e.pointerId);
  applyLayout();if(!cancel)saveLayout();
}
resizeHandle.onpointerup=e=>finishResize(e);
resizeHandle.onpointercancel=e=>finishResize(e,true);
resizeHandle.onlostpointercapture=e=>finishResize(e,true);
resizeHandle.onkeydown=e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();
  const width=Math.min(layout.sidebarWidth,maxSidebarWidth());
  layout.sidebarWidth=e.key==='Home'?220:e.key==='End'?maxSidebarWidth():Math.max(220,Math.min(maxSidebarWidth(),width+(e.key==='ArrowRight'?16:-16)));
  applyLayout();saveLayout();
};
window.addEventListener('resize',applyLayout);
applyLayout();render();send({action:'ready'});
