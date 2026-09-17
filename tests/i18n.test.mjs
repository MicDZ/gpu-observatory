import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code=readFileSync(new URL('../public/i18n.js',import.meta.url),'utf8');
function load(storage=new Map()){
  const events=[],handlers=new Map();
  const node={attributes:new Map([['data-i18n','{seconds} 秒前'],['data-i18n-values','{"seconds":5}']]),textContent:'',setAttribute(k,v){this.attributes.set(k,v);},getAttribute(k){return this.attributes.get(k);}};
  const control={value:'',addEventListener:(n,f)=>handlers.set('control:'+n,f)};
  const manifest={setAttribute(k,v){this[k]=v;}};
  const doc={documentElement:{lang:''},dispatchEvent:e=>events.push(e),querySelectorAll:s=>s==='[data-i18n]'?[node]:s==='[data-language-switch]'?[control]:s==='link[rel="manifest"]'?[manifest]:[]};
  const context={localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:doc,window:{addEventListener:(n,f)=>handlers.set(n,f)},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}}};
  vm.runInNewContext(code,context);
  return {api:context.window.I18n,doc,node,control,manifest,events,handlers};
}

test('language switches immediately, persists across reload, interpolates safely and shares stable PWA identity',()=>{
  const storage=new Map(),x=load(storage);
  assert.equal(x.api.language(),'zh');assert.equal(x.node.textContent,'5 秒前');
  x.handlers.get('control:change')({target:{value:'en'}});
  assert.equal(x.doc.documentElement.lang,'en');assert.equal(x.node.textContent,'5s ago');assert.equal(x.control.value,'en');
  assert.equal(x.manifest.href,'/manifest.en.webmanifest');
  assert.equal(x.api.t('{resource}占用前 {count} 个可读取进程',{resource:'CPU',count:20}),'Top 20 readable processes by CPU');
  assert.equal(x.api.t('alice'),'alice');
  assert.equal(load(storage).api.language(),'en');
  x.api.bind(x.node,'{host} GPU {index} 进程详情',{host:'<img src=x>',index:0});
  assert.equal(x.node.textContent,'<img src=x> GPU 0 process details');assert.ok(!('innerHTML' in x.node));
  x.handlers.get('storage')({key:'gpu-observatory-language',newValue:'zh'});
  assert.equal(x.doc.documentElement.lang,'zh-CN');assert.equal(x.node.textContent,'<img src=x> GPU 0 进程详情');
  assert.equal(x.manifest.href,'/manifest.webmanifest');assert.equal(x.api.setLanguage('invalid'),false);
  const zh=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url)));
  const en=JSON.parse(readFileSync(new URL('../public/manifest.en.webmanifest',import.meta.url)));
  assert.equal(zh.id,en.id);assert.equal(zh.start_url,en.start_url);assert.equal(en.lang,'en');
});

test('all marked static copy and explicit dynamic translation calls have English translations',()=>{
  const {api}=load();
  for(const name of ['index.html','login.html','offline.html','devices.html']){
    const html=readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
    for(const m of html.matchAll(/data-i18n(?:-(?:placeholder|aria-label|title))?="([^"]+)"/g)){
      const key=m[1].replaceAll('&quot;','"').replaceAll('&amp;','&');
      assert.ok(Object.hasOwn(api.messages,key),`${name}: ${key}`);
    }
  }
  for(const name of ['app.js','system.js','slurm.js','pwa.js','live-time.js','management.js']){
    const js=readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
    for(const m of js.matchAll(/\bT\((['"])(.*?)\1/g))if(/[\u4e00-\u9fff]/.test(m[2]))assert.ok(Object.hasOwn(api.messages,m[2]),`${name}: ${m[2]}`);
  }
  for(const [zh,en] of Object.entries(api.messages)){
    assert.ok(en&&!/[\u4e00-\u9fff]/.test(en),`Untranslated: ${zh}`);
    assert.deepEqual([...zh.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...en.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),`Interpolation mismatch: ${zh}`);
  }
});
