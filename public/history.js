(() => {
  if(document.body.dataset.page!=='dashboard')return;
  const $=id=>document.getElementById(id),T=(key,values)=>window.I18n.t(key,values);
  const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const fmt=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
  const percent=n=>Number.isFinite(n)?fmt(n,1)+'%':'—';
  let data=null,generation=0,controller=null,refreshTimer=null;
  const metric=(label,value)=>{const card=make('div');card.append(make('span','',T(label)),make('strong','',value));return card;};
  function notice(key){$('history-error').hidden=!key;if(key)window.I18n.bind($('history-error'),key);}
  function plot(target,key,label,color){
    const root=$(target),width=Math.max(320,root.clientWidth),height=190,pad={left:37,right:16,top:18,bottom:32};
    const w=width-pad.left-pad.right,h=height-pad.top-pad.bottom,days=data.days;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',T(label));
    const item=(tag,attrs,text)=>{const el=document.createElementNS(svg.namespaceURI,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;};
    const x=i=>pad.left+(days.length===1?w/2:i*w/(days.length-1)),y=v=>pad.top+h*(1-Math.min(100,Math.max(0,v))/100);
    for(const value of [0,25,50,75,100]){svg.append(item('line',{x1:pad.left,x2:width-pad.right,y1:y(value),y2:y(value),class:'history-grid'}),item('text',{x:pad.left-7,y:y(value)+3,'text-anchor':'end',class:'history-axis'},value+'%'));}
    const stride=Math.max(1,Math.ceil(days.length/Math.max(2,Math.floor(w/65))));
    for(let i=0;i<days.length;i++)if((i%stride===0&&(i===0||x(days.length-1)-x(i)>40))||i===days.length-1)svg.append(item('text',{x:x(i),y:height-9,'text-anchor':'middle',class:'history-axis'},days[i].date.slice(5)));
    let line='',open=false;
    for(let i=0;i<days.length;i++){const value=days[i][key];if(!Number.isFinite(value)){open=false;continue;}line+=(open?' L':' M')+x(i)+' '+y(value);open=true;}
    svg.append(item('path',{d:line,fill:'none',stroke:color,'stroke-width':2.5,'stroke-linecap':'round','stroke-linejoin':'round'}));
    for(let i=0;i<days.length;i++){const value=days[i][key];if(!Number.isFinite(value))continue;const dot=item('circle',{cx:x(i),cy:y(value),r:days.length>90?2:3.5,fill:color,tabindex:days.length<=31?'0':'-1'});dot.append(item('title',{},`${days[i].date} · ${T(label)} ${percent(value)} · ${T('采样 GPU 小时')} ${fmt(days[i].observedGpuHours)}`));svg.append(dot);}
    root.replaceChildren(svg);
  }
  function emptyRow(columns){const row=make('tr'),cell=make('td','history-muted',T('此范围暂无有效记录'));cell.colSpan=columns;row.append(cell);return row;}
  function render(){
    if(!data)return;
    if(!data.enabled){$('history-content').hidden=true;$('history-empty').hidden=true;notice('中心未启用历史数据库');return;}
    notice(data.writeError?'历史写入出现异常，部分时间段可能缺失；实时监控仍可使用。':null);
    for(const option of $('history-period').options)if(option.value!=='custom')option.disabled=Number(option.value)>data.retention.dailyDays;
    const s=data.summary,hasData=s.observedGpuHours>0;
    $('history-empty').hidden=hasData;$('history-content').hidden=false;
    $('history-summary').replaceChildren(metric('平均 GPU 利用率',percent(s.avgUtilization)),metric('折算 GPU 小时',s.utilizationObservedHours>0?fmt(s.utilizationHours):'—'),metric('采样 GPU 小时',fmt(s.observedGpuHours)),metric('有数据的天数',`${s.daysWithData} / ${data.days.length}`));
    window.I18n.bind($('history-quality'),'利用率有效采样 {util} GPU 小时 · 进程可见采样 {process} GPU 小时',{util:fmt(s.utilizationObservedHours),process:fmt(s.processObservedHours)});
    plot('history-util-chart','avgUtilization','每日平均 GPU 利用率','#8ee3b4');plot('history-memory-chart','memoryPercent','每日显存占用率','#8bb8ff');
    const deviceRows=document.createDocumentFragment();
    data.devices.forEach((d,i)=>{const row=make('tr'),name=make('td');name.append(make('strong','',`${d.hostName} · GPU ${d.gpuIndex}`),make('small','history-model',d.gpuName));row.append(make('td','history-muted',i+1),name,make('td','history-number',d.utilizationObservedHours>0?fmt(d.utilizationHours):'—'),make('td','history-number',percent(d.avgUtilization)),make('td','history-number',fmt(d.observedGpuHours)));deviceRows.append(row);});
    if(!data.devices.length)deviceRows.append(emptyRow(5));$('history-device-rows').replaceChildren(deviceRows);
    const userRows=document.createDocumentFragment();
    data.users.forEach((u,i)=>{const row=make('tr');row.append(make('td','history-muted',i+1),make('td','user-cell',u.username||T('未知用户')),make('td','history-number',fmt(u.occupiedGpuHours)),make('td','history-number',u.memoryObservedHours>0?fmt(u.memoryGiBHours):'—'));userRows.append(row);});
    if(!data.users.length)userRows.append(emptyRow(4));$('history-user-rows').replaceChildren(userRows);
    const dailyRows=document.createDocumentFragment();
    for(const day of [...data.days].reverse()){const row=make('tr');row.append(make('td','',day.date),make('td','history-number',percent(day.avgUtilization)),make('td','history-number',percent(day.memoryPercent)),make('td','history-number',day.utilizationObservedHours>0?fmt(day.utilizationHours):'—'),make('td','history-number',day.observedGpuHours?fmt(day.observedGpuHours):'—'));dailyRows.append(row);}
    $('history-day-rows').replaceChildren(dailyRows);
    window.I18n.bind($('history-retention'),'分钟汇总保留 {minute} 天，每日汇总保留 {daily} 天。图表和排行只包含自己的设备；排行榜最多展示 100 项。',{minute:data.retention.minuteDays,daily:data.retention.dailyDays});
    const selected=$('history-host').value,options=document.createDocumentFragment();
    const all=make('option','',T('全部设备'));all.value='';options.append(all);
    for(const host of data.hosts){const option=make('option','',host.name);option.value=host.id;options.append(option);}
    $('history-host').replaceChildren(options);$('history-host').value=selected;
    for(const id of ['history-from','history-to']){$(id).min=data.range.earliest;$(id).max=new Date().toISOString().slice(0,10);}
    if($('history-period').value!=='custom'){$('history-from').value=data.range.from;$('history-to').value=data.range.to;}
  }
  async function load(){
    const requestId=++generation;controller?.abort();controller=new AbortController();$('history-refresh').disabled=true;
    const query=new URLSearchParams({hostId:$('history-host').value});
    if($('history-period').value==='custom'){query.set('from',$('history-from').value);query.set('to',$('history-to').value);}else query.set('days',$('history-period').value);
    try{
      const response=await fetch('/api/history?'+query,{cache:'no-store',signal:controller.signal});
      if(response.status===401){location.replace('/');return;}
      const result=await response.json();if(!response.ok)throw Error(result.error||'历史数据加载失败');
      if(requestId!==generation)return;data=result;render();
    }catch(error){if(error.name!=='AbortError'&&requestId===generation){data=null;notice(error.message==='Failed to fetch'?'历史数据加载失败':error.message);$('history-content').hidden=true;$('history-empty').hidden=true;}}
    finally{if(requestId===generation)$('history-refresh').disabled=false;}
  }
  $('history-filters').addEventListener('submit',event=>{event.preventDefault();load();});
  $('history-period').addEventListener('change',()=>{const custom=$('history-period').value==='custom';$('history-from-label').hidden=!custom;$('history-to-label').hidden=!custom;$('history-from').required=custom;$('history-to').required=custom;if(!custom)load();});
  $('history-host').addEventListener('change',load);$('history-refresh').addEventListener('click',load);
  function activate(){clearInterval(refreshTimer);if(window.monitorActiveView==='history'){load();refreshTimer=setInterval(load,60000);}}
  document.addEventListener('monitor-view',activate);document.addEventListener('ui-language',render);
  let resizeFrame;new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(data?.enabled&&!$('history-panel').hidden){plot('history-util-chart','avgUtilization','每日平均 GPU 利用率','#8ee3b4');plot('history-memory-chart','memoryPercent','每日显存占用率','#8bb8ff');}});}).observe($('history-util-chart'));
  activate();
})();
