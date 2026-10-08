import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeSystem } from '../system-schema.mjs';
import { normalizeSnapshot } from '../server.mjs';

const system=()=>({collectedAt:Date.now(),sampleSeconds:5,cpu:{model:'Test CPU',physicalCores:2,logicalCores:4,percent:25,perCore:[0,25,50,25],loadAverage:[1,2,3]},memory:{total:1024**4,available:768*1024**3,used:999,percent:99,free:50*1024**3,cached:700*1024**3,buffers:1024**3,shared:0,swapTotal:0,swapUsed:0},disks:[{device:'/dev/sdb1',mountpoint:'/data',fstype:'xfs',total:8*1024**4,free:2*1024**4,used:99,percent:99,readonly:true},{device:'/dev/sda2',mountpoint:'/',fstype:'ext4',total:2*1024**4,free:1024**4,used:99,percent:99,readonly:false}],diskError:null,diskUsers:[{username:'alice',bytes:3*1024**4,paths:2,partial:false},{username:'bob',bytes:1*1024**4,paths:1,partial:true}],diskUsersAt:Date.now()-60000,diskUsersPartial:true,diskUsersScanning:false,diskUsersError:null,diskUsersRoots:['/mnt/ssd/*','/mnt/nas/*/*'],processCount:10,restrictedProcesses:1,topCpuProcesses:[{pid:123,username:'alice',name:'python',cpuPercent:220,rss:4*1024**3,cmdline:'must-not-leak',environ:'must-not-leak'}],topMemoryProcesses:[],error:null});

test('system schema handles TB-scale memory, recomputes pressure and removes sensitive extras',()=>{
  const s=normalizeSystem(system());assert.equal(s.memory.used,256*1024**3);assert.equal(s.memory.percent,25);
  assert.equal(s.memory.swapPercent,0);assert.equal(s.disks[0].mountpoint,'/');assert.equal(s.disks[0].percent,50);assert.equal(s.disks[1].readonly,true);assert.equal(s.diskUsers[0].username,'alice');assert.equal(s.diskUsers[0].bytes,3*1024**4);assert.equal(s.diskUsers[1].partial,true);assert.equal(s.topCpuProcesses[0].cpuPercent,220);
  assert.ok(!JSON.stringify(s).includes('must-not-leak'));
  const invalid=system();invalid.cpu.perCore=[0];assert.throws(()=>normalizeSystem(invalid));
  const invalidMemory=system();invalidMemory.memory.available=2*1024**4;assert.throws(()=>normalizeSystem(invalidMemory));
  const invalidDisk=system();invalidDisk.disks[0].free=invalidDisk.disks[0].total+1;assert.throws(()=>normalizeSystem(invalidDisk));
  const invalidDiskUsers=system();invalidDiskUsers.diskUsers=[{username:'alice',bytes:1},{username:'alice',bytes:2}];assert.throws(()=>normalizeSystem(invalidDiskUsers));
  const tooMany=system();tooMany.topMemoryProcesses=Array(21).fill({pid:1});assert.throws(()=>normalizeSystem(tooMany));
});

test('system/GPU errors remain independent and old agents remain compatible',()=>{
  const body={version:1,reportId:randomUUID(),collectedAt:Date.now(),gpus:[],error:'GPU unavailable',system:system()};
  assert.equal(normalizeSnapshot(body).system.cpu.percent,25);
  assert.equal(normalizeSnapshot({...body,error:null,system:{error:'Permission issue'}}).error,null);
  assert.equal(normalizeSnapshot({...body,system:undefined}).system,null);
  const old=system();delete old.disks;delete old.diskError;delete old.diskUsers;delete old.diskUsersAt;delete old.diskUsersPartial;delete old.diskUsersScanning;delete old.diskUsersError;delete old.diskUsersRoots;const oldNormalized=normalizeSystem(old);assert.deepEqual(oldNormalized.disks,[]);assert.deepEqual(oldNormalized.diskUsers,[]);
});
