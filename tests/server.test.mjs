import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createMonitor, digest } from '../server.mjs';

test('authentication, host isolation, schema validation, stale data and restart recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-monitor-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.now();
  const salt = 'a'.repeat(48), password = 'test-password-only';
  const config = { username: 'admin', passwordSalt: salt, passwordHash: scryptSync(password, salt, 64).toString('hex'),
    secureCookies: true, publicOrigin: 'https://gpus.example.test', stateFile: join(dir, 'state.json'),
    hosts: [{ id: 'host-a', name: 'Host A', tokenHash: digest('agent-a') }, { id: 'host-b', name: 'Host B', tokenHash: digest('agent-b') }] };
  const server = createMonitor(config, { now: () => clock });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = (path, options) => fetch(base + path, options);
  const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const auth = { Authorization: 'Bearer agent-a', 'X-Host-Id': 'host-a' };
  assert.equal((await req('/api/snapshot')).status, 401);
  assert.equal((await req('/api/snapshot', { headers: auth })).status, 401, 'agent token cannot read dashboard');
  assert.match(await (await req('/')).text(), /login-form/);
  assert.equal((await req('/config.json')).status, 404);
  assert.equal((await req('/api/ingest', post({}, { ...auth, Authorization: 'Bearer wrong' }))).status, 401);
  assert.equal((await req('/api/ingest', post({ hostId: 'host-b' }, auth))).status, 403);
  assert.equal((await req('/api/ingest', post({ hostId: 'host-a' }, auth))).status, 400);
  const packet = { version: 1, hostId: 'host-a', reportId: randomUUID(), collectedAt: Date.now(), hostname: 'alpha',
    system: {collectedAt:Date.now(),sampleSeconds:5,cpu:{logicalCores:2,physicalCores:1,percent:25,perCore:[20,30],loadAverage:[0,0,0]},memory:{total:16384,available:8192,swapTotal:0,swapUsed:0},processCount:3,restrictedProcesses:0,topCpuProcesses:[],topMemoryProcesses:[],error:null},
    gpus: [{ uuid: 'GPU-a', index: 0, name: 'NVIDIA Test', utilization: 71, memoryUsed: 2048, memoryTotal: 8192,
      processesAvailable: true, processes: [{ pid: 1234, username: '<script>test</script>', command: 'python', gpuMemory: 2048 }] }] };
  assert.equal((await req('/api/ingest', post(packet, auth))).status, 200);
  assert.equal((await req('/api/ingest', post(packet, auth))).status, 409, 'replayed samples are rejected');
  const skewed = { ...packet, reportId: randomUUID(), collectedAt: Date.now() + 300000 };
  assert.equal((await req('/api/ingest', post(skewed, auth))).status, 200, 'host clock drift must not block monitoring');
  assert.equal((await req('/api/ingest', post(packet, { ...auth, 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await req('/api/ingest', post({ padding: 'a'.repeat(1024 * 1024), hostId: 'host-a' }, auth))).status, 413);
  assert.equal((await req('/api/login', post({ username: 'admin', password }))).status, 403, 'login CSRF blocked');
  assert.equal((await req('/api/login', post({ username: 'admin', password: 'wrong' }, { Origin: config.publicOrigin }))).status, 401);
  const login = await req('/api/login', post({ username: 'admin', password }, { Origin: config.publicOrigin }));
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  for (const flag of ['__Host-gpu_session=', 'HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setCookie.includes(flag));
  const Cookie = setCookie.split(';')[0];
  const state = await (await req('/api/snapshot', { headers: { Cookie } })).json();
  assert.equal(state.hosts[0].status, 'online');
  assert.equal(state.hosts[0].systemStatus, 'online');
  assert.equal(state.hosts[0].system.memory.percent, 50);
  assert.ok(state.hosts[0].clockSkewSeconds >= 299);
  assert.equal(state.hosts[1].status, 'waiting');
  assert.equal(state.hosts[0].gpus[0].processes[0].pid, 1234);
  assert.ok(!JSON.stringify(state).includes('tokenHash'));
  assert.ok(!JSON.stringify(state).includes('passwordHash'));
  assert.match(await (await req('/', { headers: { Cookie } })).text(), /GPU 总览/);
  clock += 31000;
  assert.equal((await (await req('/api/snapshot', { headers: { Cookie } })).json()).hosts[0].status, 'offline');
  assert.equal((await req('/api/logout', { method: 'POST', headers: { Cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('/api/logout', { method: 'POST', headers: { Cookie, Origin: config.publicOrigin } })).status, 200);
  assert.equal((await req('/api/snapshot', { headers: { Cookie } })).status, 401, 'logout revokes session');
  assert.equal((await req('/api/login', post({ username: 'admin', password }, { Origin: config.publicOrigin, 'X-Forwarded-Proto': 'http' }))).status, 426);
  for (let i = 0; i < 9; i++) {
    const response = await req('/api/login', post({ username: 'admin', password: 'wrong' }, { Origin: config.publicOrigin }));
    assert.equal(response.status, i < 8 ? 401 : 429);
  }
  assert.equal(JSON.parse(readFileSync(config.stateFile))[0].gpus[0].processes[0].pid, 1234);
  const restarted = createMonitor(config, { now: () => clock });
  restarted.listen(0, '127.0.0.1'); await once(restarted, 'listening');
  t.after(() => restarted.close());
  const restartBase = 'http://127.0.0.1:' + restarted.address().port;
  const newLogin = await fetch(restartBase + '/api/login', post({ username: 'admin', password }, { Origin: config.publicOrigin }));
  const restored = await (await fetch(restartBase + '/api/snapshot', { headers: { Cookie: newLogin.headers.get('set-cookie').split(';')[0] } })).json();
  assert.equal(restored.hosts[0].status, 'offline', 'saved data does not become live after restart');
  assert.equal(restored.hosts[0].systemStatus, 'offline');
  assert.equal(restored.hosts[0].system.cpu.percent, 25);
  assert.equal(restored.hosts[0].gpus[0].processes[0].pid, 1234);
});
