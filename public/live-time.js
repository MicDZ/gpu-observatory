(() => {
  const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  function parseDuration(value) {
    if (typeof value !== 'string') return null;
    const match = /^(?:(\d+)-)?(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(value.trim());
    if (!match || (match[1] !== undefined && match[4] === undefined)) return null;
    const days = Number(match[1] || 0), first = Number(match[2]), middle = Number(match[3]);
    const seconds = match[4] === undefined ? middle : Number(match[4]);
    const minutes = match[4] === undefined ? first : middle;
    const hours = match[4] === undefined ? 0 : first;
    if (seconds >= 60 || (match[4] !== undefined && minutes >= 60) || (match[1] !== undefined && hours >= 24)) return null;
    const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    return Number.isSafeInteger(total) ? total : null;
  }
  function formatDuration(seconds) {
    if (!finite(seconds)) return '—';
    const n = Math.floor(seconds), days = Math.floor(n / 86400);
    const hh = Math.floor(n % 86400 / 3600), mm = Math.floor(n % 3600 / 60), ss = n % 60;
    return (days ? days + '-' : '') + [hh, mm, ss].map(v => String(v).padStart(2, '0')).join(':');
  }
  function createClock(monotonic = () => performance.now(), wall = () => Date.now()) {
    let serverAnchor = null, localAnchor = 0, lastServerTime = -Infinity;
    const now = () => serverAnchor === null ? wall() : serverAnchor + Math.max(0, monotonic() - localAnchor);
    return {
      now,
      sync(serverTime) {
        if (!finite(serverTime) || serverTime < lastServerTime) return;
        serverAnchor = serverAnchor === null ? serverTime : Math.max(serverTime, now());
        localAnchor = monotonic(); lastServerTime = serverTime;
      }
    };
  }
  function sourceStatus(source, now, staleSeconds = 30) {
    if (!finite(source.receivedAt)) return 'waiting';
    if (now - source.receivedAt > staleSeconds * 1000) return 'offline';
    return source.error ? 'error' : 'online';
  }
  function systemStatus(host, now) {
    const state = sourceStatus(host, now);
    if (state === 'waiting' || state === 'offline') return state;
    return !host.system ? 'waiting' : host.system.error ? 'error' : 'online';
  }
  function jobTimes(job, source, now) {
    const fresh = sourceStatus(source, now, Math.max(180, (source.intervalSeconds || 60) * 3)) === 'online';
    const sampledAt = source.jobSampledAt ?? source.lastSuccessfulAt ?? source.receivedAt;
    const delta = fresh && finite(sampledAt) ? Math.floor(Math.max(0, now - sampledAt) / 1000) : 0;
    const runBase = finite(job.elapsedSeconds) ? job.elapsedSeconds : parseDuration(job.elapsed);
    const waitBase = finite(job.pendingSeconds) ? job.pendingSeconds : null;
    const runEstimated = fresh && job.state === 'RUNNING' && runBase !== null && delta > 0;
    const waitEstimated = fresh && job.state === 'PENDING' && waitBase !== null && delta > 0;
    return {
      runSeconds: runBase === null ? null : runBase + (runEstimated ? delta : 0),
      waitSeconds: waitBase === null ? null : waitBase + (waitEstimated ? delta : 0),
      runEstimated, waitEstimated, stale: !fresh
    };
  }
  const clock = createClock();
  const api = { createClock, parseDuration, formatDuration, sourceStatus, systemStatus, jobTimes,
    now: clock.now, sync: clock.sync };
  window.LiveTime = api;
  if (typeof document === 'undefined' || document.body?.dataset.page !== 'dashboard') return;
  const bindings = new WeakMap();
  const T = (key, values) => window.I18n.t(key, values);
  const age = at => finite(at) ? T('{seconds} 秒前', {seconds:Math.floor(Math.max(0, clock.now()-at)/1000)}) : T('尚未上报');
  function update(node) {
    const b = bindings.get(node); if (!b) return;
    if (b.kind === 'age') node.textContent = b.key ? T(b.key, {...b.values, age:age(b.at)}) : age(b.at);
    else if (b.kind === 'clock') {
      node.textContent = new Date(clock.now()).toLocaleTimeString(window.I18n.locale(), {hour12:false});
      node.title = T('服务器时间');
    } else {
      const result = jobTimes(b.job, b.source, clock.now());
      const seconds = b.metric === 'wait' ? result.waitSeconds : result.runSeconds;
      const estimated = b.metric === 'wait' ? result.waitEstimated : result.runEstimated;
      node.textContent = (estimated ? '≈ ' : '') + formatDuration(seconds);
      node.classList.toggle('timer-estimate', estimated); node.classList.toggle('timer-stale', result.stale);
      node.dataset.estimated = String(estimated);
      node.title = seconds === null ? T('此时长尚未上报') : result.stale ? T('数据已过期，显示最后上报的时长') : estimated ? T('根据最近一次采集在前端推算；任务状态以下次采集为准') :
        b.metric === 'wait' ? T('从提交到开始运行的等待时间；排队中持续计时') : T('Slurm 已报告的运行时长；暂停或结束时不递增');
    }
  }
  function bind(node, config) {
    node.removeAttribute('data-i18n'); node.dataset.liveTime = config.kind;
    bindings.set(node, config); update(node); return node;
  }
  api.bindAge = (node, at, options = {}) => bind(node, {kind:'age', at, ...options});
  api.bindClock = node => bind(node, {kind:'clock'});
  api.bindJob = (node, job, source, metric) => {
    node.dataset.timerJob = job.jobId; node.dataset.timerMetric = metric;
    return bind(node, {kind:'job', job, source, metric});
  };
  api.unbind = node => { bindings.delete(node); node.removeAttribute('data-live-time'); };
  api.tick = () => {
    for (const node of document.querySelectorAll('[data-live-time]')) update(node);
    document.dispatchEvent(new CustomEvent('monitor-tick'));
  };
  setInterval(api.tick, 1000);
  document.addEventListener('visibilitychange', api.tick);
  window.addEventListener('pageshow', api.tick);
  document.addEventListener('ui-language', api.tick);
})();
