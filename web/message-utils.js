(() => {
  const escapeHTML=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function safeURL(value){
    if(/[\u0000-\u0020\u007f]/.test(value))return null;
    try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
  }
  function link(label,url){
    const href=safeURL(url);
    return href?'<a href="'+escapeHTML(href)+'" rel="noreferrer noopener">'+escapeHTML(label)+'</a>':escapeHTML(label+' ('+url+')');
  }
  function inline(text){
    const pattern=/\x60([^\x60]+)\x60|(!?)\[([^\]\n]+)\]\(((?:[^\s()<>]|\([^()\s<>]*\))+)\)|https?:\/\/[^\s<>]+|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let result='',end=0;
    for(const m of text.matchAll(pattern)){
      result+=escapeHTML(text.slice(end,m.index));
      if(m[1]!==undefined)result+='<code>'+escapeHTML(m[1])+'</code>';
      else if(m[3]!==undefined)result+=link((m[2]?'이미지 링크: ':'')+m[3],m[4]);
      else if(m[5]!==undefined)result+='<strong>'+escapeHTML(m[5])+'</strong>';
      else if(m[6]!==undefined)result+='<em>'+escapeHTML(m[6])+'</em>';
      else{
        let url=m[0],suffix='';
        while(/[.,;:!?]$/.test(url)||(url.endsWith(')')&&(url.match(/\)/g)||[]).length>(url.match(/\(/g)||[]).length)){
          suffix=url.slice(-1)+suffix;url=url.slice(0,-1);
        }
        result+=link(url,url)+escapeHTML(suffix);
      }
      end=m.index+m[0].length;
    }
    return result+escapeHTML(text.slice(end));
  }
  function markdown(text){
    const output=[];let fence=null,code=[];
    for(const line of String(text).split('\n')){
      const marker=line.match(/^\s*(\x60{3,}|~{3,})/);
      if(fence){
        if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length){output.push('<pre><code>'+escapeHTML(code.join('\n'))+'</code></pre>');fence=null;code=[];}
        else code.push(line);
        continue;
      }
      if(marker){fence=marker[1];continue;}
      const heading=line.match(/^#{1,6}\s+(.*)$/),bullet=line.match(/^\s*[-*]\s+(.*)$/);
      if(heading)output.push('<h4>'+inline(heading[1])+'</h4>');
      else if(bullet)output.push('<p class="bullet">'+inline(bullet[1])+'</p>');
      else output.push('<p>'+(inline(line)||'<br>')+'</p>');
    }
    if(fence)output.push('<pre><code>'+escapeHTML(code.join('\n'))+'</code></pre>');
    return output.join('');
  }
  function shouldSend(event,composing=false,justComposed=false){
    return event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.repeat&&!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!composing&&!justComposed;
  }
  globalThis.DualLensUI={markdown,shouldSend,safeURL};
})();

