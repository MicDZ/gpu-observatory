const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
import { createHash } from 'node:crypto';
import { passwordFields, checkPassword, safeUser, fail } from './accounts.mjs';

// Mirrors deploy/install-agent.py: web-enrolled reporters live under a per-device directory.
const installDir=id=>createHash('sha256').update((id||'').toString()).digest('hex').slice(0,16);
// A user-runnable, sudo-free recovery snippet. It prefers the hub-specific install directory,
// falls back to any gpu-agents install, then to the manual gpu-monitor layout.
export function recoveryCommand(origin,hostId){
  const dir=installDir(origin+'/'+hostId);
  return 'R="$HOME/.local/share/gpu-agents/'+dir+'"; [ -d "$R" ] || R=$(ls -d "$HOME"/.local/share/gpu-agents/*/ 2>/dev/null | head -n1); [ -n "$R" ] || R="$HOME/.local/share/gpu-monitor"; sh "$R/pm2.sh" startOrRestart "$R/ecosystem.json" && sh "$R/pm2.sh" save';
}

export function gpuModelNames(sample) {
  const names=sample?.gpuModels ?? sample?.gpus?.map(g=>g.name) ?? [];
  return [...new Set(names.filter(name=>typeof name==='string' && name.trim()).map(name=>name.trim()))].sort();
}

export function slurmRecoveryCommand(origin, sourceId) {
  const dir = installDir(origin + '/' + sourceId);
  return 'R="$HOME/.local/share/slurm-agents/' + dir + '"; [ -d "$R" ] || R="$HOME/.local/share/slurm-monitor"; sh "$R/pm2.sh" startOrRestart "$R/ecosystem.json" && sh "$R/pm2.sh" save';
}

export function managementRoutes({accounts, actor, json, reply, originOK, invalidate, snapshots, removeSnapshot, slurmSnapshots, removeSlurmSnapshot, now, origin}) {
  return async function route(req,res,path) {
    if (!/^\/api\/(me|devices|users|slurm-sources)(\/|$)/.test(path)) return false;
    const u=actor(req);if(!u){reply(res,401,{error:'Unauthorized'});return true;}
    if(req.method!=='GET'&&!originOK(req))throw fail(403,'Invalid origin');
    const uid=u.id;
    const active=()=>{if(actor(req)?.id!==uid)throw fail(401,'请重新登录');};
    const read=async()=>{const body=await json(req,4096);active();return body;};
    const send=(status,body)=>{reply(res,status,body);return true;};
    if(path==='/api/me'&&req.method==='GET')return send(200,{user:safeUser(u)});
    if(path==='/api/me/password'&&req.method==='POST'){
      const body=await read(),previousHash=u.passwordHash;
      if(typeof body.currentPassword!=='string'||body.currentPassword.length>512||!await checkPassword(body.currentPassword,u))throw fail(400,'当前密码不正确');
      const fields=await passwordFields(body.password);active();accounts.changePassword(uid,previousHash,fields);invalidate(uid);
      return send(200,{ok:true,relogin:true});
    }
    if(path==='/api/devices'&&req.method==='GET')return send(200,{serverTime:now(),devices:accounts.devices(uid).map(d=>{
      const sample=snapshots.get(d.id);
      const status=!sample?'waiting':now()-sample.receivedAt>30000?'offline':sample.error?'error':'online';
      return {id:d.id,name:d.name,createdAt:d.createdAt,enrolled:!!d.tokenHash,receivedAt:sample?.receivedAt||null,
        status,gpuCount:sample?.gpus?.length||0,
        recovery:(status==='offline'||status==='error')?recoveryCommand(origin,d.id):null};
    })});
    if(path==='/api/slurm-sources'&&req.method==='GET')return send(200,{serverTime:now(),sources:accounts.slurmSources(uid).map(s=>{
      const sample=slurmSnapshots?.get(s.id), interval=s.intervalSeconds||60;
      const status=!sample?'waiting':now()-sample.receivedAt>Math.max(180000,interval*3000)?'offline':sample.error?'error':'online';
      return {id:s.id,name:s.name,collectorUser:s.collectorUser,scope:s.scope,visibility:s.visibility,intervalSeconds:interval,
        createdAt:s.createdAt??null,enrolled:!!s.tokenHash,receivedAt:sample?.receivedAt??null,status,
        counts:sample?.counts??null,hostname:sample?.hostname??null,
        recovery:(status==='offline'||status==='error')?slurmRecoveryCommand(origin,s.id):null};
    })});
    if(path==='/api/slurm-sources'&&req.method==='POST'){
      const body=await read();
      const s=accounts.addSlurm(uid,body.name,{collectorUser:body.collectorUser,scope:body.scope,visibility:body.visibility,intervalSeconds:body.intervalSeconds});
      return send(201,{source:{id:s.id,name:s.name,collectorUser:s.collectorUser,scope:s.scope,visibility:s.visibility,intervalSeconds:s.intervalSeconds}});
    }
    const slurmMatch=/^\/api\/slurm-sources\/([a-zA-Z0-9._-]+)(\/install)?$/.exec(path);
    if(slurmMatch){
      const sourceId=slurmMatch[1];
      if(slurmMatch[2]&&req.method==='POST'){
        await read();
        const ticket=accounts.issueSlurmTicket(uid,sourceId,false);
        const url=origin+'/install-slurm/'+ticket.token+'.py';
        return send(201,{url,expiresAt:ticket.expiresAt,command:'bash -o pipefail -c '+shellQuote('curl --proto =https --tlsv1.2 -fsS "$1" | python3 -')+' -- '+shellQuote(url)});
      }
      if(!slurmMatch[2]&&req.method==='PATCH'){const body=await read();accounts.renameSlurm(uid,sourceId,body.name);return send(200,{ok:true});}
      if(!slurmMatch[2]&&req.method==='DELETE'){accounts.deleteSlurm(uid,sourceId);removeSlurmSnapshot?.(sourceId);return send(200,{ok:true});}
    }
    if(path==='/api/devices'&&req.method==='POST'){
      const body=await read(),d=accounts.addDevice(uid,body.name);
      return send(201,{device:{id:d.id,name:d.name}});
    }
    const match=/^\/api\/devices\/([a-zA-Z0-9._-]+)(\/install)?$/.exec(path);
    if(match){
      const hostId=match[1];
      if(match[2]&&req.method==='POST'){
        const body=await read(),ticket=accounts.issueTicket(uid,hostId,body.boot??false);
        const url=origin+'/install/'+ticket.token+'.py';
        return send(201,{url,expiresAt:ticket.expiresAt,command:'bash -o pipefail -c '+shellQuote('curl --proto =https --tlsv1.2 -fsS "$1" | python3 -')+' -- '+shellQuote(url)});
      }
      if(!match[2]&&req.method==='PATCH'){const body=await read();accounts.renameDevice(uid,hostId,body.name);return send(200,{ok:true});}
      if(!match[2]&&req.method==='DELETE'){accounts.deleteDevice(uid,hostId);removeSnapshot(hostId);return send(200,{ok:true});}
    }
    if(path==='/api/users/devices'&&req.method==='GET'){
      accounts.requireUser(uid,true);
      const owners=new Map(accounts.users().map(user=>[user.id,user.username]));
      // Explicit inventory-only projection: never return snapshots or credentials.
      const devices=accounts.allDevices().map(d=>({username:owners.get(d.ownerId)||'',name:d.name,gpuModels:gpuModelNames(snapshots.get(d.id))}));
      devices.sort((a,b)=>a.username.localeCompare(b.username)||a.name.localeCompare(b.name));
      return send(200,{devices});
    }
    if(path==='/api/users'&&req.method==='GET'){
      accounts.requireUser(uid,true);return send(200,{users:accounts.users()});
    }
    if(path==='/api/users'&&req.method==='POST'){
      accounts.requireUser(uid,true);const body=await read(),fields=await passwordFields(body.password);
      active();return send(201,{user:accounts.addUser(uid,body.username,fields,body.role??'user')});
    }
    const target=/^\/api\/users\/([a-zA-Z0-9._-]+)$/.exec(path);
    if(target&&req.method==='PATCH'){
      accounts.requireUser(uid,true);const body=await read(),patch={};
      if(body.disabled!==undefined)patch.disabled=body.disabled;
      if(body.password!==undefined)patch.fields=await passwordFields(body.password);
      if(!Object.keys(patch).length)throw fail(400,'参数无效');
      active();const user=accounts.updateUser(uid,target[1],patch);invalidate(target[1]);return send(200,{user});
    }
    return send(404,{error:'Not found'});
  };
}
