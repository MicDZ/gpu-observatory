const T = (key, values) => window.I18n.t(key, values);
const Time = window.LiveTime;
const $ = id => document.getElementById(id);
const el = (tag, cls, content) => { const node = document.createElement(tag); if (cls) node.className = cls; if (content !== undefined) node.textContent = content; return node; };
const format = (n, digits = 0) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const gib = n => Number.isFinite(n) ? format(n / 1024, 1) : '—';
if (document.body.dataset.page === 'login') {
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button');
    button.disabled = true; $('login-error').removeAttribute('data-i18n'); $('login-error').textContent = '';
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error('Sign-in failed'), { userMessage: result.error || '登录失败' });
      location.replace('/');
    } catch (error) { window.I18n.bind($('login-error'), error.userMessage || '连接失败，请重试'); }
    finally { button.disabled = false; }
  });
} else {
  let snapshot = null, shownStatuses = '';
  const statusKey = () => snapshot?.hosts.map(h => Time.sourceStatus(h, Time.now())).join('|') || '';
  const stored = name => { try { return new Set(JSON.parse(sessionStorage.getItem(name)) || []); } catch { return new Set(); } };
  const expanded = stored('gpu-expanded'), collapsed = stored('gpu-host-collapsed');
  const remember = () => { try { sessionStorage.setItem('gpu-expanded', JSON.stringify([...expanded])); sessionStorage.setItem('gpu-host-collapsed', JSON.stringify([...collapsed])); } catch {} };
  const isFree = g => g.processesAvailable && g.processes.length === 0 && g.utilization !== null && g.utilization < 5;
  const keyFor = (h, g) => `${h.id}/${g.uuid}`;
  function barCell(value, percent, cls = '') {
    const td = el('td', 'number-cell ' + cls), content = el('div', 'inline-meter');
    content.append(el('span', '', value));
    if (Number.isFinite(percent)) {
      const p = el('progress', cls); p.max = 100; p.value = Math.max(0, Math.min(100, percent));
      p.setAttribute('aria-label', value); content.append(p);
    }
    td.append(content); return td;
  }
  function detailsRow(h, g, id) {
    const row = el('tr', 'gpu-details'), td = el('td'); td.colSpan = 7; row.id = id;
    const content = el('div', 'detail-content'), meta = el('div', 'detail-meta');
    for (const value of [`${g.name || 'GPU'} · GPU ${g.index}`, `${format(g.temperature)} °C`, `${format(g.powerDraw)} / ${format(g.powerLimit)} W`, T('显存 {used} / {total} MiB',{used:format(g.memoryUsed),total:format(g.memoryTotal)}), `Driver ${h.driverVersion || '—'}`, g.uuid]) meta.append(el('span', '', value));
    content.append(meta);
    if (g.processes.length) {
      const wrap = el('div', 'process-table-wrap'), table = el('table', 'process-table');
      table.setAttribute('aria-label', T('{host} GPU {index} 进程详情',{host:h.name,index:g.index}));
      const head = el('thead'), headRow = el('tr');
      for (const label of [T("用户"), 'PID', T("进程"), T("显存 MiB")]) { const th = el('th', '', label); th.scope = 'col'; headRow.append(th); }
      head.append(headRow); table.append(head); const body = el('tbody');
      for (const p of g.processes) {
        const r = el('tr'); r.append(el('td', 'user-cell', p.username || T("未知 / 无权限")), el('td', 'pid-cell', p.pid), el('td', 'process-command', p.command || T("不可读取")), el('td', 'number-cell', format(p.gpuMemory))); body.append(r);
      }
      table.append(body); wrap.append(table); content.append(wrap);
    } else content.append(el('p', 'process-empty', g.processesAvailable ? T("当前未检测到 GPU 进程。") : T("进程信息不可读取，请检查权限或驱动支持。")));
    td.append(content); row.append(td); return row;
  }
  function gpuRows(h, g) {
    const key = keyFor(h, g), open = expanded.has(key), detailId = `detail-${h.id}-${g.index}`;
    const row = el('tr', 'gpu-row' + (h.status !== 'online' ? ' stale' : '') + (open ? ' expanded' : ''));
    const gpu = el('td', 'gpu-name'); gpu.title = `${g.name}\n${g.uuid}`;
    gpu.append(el('span', 'gpu-index', g.index), el('span', 'model', (g.name || T("未知 GPU")).replace(/^NVIDIA (GeForce )?/, '')));
    const memPercent = Number.isFinite(g.memoryUsed) && g.memoryTotal ? g.memoryUsed / g.memoryTotal * 100 : null;
    row.append(gpu, barCell(`${format(g.utilization)}%`, g.utilization), barCell(`${gib(g.memoryUsed)} / ${gib(g.memoryTotal)}`, memPercent, 'memory-cell'));
    row.append(el('td', 'optional-col number-cell', `${format(g.temperature)}°C`), el('td', 'optional-col number-cell', `${format(g.powerDraw)} / ${format(g.powerLimit)} W`));
    const users = [...new Set(g.processes.map(p => p.username || T("未知 / 无权限")))];
    const userCell = el('td', 'user-cell'); const userText = el('span', 'truncate', users.join(', ') || (g.processesAvailable ? '—' : T("不可读取")));
    userText.title = users.join('\n'); userCell.append(userText); row.append(userCell);
    const procCell = el('td', 'process-cell'), button = el('button', 'process-toggle');
    button.id = `toggle-${h.id}-${g.index}`; button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-controls', detailId);
    button.setAttribute('aria-label', T('{action} {host} GPU {index} 的进程详情',{action:open?T('收起'):T('展开'),host:h.name,index:g.index}));
    const commands = [...new Set(g.processes.map(p => p.command || T("不可读取")))].join(', ');
    button.title = g.processes.map(p => `${p.username || '?'} · ${p.pid} · ${p.command || '?'} · ${format(p.gpuMemory)} MiB`).join('\n') || T("查看 GPU 详情");
    button.append(el('span', 'chevron', open ? '▾' : '▸'), el('span', 'process-count', g.processes.length), el('span', 'truncate', commands || (h.status !== 'online' ? T("历史快照") : isFree(g) ? T("空闲") : !g.processesAvailable ? T("不可读取") : T("无进程"))));
    button.addEventListener('click', () => { open ? expanded.delete(key) : expanded.add(key); remember(); render(); });
    procCell.append(button); row.append(procCell);
    return open ? [row, detailsRow(h, g, detailId)] : [row];
  }
  function render() {
    if (!snapshot) return;
    const focusId = document.activeElement?.id;
    const query = $('search').value.trim().toLowerCase(), freeOnly = $('free-only').checked;
    const hosts = snapshot.hosts.map(h => ({...h, status:Time.sourceStatus(h, Time.now())}));
    shownStatuses = hosts.map(h => h.status).join('|');
    const online = hosts.filter(h => h.status === 'online'), gpus = online.flatMap(h => h.gpus || []);
    $('stat-hosts').textContent = `${online.length}/${snapshot.hosts.length}`;
    $('stat-gpus').textContent = gpus.length;
    $('stat-users').textContent = new Set(gpus.flatMap(g => g.processes.map(p => p.username).filter(Boolean))).size;
    const used = gpus.filter(g => g.memoryUsed !== null), total = gpus.filter(g => g.memoryTotal !== null);
    $('stat-memory').textContent = used.length ? gib(used.reduce((s, g) => s + g.memoryUsed, 0)) : '—';
    $('stat-memory-total').textContent = `/ ${total.length ? gib(total.reduce((s, g) => s + g.memoryTotal, 0)) : '—'} GiB`;
    $('account').textContent = snapshot.username;
    const fragment = document.createDocumentFragment(); let count = 0;
    for (const h of hosts) {
      const matchesHost = `${h.name} ${h.hostname || ''}`.toLowerCase().includes(query);
      const matching = (h.gpus || []).filter(g => (!query || matchesHost || `${g.name} ${g.index} ${g.processes.map(p => `${p.username} ${p.pid} ${p.command}`).join(' ')}`.toLowerCase().includes(query)) && (!freeOnly || h.status === 'online' && isFree(g)));
      if ((freeOnly || query && !matchesHost) && !matching.length) continue;
      count++;
      // Search reveals matches even if their host was previously collapsed.
      const isCollapsed = collapsed.has(h.id) && !query && !freeOnly;
      const row = el('tr', 'host-row'), cell = el('td'); cell.colSpan = 7;
      const line = el('div', 'host-line'), left = el('div', 'host-title'), button = el('button', 'host-toggle');
      button.id = `host-toggle-${h.id}`; button.setAttribute('aria-expanded', String(!isCollapsed));
      button.append(el('span', 'chevron', isCollapsed ? '▸' : '▾'), el('span', '', h.name));
      button.addEventListener('click', () => { collapsed.has(h.id) ? collapsed.delete(h.id) : collapsed.add(h.id); remember(); render(); });
      left.append(button, el('span', 'badge ' + h.status, {online:T("在线"),offline:T("离线"),waiting:T("待接入"),error:T("异常")}[h.status]), el('span', 'host-gpu-count', `${matching.length} GPU`));
      const info = el('div', 'host-info');
      if (Math.abs(h.clockSkewSeconds || 0) > 120) { const warning = el('span', 'clock-warning', T("时钟偏差")); warning.title = T('主机时钟偏差约 {minutes} 分钟；在线状态按服务器接收时间判断。',{minutes:Math.round(Math.abs(h.clockSkewSeconds)/60)}); info.append(warning); }
      if (h.status === 'offline') info.append(el('span', 'clock-warning', T("历史快照")));
      info.append(el('span', 'driver-info', h.driverVersion ? `Driver ${h.driverVersion}` : ''), Time.bindAge(el('span', 'report-age'), h.receivedAt));
      line.append(left, info); cell.append(line); row.append(cell); fragment.append(row);
      if (isCollapsed) continue;
      if (h.error || !matching.length) { const r = el('tr'), td = el('td', 'empty', h.error || (h.status === 'waiting' ? T("等待首次上报") : T("暂无 GPU 数据"))); td.colSpan = 7; r.append(td); fragment.append(r); }
      for (const g of matching) fragment.append(...gpuRows(h, g));
    }
    if (!count) { const row = el('tr'), td = el('td', 'empty', T("没有符合筛选条件的 GPU")); td.colSpan = 7; row.append(td); fragment.append(row); }
    $('hosts').replaceChildren(fragment); $('host-count').textContent = count;
    if (focusId && /^(toggle-|host-toggle-)/.test(focusId)) $(focusId)?.focus({ preventScroll: true });
  }
  async function refresh() {
    try {
      const response = await fetch('/api/snapshot', { signal: AbortSignal.timeout(12000) });
      if (response.status === 401) { location.replace('/'); return; }
      if (!response.ok) throw new Error('Failed');
      snapshot = await response.json(); Time.sync(snapshot.serverTime); render();
      window.monitorHostSnapshot = snapshot;
      document.dispatchEvent(new CustomEvent('host-snapshot', { detail: snapshot }));
      Time.bindClock($('refresh-state'));
      $('live-dot').classList.remove('bad'); $('connection-error').hidden = true;
    } catch {
      Time.unbind($('refresh-state')); window.I18n.bind($('refresh-state'),'连接中断'); $('live-dot').classList.add('bad');
      $('connection-error').hidden = false; window.I18n.bind($('connection-error'),'连接中断，当前数据可能已过期，正在自动重连…');
    } finally { setTimeout(refresh, 5000); }
  }
  $('search').addEventListener('input', render); $('free-only').addEventListener('change', render);
  $('expand-all').addEventListener('click', () => { collapsed.clear(); for (const h of snapshot?.hosts || []) for (const g of h.gpus || []) expanded.add(keyFor(h,g)); remember(); render(); });
  $('collapse-all').addEventListener('click', () => { expanded.clear(); collapsed.clear(); remember(); render(); });
  $('logout').addEventListener('click', async () => {
    try { const response = await fetch('/api/logout', { method: 'POST' }); if (response.ok) location.replace('/'); else throw new Error(); }
    catch { $('connection-error').hidden = false; window.I18n.bind($('connection-error'),'退出失败，请检查网络后重试。'); }
  });
  document.addEventListener('ui-language',render);
  document.addEventListener('monitor-tick',()=>{if(snapshot&&statusKey()!==shownStatuses)render();});
  refresh();
}
