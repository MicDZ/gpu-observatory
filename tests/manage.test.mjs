import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

test('fresh setup, private enrollment and URL migration preserve identities and tokens',t=>{
 const state=mkdtempSync(join(tmpdir(),'observatory-manage-'));t.after(()=>rmSync(state,{recursive:true,force:true}));
 const run=(...args)=>spawnSync(process.execPath,['scripts/manage.mjs',...args,'--state',state],{encoding:'utf8'});
 const read=p=>JSON.parse(readFileSync(join(state,p)));
 assert.notEqual(run('init','--origin','http://public.example.com').status,0);
 assert.equal(run('init','--origin','https://first.example.com').status,0);
 const config=read('config.json');assert.equal(config.hosts.length,0);assert.equal(statSync(join(state,'config.json')).mode&0o777,0o600);
 assert.notEqual(run('init','--origin','https://first.example.com').status,0);
 const out=run('add-host','gpu-01');assert.equal(out.status,0);
 const host=read('enrollment/gpu-01.json');assert.ok(!out.stdout.includes(host.token));
 assert.notEqual(run('add-host','gpu-01').status,0);
 assert.notEqual(run('add-host','../bad').status,0);
 assert.equal(run('add-slurm','cluster-01','--user','alice').status,0);
 assert.equal(read('enrollment/cluster-01.json').scope,'mine');
 assert.equal(run('set-origin','--origin','https://second.example.com').status,0);
 assert.equal(read('enrollment/gpu-01.json').token,host.token);
 assert.equal(read('enrollment/gpu-01.json').url,'https://second.example.com/api/ingest');
 assert.equal(read('enrollment/cluster-01.json').url,'https://second.example.com/api/slurm/ingest');
 assert.equal(read('config.json').passwordHash,config.passwordHash);
 assert.equal(read('config.json').secureCookies,true);
});
