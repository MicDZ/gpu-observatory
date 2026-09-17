import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSlurm } from './slurm/schema.mjs';
import { normalizeSystem } from './system-schema.mjs';
import { createAccounts, checkPassword, safeUser } from './accounts.mjs';
import { managementRoutes } from './management.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (v, max = 160) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;
const num = (v, max = 1e10) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;

export function normalizeSnapshot(body) {
  if (!body || body.version !== 1 || !Array.isArray(body.gpus) || body.gpus.length > 64 ||
      !Number.isSafeInteger(body.collectedAt) || body.collectedAt <= 0 ||
      !/^[a-f0-9-]{36}$/.test(body.reportId || '') ||
      (body.error != null && typeof body.error !== 'string')) throw new Error('Invalid snapshot');
  const seen = new Set();
  const gpus = body.gpus.map(g => {
    if (!g || typeof g.uuid !== 'string' || !g.uuid.length || g.uuid.length > 128 || seen.has(g.uuid) ||
        !Number.isInteger(g.index) || g.index < 0 || !Array.isArray(g.processes) || g.processes.length > 2048) throw new Error('Invalid GPU');
    seen.add(g.uuid);
    return {
      uuid: text(g.uuid), index: g.index, name: text(g.name), utilization: num(g.utilization, 100),
      memoryUsed: num(g.memoryUsed), memoryTotal: num(g.memoryTotal), temperature: num(g.temperature, 250),
      powerDraw: num(g.powerDraw, 10000), powerLimit: num(g.powerLimit, 10000),
      processesAvailable: g.processesAvailable === true,
      processes: g.processes.map(p => {
        if (!p || !Number.isInteger(p.pid) || p.pid <= 0) throw new Error('Invalid process');
        return { pid: p.pid, username: text(p.username, 100), command: text(p.command, 240), gpuMemory: num(p.gpuMemory) };
      })
    };
  });
  return { reportId: body.reportId, collectedAt: body.collectedAt, hostname: text(body.hostname), driverVersion: text(body.driverVersion),
    agentVersion: text(body.agentVersion, 32), error: text(body.error, 240), gpus, system: normalizeSystem(body.system) };
}

export function createMonitor(config, options = {}) {
  if (!config.username || !/^[a-f0-9]{128}$/.test(config.passwordHash || '') ||
      !/^[a-f0-9]{32,}$/.test(config.passwordSalt || '') || !Array.isArray(config.hosts) ||
      config.hosts.some(h => !h.id || !/^[a-f0-9]{64}$/.test(h.tokenHash || ''))) throw new Error('Invalid authentication configuration');
  const now = options.now || Date.now;
  const secure = config.secureCookies !== false;
  const cookieName = secure ? '__Host-gpu_session' : 'gpu_session';
  const sessions = new Map(), loginLimits = new Map(), ingestLimits = new Map();
  const accounts = createAccounts(config, config.accountsFile || (config.stateFile ? join(dirname(config.stateFile), 'accounts.json') : null), now);
  const hosts = { get:id => accounts.device(id), has:id => !!accounts.device(id), values:() => accounts.allDevices() };
  const actor = req => { const key=session(req); return key ? accounts.user(sessions.get(key).userId) : null; };
  const invalidate = uid => { for(const [key,s] of sessions) if(s.userId===uid) sessions.delete(key); };
  const installer = readFileSync(join(root,'deploy/install-agent.py'),'utf8');
  const agentPackage = Object.fromEntries(['agent.py','system_sampler.py','requirements.txt','deploy/setup-agent.py','deploy/setup-node.py'].map(name=>{
    const content=readFileSync(join(root,name),'utf8');return [name.split('/').pop(),{content,sha256:digest(content)}];
  }));
  const sources = new Map((config.slurmSources || []).map(s => {
    if (!s.id || !/^[a-f0-9]{64}$/.test(s.tokenHash || '') || !['mine','visible'].includes(s.scope) || !s.collectorUser) throw new Error('Invalid Slurm source configuration');
    return [s.id, s];
  }));
  const slurmSnapshots = new Map(), slurmReports = new Map();
  const snapshots = new Map(), recentReports = new Map();
  const stateFile = config.stateFile;
  const assets = new Map(['/app.js', '/style.css', '/slurm.js', '/views.js', '/system.js', '/live-time.js',
    '/management.js', '/management.css', '/pwa.js', '/pwa.css', '/i18n.js', '/sw.js', '/offline.html', '/manifest.webmanifest', '/manifest.en.webmanifest',
    '/icons/icon.svg', '/icons/app-192.png', '/icons/app-512.png', '/icons/app-maskable-512.png', '/icons/apple-touch-icon.png'
  ].map(path => [path, readFileSync(join(root, 'public', path))]));
  if (stateFile && existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    for (const item of saved) if (hosts.has(item.id)) snapshots.set(item.id, item);
  }
  if (config.slurmStateFile && existsSync(config.slurmStateFile)) {
    for (const item of JSON.parse(readFileSync(config.slurmStateFile, 'utf8'))) if (sources.has(item.id)) slurmSnapshots.set(item.id, item);
  }
  function persistSlurm() {
    if (!config.slurmStateFile) return;
    mkdirSync(dirname(config.slurmStateFile), { recursive: true, mode: 0o700 });
    writeFileSync(config.slurmStateFile + '.tmp', JSON.stringify([...slurmSnapshots.values()]), { mode: 0o600 });
    renameSync(config.slurmStateFile + '.tmp', config.slurmStateFile);
  }
  function persist() {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile + '.tmp', JSON.stringify([...snapshots.values()]), { mode: 0o600 });
    renameSync(stateFile + '.tmp', stateFile);
  }
  function rate(map, key, limit, windowMs) {
    const t = now();
    let entry = map.get(key);
    if (!entry || entry.until <= t) { entry = { n: 0, until: t + windowMs }; map.set(key, entry); }
    entry.n++;
    return entry.n <= limit;
  }
  const cleanup = setInterval(() => {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
    for (const map of [loginLimits, ingestLimits]) for (const [key, value] of map) if (value.until <= now()) map.delete(key);
  }, 60000).unref();
  function session(req) {
    const match = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='));
    if (!match) return null;
    const key = digest(match.slice(cookieName.length + 1));
    const value = sessions.get(key);
    return value && value.expires > now() && accounts.user(value.userId) ? key : null;
  }
  function reply(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }
  async function json(req, max = 1024 * 1024) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
    if (Number(req.headers['content-length']) > max) throw Object.assign(new Error('Payload too large'), { status: 413 });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('Payload too large'), { status: 413 }); chunks.push(chunk); }
    try { const body=JSON.parse(Buffer.concat(chunks).toString()); if(!body || typeof body!=='object' || Array.isArray(body)) throw Error('Expected object'); return body; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  function originOK(req) { return req.headers.origin === config.publicOrigin; }
  const manage = managementRoutes({accounts, actor, json, reply, originOK, invalidate, snapshots, now, origin:config.publicOrigin,
    removeSnapshot:id=>{snapshots.delete(id);recentReports.delete(id);persist();}});
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      // A forwarded public request must have reached Cloudflare using HTTPS.
      if (secure && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
        if (req.method === 'GET') { res.writeHead(308, { Location: config.publicOrigin + path }); return res.end(); }
        return reply(res, 426, { error: 'HTTPS required' });
      }
      if (path === '/healthz' && req.method === 'GET') return reply(res, 200, { ok: true });
      if (/^\/api\/(me|devices|users)(\/|$)/.test(path) && req.method!=='GET') {
        const user=actor(req);
        if(user && !rate(loginLimits,'manage:'+user.id,30,60000)) return reply(res,429,{error:'操作过于频繁，请稍后重试'});
      }
      if (await manage(req,res,path)) return;
      if (path === '/api/agent-package' && req.method === 'GET') return reply(res,200,{files:agentPackage});
      const installMatch = /^\/install\/([A-Za-z0-9_-]{43})\.py$/.exec(path);
      if (installMatch && req.method === 'GET') {
        const ticket=accounts.ticket(installMatch[1]);
        const settings={origin:config.publicOrigin,token:installMatch[1],hostId:ticket.hostId,boot:ticket.boot};
        res.setHeader('Content-Disposition','attachment; filename="install-agent.py"');
        return reply(res,200,installer.replace('__SETTINGS_JSON__',JSON.stringify(JSON.stringify(settings))),'text/plain; charset=utf-8');
      }
      if(path==='/api/enroll'&&req.method==='POST'){
        const ip=req.headers['cf-connecting-ip']||req.socket.remoteAddress;
        if(!rate(loginLimits,'enroll:'+ip,30,60000))return reply(res,429,{error:'Too many attempts'});
        const body=await json(req,4096);
        return reply(res,201,accounts.claim(body.token));
      }

      if (path === '/api/slurm/ingest' && req.method === 'POST') {
        const source = sources.get(req.headers['x-source-id']), auth = req.headers.authorization || '';
        if (!source || !accounts.user(source.ownerId || 'legacy-admin') || !auth.startsWith('Bearer ') || !equal(digest(auth.slice(7)), source.tokenHash)) return reply(res, 401, { error: 'Unauthorized' });
        if (!rate(ingestLimits, 'slurm:' + source.id, 6, 60000)) return reply(res, 429, { error: 'Too many reports' });
        const body = await json(req, 4 * 1024 * 1024);
        if (!accounts.user(source.ownerId || 'legacy-admin')) return reply(res,401,{error:'Unauthorized'});
        if (body.sourceId !== source.id) return reply(res, 403, { error: 'Source identity mismatch' });
        let snapshot;
        try { snapshot = normalizeSlurm(body, source); } catch { return reply(res, 400, { error: 'Invalid Slurm snapshot' }); }
        const previous = slurmSnapshots.get(source.id);
        let reports = slurmReports.get(source.id);
        if (!reports) { reports = new Set([previous?.reportId].filter(Boolean)); slurmReports.set(source.id, reports); }
        if (reports.has(snapshot.reportId)) return reply(res, 409, { error: 'Duplicate snapshot' });
        reports.add(snapshot.reportId); if (reports.size > 128) reports.delete(reports.values().next().value);
        const receivedAt = now();
        const saved = { ...snapshot, id: source.id, receivedAt, lastSuccessfulAt: snapshot.error ? previous?.lastSuccessfulAt || null : receivedAt,
          jobSampledAt: snapshot.error ? previous?.jobSampledAt ?? previous?.lastSuccessfulAt ?? null : receivedAt - snapshot.queueAgeMs };
        if (snapshot.error && previous) for (const k of ['jobs','partitions','counts','truncated']) saved[k] = previous[k];
        slurmSnapshots.set(source.id, saved); persistSlurm();
        return reply(res, 200, { ok: true });
      }
      if (path === '/api/slurm' && req.method === 'GET') {
        const user=actor(req); if (!user) return reply(res, 401, { error: 'Unauthorized' });
        const time = now();
        return reply(res, 200, { serverTime: time, sources: [...sources.values()].filter(source => (source.ownerId || 'legacy-admin') === user.id).map(source => {
          const s = slurmSnapshots.get(source.id), interval = source.intervalSeconds || 60;
          return { id: source.id, name: source.name, collectorUser: source.collectorUser, scope: source.scope,
            visibility: source.visibility, intervalSeconds: interval, ...s,
            status: !s ? 'waiting' : time - s.receivedAt > Math.max(180000, interval * 3000) ? 'offline' : s.error ? 'error' : 'online' };
        }) });
      }
      if (path === '/api/ingest' && req.method === 'POST') {
        const host = hosts.get(req.headers['x-host-id']);
        const auth = req.headers.authorization || '';
        if (!host || !accounts.user(host.ownerId) || !auth.startsWith('Bearer ') || !equal(digest(auth.slice(7)), host.tokenHash)) return reply(res, 401, { error: 'Unauthorized' });
        if (!rate(ingestLimits, host.id, 30, 60000)) return reply(res, 429, { error: 'Too many reports' });
        const body = await json(req);
        if (!accounts.user(host.ownerId) || accounts.device(host.id)?.tokenHash !== host.tokenHash) return reply(res,401,{error:'Unauthorized'});
        // Identity comes from the host-bound token; claimed IDs may not impersonate another host.
        if (body.hostId !== host.id) return reply(res, 403, { error: 'Host identity mismatch' });
        let snapshot;
        try { snapshot = normalizeSnapshot(body); } catch { return reply(res, 400, { error: 'Invalid snapshot' }); }
        let recent = recentReports.get(host.id);
        if (!recent) { recent = new Set([snapshots.get(host.id)?.reportId].filter(Boolean)); recentReports.set(host.id, recent); }
        if (recent.has(snapshot.reportId)) return reply(res, 409, { error: 'Duplicate snapshot' });
        recent.add(snapshot.reportId);
        if (recent.size > 128) recent.delete(recent.values().next().value);
        // Host clocks may drift; freshness is measured only by the hub's receipt time.
        snapshots.set(host.id, { ...snapshot, id: host.id, receivedAt: now(), clockSkewSeconds: Math.round((snapshot.collectedAt - now()) / 1000) });
        persist();
        return reply(res, 200, { ok: true });
      }
      if (path === '/api/login' && req.method === 'POST') {
        if (!originOK(req)) return reply(res, 403, { error: 'Invalid origin' });
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
        if (!rate(loginLimits, 'ip:' + ip, 8, 15 * 60000) || !rate(loginLimits, 'global', 100, 15 * 60000)) return reply(res, 429, { error: '登录尝试过多，请稍后重试' });
        const body = await json(req, 4096);
        if (typeof body.password !== 'string' || body.password.length > 512 || typeof body.username !== 'string') return reply(res, 400, { error: '请输入用户名和密码' });
        const user=accounts.byName(body.username);
        const valid=await checkPassword(body.password,user || config);
        if (!valid || !user || !accounts.user(user.id) || accounts.user(user.id).passwordHash!==user.passwordHash) return reply(res, 401, { error: '用户名或密码错误' });
        loginLimits.delete('ip:' + ip);
        if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('base64url');
        sessions.set(digest(token), { userId:user.id, expires: now() + 12 * 3600000 });
        res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
        return reply(res, 200, { ok: true, onboarding:accounts.devices(user.id).length===0 });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        if (!originOK(req)) return reply(res, 403, { error: 'Invalid origin' });
        const key = session(req); if (key) sessions.delete(key);
        res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
        return reply(res, 200, { ok: true });
      }
      if (path === '/api/snapshot' && req.method === 'GET') {
        const user=actor(req); if (!user) return reply(res, 401, { error: 'Unauthorized' });
        const time = now();
        return reply(res, 200, { serverTime: time, refreshSeconds: 5, username: user.username, user:safeUser(user), hosts: accounts.devices(user.id).map(host => {
          const s = snapshots.get(host.id);
          return { id: host.id, name: host.name, ...s, status: !s ? 'waiting' : time - s.receivedAt > 30000 ? 'offline' : s.error ? 'error' : 'online',
            systemStatus: !s ? 'waiting' : time - s.receivedAt > 30000 ? 'offline' : !s.system ? 'waiting' : s.system.error ? 'error' : 'online' };
        }) });
      }
      if (assets.has(path) && req.method === 'GET') {
        if (path === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
        const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' :
          path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' :
          path.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8' : 'text/html; charset=utf-8';
        return reply(res, 200, assets.get(path), type);
      }
      if (path === '/devices' && req.method === 'GET') return reply(res,200,readFileSync(join(root,'public',session(req)?'devices.html':'login.html')),'text/html; charset=utf-8');
      if (path === '/' && req.method === 'GET') return reply(res, 200, readFileSync(join(root, 'public', session(req) ? 'index.html' : 'login.html')), 'text/html; charset=utf-8');
      return reply(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(JSON.stringify({ event: 'request_error', status: err.status || 500, message: err.status ? err.message : 'Internal error' }));
      if (!res.headersSent) reply(res, err.status || 500, { error: err.status ? err.message : 'Internal error' }); else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.env.GPU_MONITOR_CONFIG || process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath=process.env.GPU_MONITOR_CONFIG || join(root, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.accountsFile ||= join(config.stateFile ? dirname(config.stateFile) : dirname(configPath), 'accounts.json');
  const server = createMonitor(config);
  server.listen(config.port || 8787, '127.0.0.1', () => console.log(`GPU dashboard listening on 127.0.0.1:${config.port || 8787}`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
