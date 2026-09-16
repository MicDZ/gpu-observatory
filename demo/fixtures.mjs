// Entirely invented examples. No machine discovery, subprocesses or real metrics.
const GiB=1024**3;
const queueEpoch=Math.floor(Date.now()/60000)*60000;
const specs=[['atlas-01','NVIDIA H100 80GB HBM3',4,81920,64,512],['orion-02','NVIDIA A100-SXM4-80GB',4,81920,48,256],['nova-03','NVIDIA RTX 4090',2,24576,32,128]];
const users=['alice','bob','charlie','erin'];
export function snapshot(now=Date.now()){
 const hosts=specs.map(([id,model,count,vram,cores,ram],h)=>{
  const processes=users.map((username,p)=>({username,pid:12000+h*100+p,name:p===3?'jupyter':'python',cpuPercent:[420,250,120,35][p],rss:[28,16,8,2][p]*GiB}));
  const percent=[72,48,23][h],memoryPercent=[62,44,31][h];
  return {id,name:id,hostname:id,status:'online',systemStatus:'online',receivedAt:now-2000,collectedAt:now-2200,clockSkewSeconds:0,driverVersion:'570.00',agentVersion:'1.1.0',error:null,
   gpus:Array.from({length:count},(_,i)=>{const busy=!(h===1&&i===3||h===2&&i===1),used=busy?Math.round(vram*[.78,.62,.44,.83][i%4]):0;return {uuid:`GPU-demo-${h}-${i}`,index:i,name:model,utilization:busy?[94,78,66,89][i%4]:0,memoryUsed:used,memoryTotal:vram,temperature:busy?62+i*2:33,powerDraw:busy?280+i*12:24,powerLimit:h===2?450:350,processesAvailable:true,processes:busy?[{pid:12000+h*100+i,username:users[i%4],command:'python',gpuMemory:used}]:[]};}),
   system:{error:null,collectedAt:now-2200,sampleSeconds:5,processCount:180+h*40,restrictedProcesses:0,cpu:{model:h===2?'AMD Ryzen 9 7950X':'AMD EPYC 9354',physicalCores:cores/2,logicalCores:cores,percent,perCore:Array.from({length:cores},(_,i)=>(percent+i*7)%100),loadAverage:[percent/4,percent/5,percent/6]},memory:{total:ram*GiB,used:ram*GiB*memoryPercent/100,available:ram*GiB*(100-memoryPercent)/100,percent:memoryPercent,free:ram*GiB*.12,cached:ram*GiB*.18,buffers:GiB,shared:.5*GiB,swapUsed:0,swapTotal:8*GiB,swapPercent:0},topCpuProcesses:processes,topMemoryProcesses:processes}}
 });return {serverTime:now,username:'demo',hosts};
}
export function queue(now=Date.now()){
 const sample=Math.floor(now/60000)*60000,delta=Math.floor((sample-queueEpoch)/1000);
 const jobs=Array.from({length:8},(_,i)=>({jobId:String(8100+i),username:users[i%4],partition:i===6?'interactive':'gpu-batch',state:i<3?'PENDING':'RUNNING',nodes:i===5?2:1,cpus:16,memory:'64G',elapsed:i<3?'0:00':'2:15:00',elapsedSeconds:i<3?0:8100+i*530+delta,pendingSeconds:i<3?540+i*270+delta:120,timeLimit:'1-00:00:00',priority:2000-i*100,reason:i<2?'Resources':i===2?'Priority':'None',tres:'cpu=16,mem=64G,gres/gpu=2',tresPerJob:'gres/gpu:2'}));
 return {serverTime:now,sources:[{id:'demo-cluster',name:'Aurora Research · Demo cluster',collectorUser:'demo',scope:'visible',visibility:'account-visible',intervalSeconds:60,status:'online',receivedAt:sample,jobSampledAt:sample,lastSuccessfulAt:sample,error:null,warning:null,jobs,counts:{running:5,pending:3,other:0,visible:8},partitions:[{name:'gpu-batch',availability:'up',nodes:6,state:'mix'},{name:'gpu-batch',availability:'up',nodes:2,state:'idle'},{name:'interactive',availability:'up',nodes:1,state:'idle'}]}]};
}
