import { open, opendir, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const FILE_LIMIT=100_000, LIBRARY_LIMIT=1_000_000, FILE_COUNT=200, REFERENCE_BUDGET=16000;
const extensions=new Set(['.txt','.md','.markdown','.csv','.tsv','.json','.jsonl','.yaml','.yml','.toml','.xml','.html','.css','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.r','.sql','.swift','.go','.rs','.java','.c','.h','.cpp','.sh','.tex','.bib']);
const ignored=new Set(['node_modules','vendor','build','dist','target','__pycache__','venv','env','coverage']);
const exec=promisify(execFile);
const size=value=>Buffer.byteLength(JSON.stringify(value));
const sensitive=name=>/(^|[._-])(credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519)([._-]|$)/i.test(name);

// Read a bounded snapshot, never traverse links or execute content from the folder.
export async function scanFolder(root,{pdfTool=join(import.meta.dirname,'../extract-pdf')}={}) {
  if(typeof root!=='string'||!(await lstat(root)).isDirectory())throw new Error('폴더를 선택해 주세요.');
  root=await realpath(root);
  const files=[],skipped={},sample=[];let used=2,visited=0,stopped=false;
  const skip=(path,reason)=>{skipped[reason]=(skipped[reason]||0)+1;if(sample.length<30)sample.push({path,reason});};
  async function walk(dir,prefix='',depth=0){
    const entries=await opendir(dir);
    for await(const entry of entries){
      if(++visited>5000){stopped=true;break;}
      const relative=prefix+entry.name,path=join(dir,entry.name);
      if(entry.name.startsWith('.')||ignored.has(entry.name)||sensitive(entry.name)){skip(relative,'숨김, 의존성, 인증 관련 항목');continue;}
      try{
        const stat=await lstat(path);
        if(stat.isSymbolicLink()){skip(relative,'심볼릭 링크');continue;}
        if(stat.isDirectory()){
          if(depth>=12){skip(relative,'폴더 깊이 제한');continue;}
          await walk(path,relative+'/',depth+1);if(stopped)break;continue;
        }
        if(!stat.isFile()){skip(relative,'일반 파일 아님');continue;}
        const ext=extname(entry.name).toLowerCase();
        if(!extensions.has(ext)&&ext!=='.pdf'){skip(relative,'지원하지 않는 형식');continue;}
        if(files.length>=FILE_COUNT){skip(relative,'200개 파일 한도');continue;}
        if(stat.size>(ext==='.pdf'?10_000_000:FILE_LIMIT)){skip(relative,'파일 크기 한도');continue;}
        let text;
        if(ext==='.pdf'){
          const result=await exec(pdfTool,[path],{timeout:10000,maxBuffer:FILE_LIMIT+4096});
          text=result.stdout;
        }else{
          const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
          try{
            if(!(await handle.stat()).isFile())throw new Error('일반 파일 아님');
            const buffer=Buffer.alloc(FILE_LIMIT+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
            if(bytesRead>FILE_LIMIT){skip(relative,'파일 크기 한도');continue;}
            text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead));
          }finally{await handle.close();}
        }
        if(!text.trim()||text.includes('\0')){skip(relative,'빈 파일, 텍스트 없음');continue;}
        if(Buffer.byteLength(text)>FILE_LIMIT){skip(relative,'추출 텍스트 100KB 초과');continue;}
        const file={path:relative,text};
        if(used+size(file)+1>LIBRARY_LIMIT){skip(relative,'프로젝트 자료 1MB 한도');continue;}
        used+=size(file)+1;files.push(file);
      }catch{skip(relative,'읽기 실패, PDF 추출 불가');}
    }
  }
  await walk(root);
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return {name:basename(root),files,skipped,sample,stopped,bytes:size(files)};
}

export function validateFiles(files){
  if(!Array.isArray(files)||files.length>FILE_COUNT)throw new Error('프로젝트 자료는 최대 200개입니다.');
  const seen=new Set();
  const clean=files.map(file=>{
    if(!file||typeof file.path!=='string'||!file.path||file.path.length>1000||file.path.startsWith('/')||file.path.split('/').some(p=>p==='..'||p==='.')||/[\x00-\x1f]/.test(file.path)||seen.has(file.path)||typeof file.text!=='string'||Buffer.byteLength(file.text)>FILE_LIMIT)throw new Error('프로젝트 파일 형식 또는 크기가 올바르지 않습니다.');
    seen.add(file.path);return {path:file.path,text:file.text};
  });
  if(size(clean)>LIBRARY_LIMIT)throw new Error('프로젝트 자료는 최대 1MB입니다.');
  return clean;
}

function terms(text){
  const words=String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)||[];
  const result=new Set(words);
  // Korean particles often attach to nouns. Bigrams give a modest lexical fallback.
  for(const word of words)if(/[가-힣]/.test(word))for(let i=0;i<word.length-1;i++)result.add(word.slice(i,i+2));
  return [...result].slice(0,300);
}
export function selectReferences(project,query,budget=REFERENCE_BUDGET){
  const files=project?.files||[];
  if(!files.length)return null;
  const chunks=[],keywords=terms(query);
  for(const file of files)for(let offset=0;offset<file.text.length;offset+=1800){
    const text=file.text.slice(offset,offset+1800),body=text.toLowerCase(),path=file.path.toLowerCase();
    const score=keywords.reduce((sum,t)=>sum+(path.includes(t)?6:0)+(body.includes(t)?1:0),0);
    chunks.push({path:file.path,offset,text,score});
  }
  chunks.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)||a.offset-b.offset);
  const excerpts=[];let used=2;
  for(const {score,...chunk} of chunks){
    const length=JSON.stringify(chunk).length+1;
    if(used+length>budget)continue;
    used+=length;excerpts.push(chunk);
  }
  return {projectName:project.name,totalFiles:files.length,totalChunks:chunks.length,partial:excerpts.length<chunks.length,matched:chunks.some(c=>c.score>0),excerpts};
}
