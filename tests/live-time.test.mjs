import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code=readFileSync(new URL('../public/live-time.js',import.meta.url),'utf8');
function harness(dom=false){
  let mono=0;const nodes=[],timers=[],events=[];
  const context={window:{I18n:{t:(key,values={})=>key==='{seconds} 秒前'?values.seconds+'s ago':key,locale:()=> 'en-US'},addEventListener(){}},performance:{now:()=>mono},Date,CustomEvent:class{constructor(type){this.type=type;}},setInterval:(fn,ms)=>timers.push({fn,ms})};
  if(dom)context.document={body:{dataset:{page:'dashboard'}},querySelectorAll:()=>nodes.filter(n=>n.dataset.liveTime),addEventListener(){},dispatchEvent:e=>events.push(e)};
  vm.runInNewContext(code,context);
  return {api:context.window.LiveTime,nodes,timers,events,advance:ms=>{mono+=ms;}};
}
const source={receivedAt:100000,jobSampledAt:98000,intervalSeconds:60,error:null};

test('clock is based on server time and monotonic elapsed time, not the client wall clock',()=>{
  const {api}=harness();let mono=0,wall=900000000;
  const clock=api.createClock(()=>mono,()=>wall);
  clock.sync(100000);assert.equal(clock.now(),100000);
  mono+=3300;wall+=3600000;assert.equal(clock.now(),103300);
  clock.sync(99000);assert.equal(clock.now(),103300,'late responses cannot rewind the clock');
  clock.sync(103200);assert.equal(clock.now(),103300);
  mono+=12700;assert.equal(clock.now(),116000,'delayed ticks catch up from timestamps');
});

test('waiting advances only while pending; run time advances only while running',()=>{
  const {api}=harness();const job={state:'PENDING',pendingSeconds:40,elapsedSeconds:0};
  let result=api.jobTimes(job,source,103000);
  assert.equal(result.waitSeconds,45);assert.equal(result.runSeconds,0);assert.equal(result.waitEstimated,true);assert.equal(result.runEstimated,false);
  result=api.jobTimes({...job,state:'RUNNING',pendingSeconds:47,elapsedSeconds:20},source,103000);
  assert.equal(result.waitSeconds,47);assert.equal(result.runSeconds,25);assert.equal(result.runEstimated,true);
  for(const state of ['SUSPENDED','COMPLETING','COMPLETED','FAILED','CANCELLED']){
    result=api.jobTimes({...job,state,elapsedSeconds:20},source,103000);
    assert.equal(result.waitSeconds,40);assert.equal(result.runSeconds,20);assert.equal(result.runEstimated,false);
  }
});

test('missing data stays unknown; stale and error snapshots stop extrapolating',()=>{
  const {api}=harness();
  assert.equal(api.jobTimes({state:'PENDING',elapsed:'0:00'},source,103000).waitSeconds,null);
  assert.equal(api.jobTimes({state:'RUNNING',elapsed:'INVALID'},source,103000).runSeconds,null);
  const job={state:'RUNNING',elapsed:'1:58',pendingSeconds:2};
  assert.equal(api.jobTimes(job,source,103000).runSeconds,123);
  assert.equal(api.jobTimes(job,source,281000).runSeconds,118);
  assert.equal(api.jobTimes(job,{...source,error:'Failed'},103000).runSeconds,118);
  assert.equal(api.sourceStatus({receivedAt:100000},130001),'offline');
  assert.equal(api.systemStatus({receivedAt:100000,error:'GPU error',system:{cpu:{},error:null}},103000),'online');
});

test('duration parsing handles seconds, hours and days without interpreting unknowns as zero',()=>{
  const {api}=harness();
  for(const [value,expected] of [['0:00',0],['3:43',223],['1:10:00',4200],['2-03:04:05',183845]])assert.equal(api.parseDuration(value),expected);
  for(const value of ['INVALID','UNLIMITED','N/A','2:60','1-25:00:00'])assert.equal(api.parseDuration(value),null);
  assert.equal(api.formatDuration(183845),'2-03:04:05');assert.equal(api.formatDuration(null),'—');
});

test('bound text advances every second without fetching or replacing table rows',()=>{
  const h=harness(true);h.api.sync(100000);
  const node=()=>{const n={dataset:{},textContent:'',classList:{toggle(){}},removeAttribute(name){if(name==='data-live-time')delete this.dataset.liveTime;}};h.nodes.push(n);return n;};
  const age=h.api.bindAge(node(),67000);
  const run=h.api.bindJob(node(),{jobId:'1',state:'RUNNING',elapsedSeconds:120,pendingSeconds:2},source,'run');
  assert.equal(age.textContent,'33s ago');assert.equal(run.textContent,'≈ 00:02:02');
  assert.equal(h.timers[0].ms,1000);
  h.advance(7000);h.timers[0].fn();
  assert.equal(age.textContent,'40s ago');assert.equal(run.textContent,'≈ 00:02:09');
  assert.equal(h.nodes.length,2);assert.equal(h.events.at(-1).type,'monitor-tick');
  h.api.unbind(age);age.textContent='Disconnected';h.advance(1000);h.api.tick();assert.equal(age.textContent,'Disconnected');
});
