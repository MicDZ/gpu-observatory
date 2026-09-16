const value = (v, max = 1e15) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const text = (v, max = 200) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max) : null;
const count = (v, max = 1e7) => Number.isInteger(v) ? value(v,max) : null;

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
  const processes = list => {
    if(!Array.isArray(list)||list.length>20)throw new Error('Invalid system processes');
    return list.map(p=>{
      if(!p||!Number.isInteger(p.pid)||p.pid<=0)throw new Error('Invalid process');
      return {pid:p.pid,username:text(p.username,128),name:text(p.name,240),cpuPercent:value(p.cpuPercent,logical*100),rss:value(p.rss)};
    });
  };
  return {collectedAt:s.collectedAt,sampleSeconds:value(s.sampleSeconds,86400),cpu,memory,
    processCount:count(s.processCount),restrictedProcesses:count(s.restrictedProcesses),
    topCpuProcesses:processes(s.topCpuProcesses),topMemoryProcesses:processes(s.topMemoryProcesses),error:null};
}
