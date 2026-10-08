(() => {
  const T = (key, values) => window.I18n?.t(key, values) ?? key;
  if(document.body.dataset.page!=='dashboard')return;
  const Time=window.LiveTime;
  const $=id=>document.getElementById(id);
  const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
  const gib=n=>Number.isFinite(n)?fmt(n/1024**3):'—';
  const resourceName=kind=>kind==='cpu'?'CPU':kind==='memory'?T('内存'):T('硬盘');
  const read=name=>{try{return new Set(JSON.parse(sessionStorage.getItem('resource-open-'+name))||[]);}catch{return new Set();}};
  const opened={cpu:read('cpu'),memory:read('memory'),disk:read('disk')};let snapshot=window.monitorHostSnapshot||null,shownStatuses='';
  const remember=kind=>{try{sessionStorage.setItem('resource-open-'+kind,JSON.stringify([...opened[kind]]));}catch{}};
  const status=h=>Time.systemStatus(h,Time.now());
  const statusKey=()=>snapshot?.hosts.map(status).join('|')||'';
  const metric=(label,value)=>{const e=make('div');e.append(make('span','',label),make('strong','',value));return e;};
  function meter(percent,label){
    const e=make('div','resource-meter');e.append(make('span','',label));
    if(Number.isFinite(percent)){const p=make('progress');p.max=100;p.value=percent;p.setAttribute('aria-label',label);e.append(p);}return e;
  }
  function processTable(host,kind){
    const s=host.system,list=kind==='cpu'?s.topCpuProcesses:s.topMemoryProcesses;
    const block=make('div','resource-processes');
    block.append(make('div','detail-heading',T('{resource}占用前 {count} 个可读取进程',{resource:kind==='cpu'?'CPU':T('内存'),count:list.length})));
    const wrap=make('div','process-table-wrap'),table=make('table','process-table'),head=make('thead'),headRow=make('tr');
    table.setAttribute('aria-label',T('{host} {resource}进程详情',{host:host.name,resource:kind==='cpu'?'CPU':T('内存')}));
    for(const label of [T("用户"),'PID',T("进程"),kind==='cpu'?T("CPU %（单核）"):'RSS GiB'])headRow.append(make('th','',label));
    head.append(headRow);table.append(head);const body=make('tbody');
    for(const p of list){const row=make('tr');row.append(make('td','user-cell',p.username||T("未知 / 无权限")),make('td','pid-cell',p.pid),make('td','process-command',p.name||T("不可读取")),make('td','number-cell',kind==='cpu'?fmt(p.cpuPercent):gib(p.rss)));body.append(row);}
    table.append(body);wrap.append(table);block.append(wrap);
    if(!list.length)block.append(make('p','process-empty',T("暂无可读取的进程采样。")));
    if(s.restrictedProcesses)block.append(make('p','queue-note',T('{count} 个进程的部分字段不可读取；排名仅基于可读取数据。',{count:s.restrictedProcesses})));
    return block;
  }
  function diskTable(disks){
    const wrap=make('div','process-table-wrap'),table=make('table','process-table disk-table'),head=make('thead'),headRow=make('tr');
    table.setAttribute('aria-label',T('文件系统详情'));
    for(const label of [T("挂载点"),T("设备"),T("文件系统"),T("已用 / 总量"),T("可用"),T("占用"),T("只读")])headRow.append(make('th','',label));
    head.append(headRow);table.append(head);const body=make('tbody');
    for(const d of disks){
      const row=make('tr');
      row.append(make('td','process-command',d.mountpoint),make('td','process-command',d.device||'—'),make('td','',d.fstype||'—'),
        make('td','number-cell',`${gib(d.used)} / ${gib(d.total)} GiB`),make('td','number-cell',gib(d.free)+' GiB'),
        make('td','number-cell',fmt(d.percent)+'%'),make('td','',d.readonly?T("是"):T("否")));
      body.append(row);
    }
    table.append(body);wrap.append(table);return wrap;
  }
  function diskUserTable(users){
    const total=users.reduce((n,u)=>n+u.bytes,0);
    const wrap=make('div','process-table-wrap'),table=make('table','process-table disk-user-table'),head=make('thead'),headRow=make('tr');
    table.setAttribute('aria-label',T('按用户硬盘统计'));
    for(const label of [T("用户"),T("已用"),T("占可读空间"),T("目录数"),T("状态")])headRow.append(make('th','',label));
    head.append(headRow);table.append(head);const body=make('tbody');
    for(const u of users){
      const row=make('tr');
      row.append(make('td','user-cell',u.username),make('td','number-cell',gib(u.bytes)+' GiB'),
        make('td','number-cell',fmt(total?u.bytes/total*100:null)+'%'),make('td','number-cell',u.paths),
        make('td','',u.partial?T("部分"):T("完整")));
      body.append(row);
    }
    table.append(body);wrap.append(table);return wrap;
  }
  function detail(host,kind){
    const s=host.system,box=make('div','resource-detail');
    if(!s||s.error){box.append(make('p','notice',s?.error||T("等待主机上报 {resource} 数据。",{resource:resourceName(kind)})));return box;}
    if(kind==='disk'){
      if(s.diskError)box.append(make('p','notice',s.diskError));
      if(!s.disks?.length)box.append(make('p','process-empty',T("未检测到可访问的本地文件系统。")));
      else box.append(diskTable(s.disks));
      if(s.diskUsersError)box.append(make('p','notice',s.diskUsersError));
      const users=s.diskUsers||[];
      if(users.length){
        box.append(make('div','detail-heading',T('按用户统计 · {count} 个用户',{count:users.length})));
        box.append(diskUserTable(users));
      }else if(s.diskUsersScanning)box.append(make('p','process-empty',T("正在后台统计各用户硬盘用量…")));
      else box.append(make('p','process-empty',T("尚未生成按用户统计。")));
      if(s.diskUsersAt){const note=make('p','queue-note');note.append(T("上次扫描："),Time.bindAge(make('span'),s.diskUsersAt));box.append(note);}
      if(s.diskUsersPartial)box.append(make('p','queue-note',T("按用户统计只包含 agent 可读取的共享目录；部分目录因权限或超时未计入。")));
      return box;
    }
    if(kind==='cpu'){
      box.append(make('div','detail-heading',T('{model} · 采样间隔 {seconds} 秒',{model:s.cpu.model||'CPU',seconds:fmt(s.sampleSeconds)})));
      const grid=make('div','core-grid');
      s.cpu.perCore.forEach((percent,i)=>{const tile=make('div','core-cell '+(percent>=80?'hot':percent>=40?'warm':'cool'));tile.append(make('span','',`#${i}`),make('strong','',fmt(percent,0)+'%'));tile.title=T('逻辑核心 {index}: {percent}%',{index:i,percent:fmt(percent)});grid.append(tile);});
      box.append(grid);
    }else{
      const m=s.memory,grid=make('div','memory-breakdown');
      for(const [label,value] of [[T("可用"),m.available],[T("空闲内存"),m.free],[T("缓存"),m.cached],[T("缓冲区"),m.buffers],[T("共享"),m.shared]])grid.append(metric(label,gib(value)+' GiB'));
      grid.append(metric(T("Swap 已用 / 总量"),`${gib(m.swapUsed)} / ${gib(m.swapTotal)} GiB`));
      box.append(grid,make('p','queue-note',T("缓存、共享等字段可能重叠；“可用”包含可回收内存，不能把这些明细直接相加。")));
    }
    box.append(processTable(host,kind));return box;
  }
  function renderKind(kind){
    const summary=$(kind+'-summary'),list=$(kind+'-hosts'),query=$(kind+'-search').value.trim().toLowerCase();
    const online=snapshot.hosts.filter(h=>status(h)==='online'&&h.system&&!h.system.error);
    const resource=resourceName(kind);
    if(kind==='cpu'){
      const logical=online.reduce((n,h)=>n+h.system.cpu.logicalCores,0);
      const knownCpu=online.filter(h=>Number.isFinite(h.system.cpu.percent)),knownCores=knownCpu.reduce((n,h)=>n+h.system.cpu.logicalCores,0);
      const cpu=knownCores?knownCpu.reduce((n,h)=>n+h.system.cpu.percent*h.system.cpu.logicalCores,0)/knownCores:null;
      summary.replaceChildren(metric(T("在线主机"),`${online.length}/${snapshot.hosts.length}`),metric(T("总利用率（核心加权）"),fmt(cpu)+'%'),metric(T("逻辑核心"),logical),metric(T("可见进程"),online.reduce((n,h)=>n+(h.system.processCount||0),0)));
    }else if(kind==='memory'){
      const ramTotal=online.reduce((n,h)=>n+h.system.memory.total,0),ramUsed=online.reduce((n,h)=>n+h.system.memory.used,0);
      const swapTotal=online.reduce((n,h)=>n+(h.system.memory.swapTotal||0),0),swapUsed=online.reduce((n,h)=>n+(h.system.memory.swapUsed||0),0);
      summary.replaceChildren(metric(T("在线主机"),`${online.length}/${snapshot.hosts.length}`),metric(T("RAM 已用 / 总量"),`${online.length?gib(ramUsed):'—'} / ${online.length?gib(ramTotal):'—'} GiB`),metric(T("利用率"),fmt(ramTotal?ramUsed/ramTotal*100:null)+'%'),metric('Swap',`${gib(swapUsed)} / ${gib(swapTotal)} GiB`));
    }else{
      const diskHosts=online.filter(h=>h.system.disks?.length);
      const total=diskHosts.reduce((n,h)=>n+h.system.disks.reduce((m,d)=>m+d.total,0),0);
      const free=diskHosts.reduce((n,h)=>n+h.system.disks.reduce((m,d)=>m+d.free,0),0);
      const used=Math.max(0,total-free),filesystems=diskHosts.reduce((n,h)=>n+h.system.disks.length,0);
      const warnings=diskHosts.reduce((n,h)=>n+h.system.disks.filter(d=>d.percent>=80).length,0);
      summary.replaceChildren(metric(T("在线主机"),`${online.length}/${snapshot.hosts.length}`),metric(T("总容量"),total?gib(total)+' GiB':'—'),metric(T("已用 / 总量"),total?`${gib(used)} / ${gib(total)} GiB`:'—'),metric(T("利用率"),total?fmt(used/total*100)+'%':'—'),metric(T("文件系统"),filesystems),metric(T("高占用（≥80%）"),warnings));
    }
    const fragment=document.createDocumentFragment();let matches=0;
    for(const host of snapshot.hosts){
      const s=host.system,procs=kind==='cpu'?s?.topCpuProcesses:kind==='memory'?s?.topMemoryProcesses:[];
      const searchable=(kind==='disk'
        ?`${host.name} ${host.hostname||''} ${(s?.disks||[]).map(d=>`${d.mountpoint} ${d.device} ${d.fstype}`).join(' ')} ${(s?.diskUsers||[]).map(u=>u.username).join(' ')}`
        :`${host.name} ${host.hostname||''} ${s?.cpu?.model||''} ${(procs||[]).map(p=>`${p.username} ${p.name} ${p.pid}`).join(' ')}`).toLowerCase();
      if(query&&!searchable.includes(query))continue;matches++;
      const card=make('article','resource-card'),header=make('div','resource-header'),left=make('div','resource-title'),toggle=make('button','host-toggle');
      const open=opened[kind].has(host.id);toggle.id=`resource-${kind}-${host.id}`;toggle.setAttribute('aria-expanded',String(open));
      toggle.setAttribute('aria-label',T('{action} {host} {resource}详情',{action:open?T('收起'):T('展开'),host:host.name,resource}));
      toggle.append(make('span','chevron',open?'▾':'▸'),make('strong','',host.name));
      toggle.addEventListener('click',()=>{open?opened[kind].delete(host.id):opened[kind].add(host.id);remember(kind);render();});
      const state=status(host);left.append(toggle,make('span','badge '+state,{online:T("在线"),offline:T("离线"),error:T("异常"),waiting:T("待上报")}[state]));
      header.append(left,Time.bindAge(make('span','resource-age'),host.receivedAt));card.append(header);
      if(!s||s.error)card.append(make('p','empty',s?.error||T("等待此主机的 {resource} 数据",{resource})));
      else {
        if(kind==='disk'&&s.diskError)card.append(make('p','notice',s.diskError));
        if(kind==='disk'&&!s.disks?.length)card.append(make('p','empty',T("未检测到可访问的本地文件系统。")));
        else {
          const row=make('div','resource-row '+kind+(state!=='online'?' stale':''));
          if(kind==='cpu'){
            row.append(metric(T("CPU 型号"),s.cpu.model||'—'),meter(s.cpu.percent,fmt(s.cpu.percent)+'%'),metric(T("物理核 / 逻辑核"),`${s.cpu.physicalCores??'—'} / ${s.cpu.logicalCores}`),metric(T("负载 1 / 5 / 15 分钟"),(s.cpu.loadAverage||[]).map(n=>fmt(n,2)).join(' / ')||'—'),metric(T("进程数"),s.processCount??'—'));
          }else if(kind==='memory'){
            const m=s.memory;row.append(meter(m.percent,fmt(m.percent)+'%'),metric(T("RAM 已用 / 总量"),`${gib(m.used)} / ${gib(m.total)} GiB`),metric(T("可用"),gib(m.available)+' GiB'),metric(T("缓存"),gib(m.cached)+' GiB'),metric(T("Swap 已用 / 总量"),`${gib(m.swapUsed)} / ${gib(m.swapTotal)} GiB`));
          }else{
            const disks=s.disks||[],total=disks.reduce((n,d)=>n+d.total,0),free=disks.reduce((n,d)=>n+d.free,0),used=Math.max(0,total-free);
            const worst=disks.reduce((best,d)=>!best||d.percent>best.percent?d:best,null);
            row.append(meter(total?used/total*100:null,fmt(total?used/total*100:null)+'%'),metric(T("已用 / 总量"),`${gib(used)} / ${gib(total)} GiB`),metric(T("可用"),gib(free)+' GiB'),metric(T("文件系统"),disks.length),metric(T("最高占用"),worst?`${worst.mountpoint} · ${fmt(worst.percent)}%`:'—'));
          }
          card.append(row);if(open)card.append(detail(host,kind));
        }
      }
      if(state==='offline')card.append(make('p','queue-note resource-offline',T("上报已中断，显示最后一次快照。")));
      fragment.append(card);
    }
    if(!matches)fragment.append(make('p','empty',T("没有符合筛选条件的主机或前 20 名进程")));
    list.replaceChildren(fragment);
  }
  function render(){
    if(!snapshot)return;const focus=document.activeElement?.id;
    shownStatuses=statusKey();renderKind('cpu');renderKind('memory');renderKind('disk');
    if(focus?.startsWith('resource-'))$(focus)?.focus({preventScroll:true});
  }
  for(const kind of ['cpu','memory','disk'])$(kind+'-search').addEventListener('input',render);
  document.addEventListener('host-snapshot',event=>{snapshot=event.detail;render();});
  document.addEventListener('ui-language',render);
  document.addEventListener('monitor-tick',()=>{if(snapshot&&statusKey()!==shownStatuses)render();});
  render();
})();
