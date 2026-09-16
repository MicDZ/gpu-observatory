import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeSystem } from '../system-schema.mjs';
import { normalizeSnapshot } from '../server.mjs';

const system=()=>({collectedAt:Date.now(),sampleSeconds:5,cpu:{model:'Test CPU',physicalCores:2,logicalCores:4,percent:25,perCore:[0,25,50,25],loadAverage:[1,2,3]},memory:{total:1024**4,available:768*1024**3,used:999,percent:99,free:50*1024**3,cached:700*1024**3,buffers:1024**3,shared:0,swapTotal:0,swapUsed:0},processCount:10,restrictedProcesses:1,topCpuProcesses:[{pid:123,username:'alice',name:'python',cpuPercent:220,rss:4*1024**3,cmdline:'must-not-leak',environ:'must-not-leak'}],topMemoryProcesses:[],error:null});

test('system schema handles TB-scale memory, recomputes pressure and removes sensitive extras',()=>{
  const s=normalizeSystem(system());assert.equal(s.memory.used,256*1024**3);assert.equal(s.memory.percent,25);
  assert.equal(s.memory.swapPercent,0);assert.equal(s.topCpuProcesses[0].cpuPercent,220);
  assert.ok(!JSON.stringify(s).includes('must-not-leak'));
  const invalid=system();invalid.cpu.perCore=[0];assert.throws(()=>normalizeSystem(invalid));
  const invalidMemory=system();invalidMemory.memory.available=2*1024**4;assert.throws(()=>normalizeSystem(invalidMemory));
  const tooMany=system();tooMany.topMemoryProcesses=Array(21).fill({pid:1});assert.throws(()=>normalizeSystem(tooMany));
});

test('system/GPU errors remain independent and old agents remain compatible',()=>{
  const body={version:1,reportId:randomUUID(),collectedAt:Date.now(),gpus:[],error:'GPU unavailable',system:system()};
  assert.equal(normalizeSnapshot(body).system.cpu.percent,25);
  assert.equal(normalizeSnapshot({...body,error:null,system:{error:'Permission issue'}}).error,null);
  assert.equal(normalizeSnapshot({...body,system:undefined}).system,null);
});
