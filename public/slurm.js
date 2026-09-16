(() => {
  const T = (key, values) => window.I18n?.t(key, values) ?? key;
  if (document.body.dataset.page !== 'dashboard') return;
  const Time = window.LiveTime;
  const $ = id => document.getElementById(id);
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const states = () => ({PENDING:T("排队中"),RUNNING:T("运行中"),COMPLETING:T("完成中"),CONFIGURING:T("准备中"),SUSPENDED:T("暂停")});
  let data = null, inFlight = false, selected = window.monitorActiveView || 'gpu', shownStatuses = '';
  const sourceStatus = source => Time.sourceStatus(source,Time.now(),Math.max(180,(source.intervalSeconds||60)*3));
  const statusKey = () => data?.sources.map(sourceStatus).join('|') || '';
  const opened = new Set(), pages = new Map(), partitionOpen = new Set();
  function partitions(source) {
    const details = make('details', 'partition-details'); details.open = partitionOpen.has(source.id);
    const total = (source.partitions || []).reduce((n,p) => n + p.nodes, 0);
    details.append(make('summary', '', T('分区节点状态 · {count} 个节点条目（点击展开）',{count:total})));
    details.addEventListener('toggle', () => { details.open ? partitionOpen.add(source.id) : partitionOpen.delete(source.id); });
    const grid = make('div','partition-grid'), grouped = new Map();
    for (const p of source.partitions || []) {
      if (!grouped.has(p.name)) grouped.set(p.name, []);
      grouped.get(p.name).push(p);
    }
    for (const [name, parts] of grouped) {
      const card = make('div','partition-item'); card.append(make('strong','',name));
      for (const p of parts) card.append(make('span','',`${p.state}: ${p.nodes}`));
      grid.append(card);
    }
    details.append(grid, make('p','queue-note',T("节点条目按分区统计；同一节点若属于多个分区可能重复。mix 表示部分资源已用，idle 为空闲；保留 Slurm 原始状态及后缀。")));
    return details;
  }
  function render() {
    if (!data) return;
    const focus = document.activeElement?.id;
    const root = document.createDocumentFragment(), search = $('slurm-search').value.trim().toLowerCase(), state = $('slurm-state').value;
    let visible = 0, healthy = data.sources.length > 0;
    shownStatuses=statusKey();
    for (const original of data.sources) {
      const source={...original,status:sourceStatus(original)};
      const total = source.counts?.visible;
      const hasTotal = Number.isSafeInteger(total) && total >= 0;
      healthy &&= source.status === 'online' && hasTotal;
      if (hasTotal) visible += total;
      const card = make('article','queue-card');
      const header = make('div','queue-header'), title = make('div','queue-title');
      title.append(make('strong','',source.name), make('span','badge ' + source.status, {online:T("在线"),offline:T("离线"),waiting:T("待接入"),error:T("采集异常")}[source.status]));
      const counts = make('div','queue-counts');
      for (const [label,key] of [[T("排队"),'pending'],[T("运行"),'running'],[T("其他"),'other'],[T("可见作业"),'visible']]) {
        const item = make('span','',label+' '); item.append(make('strong','', source.counts ? source.counts[key] : '—')); counts.append(item);
      }
      header.append(title,counts); card.append(header);
      card.append(Time.bindAge(make('p','queue-note source-age'),source.receivedAt,{key:'账号 {user} · {scope} · 最近上报 {age} · 每 {seconds} 秒采集',values:{user:source.collectorUser,scope:source.scope==='mine'?T('仅自己的作业'):T('账号可见队列'),seconds:source.intervalSeconds}}));
      if (source.visibility === 'private-jobs') card.append(make('p','queue-notice',T("集群启用了 PrivateData=jobs：仅显示该账号获准查看的作业；空队列不代表集群空闲。")));
      if (source.status !== 'online' && source.status !== 'waiting') card.append(make('p','notice', source.error || T("上报已超时，下方是历史快照，不代表当前队列。")));
      if (source.warning) card.append(make('p','notice',source.warning));
      if (source.partitions?.length) card.append(partitions(source));
      const jobs = (source.jobs || []).filter(j => (!search || `${j.jobId} ${j.username} ${j.partition} ${j.reason}`.toLowerCase().includes(search)) &&
        (state === 'all' || (state === 'other' ? !['PENDING','RUNNING'].includes(j.state) : j.state === state)));
      jobs.sort((a,b) => Number(b.state==='PENDING')-Number(a.state==='PENDING') || (b.priority||0)-(a.priority||0) || a.jobId.localeCompare(b.jobId,undefined,{numeric:true}));
      if (!jobs.length) card.append(make('p','empty queue-empty', source.status === 'waiting' ? T("等待登录节点首次上报") : (source.jobs?.length ? T("没有符合筛选条件的作业") : source.error ? T("暂无可用的成功采集快照") : T("当前账号可见队列为空"))));
      else {
        const wrap=make('div','queue-table-wrap'),table=make('table','queue-table'),head=make('thead'),tr=make('tr');
        for (const text of [T("作业 ID"),T("用户"),T("分区"),T("状态"),T("节点 / CPU"),T('等待时长'),T('运行时长'),T("原因"),T("详情")]) tr.append(make('th','',text));
        head.append(tr);table.append(head);const tbody=make('tbody');
        const page = Math.min(pages.get(source.id)||0,Math.floor((jobs.length-1)/15));pages.set(source.id,page);
        for (const job of jobs.slice(page*15,(page+1)*15)) {
          const key=source.id+'/'+job.jobId,row=make('tr',''),button=make('button','small-button',opened.has(key)?T("收起"):T("展开"));
          button.id='slurm-job-'+encodeURIComponent(key);button.setAttribute('aria-expanded',String(opened.has(key)));
          button.setAttribute('aria-label',T('作业 {id} 详情',{id:job.jobId}));
          button.addEventListener('click',()=>{opened.has(key)?opened.delete(key):opened.add(key);render();});
          row.append(make('td','',job.jobId),make('td','user-cell',job.username),make('td','',job.partition),make('td','',states()[job.state]||job.state),make('td','number-cell',`${job.nodes??'—'} / ${job.cpus??'—'}`),Time.bindJob(make('td','number-cell time-cell'),job,source,'wait'),Time.bindJob(make('td','number-cell time-cell'),job,source,'run'),make('td','queue-reason',job.reason==='None'?'—':job.reason||'—'));
          const action=make('td');action.append(button);row.append(action);tbody.append(row);
          if(opened.has(key)) {
            const detail=make('tr','queue-job-detail'),td=make('td');td.colSpan=9;
            td.textContent=T('优先级 {priority} · 内存 {memory} · 时限 {limit} · TRES {tres} · 每作业 TRES {perJob}',{priority:job.priority??'—',memory:job.memory||'—',limit:job.timeLimit||'—',tres:job.tres||'—',perJob:job.tresPerJob||'—'});
            detail.append(td);tbody.append(detail);
          }
        }
        table.append(tbody);wrap.append(table);card.append(wrap);
        const pager=make('div','queue-pager'),prev=make('button','small-button',T("上一页")),next=make('button','small-button',T("下一页"));
        prev.disabled=page===0;next.disabled=(page+1)*15>=jobs.length;
        prev.addEventListener('click',()=>{pages.set(source.id,page-1);render();});next.addEventListener('click',()=>{pages.set(source.id,page+1);render();});
        pager.append(make('span','',T('{count} 条 · 第 {page} / {pages} 页',{count:jobs.length,page:page+1,pages:Math.ceil(jobs.length/15)})),prev,next);card.append(pager);
      }
      if(source.truncated)card.append(make('p','notice',T("记录超过显示上限，仅展示前 5000 条；上方计数包含全部可见记录。")));
      root.append(card);
    }
    if(!data.sources.length)root.append(make('p','empty',T("尚未配置 Slurm 数据源")));
    $('slurm-sources').replaceChildren(root);
    $('slurm-tab-count').textContent=!data.sources.length?'—':healthy?visible:'!';
    $('slurm-tab-count').title=!data.sources.length?T('尚未配置 Slurm 数据源'):healthy?T('可见作业总数（含排队、运行及其他状态）'):T("队列源尚未就绪或上报已中断");
    if(focus?.startsWith('slurm-job-'))$(focus)?.focus({preventScroll:true});
  }
  async function refresh() {
    if(inFlight)return;inFlight=true;
    try {
      const response=await fetch('/api/slurm',{signal:AbortSignal.timeout(12000)});
      if(response.status===401){location.replace('/');return;}
      if(!response.ok)throw new Error();data=await response.json();Time.sync(data.serverTime);render();$('slurm-fetch-error').hidden=true;
    }catch{$('slurm-fetch-error').hidden=false;window.I18n.bind($('slurm-fetch-error'),'队列缓存读取失败，正在重试；已有数据可能过期。');}
    finally{inFlight=false;}
  }
  document.addEventListener('monitor-view',event=>{selected=event.detail;if(selected==='slurm')refresh();});
  document.addEventListener('ui-language',render);
  document.addEventListener('monitor-tick',()=>{if(data&&statusKey()!==shownStatuses)render();});
  for(const id of ['slurm-search','slurm-state'])$(id).addEventListener(id==='slurm-search'?'input':'change',()=>{pages.clear();render();});
  refresh();
  setInterval(()=>{if(selected==='slurm')refresh();},15000);
  setInterval(()=>{if(selected!=='slurm')refresh();},60000);
})();
