const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
import { passwordFields, checkPassword, safeUser, fail } from './accounts.mjs';

export function managementRoutes({accounts, actor, json, reply, originOK, invalidate, snapshots, removeSnapshot, now, origin}) {
  return async function route(req,res,path) {
    if (!/^\/api\/(me|devices|users)(\/|$)/.test(path)) return false;
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
      return {id:d.id,name:d.name,createdAt:d.createdAt,enrolled:!!d.tokenHash,receivedAt:sample?.receivedAt||null,
        status:!sample?'waiting':now()-sample.receivedAt>30000?'offline':sample.error?'error':'online',gpuCount:sample?.gpus?.length||0};
    })});
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
