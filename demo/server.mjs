// Local-only preview. Does not load hub configuration or accept agent reports.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {snapshot,queue} from './fixtures.mjs';
const root=new URL('../public/',import.meta.url);
const types={'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.html':'text/html'};
const assets=new Map();
for(const file of ['index.html','style.css','pwa.css','app.js','system.js','slurm.js','views.js','i18n.js','live-time.js','manifest.webmanifest','manifest.en.webmanifest','icons/icon.svg','icons/app-192.png','icons/app-512.png','icons/app-maskable-512.png','icons/apple-touch-icon.png'])assets.set('/'+file,readFileSync(new URL(file,root)));
const html=assets.get('/index.html').toString().replace('<script src="/pwa.js" defer></script>','<script src="/demo.js" defer></script>').replace('<div class="workspace">','<div class="workspace"><p class="notice" role="status">DEMO · SYNTHETIC DATA / 虚构演示数据 · No live hosts connected</p>');
const demoScript=`if(!localStorage.getItem('gpu-observatory-language'))localStorage.setItem('gpu-observatory-language','en');document.querySelectorAll('#logout,[data-install-app]').forEach(e=>e.hidden=true);window.I18n?.setLanguage?.(localStorage.getItem('gpu-observatory-language')||'en');`;
const server=http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET'){res.writeHead(405);return res.end();}
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/api/snapshot'||path==='/api/slurm'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(path==='/api/snapshot'?snapshot():queue()));}
 if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
 if(path==='/demo.js'){res.setHeader('Content-Type','text/javascript');return res.end(demoScript);}
 if(assets.has(path)){res.setHeader('Content-Type',types[path.slice(path.lastIndexOf('.'))]||'application/octet-stream');return res.end(assets.get(path));}
 res.writeHead(404);res.end();
});
const port=Number(process.env.DEMO_PORT||8790);
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic demo: http://127.0.0.1:${port} (no authentication, local preview only)`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
