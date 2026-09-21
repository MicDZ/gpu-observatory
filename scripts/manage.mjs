#!/usr/bin/env node
// Configuration stays outside the checkout. Never print passwords or bearer tokens.
import { parseArgs } from 'node:util';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';

const { values: o, positionals: args } = parseArgs({allowPositionals:true, options:{
  state:{type:'string'}, origin:{type:'string'}, username:{type:'string'}, name:{type:'string'},
  user:{type:'string'}, scope:{type:'string'}, visibility:{type:'string'}, interval:{type:'string'},
  port:{type:'string'}, local:{type:'boolean'}, help:{type:'boolean'}
}});
const usage = `Usage: node scripts/manage.mjs COMMAND [ID] [options]
  init --origin https://monitor.example.com --username admin
  add-host gpu-01 [--name "GPU 01"]
  add-slurm cluster-01 --user alice [--scope mine|visible] [--visibility account-visible|private-jobs]
  reset-password USERNAME (stop hub first, then restart)
  set-origin --origin https://new-host.example.com
Options: --state DIRECTORY (default ~/.local/share/gpu-observatory-hub)
         --port 8787 (init), --interval 60 (add-slurm)
         --local permits HTTP loopback for local development only (init/set-origin).
Enrollment files and login-credentials.txt are private. Restart the hub after changes.`;
if(o.help || !args.length){console.log(usage);process.exit(0);}
const dir=resolve(o.state || join(homedir(),'.local/share/gpu-observatory-hub'));
const path=join(dir,'config.json');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(p,v)=>{writeFileSync(p+'.tmp',JSON.stringify(v,null,2)+'\n',{mode:0o600});chmodSync(p+'.tmp',0o600);renameSync(p+'.tmp',p);};
const hash=v=>createHash('sha256').update(v).digest('hex');
function origin(){
  const u=new URL(o.origin);
  if(u.username || u.password || u.pathname!=='/' || u.search || u.hash)throw Error('Origin must have no credentials, path, query or fragment');
  if(u.protocol!=='https:' && !(o.local && u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error('HTTPS is required (HTTP loopback needs --local)');
  return u.origin;
}
try{
  const command=args[0];
  if(command==='init'){
    const publicOrigin=origin(),port=Number(o.port||8787),username=o.username||'admin';
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Choose an unprivileged port (1024–65535)');
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(username))throw Error('Invalid dashboard username');
    if(existsSync(path)||existsSync(join(dir,'login-credentials.txt')))throw Error('Refusing to replace existing credentials');
    for(const d of [dir,join(dir,'data'),join(dir,'enrollment')]){mkdirSync(d,{recursive:true,mode:0o700});chmodSync(d,0o700);}
    const password=randomBytes(24).toString('base64url'),salt=randomBytes(24).toString('hex');
    const config={username,passwordSalt:salt,passwordHash:scryptSync(password,salt,64).toString('hex'),publicOrigin,secureCookies:publicOrigin.startsWith('https:'),port,accountsFile:join(dir,'accounts.json'),history:{enabled:true,file:join(dir,'data/history.sqlite'),minuteRetentionDays:30,dailyRetentionDays:365},stateFile:join(dir,'data/snapshots.json'),slurmStateFile:join(dir,'data/slurm-snapshots.json'),hosts:[],slurmSources:[]};
    writeFileSync(join(dir,'login-credentials.txt'),`Username: ${username}\nPassword: ${password}\n`,{mode:0o600,flag:'wx'});
    save(path,config);
    console.log('Initialized hub. Read login-credentials.txt privately; values are not printed.');
  }else if(command==='add-host'||command==='add-slurm'){
    const id=args[1];
    if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id||''))throw Error('ID must be lowercase letters, numbers, dot, underscore or hyphen (1–80 characters)');
    const config=read(path),file=join(dir,'enrollment',id+'.json');
    if([...config.hosts,...(config.slurmSources||[])].some(s=>s.id===id)||existsSync(file))throw Error('ID exists; refusing to replace credentials');
    const token=randomBytes(32).toString('base64url'),entry={id,name:o.name||id,tokenHash:hash(token)};
    let enrollment;
    if(command==='add-host'){
      config.hosts.push(entry);enrollment={hostId:id,url:config.publicOrigin+'/api/ingest',token,interval:5};
    }else{
      const scope=o.scope||'mine',visibility=o.visibility||'account-visible',intervalSeconds=Number(o.interval||60);
      if(!/^[A-Za-z0-9._@-]{1,128}$/.test(o.user||''))throw Error('--user is required (collector OS username)');
      if(!['mine','visible'].includes(scope)||!['account-visible','private-jobs'].includes(visibility))throw Error('Invalid scope or visibility');
      if(!Number.isInteger(intervalSeconds)||intervalSeconds<60)throw Error('Slurm interval must be at least 60 seconds');
      config.slurmSources??=[];config.slurmSources.push({...entry,collectorUser:o.user,scope,visibility,intervalSeconds});
      enrollment={sourceId:id,url:config.publicOrigin+'/api/slurm/ingest',token,scope,visibility,intervalSeconds,squeuePath:'/usr/bin/squeue',sinfoPath:'/usr/bin/sinfo'};
    }
    writeFileSync(file,JSON.stringify(enrollment,null,2)+'\n',{mode:0o600,flag:'wx'});save(path,config);
    console.log(`Enrolled ${id}. Transfer only enrollment/${id}.json to that reporter; restart the hub.`);
  }else if(command==='reset-password'){
    const config=read(path),accountsFile=config.accountsFile||join(dirname(config.stateFile),'accounts.json');
    if(!existsSync(accountsFile))throw Error('Start the upgraded hub once to migrate accounts, then stop it before resetting a password');
    const accounts=read(accountsFile),user=accounts.users.find(u=>u.username===args[1]);
    if(!user)throw Error('User not found');
    const password=randomBytes(24).toString('base64url'),salt=randomBytes(24).toString('hex');
    user.passwordSalt=salt;user.passwordHash=scryptSync(password,salt,64).toString('hex');
    accounts.tickets=accounts.tickets.filter(t=>t.ownerId!==user.id);
    save(accountsFile,accounts);
    const credentials=join(dir,'reset-login-credentials.txt');
    writeFileSync(credentials,`Username: ${user.username}\nPassword: ${password}\n`,{mode:0o600});chmodSync(credentials,0o600);
    console.log('Password reset. Read reset-login-credentials.txt privately, then restart the hub. Values were not printed.');
  }else if(command==='set-origin'){
    const publicOrigin=origin(),config=read(path);config.publicOrigin=publicOrigin;config.secureCookies=publicOrigin.startsWith('https:');
    for(const f of readdirSync(join(dir,'enrollment')).filter(f=>f.endsWith('.json'))){const p=join(dir,'enrollment',f),e=read(p);e.url=publicOrigin+(e.sourceId?'/api/slurm/ingest':'/api/ingest');save(p,e);}
    save(path,config);console.log('Updated origin and local enrollment URLs. Restart hub; redistribute enrollment files and restart EVERY reporter. Remote agents were not changed.');
  }else throw Error('Unknown command. Run with --help.');
}catch(error){console.error(error.message);process.exitCode=1;}
