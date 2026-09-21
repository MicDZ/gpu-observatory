import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

const MINUTE=60000, DAY=86400000, HOUR=3600000;
const metrics=['observed_ms','util_ms','util_observed_ms','memory_mib_ms','capacity_mib_ms','memory_observed_ms','busy_ms','process_observed_ms'];
const sumUpdates=metrics.map(k=>`${k}=${k}+excluded.${k}`).join(',');
const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const dayKey=t=>new Date(t).toISOString().slice(0,10);
const bad=message=>Object.assign(new Error(message),{status:400});

export function historyRange(options={},now=Date.now(),retentionDays=365){
  const today=Math.floor(now/DAY)*DAY;
  const parse=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw bad('历史日期无效');
    const time=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(time)||dayKey(time)!==value)throw bad('历史日期无效');return time;
  };
  let from,to;
  if(options.from!==undefined||options.to!==undefined){from=parse(options.from);to=parse(options.to);}
  else{const days=Number(options.days??7);if(!Number.isInteger(days)||days<1||days>retentionDays)throw bad('历史日期范围超出限制');to=today;from=today-(days-1)*DAY;}
  const earliest=today-(retentionDays-1)*DAY;
  if(to<from||to>today||from<earliest||to-from>=retentionDays*DAY)throw bad('历史日期范围超出限制');
  return {from,to,fromDate:dayKey(from),toDate:dayKey(to),earliestDate:dayKey(earliest)};
}
function gpuMetrics(row){
  return {observedGpuHours:row.observed_ms/HOUR,utilizationHours:row.util_ms/(100*HOUR),busyGpuHours:row.busy_ms/HOUR,
    avgUtilization:row.util_observed_ms?row.util_ms/row.util_observed_ms:null,
    avgMemoryGiB:row.memory_observed_ms?row.memory_mib_ms/row.memory_observed_ms/1024:null,
    memoryPercent:row.capacity_mib_ms?row.memory_mib_ms/row.capacity_mib_ms*100:null,
    utilizationObservedHours:row.util_observed_ms/HOUR,processObservedHours:row.process_observed_ms/HOUR};
}
function sampleOf(host,snapshot,at){
  return {ownerId:host.ownerId,hostId:host.id,hostName:host.name,at,error:!!snapshot.error,gpus:snapshot.gpus.map(g=>{
    const users=new Map(),seenPids=new Set();
    if(g.processesAvailable)for(const p of g.processes){
      // Count one OS user once per GPU, regardless of how many PIDs they own.
      if(seenPids.has(p.pid))continue;seenPids.add(p.pid);
      const username=p.username||'';const u=users.get(username)||{username,memory:0,memoryKnown:true};
      if(valid(p.gpuMemory))u.memory+=p.gpuMemory;else u.memoryKnown=false;users.set(username,u);
    }
    return {uuid:g.uuid,index:g.index,name:g.name||'GPU',utilization:g.utilization,memoryUsed:g.memoryUsed,memoryTotal:g.memoryTotal,
      processesAvailable:g.processesAvailable,users:[...users.values()]};
  })};
}

export class HistoryStore {
  constructor({file=':memory:',minuteRetentionDays=30,dailyRetentionDays=365,maxGapSeconds=30,now=Date.now}={}){
    if(!Number.isInteger(minuteRetentionDays)||minuteRetentionDays<1||minuteRetentionDays>90||!Number.isInteger(dailyRetentionDays)||dailyRetentionDays<Math.max(7,minuteRetentionDays)||dailyRetentionDays>730||!Number.isFinite(maxGapSeconds)||maxGapSeconds<5||maxGapSeconds>60)throw Error('Invalid history retention configuration');
    this.now=now;this.minuteDays=minuteRetentionDays;this.dailyDays=dailyRetentionDays;this.gapMs=maxGapSeconds*1000;this.pending=new Map();this.lastError=false;this.lastPrune=-Infinity;
    if(file!==':memory:'){
      mkdirSync(dirname(file),{recursive:true,mode:0o700});
      if(!existsSync(file))closeSync(openSync(file,'wx',0o600));chmodSync(file,0o600);
    }
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>1){this.db.close();throw Error('History database was created by a newer version');}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_cursor(host_id TEXT PRIMARY KEY,report_id TEXT NOT NULL,received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_gpu(id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,host_id TEXT NOT NULL,host_name TEXT NOT NULL,gpu_uuid TEXT NOT NULL,gpu_index INTEGER NOT NULL,gpu_name TEXT NOT NULL,UNIQUE(owner_id,host_id,gpu_uuid));
      CREATE INDEX IF NOT EXISTS history_gpu_owner ON history_gpu(owner_id,host_id);
      ${['minute','day'].map(level=>`CREATE TABLE IF NOT EXISTS gpu_${level}(gpu_id INTEGER NOT NULL REFERENCES history_gpu(id) ON DELETE CASCADE,bucket INTEGER NOT NULL,${metrics.map(k=>k+' REAL NOT NULL').join(',')},peak_util REAL,peak_memory_mib REAL,PRIMARY KEY(gpu_id,bucket));
        CREATE INDEX IF NOT EXISTS gpu_${level}_bucket ON gpu_${level}(bucket);
        CREATE TABLE IF NOT EXISTS user_${level}(gpu_id INTEGER NOT NULL REFERENCES history_gpu(id) ON DELETE CASCADE,bucket INTEGER NOT NULL,username TEXT NOT NULL,occupied_ms REAL NOT NULL,memory_mib_ms REAL NOT NULL,memory_observed_ms REAL NOT NULL,PRIMARY KEY(gpu_id,bucket,username));
        CREATE INDEX IF NOT EXISTS user_${level}_bucket ON user_${level}(bucket);`).join('\n')}
      PRAGMA user_version=1;
    `);
    this.db.prepare('INSERT OR IGNORE INTO history_meta VALUES (?,?)').run('started_at',now());
    this.startedAt=this.db.prepare('SELECT value FROM history_meta WHERE key=?').get('started_at').value;
    this.statements={cursor:this.db.prepare('SELECT report_id,received_at FROM history_cursor WHERE host_id=?'),
      setCursor:this.db.prepare('INSERT INTO history_cursor VALUES (?,?,?) ON CONFLICT(host_id) DO UPDATE SET report_id=excluded.report_id,received_at=excluded.received_at'),
      gpu:this.db.prepare('INSERT INTO history_gpu(owner_id,host_id,host_name,gpu_uuid,gpu_index,gpu_name) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,host_id,gpu_uuid) DO UPDATE SET host_name=excluded.host_name,gpu_index=excluded.gpu_index,gpu_name=excluded.gpu_name RETURNING id')};
    for(const level of ['minute','day']){
      this.statements['gpu_'+level]=this.db.prepare(`INSERT INTO gpu_${level}(gpu_id,bucket,${metrics.join(',')},peak_util,peak_memory_mib) VALUES (${Array(12).fill('?').join(',')}) ON CONFLICT(gpu_id,bucket) DO UPDATE SET ${sumUpdates},peak_util=CASE WHEN excluded.peak_util IS NULL THEN peak_util WHEN peak_util IS NULL THEN excluded.peak_util ELSE MAX(peak_util,excluded.peak_util) END,peak_memory_mib=CASE WHEN excluded.peak_memory_mib IS NULL THEN peak_memory_mib WHEN peak_memory_mib IS NULL THEN excluded.peak_memory_mib ELSE MAX(peak_memory_mib,excluded.peak_memory_mib) END`);
      this.statements['user_'+level]=this.db.prepare(`INSERT INTO user_${level} VALUES (?,?,?,?,?,?) ON CONFLICT(gpu_id,bucket,username) DO UPDATE SET occupied_ms=occupied_ms+excluded.occupied_ms,memory_mib_ms=memory_mib_ms+excluded.memory_mib_ms,memory_observed_ms=memory_observed_ms+excluded.memory_observed_ms`);
    }
    this.prune(now());
    if(file!==':memory:')for(const suffix of ['','-wal','-shm'])if(existsSync(file+suffix))chmodSync(file+suffix,0o600);
  }
  record(host,snapshot,at=this.now()){
    const cursor=this.statements.cursor.get(host.id);
    if(cursor?.report_id===snapshot.reportId)return false;
    const receivedAt=Math.max(at,cursor?.received_at??at);
    const previous=this.pending.get(host.id),next=sampleOf(host,snapshot,receivedAt);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // A restart, owner change, clock reversal or long reporting gap starts a new
      // baseline. Never extrapolate the most recent report into unobserved time.
      if(previous&&!previous.error&&previous.ownerId===host.ownerId&&at>previous.at&&at-previous.at<=this.gapMs){
        for(const gpu of previous.gpus){
          const {id}=this.statements.gpu.get(previous.ownerId,host.id,host.name||host.id,gpu.uuid,gpu.index,gpu.name);
          for(let start=previous.at;start<at;){
            const end=Math.min(at,(Math.floor(start/MINUTE)+1)*MINUTE),dt=end-start;
            const util=valid(gpu.utilization)&&gpu.utilization<=100,mem=valid(gpu.memoryUsed)&&valid(gpu.memoryTotal)&&gpu.memoryTotal>0&&gpu.memoryUsed<=gpu.memoryTotal;
            const values=[dt,util?gpu.utilization*dt:0,util?dt:0,mem?gpu.memoryUsed*dt:0,mem?gpu.memoryTotal*dt:0,mem?dt:0,util&&gpu.utilization>=5?dt:0,gpu.processesAvailable?dt:0];
            for(const [level,width] of [['minute',MINUTE],['day',DAY]]){
              const bucket=Math.floor(start/width)*width;
              this.statements['gpu_'+level].run(id,bucket,...values,util?gpu.utilization:null,mem?gpu.memoryUsed:null);
              if(gpu.processesAvailable)for(const user of gpu.users)this.statements['user_'+level].run(id,bucket,user.username,dt,user.memoryKnown?user.memory*dt:0,user.memoryKnown?dt:0);
            }
            start=end;
          }
        }
      }
      this.statements.setCursor.run(host.id,snapshot.reportId,receivedAt);this.db.exec('COMMIT');
      this.pending.set(host.id,next);this.lastError=false;
    }catch(error){this.db.exec('ROLLBACK');this.pending.delete(host.id);this.lastError=true;throw error;}
    return true;
  }
  forgetBaseline(ownerId){for(const [id,sample] of this.pending)if(sample.ownerId===ownerId)this.pending.delete(id);}
  removeHost(hostId){
    this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('DELETE FROM history_gpu WHERE host_id=?').run(hostId);this.db.prepare('DELETE FROM history_cursor WHERE host_id=?').run(hostId);this.db.exec('COMMIT');this.pending.delete(hostId);}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  reconcile(activeHostIds){
    const active=new Set(activeHostIds);
    for(const row of this.db.prepare('SELECT DISTINCT host_id FROM history_gpu').all())if(!active.has(row.host_id))this.removeHost(row.host_id);
  }
  prune(at=this.now()){
    if(at-this.lastPrune<HOUR)return;
    const today=Math.floor(at/DAY)*DAY;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const [level,days] of [['minute',this.minuteDays],['day',this.dailyDays]])for(const table of ['gpu','user'])this.db.prepare(`DELETE FROM ${table}_${level} WHERE bucket<?`).run(today-(days-1)*DAY);
      this.db.prepare('DELETE FROM history_cursor WHERE received_at<?').run(at-DAY);
      this.db.exec('DELETE FROM history_gpu WHERE NOT EXISTS(SELECT 1 FROM gpu_day WHERE gpu_id=history_gpu.id) AND NOT EXISTS(SELECT 1 FROM gpu_minute WHERE gpu_id=history_gpu.id)');
      this.db.exec('COMMIT');this.lastPrune=at;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  query(ownerId,options={},at=this.now()){
    const range=historyRange(options,at,this.dailyDays),hostId=options.hostId||'';
    const filter='g.owner_id=? AND (?=\'\' OR g.host_id=?) AND m.bucket>=? AND m.bucket<?';
    const params=[ownerId,hostId,hostId,range.from,range.to+DAY];
    const daily=this.db.prepare(`SELECT m.bucket,${metrics.map(k=>`SUM(m.${k}) AS ${k}`).join(',')},MAX(m.peak_util) AS peakUtilization,MAX(m.peak_memory_mib)/1024 AS peakMemoryGiB FROM gpu_day m JOIN history_gpu g ON g.id=m.gpu_id WHERE ${filter} GROUP BY m.bucket ORDER BY m.bucket`).all(...params);
    const byDay=new Map(daily.map(r=>[r.bucket,r]));const series=[];
    for(let day=range.from;day<=range.to;day+=DAY){const row=byDay.get(day);series.push({date:dayKey(day),...(row?{...gpuMetrics(row),peakUtilization:row.peakUtilization,peakMemoryGiB:row.peakMemoryGiB}:{observedGpuHours:0,utilizationHours:0,busyGpuHours:0,avgUtilization:null,avgMemoryGiB:null,memoryPercent:null,utilizationObservedHours:0,processObservedHours:0,peakUtilization:null,peakMemoryGiB:null})});}
    const total=Object.fromEntries(metrics.map(k=>[k,daily.reduce((sum,row)=>sum+row[k],0)]));
    const leaderboard=this.db.prepare(`SELECT g.host_id AS hostId,g.host_name AS hostName,g.gpu_index AS gpuIndex,g.gpu_name AS gpuName,${metrics.map(k=>`SUM(m.${k}) AS ${k}`).join(',')} FROM gpu_day m JOIN history_gpu g ON g.id=m.gpu_id WHERE ${filter} GROUP BY g.id ORDER BY SUM(m.util_ms) DESC,g.host_id,g.gpu_index LIMIT 100`).all(...params).map(row=>({hostId:row.hostId,hostName:row.hostName,gpuIndex:row.gpuIndex,gpuName:row.gpuName,...gpuMetrics(row)}));
    const users=this.db.prepare(`SELECT m.username,SUM(m.occupied_ms)/${HOUR} AS occupiedGpuHours,SUM(m.memory_mib_ms)/${1024*HOUR} AS memoryGiBHours,SUM(m.memory_observed_ms)/${HOUR} AS memoryObservedHours FROM user_day m JOIN history_gpu g ON g.id=m.gpu_id WHERE ${filter} GROUP BY m.username ORDER BY SUM(m.occupied_ms) DESC,m.username LIMIT 100`).all(...params);
    const hosts=this.db.prepare('SELECT host_id AS id,MAX(host_name) AS name FROM history_gpu WHERE owner_id=? GROUP BY host_id ORDER BY name').all(ownerId);
    return {enabled:true,timezone:'UTC',range:{from:range.fromDate,to:range.toDate,earliest:range.earliestDate},startedAt:this.startedAt,retention:{minuteDays:this.minuteDays,dailyDays:this.dailyDays},maxGapSeconds:this.gapMs/1000,writeError:this.lastError,summary:{...gpuMetrics(total),daysWithData:daily.length},days:series,devices:leaderboard,users,hosts};
  }
  close(){if(this.closed)return;this.closed=true;this.pending.clear();this.db.close();}
}
