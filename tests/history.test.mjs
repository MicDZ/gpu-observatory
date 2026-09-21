import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {HistoryStore,historyRange} from '../history.mjs';
const H=3600000,D=86400000;
const host={id:'host-a',ownerId:'alice-account',name:'Test host'};
const gpu=(overrides={})=>({uuid:'GPU-test',index:0,name:'Test GPU',utilization:50,memoryUsed:4096,memoryTotal:8192,processesAvailable:true,processes:[],...overrides});
const sample=(gpus=[gpu()],error=null)=>({reportId:randomUUID(),gpus,error});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('SQLite history splits UTC days, time-weights metrics and counts unique OS users without retaining PIDs',()=>{
 const start=Date.parse('2026-09-20T23:59:58Z'),db=new HistoryStore({now:()=>start});
 try{
  const first=sample([gpu({utilization:100,processes:[{pid:1,username:'alice',gpuMemory:1024},{pid:1,username:'alice',gpuMemory:1024},{pid:2,username:'alice',gpuMemory:2048},{pid:3,username:'bob',gpuMemory:null}]}),gpu({uuid:'GPU-second',index:1,utilization:0,memoryUsed:null,memoryTotal:null,processesAvailable:false})]);
  db.record(host,first,start);assert.equal(db.query(host.ownerId,{},start).summary.observedGpuHours,0,'one sample has no duration');
  db.record(host,sample(first.gpus),start+5000);
  const result=db.query(host.ownerId,{from:'2026-09-20',to:'2026-09-21'},start+5000);
  near(result.days[0].observedGpuHours,4000/H);
  near(result.days[1].observedGpuHours,6000/H);
  near(result.summary.observedGpuHours,10000/H);near(result.summary.utilizationHours,5000/H);
  near(result.summary.avgUtilization,50);near(result.summary.memoryPercent,50);
  near(result.summary.avgMemoryGiB,4);near(result.summary.processObservedHours,5000/H);
  const alice=result.users.find(u=>u.username==='alice'),bob=result.users.find(u=>u.username==='bob');
  near(alice.occupiedGpuHours,5000/H);near(alice.memoryGiBHours,3*5000/H);
  near(bob.occupiedGpuHours,5000/H);assert.equal(bob.memoryObservedHours,0);
  assert.equal(db.query('other-account',{},start+5000).devices.length,0);
  assert.ok(!JSON.stringify(result).includes('GPU-test'),'hardware UUIDs are not exposed in analytics');
  for(const row of db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all())assert.ok(!/\bpid\b|command|password|token/i.test(row.sql));
 }finally{db.close();}
});

test('missing metrics and long gaps never become idle zeros or extrapolated occupancy',()=>{
 const at=Date.parse('2026-09-21T10:00:00Z'),db=new HistoryStore({now:()=>at});
 try{
  db.record(host,sample([gpu({utilization:80})]),at);
  db.record(host,sample([gpu({utilization:null,memoryUsed:null,memoryTotal:null,processesAvailable:false})]),at+5000);
  db.record(host,sample([],'Collection failed'),at+10000);
  db.record(host,sample(),at+15000);
  db.record(host,sample(),at+90000);
  let r=db.query(host.ownerId,{},at+90000);
  near(r.summary.observedGpuHours,10000/H);near(r.summary.avgUtilization,80);
  assert.equal(r.days[0].avgUtilization,null);
  db.record(host,sample([gpu({utilization:0})]),at+95000);
  r=db.query(host.ownerId,{},at+95000);near(r.summary.observedGpuHours,15000/H);near(r.summary.avgUtilization,65);
  const frozen=r.summary.utilizationHours;
  near(db.query(host.ownerId,{},at+H).summary.utilizationHours,frozen,'query never extrapolates latest sample');
 }finally{db.close();}
});

test('transactions roll back minute/day/user writes together and a failed write breaks the baseline',()=>{
 const at=Date.parse('2026-09-21T10:00:00Z'),db=new HistoryStore({now:()=>at});
 try{
  db.record(host,sample(),at);
  db.db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON gpu_day BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;");
  const next=sample();assert.throws(()=>db.record(host,next,at+5000));assert.equal(db.lastError,true);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM gpu_minute').get().n,0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM history_gpu').get().n,0);
  db.db.exec('DROP TRIGGER fail_write');db.record(host,next,at+5000);
  assert.equal(db.record(host,next,at+6000),false,'duplicate IDs are durable and idempotent');
  db.record(host,sample(),at+10000);near(db.query(host.ownerId,{},at+10000).summary.observedGpuHours,5000/H);
  assert.equal(db.lastError,false);
 }finally{db.close();}
});

test('restart, retention, device deletion and SQLite permissions preserve privacy and bounded storage',()=>{
 const dir=mkdtempSync(join(tmpdir(),'history-')),file=join(dir,'history.sqlite'),at=Date.parse('2026-09-01T00:00:00Z');let db;
 try{
  db=new HistoryStore({file,minuteRetentionDays:1,dailyRetentionDays:7,now:()=>at});
  const first=sample([gpu({processes:[{pid:1,username:'alice',gpuMemory:2048}]})]);
  db.record(host,first,at);const last=sample(first.gpus);db.record(host,last,at+5000);db.close();
  db=new HistoryStore({file,minuteRetentionDays:1,dailyRetentionDays:7,now:()=>at+10000});
  assert.equal(db.record(host,last,at+10000),false);
  db.record(host,sample(first.gpus),at+15000);near(db.query(host.ownerId,{days:1},at+15000).summary.observedGpuHours,5000/H,'restart does not fill a gap');
  db.prune(at+D);assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM gpu_minute').get().n,0);
  assert.equal(db.query(host.ownerId,{days:2},at+D).summary.daysWithData,1);
  db.prune(at+8*D);assert.equal(db.query(host.ownerId,{},at+8*D).summary.daysWithData,0);
  db.record(host,sample(first.gpus),at+8*D);db.record(host,sample(first.gpus),at+8*D+5000);
  db.removeHost(host.id);
  for(const table of ['history_gpu','gpu_minute','gpu_day','user_minute','user_day','history_cursor'])assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.equal(statSync(file).mode&0o777,0o600);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('date filters reject invalid days, future dates, excessive windows and SQL-shaped host values stay literal',()=>{
 const at=Date.parse('2026-09-21T10:00:00Z'),db=new HistoryStore({now:()=>at});
 try{
  for(const options of [{days:0},{days:731},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-09-22',to:'2026-09-22'},{from:'2026-09-21',to:'2026-09-20'}])assert.throws(()=>historyRange(options,at));
  assert.equal(db.query(host.ownerId,{hostId:"' OR 1=1 --"},at).summary.daysWithData,0);
 }finally{db.close();}
});

test('server clock reversal cannot double-count an already observed interval',()=>{
 const at=Date.parse('2026-09-21T10:00:00Z'),db=new HistoryStore({now:()=>at});
 try{
  db.record(host,sample(),at);db.record(host,sample(),at+10000);
  db.record(host,sample(),at+8000);db.record(host,sample(),at+15000);
  near(db.query(host.ownerId,{},at+15000).summary.observedGpuHours,15000/H);
 }finally{db.close();}
});

test('online SQLite backup includes committed WAL records and refuses to overwrite an existing backup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'history-backup-')),file=join(dir,'live.sqlite'),target=join(dir,'backup.sqlite'),at=Date.parse('2026-09-21T10:00:00Z');let source,restored;
 try{
  source=new HistoryStore({file,now:()=>at});source.record(host,sample(),at);source.record(host,sample(),at+5000);
  for(const path of [file,file+'-wal',file+'-shm'])assert.equal(statSync(path).mode&0o777,0o600);
  const command=()=>spawnSync(process.execPath,['scripts/backup-history.mjs',file,target],{encoding:'utf8'});
  assert.equal(command().status,0);assert.equal(statSync(target).mode&0o777,0o600);
  assert.notEqual(command().status,0);
  restored=new HistoryStore({file:target,now:()=>at+5000});near(restored.query(host.ownerId,{},at+5000).summary.observedGpuHours,5000/H);
 }finally{restored?.close();source?.close();rmSync(dir,{recursive:true,force:true});}
});
