import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { createMonitor } from '../server.mjs';

test('install manifest, PNG dimensions, CSP and worker scope are available before login', async t => {
  const salt='a'.repeat(48);
  const server=createMonitor({username:'test',passwordSalt:salt,passwordHash:scryptSync('test',salt,64).toString('hex'),hosts:[],secureCookies:false,publicOrigin:'http://localhost'});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/manifest.webmanifest');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^application\/manifest\+json/);
  const manifest=await response.json();assert.equal(manifest.id,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.start_url,'/');assert.equal(manifest.display,'standalone');assert.equal(manifest.prefer_related_applications,false);
  for(const size of [192,512]){
    const icon=manifest.icons.find(i=>i.sizes===`${size}x${size}`&&i.purpose==='any');assert.ok(icon);
    const r=await fetch(base+icon.src);assert.equal(r.headers.get('content-type'),'image/png');
    const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  }
  const worker=await fetch(base+'/sw.js');assert.match(worker.headers.get('content-type'),/javascript/);assert.equal(worker.headers.get('service-worker-allowed'),'/');assert.equal(worker.headers.get('cache-control'),'no-store');
  const page=await fetch(base+'/');const html=await page.text();
  assert.match(html,/rel="manifest"/);assert.match(html,/data-install-app/);assert.match(html,/login-form/);
  assert.match(page.headers.get('content-security-policy'),/worker-src 'self'/);assert.match(page.headers.get('content-security-policy'),/manifest-src 'self'/);
  assert.equal((await fetch(base+'/api/snapshot')).status,401);assert.equal((await fetch(base+'/api/slurm')).status,401);
  assert.equal((await fetch(base+'/config.json')).status,404);
});

test('service worker caches only public offline assets and never retains private HTML or API data', async () => {
  const listeners=new Map(),entries=new Map();let mode='online',fetches=0;
  const cache={addAll:async paths=>{for(const p of paths)entries.set(p,new Response(p==='/offline.html'?'OFFLINE PUBLIC PAGE':'PUBLIC ASSET'));},match:async p=>entries.get(p)?.clone()};
  const context={URL,Response,caches:{open:async()=>cache},fetch:async()=>{fetches++;if(mode==='offline')throw new Error('network');return new Response(mode==='unauthorized'?'Unauthorized':'SECRET-GPU-HOST',{status:mode==='unauthorized'?401:200});},self:{location:{origin:'https://gpus.example'},addEventListener:(name,fn)=>listeners.set(name,fn),skipWaiting:async()=>{},clients:{claim:async()=>{}}}};
  vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),context);
  let installation;listeners.get('install')({waitUntil:p=>installation=p});await installation;
  assert.deepEqual([...entries.keys()],['/offline.html','/pwa.css','/icons/app-192.png','/i18n.js']);
  const request=(path,method='GET',mode='cors')=>({url:'https://gpus.example'+path,method,mode});
  const dispatch=req=>{let result;listeners.get('fetch')({request:req,respondWith:p=>result=p});return result;};
  for(const path of ['/api/history','/api/snapshot','/api/slurm','/api/login','/api/logout','/api/ingest'])assert.equal(dispatch(request(path,path.includes('login')||path.includes('logout')?'POST':'GET','navigate')),undefined);
  assert.equal(fetches,0,'API requests are not intercepted');
  assert.equal(await(await dispatch(request('/','GET','navigate'))).text(),'SECRET-GPU-HOST');
  assert.ok(!entries.has('/'),'authenticated root HTML is never stored');
  mode='unauthorized';assert.equal((await dispatch(request('/','GET','navigate'))).status,401,'do not substitute cached pages for auth failures');
  mode='offline';assert.equal(await(await dispatch(request('/','GET','navigate'))).text(),'OFFLINE PUBLIC PAGE');
  assert.equal(await(await dispatch(request('/pwa.css'))).text(),'PUBLIC ASSET');
  assert.equal(dispatch(request('/app.js')),undefined,'monitoring scripts are not offline-cached');
  for(const r of entries.values())assert.ok(!(await r.clone().text()).includes('SECRET-GPU-HOST'));
});

test('install button invokes each native prompt once and falls back safely after dismissal', async () => {
  const listeners=new Map(),buttonListeners=new Map(),elements=[];
  const button={dataset:{},hidden:false,disabled:false,addEventListener:(name,fn)=>buttonListeners.set(name,fn)};
  const createElement=tag=>({tag,open:false,children:[],setAttribute(){},append(...nodes){this.children.push(...nodes);},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}});
  const context={console,navigator:{},window:{matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener:(name,fn)=>listeners.set(name,fn),isSecureContext:false},document:{querySelectorAll:()=>[button],createElement,body:{append:e=>elements.push(e)}}};
  vm.runInNewContext(readFileSync(new URL('../public/pwa.js',import.meta.url),'utf8'),context);
  await buttonListeners.get('click')();assert.equal(elements[0].open,true,'unsupported browser gets instructions');elements[0].close();
  let prompts=0,prevented=false;
  listeners.get('beforeinstallprompt')({preventDefault(){prevented=true;},prompt:async()=>{prompts++;},userChoice:Promise.resolve({outcome:'dismissed'})});
  assert.ok(prevented);assert.equal(button.dataset.installReady,'true');
  await buttonListeners.get('click')();assert.equal(prompts,1);assert.equal(button.hidden,false);assert.equal(button.disabled,false);
  await buttonListeners.get('click')();assert.equal(prompts,1);assert.equal(elements[0].open,true);
  listeners.get('beforeinstallprompt')({preventDefault(){},prompt:async()=>{prompts++;},userChoice:Promise.resolve({outcome:'accepted'})});
  await buttonListeners.get('click')();assert.equal(button.hidden,true);
  listeners.get('appinstalled')();assert.equal(elements[0].open,false);
});
