(() => {
  if(document.body.dataset.page!=='management')return;
  const $=id=>document.getElementById(id),T=(key,values)=>window.I18n.t(key,values);
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  let inventory=[],inventoryLoaded=false,inventoryLoading=false;
  let me,devices=[],users=[],installation=null,action=null,loading=false;
  async function api(path,method='GET',body){
    const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
    if(response.status===401){location.replace('/');throw Error('请重新登录');}
    const result=await response.json();if(!response.ok)throw Error(result.error||'操作失败');return result;
  }
  function message(error){const e=$('page-message');e.hidden=!error;if(error)window.I18n.bind(e,error.message||error);}
  function button(text,callback,cls='small-button'){
    const b=node('button',cls,T(text));b.type='button';b.addEventListener('click',callback);return b;
  }
  function renderDevices(){
    const root=document.createDocumentFragment();
    if(!devices.length)root.append(node('p','device-empty',T('还没有设备。添加第一台 GPU 服务器开始监控。')));
    for(const d of devices){
      const card=node('article','device-card'),head=node('div','section-heading');
      head.append(node('h2','',d.name),node('span','badge device-status '+d.status,T({online:'在线',offline:'离线',waiting:'待接入',error:'采集异常'}[d.status]||'待接入')));
      const meta=node('div','device-meta');meta.append(node('span','',T('GPU 数量：{count}',{count:d.gpuCount})),node('span','',d.enrolled?T('已注册上报端'):T('等待安装')));
      const actions=node('div','device-actions');
      actions.append(button(d.enrolled?'重新生成安装链接':'生成安装链接',()=>openAction({title:'生成安装链接',description:'新链接会替换旧链接。重新安装成功后，旧上报凭据才会失效。',boot:true,run:async()=>showInstall(d,await api('/api/devices/'+encodeURIComponent(d.id)+'/install','POST',{boot:$('action-boot').checked}))})),
        button('重命名',()=>openAction({title:'重命名',label:'设备名称',value:d.name,run:async value=>api('/api/devices/'+encodeURIComponent(d.id),'PATCH',{name:value})})),
        button('移除设备',()=>openAction({title:'移除设备',description:'移除后会撤销上报凭据并删除中心快照。远端进程需要自行停止。',run:async()=>api('/api/devices/'+encodeURIComponent(d.id),'DELETE')}),'small-button danger'));
      card.append(head,meta,actions);root.append(card);
    }
    $('device-list').replaceChildren(root);
  }
  function renderUsers(){
    const root=document.createDocumentFragment();
    for(const u of users){
      const row=node('tr');row.append(node('td','',u.username),node('td','',T(u.role==='admin'?'管理员':'普通用户')),node('td','',T(u.disabled?'已停用':'已启用')));
      const cell=node('td');
      if(u.id!==me.id)cell.append(button(u.disabled?'启用':'停用',()=>openAction({title:u.disabled?'启用用户':'停用用户',description:'停用会立即撤销登录会话、安装链接并暂停接收其设备上报。',run:async()=>api('/api/users/'+u.id,'PATCH',{disabled:!u.disabled})})));
      cell.append(button('重置密码',()=>openAction({title:'重置密码',label:'新密码（至少 12 个字符）',password:true,description:'重置后该用户需要重新登录。请通过私密渠道告知新密码。',run:async value=>{await api('/api/users/'+u.id,'PATCH',{password:value});if(u.id===me.id)location.replace('/');}})));
      row.append(cell);root.append(row);
    }
    $('user-list').replaceChildren(root);
  }
  function renderInventory(){
    const rows=document.createDocumentFragment();
    for(const d of inventory){
      const row=node('tr');row.append(node('td','',d.username),node('td','',d.name),node('td','',d.gpuModels.length?d.gpuModels.join(' / '):T('尚无型号信息')));rows.append(row);
    }
    if(!inventory.length){const row=node('tr'),cell=node('td','muted',T('暂无已添加的设备'));cell.colSpan=3;row.append(cell);rows.append(row);}
    $('inventory-list').replaceChildren(rows);
  }
  async function loadInventory(){
    if(me?.role!=='admin'||inventoryLoading)return;
    inventoryLoading=true;$('refresh-inventory').disabled=true;
    try{inventory=(await api('/api/users/devices')).devices;inventoryLoaded=true;renderInventory();}
    catch(error){message(error);}finally{inventoryLoading=false;$('refresh-inventory').disabled=false;}
  }
  $('refresh-inventory').addEventListener('click',loadInventory);
  async function load(){
    if(loading)return;loading=true;
    try{
      if(!me){me=(await api('/api/me')).user;$('identity').textContent=me.username;$('users-section').hidden=me.role!=='admin';}
      devices=(await api('/api/devices')).devices;renderDevices();
      if(me.role==='admin'){users=(await api('/api/users')).users;renderUsers();if(!inventoryLoaded)await loadInventory();}
    }catch(error){message(error);}finally{loading=false;}
  }
  function openAction(value){
    action=value;$('action-title').textContent=T(value.title);$('action-description').textContent=value.description?T(value.description):'';
    $('action-input-label').hidden=!value.label;$('action-label').textContent=value.label?T(value.label):'';
    const input=$('action-input');input.type=value.password?'password':'text';input.value=value.value||'';input.required=!!value.label;input.minLength=value.password?12:1;input.maxLength=value.password?256:80;
    $('action-boot-label').hidden=!value.boot;$('action-boot').checked=false;
    $('action-form').querySelector('.error').textContent='';$('action-dialog').showModal();
  }
  function showInstall(device,result){
    installation=result;$('copy-command').textContent=T('复制安装命令');$('copy-link').textContent=T('复制安装链接');$('install-device').textContent=device.name;$('install-command').value=result.command;
    $('install-expiry').textContent=T('过期时间：{time}',{time:new Date(result.expiresAt).toLocaleString(window.I18n.locale())});
    $('install-dialog').querySelector('.error').textContent='';$('install-dialog').showModal();
  }
  async function submit(form,run){
    const b=form.querySelector('button:not([type=button]):last-child')||form.querySelector('.primary');
    if(b.disabled)return;b.disabled=true;
    const errorNode=form.querySelector('.error');if(errorNode)errorNode.textContent='';
    try{await run();message(null);}catch(error){if(errorNode&&(!form.closest('dialog')||form.closest('dialog').open))window.I18n.bind(errorNode,error.message);else message(error);}
    finally{b.disabled=false;inventoryLoaded=false;await load();}
  }
  for(const b of document.querySelectorAll('.close-dialog'))b.addEventListener('click',()=>b.closest('dialog').close());
  $('install-dialog').addEventListener('close',()=>{installation=null;$('install-command').value='';});
  $('add-device').addEventListener('click',()=>{$('device-form').reset();$('device-form').querySelector('.error').textContent='';$('device-dialog').showModal();});
  $('device-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{
    const form=new FormData(event.currentTarget),d=(await api('/api/devices','POST',{name:form.get('name')})).device;
    $('device-dialog').close();showInstall(d,await api('/api/devices/'+d.id+'/install','POST',{boot:form.get('boot')==='on'}));
  });});
  $('action-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{const current=action;await current.run($('action-input').value);$('action-dialog').close();});});
  $('add-user').addEventListener('click',()=>{$('user-form').reset();$('user-form').querySelector('.error').textContent='';$('user-dialog').showModal();});
  $('user-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;submit(form,async()=>{await api('/api/users','POST',Object.fromEntries(new FormData(form)));form.reset();$('user-dialog').close();});});
  $('password-form').addEventListener('submit',event=>{event.preventDefault();submit(event.currentTarget,async()=>{await api('/api/me/password','POST',Object.fromEntries(new FormData(event.currentTarget)));location.replace('/');});});
  for(const [id,key] of [['copy-command','command'],['copy-link','url']])$(id).addEventListener('click',async()=>{
    if(!installation)return;
    try{await navigator.clipboard.writeText(installation[key]);$(id).textContent=T('已复制');}
    catch{window.I18n.bind($('install-dialog').querySelector('.error'),'无法自动复制，请手动选择并复制安装命令');$('install-command').focus();$('install-command').select();}
  });
  $('sign-out').addEventListener('click',async()=>{try{await api('/api/logout','POST',{});location.replace('/');}catch(error){message(error);}});
  document.addEventListener('ui-language',()=>{renderDevices();if(me?.role==='admin'){renderUsers();renderInventory();}if(installation)$('install-expiry').textContent=T('过期时间：{time}',{time:new Date(installation.expiresAt).toLocaleString(window.I18n.locale())});});
  load();setInterval(load,15000);
})();
