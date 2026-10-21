import test from 'node:test';
import assert from 'node:assert/strict';
import '../web/message-utils.js';
const {markdown,shouldSend,safeURL}=globalThis.DualLensUI;

test('Enter sends, while Shift+Enter and IME confirmation never send',()=>{
  assert.equal(shouldSend({key:'Enter'}),true);
  assert.equal(shouldSend({key:'Enter',metaKey:true}),true);
  for(const extra of [{shiftKey:true},{altKey:true},{ctrlKey:true},{repeat:true},{isComposing:true},{keyCode:229},{defaultPrevented:true}]){
    assert.equal(shouldSend({key:'Enter',...extra}),false);
  }
  assert.equal(shouldSend({key:'Enter'},true),false);
  assert.equal(shouldSend({key:'Enter'},false,true),false);
  assert.equal(shouldSend({key:'a'}),false);
});
test('Markdown and plain web links are clickable, with encoded attributes and balanced parentheses',()=>{
  assert.match(markdown('[논문](https://example.org/paper?a=1&b=2)'),/href="https:\/\/example.org\/paper\?a=1&amp;b=2"/);
  assert.match(markdown('https://example.org/a_(b).'),/>https:\/\/example.org\/a_\(b\)<\/a>\./);
  assert.match(markdown('[논문](https://example.org/a_(b))'),/href="https:\/\/example.org\/a_\(b\)"/);
});
test('Untrusted responses cannot create executable markup or load remote images',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','https://example.org\n/test'])assert.equal(safeURL(url),null);
  assert.doesNotMatch(markdown('[열기](javascript:alert(1))'),/<a /);
  assert.doesNotMatch(markdown('<img src=x onerror=alert(1)>'),/<img/);
  assert.match(markdown('![그림](https://example.org/image.png)'),/이미지 링크: 그림/);
  assert.doesNotMatch(markdown('![그림](https://example.org/image.png)'),/<img/);
});
test('blank prose lines do not create empty paragraphs; code spacing remains literal',()=>{
  assert.equal(markdown('First\n\n\nSecond'),'<p>First</p><p>Second</p>');
  assert.equal(markdown('~~~\nFirst\n\nSecond\n~~~'),'<pre><code>First\n\nSecond</code></pre>');
});
test('Code remains literal and never becomes a link or HTML',()=>{
  assert.equal(markdown('\x60https://example.org\x60'),'<p><code>https://example.org</code></p>');
  const code=markdown('~~~html\n<script>alert(1)</script>\nhttps://example.org\n~~~');
  assert.match(code,/<pre><code>&lt;script&gt;/);assert.doesNotMatch(code,/<a |<script/);
});

