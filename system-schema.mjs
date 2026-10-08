const value = (v, max = 1e15) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const text = (v, max = 200) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max) : null;
const count = (v, max = 1e7) => Number.isInteger(v) ? value(v,max) : null;
const storage = (v, max = 1e18) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;

export function normalizeSystem(s) {
  if (s == null) return null; // Backward compatible during rolling upgrades.
  if (typeof s !== 'object' || Array.isArray(s)) throw new Error('Invalid system data');
  if (s.error) {
    if (typeof s.error !== 'string') throw new Error('Invalid system error');
    return { error: text(s.error) };
  }
  if (!s.cpu || !s.memory || !Number.isSafeInteger(s.collectedAt) || s.collectedAt <= 0 ||
      !Array.isArray(s.cpu.perCore) || s.cpu.perCore.length > 4096) throw new Error('Invalid system sample');
  const logical = count(s.cpu.logicalCores,4096);
  if (!logical || s.cpu.perCore.length !== logical || s.cpu.perCore.some(p=>value(p,100)===null)) throw new Error('Invalid CPU data');
  const cpu = { model:text(s.cpu.model), logicalCores:logical, physicalCores:count(s.cpu.physicalCores,logical),
    percent:value(s.cpu.percent,100), perCore:s.cpu.perCore.map(p=>value(p,100)),
    loadAverage:Array.isArray(s.cpu.loadAverage) && s.cpu.loadAverage.length===3 ? s.cpu.loadAverage.map(n=>value(n,1e7)) : null };
  const total=value(s.memory.total), available=value(s.memory.available,total);
  if (!total || available===null) throw new Error('Invalid memory data');
  const memory={total,available,used:total-available,percent:Math.round((total-available)/total*1000)/10};
  for(const k of ['free','cached','buffers','shared'])memory[k]=value(s.memory[k],total);
  memory.swapTotal=value(s.memory.swapTotal);memory.swapUsed=value(s.memory.swapUsed,memory.swapTotal);
  memory.swapPercent=memory.swapTotal===0?0:memory.swapTotal&&memory.swapUsed!==null?Math.round(memory.swapUsed/memory.swapTotal*1000)/10:null;
  const diskList = s.disks == null ? [] : s.disks;
  if (!Array.isArray(diskList) || diskList.length > 64) throw new Error('Invalid disk data');
  const seenMounts = new Set();
  const disks = diskList.map(d => {
    if (!d || typeof d.device !== 'string' || typeof d.mountpoint !== 'string' ||
        typeof d.fstype !== 'string' || !d.mountpoint || seenMounts.has(d.mountpoint)) throw new Error('Invalid disk data');
    const total = storage(d.total), free = storage(d.free, total);
    if (!total || free === null) throw new Error('Invalid disk capacity');
    seenMounts.add(d.mountpoint);
    const used = Math.max(0, total - free);
    return { device:text(d.device,256), mountpoint:text(d.mountpoint,512), fstype:text(d.fstype,64),
      total, free, used, percent:Math.round(used / total * 1000) / 10, readonly:d.readonly === true };
  }).sort((a,b)=>a.mountpoint.localeCompare(b.mountpoint));
  if (s.diskError != null && typeof s.diskError !== 'string') throw new Error('Invalid disk error');
  const diskUserList = s.diskUsers == null ? [] : s.diskUsers;
  if (!Array.isArray(diskUserList) || diskUserList.length > 500) throw new Error('Invalid disk users');
  const seenDiskUsers = new Set();
  const diskUsers = diskUserList.map(u => {
    if (!u || typeof u.username !== 'string' || !u.username || u.username.length > 128 || seenDiskUsers.has(u.username)) throw new Error('Invalid disk user');
    const bytes = storage(u.bytes);
    if (bytes === null) throw new Error('Invalid disk user bytes');
    seenDiskUsers.add(u.username);
    return {username:text(u.username,128), bytes, paths:count(u.paths,1e6) ?? 0, partial:u.partial === true};
  }).sort((a,b)=>b.bytes-a.bytes);
  if (s.diskUsersAt != null && (!Number.isSafeInteger(s.diskUsersAt) || s.diskUsersAt <= 0)) throw new Error('Invalid disk users timestamp');
  if (s.diskUsersPartial != null && typeof s.diskUsersPartial !== 'boolean') throw new Error('Invalid disk users partial flag');
  if (s.diskUsersScanning != null && typeof s.diskUsersScanning !== 'boolean') throw new Error('Invalid disk users scanning flag');
  if (s.diskUsersError != null && typeof s.diskUsersError !== 'string') throw new Error('Invalid disk users error');
  const diskRoots = s.diskUsersRoots == null ? [] : s.diskUsersRoots;
  if (!Array.isArray(diskRoots) || diskRoots.length > 32 || diskRoots.some(x=>typeof x !== 'string')) throw new Error('Invalid disk users roots');
  const diskUsersRoots = diskRoots.map(x=>text(x,256));
  const processes = list => {
    if(!Array.isArray(list)||list.length>20)throw new Error('Invalid system processes');
    return list.map(p=>{
      if(!p||!Number.isInteger(p.pid)||p.pid<=0)throw new Error('Invalid process');
      return {pid:p.pid,username:text(p.username,128),name:text(p.name,240),cpuPercent:value(p.cpuPercent,logical*100),rss:value(p.rss)};
    });
  };
  return {collectedAt:s.collectedAt,sampleSeconds:value(s.sampleSeconds,86400),cpu,memory,disks,diskError:text(s.diskError),
    diskUsers,diskUsersAt:s.diskUsersAt??null,diskUsersPartial:s.diskUsersPartial===true,diskUsersScanning:s.diskUsersScanning===true,
    diskUsersError:text(s.diskUsersError),diskUsersRoots,
    processCount:count(s.processCount),restrictedProcesses:count(s.restrictedProcesses),
    topCpuProcesses:processes(s.topCpuProcesses),topMemoryProcesses:processes(s.topMemoryProcesses),error:null};
}
