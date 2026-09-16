const str = (v, limit = 256) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : null;
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;

export function normalizeSlurm(body, source) {
  if (!body || body.version !== 1 || !/^[a-f0-9-]{36}$/.test(body.reportId || '') ||
      !Number.isSafeInteger(body.collectedAt) || body.collectedAt <= 0 || body.scope !== source.scope ||
      !Array.isArray(body.jobs) || body.jobs.length > 5000 || !Array.isArray(body.partitions) || body.partitions.length > 1000 ||
      (body.error != null && typeof body.error !== 'string')) throw new Error('Invalid Slurm snapshot');
  const seen = new Set();
  const jobs = body.jobs.map(j => {
    if (!j || typeof j.jobId !== 'string' || !j.jobId || j.jobId.length > 128 || seen.has(j.jobId) ||
        typeof j.username !== 'string' || typeof j.state !== 'string' || !j.state) throw new Error('Invalid job');
    if (source.scope === 'mine' && j.username !== source.collectorUser) throw new Error('Job outside permitted user scope');
    seen.add(j.jobId);
    const result = { jobId: str(j.jobId, 128), username: str(j.username, 128), partition: str(j.partition, 96),
      state: str(j.state, 64), nodes: integer(j.nodes), cpus: integer(j.cpus), memory: str(j.memory, 32),
      elapsed: str(j.elapsed, 32), timeLimit: str(j.timeLimit, 32), priority: integer(j.priority),
      reason: str(j.reason), tres: str(j.tres, 512), tresPerJob: str(j.tresPerJob),
      elapsedSeconds: integer(j.elapsedSeconds), pendingSeconds: integer(j.pendingSeconds) };
    return result;
  });
  const partitions = body.partitions.map(p => {
    if (!p || typeof p.name !== 'string' || integer(p.nodes) === null || typeof p.state !== 'string') throw new Error('Invalid partition');
    return { name: str(p.name, 96), availability: str(p.availability, 32), nodes: p.nodes, state: str(p.state, 64) };
  });
  const counts = { running: 0, pending: 0, other: 0, visible: jobs.length };
  for (const j of jobs) counts[j.state === 'RUNNING' ? 'running' : j.state === 'PENDING' ? 'pending' : 'other']++;
  // Truncated reports carry exact aggregate counts but explicitly limit the displayed rows.
  if (body.truncated === true) {
    if (!body.counts || ['running','pending','other','visible'].some(k => integer(body.counts[k]) === null) ||
        body.counts.visible < jobs.length || body.counts.running + body.counts.pending + body.counts.other !== body.counts.visible) throw new Error('Invalid totals');
    for (const key of Object.keys(counts)) counts[key] = body.counts[key];
  }
  return { reportId: body.reportId, collectedAt: body.collectedAt, hostname: str(body.hostname, 128),
    collectorUser: source.collectorUser, scope: source.scope, visibility: source.visibility,
    durationMs: integer(body.durationMs), queueAgeMs: integer(body.queueAgeMs) !== null && body.queueAgeMs <= 120000 ? body.queueAgeMs : 0,
    jobs, partitions, counts, truncated: body.truncated === true,
    error: str(body.error), warning: str(body.warning) };
}
