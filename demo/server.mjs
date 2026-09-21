// Local-only preview. Does not load hub configuration or accept agent reports.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {scryptSync} from 'node:crypto';
import {createAccounts,passwordFields} from '../accounts.mjs';
import {managementRoutes} from '../management.mjs';
import {snapshot,queue} from './fixtures.mjs';
import {historyDemo} from './history.mjs';
const root=new URL('../public/',import.meta.url);
const types={'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.html':'text/html'};
const assets=new Map();
for(const file of ['index.html','history.js','history.css','devices.html','management.js','management.css','style.css','pwa.css','app.js','system.js','slurm.js','views.js','i18n.js','live-time.js','manifest.webmanifest','manifest.en.webmanifest','icons/icon.svg','icons/app-192.png','icons/app-512.png','icons/app-maskable-512.png','icons/apple-touch-icon.png'])assets.set('/'+file,readFileSync(new URL(file,root)));
const html=assets.get('/index.html').toString().replace('<script src="/pwa.js" defer></script>','<script src="/demo.js" defer></script>').replace('<div class="workspace">','<div class="workspace"><p class="notice" role="status">DEMO · SYNTHETIC DATA / 虚构演示数据 · No live hosts connected</p>');
const demoScript=`if(!localStorage.getItem('gpu-observatory-language'))localStorage.setItem('gpu-observatory-language','en');document.querySelectorAll('#logout,#sign-out,[data-install-app]').forEach(e=>e.hidden=true);window.I18n?.setLanguage?.(localStorage.getItem('gpu-observatory-language')||'en');`;
const accounts=createAccounts({username:'demo',passwordSalt:'a'.repeat(48),passwordHash:scryptSync('demo-preview-only','a'.repeat(48),64).toString('hex'),hosts:snapshot().hosts.map(h=>({id:h.id,name:h.name,tokenHash:'0'.repeat(64)})),publicOrigin:'https://demo.invalid'},null);
accounts.addUser('legacy-admin','alice',await passwordFields('synthetic-account-only'));
const samples=new Map();
const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const manage=managementRoutes({accounts,actor:()=>accounts.user('legacy-admin'),json:async req=>{let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)throw Error('Request too large');}return JSON.parse(text||'{}');},reply,originOK:req=>req.headers.origin==='http://127.0.0.1:'+port,invalidate:()=>{},snapshots:samples,removeSnapshot:id=>samples.delete(id),now:Date.now,origin:'https://demo.invalid'});
const devicesHTML=assets.get('/devices.html').toString().replace('<script src="/management.js" defer></script>','<script src="/demo.js" defer></script><script src="/management.js" defer></script>').replace('<main class="management-main">','<main class="management-main"><p class="notice">DEMO · SYNTHETIC DATA / 虚构演示数据 · Installation links are nonfunctional examples.</p>');
const server=http.createServer(async(req,res)=>{
 try{
 for(const h of snapshot().hosts)samples.set(h.id,h);

 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const path=new URL(req.url,'http://localhost').pathname;
 if(await manage(req,res,path))return;
 if(req.method!=='GET'){res.writeHead(405);return res.end();}
 if(path==='/api/history'){const result=historyDemo(Object.fromEntries(new URL(req.url,'http://localhost').searchParams));result.hosts=accounts.devices('legacy-admin').map(h=>({id:h.id,name:h.name}));return reply(res,200,result);}
 if(path==='/api/snapshot'||path==='/api/slurm'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(path==='/api/snapshot'?{...snapshot(),hosts:accounts.devices('legacy-admin').map(d=>samples.get(d.id)||{id:d.id,name:d.name,gpus:[],status:'waiting'})}:queue()));}
 if(path==='/devices'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(devicesHTML);}
 if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
 if(path==='/demo.js'){res.setHeader('Content-Type','text/javascript');return res.end(demoScript);}
 if(assets.has(path)){res.setHeader('Content-Type',types[path.slice(path.lastIndexOf('.'))]||'application/octet-stream');return res.end(assets.get(path));}
 res.writeHead(404);res.end();
 }catch(error){reply(res,error.status||400,{error:error.status?error.message:'Demo request failed'});}
});
const port=Number(process.env.DEMO_PORT||8790);
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic demo: http://127.0.0.1:${port} (no authentication, local preview only)`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
