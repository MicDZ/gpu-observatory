import test from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createMonitor,digest} from '../server.mjs';

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'accounts-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let clock=Date.now();const password='initial-admin-password',salt='a'.repeat(48),origin='https://monitor.example.test';
 const config={username:'admin',passwordSalt:salt,passwordHash:scryptSync(password,salt,64).toString('hex'),publicOrigin:origin,secureCookies:false,stateFile:join(dir,'snapshots.json'),accountsFile:join(dir,'accounts.json'),hosts:[{id:'legacy',name:'Legacy GPU',tokenHash:digest('legacy-agent')}],slurmSources:[{id:'cluster',name:'Private cluster',tokenHash:digest('slurm-token'),collectorUser:'admin',scope:'mine'}]};
 let server,base;
 async function start(){server=createMonitor(config,{now:()=>clock});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;}
 await start();t.after(()=>server.close());
 const request=(path,method='GET',body,cookie,extra={})=>fetch(base+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...extra},body:body?JSON.stringify(body):undefined});
 async function login(username,pass){const r=await request('/api/login','POST',{username,password:pass});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
 const admin=await login('admin',password);
 async function addUser(username){const r=await request('/api/users','POST',{username,password:'safe-password-'+username},admin);assert.equal(r.status,201);return (await r.json()).user;}
 const result={request,login,addUser,admin,config,advance:n=>clock+=n,restart:async()=>{await new Promise(r=>server.close(r));await start();}};
 return result;
}
const packet=hostId=>({version:1,hostId,reportId:randomUUID(),collectedAt:Date.now(),hostname:'fictional-host',gpus:[],error:null});
const installToken=link=>new URL(link.url).pathname.split('/').pop().replace('.py','');

test('accounts isolate monitoring, Slurm and every device mutation; enrollment is one-time and bound to ownership',async t=>{
 const f=await fixture(t),{request,admin,config}=f;
 const alice=await f.addUser('alice'),bob=await f.addUser('bob');
 const a=await f.login('alice','safe-password-alice'),b=await f.login('bob','safe-password-bob');
 assert.equal((await request('/api/users','GET',null,a)).status,403);
 assert.equal((await request('/api/users','POST',{username:'evil',password:'safe-long-password',role:'admin'},a)).status,403);
 assert.equal((await request('/api/devices','POST',{name:'bad-origin'},a,{Origin:'https://evil.example'})).status,403);
 assert.equal((await request('/api/devices')).status,401);
 assert.equal((await request('/api/snapshot','GET',null,a)).status,200);
 assert.deepEqual((await(await request('/api/snapshot','GET',null,a)).json()).hosts,[]);
 assert.equal((await(await request('/api/slurm','GET',null,a)).json()).sources.length,0);
 assert.equal((await(await request('/api/slurm','GET',null,admin)).json()).sources.length,1);
 const d=(await(await request('/api/devices','POST',{name:'Alice GPU',ownerId:bob.id},a)).json()).device;
 for(const [method,suffix,body] of [['PATCH','',{name:'stolen'}],['DELETE','',null],['POST','/install',{}]])assert.equal((await request('/api/devices/'+d.id+suffix,method,body,b)).status,404);
 const link=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json(),token=installToken(link);
 assert.ok(link.url.startsWith(config.publicOrigin+'/install/'));assert.match(link.command,/pipefail/);assert.equal(spawnSync('bash',['-n','-c',link.command]).status,0);
 for(let i=0;i<2;i++){const r=await request(new URL(link.url).pathname);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const script=await r.text();assert.ok(script.includes(token));assert.equal(spawnSync('python3',['-c',"import sys; compile(sys.stdin.read(), '<installer>', 'exec')"],{input:script}).status,0);}
 const claims=await Promise.all([request('/api/enroll','POST',{token}),request('/api/enroll','POST',{token})]);
 assert.deepEqual(claims.map(r=>r.status).sort(),[201,410]);
 const enrollment=await claims.find(r=>r.status===201).json();assert.equal(enrollment.hostId,d.id);
 const auth={Authorization:'Bearer '+enrollment.token,'X-Host-Id':d.id};
 assert.equal((await request('/api/ingest','POST',packet(d.id),null,auth)).status,200);
 assert.equal((await request('/api/snapshot','GET',null,null,auth)).status,401);
 const snapshot=await(await request('/api/snapshot','GET',null,a)).json();assert.equal(snapshot.hosts.length,1);assert.equal(snapshot.hosts[0].id,d.id);
 assert.deepEqual((await(await request('/api/devices','GET',null,b)).json()).devices,[]);
 assert.equal((await(await request('/api/snapshot','GET',null,admin)).json()).hosts[0].id,'legacy');
 assert.ok(!JSON.stringify(snapshot).includes(enrollment.token));assert.ok(!JSON.stringify(snapshot).includes('tokenHash'));
 const second=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json();
 const third=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json();
 assert.equal((await request('/api/enroll','POST',{token:installToken(second)})).status,410);
 assert.equal((await request('/api/ingest','POST',packet(d.id),null,auth)).status,200,'new link alone does not revoke active reporter');
 const renewed=await(await request('/api/enroll','POST',{token:installToken(third)})).json();
 assert.equal((await request('/api/ingest','POST',packet(d.id),null,auth)).status,401);
 assert.equal((await request('/api/devices/'+d.id,'DELETE',null,a)).status,200);
 assert.equal((await request('/api/ingest','POST',packet(d.id),null,{...auth,Authorization:'Bearer '+renewed.token})).status,401);
 assert.equal((await(await request('/api/snapshot','GET',null,a)).json()).hosts.length,0);
 const saved=readFileSync(config.accountsFile,'utf8');assert.ok(!saved.includes(token));assert.ok(!saved.includes(renewed.token));assert.equal(statSync(config.accountsFile).mode&0o777,0o600);
});

test('migration, expiry, disabling and password changes survive restart without resurrecting deleted legacy devices',async t=>{
 const f=await fixture(t),{request,admin}=f;
 const alice=await f.addUser('alice');const a=await f.login('alice','safe-password-alice');
 const d=(await(await request('/api/devices','POST',{name:'Alice GPU'},a)).json()).device;
 const link=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json();
 f.advance(15*60000+1);
 assert.equal((await request('/api/enroll','POST',{token:installToken(link)})).status,410);
 const fresh=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json();
 const enrollment=await(await request('/api/enroll','POST',{token:installToken(fresh)})).json();
 const pending=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json();
 assert.equal((await request('/api/users/'+alice.id,'PATCH',{disabled:true},admin)).status,200);
 assert.equal((await request('/api/me','GET',null,a)).status,401);
 assert.equal((await request('/api/enroll','POST',{token:installToken(pending)})).status,410);
 assert.equal((await request('/api/ingest','POST',packet(d.id),null,{Authorization:'Bearer '+enrollment.token,'X-Host-Id':d.id})).status,401);
 assert.equal((await request('/api/users/'+alice.id,'PATCH',{disabled:false},admin)).status,200);
 const a2=await f.login('alice','safe-password-alice');
 assert.equal((await request('/api/me/password','POST',{currentPassword:'wrong',password:'new-safe-password'},a2)).status,400);
 assert.equal((await request('/api/me/password','POST',{currentPassword:'safe-password-alice',password:'new-safe-password'},a2)).status,200);
 assert.equal((await request('/api/me','GET',null,a2)).status,401);
 assert.equal((await request('/api/users/legacy-admin','PATCH',{disabled:true},admin)).status,400);
 assert.equal((await request('/api/devices/legacy','DELETE',null,admin)).status,200);
 await f.restart();
 const a3=await f.login('alice','new-safe-password'),admin2=await f.login('admin','initial-admin-password');
 assert.equal((await(await request('/api/devices','GET',null,a3)).json()).devices[0].id,d.id);
 assert.equal((await(await request('/api/devices','GET',null,admin2)).json()).devices.length,0);
 assert.equal((await request('/api/ingest','POST',packet('legacy'),null,{Authorization:'Bearer legacy-agent','X-Host-Id':'legacy'})).status,401);
 assert.equal((await request('/api/users/'+alice.id,'PATCH',{password:'admin-reset-password'},admin2)).status,200);
 assert.equal((await request('/api/me','GET',null,a3)).status,401);
 await f.login('alice','admin-reset-password');
});

test('admin inventory exposes only owner, device name and GPU models; preserves last successful models without broadening telemetry access',async t=>{
 const f=await fixture(t),{request,admin}=f;
 const alice=await f.addUser('alice'),a=await f.login('alice','safe-password-alice');
 const add=async name=>(await(await request('/api/devices','POST',{name},a)).json()).device;
 const d=await add('Alice workstation');await add('Not installed yet');
 const link=await(await request('/api/devices/'+d.id+'/install','POST',{},a)).json();
 const enrolled=await(await request('/api/enroll','POST',{token:installToken(link)})).json();
 const auth={Authorization:'Bearer '+enrolled.token,'X-Host-Id':d.id};
 const gpu=(name,index)=>({uuid:'GPU-inventory-'+index,index,name,utilization:93,memoryUsed:4500,memoryTotal:8192,temperature:61,powerDraw:220,processesAvailable:true,processes:[{pid:54321,username:'private-process-user',command:'private-command',gpuMemory:4500}]});
 const report={...packet(d.id),hostname:'private-hostname',gpus:[gpu('NVIDIA A100',0),gpu('NVIDIA A100',1),gpu('NVIDIA H100',2)]};
 assert.equal((await request('/api/ingest','POST',report,null,auth)).status,200);
 assert.equal((await request('/api/users/devices')).status,401);
 assert.equal((await request('/api/users/devices','GET',null,a)).status,403);
 assert.equal((await request('/api/users/devices','GET',null,null,auth)).status,401);
 const inventory=await(await request('/api/users/devices','GET',null,admin)).json();
 assert.deepEqual(Object.keys(inventory),['devices']);
 for(const row of inventory.devices)assert.deepEqual(Object.keys(row).sort(),['gpuModels','name','username']);
 assert.deepEqual(inventory.devices.find(row=>row.name===d.name),{username:'alice',name:d.name,gpuModels:['NVIDIA A100','NVIDIA H100']});
 assert.deepEqual(inventory.devices.find(row=>row.name==='Not installed yet').gpuModels,[]);
 assert.ok(!JSON.stringify(inventory).includes('private-'));
 assert.deepEqual((await(await request('/api/snapshot','GET',null,admin)).json()).hosts.map(h=>h.id),['legacy']);
 assert.equal((await request('/api/devices/'+d.id,'PATCH',{name:'Renamed workstation'},a)).status,200);
 assert.equal((await request('/api/ingest','POST',{...packet(d.id),error:'GPU unavailable'},null,auth)).status,200);
 f.advance(31000);
 assert.equal((await request('/api/users/'+alice.id,'PATCH',{disabled:true},admin)).status,200);
 await f.restart();const admin2=await f.login('admin','initial-admin-password');
 const after=await(await request('/api/users/devices','GET',null,admin2)).json();
 assert.deepEqual(after.devices.find(row=>row.name==='Renamed workstation').gpuModels,['NVIDIA A100','NVIDIA H100']);
 assert.equal((await request('/api/users/'+alice.id,'PATCH',{disabled:false},admin2)).status,200);
 const a2=await f.login('alice','safe-password-alice');
 assert.equal((await request('/api/devices/'+d.id,'DELETE',null,a2)).status,200);
 assert.ok(!(await(await request('/api/users/devices','GET',null,admin2)).json()).devices.some(row=>row.name==='Renamed workstation'));
});
