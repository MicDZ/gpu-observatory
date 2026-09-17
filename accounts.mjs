import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
const derive = promisify(scrypt);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const fail = (status, message) => Object.assign(new Error(message), { status });
const id = prefix => prefix + randomBytes(12).toString('hex');
export const safeUser = u => ({ id:u.id, username:u.username, role:u.role, disabled:u.disabled === true, createdAt:u.createdAt });
export async function passwordFields(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw fail(400, '密码长度需要为 12–256 个字符');
  const passwordSalt = randomBytes(24).toString('hex');
  return {passwordSalt, passwordHash:(await derive(password, passwordSalt, 64)).toString('hex')};
}
export async function checkPassword(password, user) {
  const value = (await derive(password, user.passwordSalt, 64)).toString('hex');
  return timingSafeEqual(Buffer.from(value), Buffer.from(user.passwordHash));
}
export function createAccounts(config, file, now = Date.now) {
  let state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
    version:1, users:[{id:'legacy-admin', username:config.username, passwordSalt:config.passwordSalt,
      passwordHash:config.passwordHash, role:'admin', disabled:false, createdAt:now()}], devices:[], tickets:[]
  };
  if (state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.devices) || !Array.isArray(state.tickets) ||
      !state.users.some(u => u.role === 'admin' && !u.disabled) || state.users.some(u =>
        !u.id || !u.username || !['admin','user'].includes(u.role) || !/^[a-f0-9]{128}$/.test(u.passwordHash) || !/^[a-f0-9]{32,}$/.test(u.passwordSalt))) throw Error('Invalid accounts state');
  const persist = next => {
    if (file) {
      mkdirSync(dirname(file), {recursive:true, mode:0o700});
      writeFileSync(file+'.tmp', JSON.stringify(next,null,2)+'\n', {mode:0o600});
      chmodSync(file+'.tmp', 0o600); renameSync(file+'.tmp', file);
    }
    state = next;
  };
  // Persist migration immediately, including the old password hash; subsequent config
  // password edits must never silently reset a user's changed password.
  if (file && !existsSync(file)) persist(state);
  const user = uid => state.users.find(u => u.id === uid && !u.disabled);
  const requireUser = (uid, admin=false) => {
    const u = user(uid); if (!u || admin && u.role !== 'admin') throw fail(403,'没有操作权限'); return u;
  };
  const allDevices = () => {
    const devices = new Map(config.hosts.map(h => [h.id, {...h, ownerId:h.ownerId || 'legacy-admin', createdAt:null}]));
    for (const d of state.devices) devices.set(d.id,d);
    return [...devices.values()].filter(d => !d.deleted);
  };
  const device = hostId => allDevices().find(d => d.id === hostId);
  const ownDevice = (uid, hostId) => {
    requireUser(uid); const d = device(hostId);
    if (!d || d.ownerId !== uid) throw fail(404,'设备不存在'); return d;
  };
  const editDevice = (next, d) => {
    next.devices = next.devices.filter(x => x.id !== d.id); next.devices.push(d);
  };
  return {
    user, requireUser, device, allDevices,
    byName: name => state.users.find(u => u.username === name),
    users: () => state.users.map(safeUser),
    devices: uid => allDevices().filter(d => d.ownerId === uid),
    addUser(actor, username, fields, role='user') {
      requireUser(actor,true);
      if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(username)) throw fail(400,'用户名格式不正确');
      if (!['user','admin'].includes(role)) throw fail(400,'角色无效');
      if (state.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw fail(409,'用户名已存在');
      if (state.users.length >= 500) throw fail(400,'用户数量已达上限');
      const u = {id:id('user-'),username,...fields,role,disabled:false,createdAt:now()};
      const next = structuredClone(state);next.users.push(u);persist(next);return safeUser(u);
    },
    updateUser(actor, uid, patch) {
      requireUser(actor,true);
      const next=structuredClone(state),u=next.users.find(u=>u.id===uid);
      if (!u) throw fail(404,'用户不存在');
      if (patch.disabled !== undefined) {
        if (typeof patch.disabled !== 'boolean') throw fail(400,'参数无效');
        if (actor===uid && patch.disabled) throw fail(400,'不能停用自己的账号');
        u.disabled=patch.disabled;
      }
      if (patch.fields) Object.assign(u,patch.fields);
      if (!next.users.some(u=>u.role==='admin'&&!u.disabled)) throw fail(400,'至少保留一个管理员');
      next.tickets=next.tickets.filter(t=>t.ownerId!==uid);persist(next);return safeUser(u);
    },
    changePassword(uid, previousHash, fields) {
      const u=requireUser(uid);
      if (u.passwordHash!==previousHash) throw fail(409,'账号已更新，请重新登录');
      const next=structuredClone(state);Object.assign(next.users.find(u=>u.id===uid),fields);
      next.tickets=next.tickets.filter(t=>t.ownerId!==uid);persist(next);
    },
    addDevice(uid, name) {
      requireUser(uid);
      if (typeof name!=='string' || !name.trim() || name.length>80 || /[\u0000-\u001f\u007f]/.test(name)) throw fail(400,'设备名称需要为 1–80 个字符');
      if (allDevices().filter(d=>d.ownerId===uid).length>=100) throw fail(400,'设备数量已达上限');
      const d={id:id('gpu-'),name:name.trim(),ownerId:uid,tokenHash:null,createdAt:now()};
      const next=structuredClone(state);next.devices.push(d);persist(next);return d;
    },
    renameDevice(uid, hostId, name) {
      const d=ownDevice(uid,hostId);
      if (typeof name!=='string'||!name.trim()||name.length>80||/[\u0000-\u001f\u007f]/.test(name)) throw fail(400,'设备名称需要为 1–80 个字符');
      const next=structuredClone(state);editDevice(next,{...d,name:name.trim()});persist(next);
    },
    deleteDevice(uid, hostId) {
      const d=ownDevice(uid,hostId),next=structuredClone(state);
      editDevice(next,{id:d.id,ownerId:uid,deleted:true});
      next.tickets=next.tickets.filter(t=>t.hostId!==hostId);persist(next);
    },
    issueTicket(uid, hostId, boot=false) {
      ownDevice(uid,hostId);if(typeof boot!=='boolean')throw fail(400,'参数无效');
      const token=randomBytes(32).toString('base64url'),expiresAt=now()+15*60000,next=structuredClone(state);
      next.tickets=next.tickets.filter(t=>t.hostId!==hostId&&t.expiresAt>now());
      next.tickets.push({hash:hash(token),ownerId:uid,hostId,expiresAt,boot,origin:config.publicOrigin});persist(next);
      return {token,expiresAt};
    },
    ticket(token) {
      if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail(410,'安装链接已失效，请重新生成');
      const ticket=state.tickets.find(t=>t.hash===hash(token)&&t.expiresAt>now()&&t.origin===config.publicOrigin);
      if(!ticket||!user(ticket.ownerId))throw fail(410,'安装链接已失效，请重新生成');
      ownDevice(ticket.ownerId,ticket.hostId);return ticket;
    },
    claim(token) {
      const ticket=this.ticket(token),d=ownDevice(ticket.ownerId,ticket.hostId),reportToken=randomBytes(32).toString('base64url');
      const next=structuredClone(state);next.tickets=next.tickets.filter(t=>t.hash!==ticket.hash);
      editDevice(next,{...d,tokenHash:hash(reportToken),enrolledAt:now()});persist(next);
      return {hostId:d.id,url:config.publicOrigin+'/api/ingest',token:reportToken,interval:5};
    }
  };
}
