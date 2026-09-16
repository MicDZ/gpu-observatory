# Deployment runbook for agents

This runbook is designed to be followed by a coding or operations agent. All example names are fictional. Do not paste private infrastructure details into public issues or commits. Commands assume a POSIX shell, a Linux or macOS hub and Linux NVIDIA reporters. No sudo is required by these scripts.

## 1. Establish the topology

**A central server is required.** It can be a small VPS, a home server, a Mac, or an existing workstation. It needs no GPU, but must remain powered on and connected. It runs the Node hub and an HTTPS ingress (Cloudflare Tunnel or another trusted reverse proxy). Every monitored host pushes outbound HTTPS; the hub does not SSH into hosts for polling, and hosts need no inbound ports.

Collect the hub's SSH destination, its OS, an installation directory, and the monitored hosts' SSH aliases. Ask whether the user owns a domain and can configure DNS. Keep this inventory outside the checkout. Probe only these authorized hosts. First deploy one reporter, verify it, then roll out to the others.

Prerequisites:

- Hub: Node.js 20+ and npm; Python 3.10+ for the PM2 helper; `cloudflared` on PATH if using Cloudflare. The Node hub itself has no npm dependencies.
- GPU hosts: Linux, Python 3.10+ with pip/venv support, a working NVIDIA driver/NVML (`nvidia-smi`), outbound HTTPS, Node/npm for PM2. Read-only CPU and RAM sampling uses psutil. GPU monitoring supports NVIDIA; AMD/Apple GPUs are not currently supported.
- Optional Slurm source: Python 3.10+, working `squeue`/`sinfo`, a user-space Node runtime for PM2, and permission to run a persistent collector at the chosen cadence. Do not assume login-node daemons or boot hooks are allowed.

Check versions and command availability without dumping shell environments. Never install system packages with sudo. If Node is missing on a Linux GPU host, `deploy/setup-node.py` installs a checksum-verified official Node 22 binary under `~/.local/share/gpu-monitor/node`. It supports x86_64/aarch64 Linux systems compatible with official Node binaries; otherwise ask the operator to provide a supported runtime. Do not build software on a managed login node without policy approval.

## 2. Choose the public address

**If the user has no domain, use Quick Tunnel for the initial deployment.** It needs no Cloudflare account, DNS record or custom domain. Cloudflare assigns a random `https://….trycloudflare.com` URL. The URL changes when the tunnel process restarts, including PM2 recovery or a reboot. Follow section 7 whenever it changes. Quick Tunnel has no uptime SLA and is intended for development/testing, with a 200 concurrent-request limit and no SSE. This dashboard uses HTTP polling, not SSE.

**Recommend a user-owned domain with a named tunnel for persistent use.** Its stable URL avoids redistributing reporter endpoints after restarts and keeps bookmarks and installed desktop apps useful. Named tunnels require a Cloudflare account and a domain configured for that account, or use another stable HTTPS reverse proxy under the user's control.

References: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [account-free setup](https://developers.cloudflare.com/tunnel/get-started/), [cloudflared downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

## 3. Prepare the hub

Clone this repository into a durable directory, then run the following from its root. Set `HUB_STATE` to a dedicated private directory, not a web-served folder or the checkout. Use a reasonably short path: PM2 uses Unix sockets with OS path-length limits. The hub helper rejects paths that are too long. Shell variables in this guide must be re-established when opening a new SSH shell.

```sh
umask 077
export HUB_STATE="$HOME/.local/share/gpu-observatory-hub"
```

### Option A: no domain — Quick Tunnel

Initialize with a deliberately unusable origin. This keeps login blocked at any public hostname until the actual URL is set. The randomly generated dashboard password already protects the API.

```sh
node scripts/manage.mjs init --state "$HUB_STATE" --origin https://pending.invalid --username admin
python3 deploy/setup-hub.py --state "$HUB_STATE" --quick-tunnel
"$HUB_STATE/pm2.sh" logs gpu-tunnel --lines 60 --nostream
```

Find the newly created `https://….trycloudflare.com` address in the tunnel's startup log; do not use a URL from an old log entry. Substitute it below:

```sh
node scripts/manage.mjs set-origin --state "$HUB_STATE" --origin https://REPLACE-WITH-ACTUAL-URL.trycloudflare.com
"$HUB_STATE/pm2.sh" restart gpu-dashboard
```

Do not restart `gpu-tunnel` at this point: that would allocate another URL. The helper uses a dedicated empty YAML configuration instead of changing `~/.cloudflared/config.yml` or an existing tunnel. Cloudflare notes that existing default configuration files can interfere with Quick Tunnels; inspect the selected configuration if creation fails. Never rename or overwrite another deployment's configuration as a shortcut.

### Option B: own domain — named tunnel

Configure a dedicated Cloudflare named tunnel and DNS route using the [official locally managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/). Account login and DNS setup require the user's authorized account. Reuse an existing tunnel only if it is explicitly designated for this app. Store its credentials outside this repository with restrictive permissions.

The dedicated YAML config should use this shape, replacing the placeholders:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /absolute/private/path/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: monitor.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```sh
node scripts/manage.mjs init --state "$HUB_STATE" --origin https://monitor.example.com --username admin
python3 deploy/setup-hub.py --state "$HUB_STATE" --tunnel-config /absolute/private/path/tunnel.yml
```

For an existing HTTPS reverse proxy, omit both tunnel flags. Proxy the whole site, including `/api/ingest` and `/api/slurm/ingest`, to `127.0.0.1:8787`. Preserve the origin and set `X-Forwarded-Proto: https` on authenticated browser requests. Disable caching for authenticated HTML and `/api/*`. An interactive proxy login on ingestion routes will block machine reporters; use an appropriately scoped machine policy while retaining the app's bearer authentication. Never send tokens through redirects.

### Hub state and process management

The setup helper installs PM2 locally under `$HUB_STATE/runtime` and uses `$HUB_STATE/pm2`, isolated from existing PM2 applications. It starts `gpu-dashboard` and optionally `gpu-tunnel`, then saves that process list. The source checkout must remain at its current path. Re-running the helper restarts selected applications; with Quick Tunnel that changes the public URL. Omitting a tunnel flag on a later invocation does not delete an existing tunnel process.

The generated `$HUB_STATE/login-credentials.txt` contains a random password. Tell the user its private filesystem location; do not echo it into the agent transcript. The config stores a salted password hash. All state directories use mode 0700 and credential files mode 0600. Read credentials only within a private local verification process when testing login.

Useful commands:

```sh
"$HUB_STATE/pm2.sh" status
"$HUB_STATE/pm2.sh" logs gpu-dashboard --lines 30 --nostream
"$HUB_STATE/pm2.sh" restart gpu-dashboard
```

A PM2 save is not an OS boot hook. See section 6 for persistence. Sessions are in memory; restarting the hub logs browsers out. Static assets are read at startup, so source updates also require a hub restart.

## 4. Enroll the first GPU host

On the hub, choose a stable lowercase source ID and optional display name:

```sh
node scripts/manage.mjs add-host gpu-01 --name "Atlas GPU 01" --state "$HUB_STATE"
"$HUB_STATE/pm2.sh" restart gpu-dashboard
```

This generates `$HUB_STATE/enrollment/gpu-01.json`. Transfer **only this host's file** as `~/.local/share/gpu-monitor/agent-config.json` on its intended host using SSH/SCP or a secure pipe. Do not copy the hub config, password file, entire enrollment directory, or another host's token. Create the destination with mode 0700 and set the config to 0600 before starting the reporter. Never disable SSH host-key checking; resolve new-host trust with the operator.

Copy these public source files to the same remote directory:

- `agent.py`, `system_sampler.py`, `requirements.txt`
- `deploy/setup-agent.py`, `deploy/pm2.sh` (flatten the `deploy/` directory for these files)
- `deploy/setup-node.py` only if a user-local Node install is needed

Then on that host:

```sh
cd "$HOME/.local/share/gpu-monitor"
# Only if node/npm are absent:
# python3 setup-node.py
python3 setup-agent.py
sh ./pm2.sh status
sh ./pm2.sh logs gpu-reporter --lines 30 --nostream
```

The installer creates a virtual environment, installs pinned Python dependencies, and starts/saves `gpu-reporter` in its isolated PM2 home. It runs without sudo and collects no full command lines or environments. GPU, CPU and RAM travel in the same report every five seconds. Process visibility depends on permissions. A GPU sampling failure can coexist with usable CPU/RAM data, and vice versa.

The default setup does not add a boot hook. On ordinary Linux hosts where user cron is permitted and desired, run `python3 setup-agent.py --boot`; this preserves other crontab entries and adds one marked `@reboot` command. Review existing hooks before changing them. The script does not remove a previously installed hook when subsequently run without `--boot`.

Verify the first host using section 8, then enroll each additional host with its own unique ID and token. Never reuse one enrollment file on multiple machines. The hub configuration is loaded at startup, so restart the hub after adding sources.

## 5. Optional Slurm source

This is separate from GPU host monitoring and does not collect CPU/RAM on the login node. Check cluster policy and any required administrator authorization first. Do not enable lingering, cron, user services or shell-startup workarounds without permission for that persistence mechanism.

On the hub:

```sh
node scripts/manage.mjs add-slurm cluster-01 --user alice --scope mine --state "$HUB_STATE"
"$HUB_STATE/pm2.sh" restart gpu-dashboard
```

Replace `alice` with the actual collector OS username. Default `mine` requests only that user's jobs. Use `--scope visible` only when the intended account-visible collection is permitted. Set `--visibility private-jobs` if the cluster uses `PrivateData=jobs`; this adds an explicit UI warning that an empty account-visible queue does not mean the cluster is idle. The default interval is 60 seconds; `--interval` may increase it, never reduce it below 60.

On the permitted collector node, create `~/.local/share/slurm-monitor` privately. Transfer only `enrollment/cluster-01.json` as `config.json`, plus `slurm/collector.py` and `slurm/setup-runtime.py`. Verify `squeuePath`/`sinfoPath` in the private config match `command -v squeue` and `command -v sinfo`. In a multi-login-node cluster choose an authorized stable node; avoid starting duplicate collectors through a round-robin SSH hostname.

```sh
cd "$HOME/.local/share/slurm-monitor"
python3 setup-runtime.py
./pm2.sh start ecosystem.json
./pm2.sh save
./pm2.sh logs slurm-reporter --lines 30 --nostream
```

The runtime helper downloads a checksum-verified Linux Node 22 binary and installs isolated PM2. It creates no boot hooks. It uses `/usr/bin/python3`; adjust the generated `interpreter` if the site's supported Python 3.10+ is elsewhere. Queries use `squeue` and `sinfo`, not training jobs. Browser refreshes read the hub cache; they never increase scheduler polling. Wait/run timers advance locally between reports and freeze on stale/error samples. The queue badge counts all visible jobs, including running jobs.

## 6. Persistence and recovery without root

Reporter `--boot` provides Linux user-cron recovery where available. For the hub, PM2 survives ordinary SSH logout, but automatic restart depends on OS policy. Never run `pm2 startup` if it asks for root. Do not claim reboot recovery merely because `pm2 save` succeeded.

For a Linux hub with authorized user cron, add one marked `@reboot` entry invoking the absolute `$HUB_STATE/pm2.sh resurrect` path and redirecting output to a private log. Use `crontab -l`, preserve every unrelated entry, and install the merged crontab. Use absolute paths and shell-quote paths. If cron is unavailable or login sessions are killed by policy, report the limitation instead of enabling linger or inventing another persistence mechanism.

For a macOS hub, a user LaunchAgent starts **at user login**, not before login after a reboot. With authorization for this login behavior, generate a plist under `~/Library/LaunchAgents` with a unique label such as `org.gpu-observatory.hub`, `RunAtLoad: true`, and `ProgramArguments: ["/absolute/path/to/private/pm2.sh", "resurrect"]`. Use absolute paths, load via `launchctl bootstrap gui/$(id -u) /absolute/path/to/plist`, and keep logs in the private state directory. Do not enable `KeepAlive` for this short-lived resurrect command. Use `launchctl bootout` for the same label before replacing an already loaded plist. Full boot-before-login behavior requires a separately authorized OS service; it is not supplied by this user-space deployment.

Test recovery only for this project's isolated PM2 namespace, and only when a brief interruption is acceptable. For reporters, stop the isolated PM2 daemon with the project's helper and resurrect its saved list, then verify a fresh report. Do not kill global PM2 or unrelated applications. Restarting a Quick Tunnel allocates a new address and requires section 7. An actual host reboot is a separate disruptive operation; do not do it solely to validate installation.

## 7. When a Quick Tunnel URL changes

1. Read the current tunnel startup log and confirm the new URL returns `/healthz` with `{"ok":true}`.
2. On the hub, run `node scripts/manage.mjs set-origin --state "$HUB_STATE" --origin https://NEW-URL.trycloudflare.com`. This updates the login origin and local enrollment files while preserving password and token identities.
3. Restart **only** `gpu-dashboard`.
4. Securely transfer each updated enrollment file to its existing reporter config path. Reapply mode 0600. Restart `gpu-reporter` or `slurm-reporter` using that reporter's own PM2 helper. The command does not update remote hosts automatically.
5. Verify all expected sources become fresh. Tell the user the new URL. Bookmarks and installed desktop apps point to the old origin; update or reinstall them. No-domain deployment is convenient to try, but a stable custom domain avoids this recurring work.

## 8. Acceptance checks and handoff

- Public `/healthz` returns 200. Anonymous `/api/snapshot` and `/api/slurm` return 401; `/` shows the login screen. Unknown static paths cannot read config files.
- Log in privately. Confirm secure/HttpOnly/SameSite cookies and successful metrics loading; do not paste the password or cookie into logs. Incorrect origin and incorrect credentials must be rejected.
- Each GPU host reports under the intended ID, within about five seconds plus collection/network time. Check GPU counts and process visibility on the host without recording real process lists in public artifacts. CPU/RAM should appear in separate tabs.
- Report ages advance without a reload. An isolated stopped reporter becomes stale after 30 seconds. Stop/restart only the newly installed test reporter if needed.
- Slurm appears within one collection interval; account visibility matches policy, and no unexpected source or duplicate collector exists. Offline threshold is at least 180 seconds. Do not submit a GPU workload just to validate an empty queue.
- PM2 is running in the project's private namespace, its saved list is current, and boot/login behavior is described accurately. Note any policy or OS limitation.
- Chinese and English switching works. On stable HTTPS origins, Chrome/Edge may offer installation after their installability checks; the in-page install control also explains platform-specific steps. Native installation requires user interaction.

Handoff: provide the public URL, private credential-file path, enrolled IDs, process helper paths, restart commands, any persistence limitations, and the Quick Tunnel URL-change procedure. Never include credential values or unredacted screenshots in a public handoff.

## 9. Updates and rollback

Keep a copy of the previous source revision and back up private state outside Git before updating. Run tests, deploy the new source to the same path, restart the hub, and update/restart agents only when their code or dependencies changed. Re-running `init` or enrolling an existing ID intentionally fails instead of silently rotating secrets. For rollback, restore the previous source and only restore private state if schema compatibility requires it; restarting sessions is expected.

Remove only this project's PM2 apps, marked cron entry or dedicated LaunchAgent when uninstalling. Do not remove the entire PM2 home if it unexpectedly contains other apps. Retain or securely remove private credentials and snapshots according to the operator's wishes. See [SECURITY.md](../SECURITY.md) for revocation.
