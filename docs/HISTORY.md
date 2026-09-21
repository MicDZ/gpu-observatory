# GPU history and analytics

The **History** dashboard shows daily GPU utilization, daily VRAM occupancy, GPU usage rankings and process-user occupancy rankings. Choose the last 7, 30, 90 or 365 days, a custom inclusive date range, and an individual device. Charts have per-point tooltips; the expandable daily table provides numeric values. Dates and day boundaries are **UTC**, independent of browser locale. Today's totals are incomplete.

The hub now requires **Node.js 22.16+** (current Node 22/24 LTS recommended). It uses the built-in `node:sqlite` module, so no database server, npm runtime dependency, native addon build, sudo or reporter update is required. Existing agents continue posting every five seconds.

## Storage and retention

History recording starts when the upgraded hub receives new reports. Old live snapshots cannot reconstruct historical usage and are not backfilled. The first report establishes a baseline; at least two reports are needed to measure a duration.

The SQLite database defaults to `history.sqlite` beside the configured `stateFile`, normally `$HUB_STATE/data/history.sqlite`. If no state file was configured, startup places it beside the config file. New configurations explicitly include:

```json
{
  "history": {
    "enabled": true,
    "file": "/absolute/private/path/history.sqlite",
    "minuteRetentionDays": 30,
    "dailyRetentionDays": 365
  }
}
```

Omit the section to use these defaults. Minute retention supports 1–90 calendar days; daily retention supports 7–730 days and must be at least as long as minute retention. Restart the hub after changing configuration. Set `enabled` to false to stop recording and disable the analytics view without deleting an existing database.

Every accepted report updates a transaction containing UTC minute and daily aggregates plus a deduplication cursor. The dashboard queries daily aggregates; minute rows preserve finer-grained history for private SQL analysis. Raw five-second payloads, PIDs, process commands and environments are **not** archived. Stored values include ownership/source IDs, GPU identity/model, OS usernames, duration-weighted measurements, maxima and known-data durations. These are private telemetry.

Default retention is 30 days of minute aggregates and 365 days of daily aggregates. A periodic cleanup checks expiration and prunes roughly hourly, also on startup. Old GPU metadata without aggregates is removed. SQLite reuses freed pages; the file need not shrink immediately. Storage scales with GPUs, observed minutes and distinct OS users, not the number of reporter requests. Monitor disk usage and adjust retention to suit your fleet.

The database and WAL/SHM sidecars use mode 0600. Store them in a private local directory; do not use a network filesystem or share the database between multiple hub processes. The hub uses WAL, a short busy timeout and SQLite transactions. Minute/day/user updates commit together. Synchronous queries suit a small fleet; this is not a distributed analytics service.

## How usage is calculated

Measurements use the hub's receipt clock, not the agent's possibly skewed timestamp. A previous valid GPU sample represents the interval until the next accepted report, provided it arrives within 30 seconds. This is a sampling estimate, not a hardware billing measurement.

- **Observed GPU hours:** valid GPU observation time, summed across GPUs. Two GPUs observed for one hour contribute two GPU hours. It is not a percent-of-expected-uptime figure.
- **Average GPU utilization:** sum of utilization × duration, divided by the duration for which utilization is known. GPUs are weighted by observed time, not model performance. Unknown readings do not become zero.
- **Weighted GPU hours:** sum of utilization / 100 × observed hours. For example, 50% utilization for two hours is one weighted GPU hour. An H100 hour and a smaller GPU hour do not imply equal throughput. Device ranking uses this value, up to 100 entries.
- **VRAM occupancy:** time-integrated used memory divided by time-integrated total memory over known readings. This is capacity-weighted; it is not the unweighted mean of percentages. Memory samples exceeding reported capacity are treated as unknown.
- **Process-user occupied GPU hours:** one OS username visible on a GPU counts once per interval, even with several PIDs. Two users sharing one GPU each accrue occupancy, so user totals can exceed a device's occupied time. This is not per-user utilization or computation: the agent does not provide those measurements.
- **User VRAM GiB-hours:** per-user process memory integrated over known time. Shared/accounted memory may overlap. If any process memory for a user on a GPU is unavailable, that interval is excluded from this memory integral. Unknown memory is shown as unavailable, not zero.

Process-user rankings group identical OS usernames across the selected devices, not website accounts or verified real-world identities. Unknown usernames use a separate placeholder. Unavailable process lists are excluded; the view reports how much process-visible observation time exists.

Long gaps are wholly omitted rather than extended at the old utilization. Collection errors stop subsequent accumulation until a valid baseline returns. The interval from a valid sample to the error's arrival may still count when it is within 30 seconds. Restarts deliberately start new in-memory baselines and do not fill the downtime. Receipt-clock reversals do not double-count already covered intervals. Queries never extrapolate the latest sample into the future. No-data dates are blank, not 0%; observed idle periods remain valid zeros.

## Isolation and failure behavior

`GET /api/history` requires a browser session. Every query uses the authenticated owner ID; agent bearer tokens cannot read history, and an administrator cannot request another user's analytics. The admin inventory remains limited to device names and GPU models. Never enable shared proxy caching for history responses. The service worker does not intercept or cache `/api/history`.

Deleting a device removes its historical aggregates and cursor as well as the current snapshot. Disabling a user preserves history but blocks their sessions and reports; it resumes only after re-enabling. In the absence of an explicit device-transfer feature, do not edit ownership as a way to share history; recorded history is scoped to the owner at collection time. Orphaned records for removed devices are reconciled at startup.

If a history write fails, the hub logs a generic storage error, marks analytics with a warning, breaks the sampling baseline and continues live monitoring. It does not pretend the failed interval was saved. After successful writes resume, missing intervals remain gaps. Query failures produce an explicit error, not a fabricated zero chart. An inaccessible or unsupported database at startup must be fixed (or recording explicitly disabled) before the hub can start.

## Backup, restore and rollback

Do **not** copy only the main SQLite file while the hub is running: recent committed data can be in `history.sqlite-wal`. A small online backup utility uses SQLite's backup API:

```sh
node scripts/backup-history.mjs "$HUB_STATE/data/history.sqlite" /private/backup/location/history-2026-01-01.sqlite
```

Use your actual configured path. The output directory must already exist and be private. Existing backup files are never overwritten. Backup files contain private telemetry and have mode 0600. Keep them out of Git, screenshots and public issues. Back up config/accounts separately as before.

For restore, stop only this project's hub, preserve the current database and its sidecars privately, place the consistent backup at the configured history path, remove only the old history WAL/SHM after the hub is fully stopped, and restart. Do not replace unrelated databases. Validate the restored date range and account ownership.

The schema is versioned with SQLite `user_version`. Startup rejects a newer unknown schema. The initial migration is additive and leaves existing account/agent configuration intact. Rolling back the app to a version without history leaves this database unused; keep it privately for a later upgrade. Never serve it as a static file. Existing reporter credentials and tunnel configuration do not need to change.
