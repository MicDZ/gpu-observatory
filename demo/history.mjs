// Fictional historical telemetry, generated without reading machines or databases.
import {historyRange} from '../history.mjs';
import {snapshot} from './fixtures.mjs';
const DAY=86400000;
export function historyDemo(options={},now=Date.now()){
 const range=historyRange(options,now),allHosts=snapshot(now).hosts,hosts=allHosts.filter(h=>!options.hostId||h.id===options.hostId);
 const deviceMap=new Map(),userMap=new Map(),days=[];
 for(let time=range.from;time<=range.to;time+=DAY){
  const index=Math.floor(time/DAY),missing=index%13===0,hours=time===Math.floor(now/DAY)*DAY?(now-time)/3600000:24;
  let observed=0,used=0,memory=0,capacity=0;
  for(const [hi,h] of hosts.entries())for(const g of h.gpus){
   if(missing)continue;
   const observedHours=hours*(.82+.1*Math.sin(index*.41+hi)),util=Math.max(5,Math.min(96,49+25*Math.sin(index*.68+g.index*.3+hi*.8)));
   const memPercent=35+22*Math.sin(index*.35+hi+g.index*.2),effective=observedHours*util/100;
   observed+=observedHours;used+=effective;memory+=observedHours*g.memoryTotal*memPercent/100;capacity+=observedHours*g.memoryTotal;
   const key=h.id+'/'+g.index,d=deviceMap.get(key)||{hostId:h.id,hostName:h.name,gpuIndex:g.index,gpuName:g.name,observedGpuHours:0,utilizationHours:0,busyGpuHours:0,utilizationObservedHours:0,processObservedHours:0};
   d.observedGpuHours+=observedHours;d.utilizationHours+=effective;d.busyGpuHours+=observedHours*.8;d.utilizationObservedHours+=observedHours;d.processObservedHours+=observedHours;deviceMap.set(key,d);
   const username=['alice','bob','charlie','erin'][(g.index+hi)%4],u=userMap.get(username)||{username,occupiedGpuHours:0,memoryGiBHours:0,memoryObservedHours:0};
   u.occupiedGpuHours+=observedHours*.8;u.memoryObservedHours+=observedHours*.8;u.memoryGiBHours+=observedHours*.8*g.memoryTotal/1024*memPercent/100;userMap.set(username,u);
  }
  days.push({date:new Date(time).toISOString().slice(0,10),observedGpuHours:observed,utilizationHours:used,busyGpuHours:observed*.8,avgUtilization:observed?used/observed*100:null,memoryPercent:capacity?memory/capacity*100:null,avgMemoryGiB:observed?memory/observed/1024:null,utilizationObservedHours:observed,processObservedHours:observed,peakUtilization:null,peakMemoryGiB:null});
 }
 const observed=days.reduce((n,d)=>n+d.observedGpuHours,0),used=days.reduce((n,d)=>n+d.utilizationHours,0);
 const devices=[...deviceMap.values()].map(d=>({...d,avgUtilization:d.utilizationHours/d.observedGpuHours*100})).sort((a,b)=>b.utilizationHours-a.utilizationHours);
 return {enabled:true,timezone:'UTC',range:{from:range.fromDate,to:range.toDate,earliest:range.earliestDate},startedAt:now-365*DAY,retention:{minuteDays:30,dailyDays:365},maxGapSeconds:30,writeError:false,
  summary:{observedGpuHours:observed,utilizationObservedHours:observed,processObservedHours:observed,utilizationHours:used,busyGpuHours:observed*.8,avgUtilization:observed?used/observed*100:null,daysWithData:days.filter(d=>d.observedGpuHours>0).length},days,devices,users:[...userMap.values()].sort((a,b)=>b.occupiedGpuHours-a.occupiedGpuHours),hosts:allHosts.map(h=>({id:h.id,name:h.name}))};
}
