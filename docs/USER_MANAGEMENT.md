# Users, devices and one-command installation

GPU Observatory 2 adds private user workspaces. Open **My devices** in the dashboard header, or visit `/devices` after login. Each user sees only their own GPU/CPU/RAM data and devices. Administrators manage accounts on the same page; admin status does not automatically expose other users' telemetry. There is no public self-registration.

Administrators can open **All users’ devices** below the user list to see a read-only inventory with exactly three fields: owner username, device display name and distinct GPU model names. Models come from the last successful GPU report and remain available when a device goes offline or collection fails. Devices without known models show a placeholder. Use **Refresh inventory** to reload this list; it does not poll live telemetry. No utilization, memory, processes, hardware identifiers, report times or credentials are included. Ordinary users cannot access this inventory endpoint.

## Administrator workflow

1. Sign in with the existing dashboard account. During upgrade it becomes the initial administrator automatically.
2. Open **My devices → User management → Create user**. Choose a unique username, an initial password of 12–256 characters and a role. Ordinary users are the default. Administrators can create/manage other accounts, so assign that role deliberately.
3. Share the site URL and initial credentials privately. The user can change their password in **Account settings**.
4. Disable/enable accounts or reset their passwords from the user list. Disabling invalidates browser sessions and installation links immediately, and rejects device reports until re-enabled. Password changes/resets invalidate that user's sessions. You cannot disable your own account.

## Device owner workflow

1. Open **My devices → Add device** and enter a display name.
2. Optionally select **Linux user-cron startup at boot**, only where the host permits it. PM2 process supervision is always enabled; OS boot recovery is a separate option. The default creates no boot hook.
3. Copy the **install command** and run it as your normal user on the intended Linux NVIDIA server. Do not use sudo. You can alternatively copy the install link and download/inspect the Python script before running it.
4. Watch for the first report on **My devices** and then open the dashboard. A new device does not require restarting the hub.

The target needs Python 3.10+, pip/virtualenv support, `curl`, Bash, an NVIDIA driver with `nvidia-smi` on PATH, and outbound HTTPS to this hub, PyPI, npm and (if Node is missing/old) nodejs.org. The installer identifies requests as `gpu-observatory-installer/2.0`. Your HTTPS ingress must allow `/install/*`, `/api/agent-package` and `/api/enroll` without an interactive proxy login; the one-time ticket protects enrollment. No Git checkout, inbound SSH listener for the hub, or manually copied reporter token is needed. Package installation uses a private virtual environment and PM2 prefix. If these prerequisites are restricted by site policy, use the manual deployment runbook with administrator-approved dependencies.

The generated command uses Bash `pipefail`, so a failed download does not appear successful because Python received empty input. Both downloads and agent reports verify HTTPS certificates; redirects are not followed by the installer. HTTP-only development hubs can preview the UI but their generated install commands are intentionally unusable: configure public HTTPS before installing reporters.

Each installation has its own directory under `~/.local/share/gpu-agents/<installation-id>` and its own PM2 home, keyed by the hub origin and device ID. It will not replace an unrelated legacy `~/.local/share/gpu-monitor` deployment. `pm2.sh status` in that directory shows the reporter. The private `agent-config.json` contains that device's long-lived credential and has mode 0600. Keep it out of Git and screenshots.

## Installation-link lifecycle

Links are bearer capabilities: anyone holding an unused link can enroll that device. Keep them private. A link expires after 15 minutes, can enroll once, and is bound to the device, owner and hub origin. The hub stores only its hash. Fetching/previewing the script does not consume it. Dependencies are prepared first; the final enrollment POST consumes it and creates a new source-bound reporting credential.

Generating another link invalidates older links for that device but leaves its running reporter active. Redeeming the replacement link rotates the reporting credential. The previous reporter then receives 401; stop any obsolete PM2 process on its original machine yourself. Removing a device immediately revokes its reporting credential and deletes its hub snapshot; it does not execute remote commands or uninstall software.

If a slow dependency download takes longer than 15 minutes, generate another link and run the new command. Cached dependencies are reused. If enrollment succeeded but PM2 startup failed, the script prints the installation directory: run `GPU_MONITOR_ROOT="/that/directory" python3 /that/directory/setup-agent.py` there to retry without needing the consumed link. Add `--boot` only if desired and permitted. If the enrollment response was lost before a config was saved, generate a new link. Re-running without `--boot` does not remove an existing cron hook.

The installation script is served by your own trusted hub. The hub also serves an explicit source-file manifest with SHA-256 hashes; these detect damaged package contents, not a compromised hub. Do not run installation commands from an untrusted monitoring server. Avoid access logs containing `/install/*` URLs; the short-lived token is in the URL. Long-lived reporter tokens are returned only by the enrollment POST, never embedded in installation URLs or commands.

## Upgrade from version 1

Back up your private config and state, update the source checkout, and restart **only `gpu-dashboard`**. Existing reporter URLs and tokens remain valid. No GPU reporter redeployment is needed just to enable user management. Do not restart a Quick Tunnel unnecessarily.

The first start migrates the old username/password hash to an administrator and assigns existing GPU hosts and Slurm sources to that account. New installs store user/device state in `config.accountsFile` (normally `$HUB_STATE/accounts.json`). For older configs without that field, it defaults to `accounts.json` beside `stateFile`, normally `$HUB_STATE/data/accounts.json`. The file uses mode 0600. Back it up with the snapshots; losing it loses new users, ownership and web-enrolled credentials. Run a single hub process against this state file; PM2 cluster mode or multiple writers are not supported.

Existing config-defined hosts still load at startup. Web renames and removals override their legacy entries, so a removed device does not return on restart. CLI `add-host`/`add-slurm` remain available and assign sources to the initial administrator by default; restart the hub after CLI configuration changes. A Slurm source can have an explicit `ownerId` matching a user ID, set by the hub operator. The browser installer enrolls GPU reporters only, not Slurm collectors; cluster permission checks still apply.

After migration, passwords live in the accounts file. Editing the old top-level password hash no longer changes the login password. For administrator recovery, stop the hub to avoid concurrent state writes, then run from the source checkout:

```sh
node scripts/manage.mjs reset-password YOUR_USERNAME --state "$HUB_STATE"
```

Read `$HUB_STATE/reset-login-credentials.txt` privately and restart the hub. This changes the password and invalidates outstanding install links without exposing credential values in terminal output. It does not re-enable a disabled account. Prefer the web interface while a working administrator is available.

## Changing the public URL

Follow `manage.mjs set-origin` and restart the hub as in the deployment runbook. Existing install links become invalid because they are bound to the old origin. Web-enrolled devices have no plaintext enrollment file on the hub: securely update the `url` in each remote private `agent-config.json`, keeping its token, then restart that reporter with its own PM2 helper. Alternatively, generate a new install link and reinstall, then stop the obsolete old-origin installation. New origins create separate installation directories. Update bookmarks and installed PWAs as well.

## Rollback

Keep the previous private-state backup before upgrading. Version 1 has no ownership filtering and cannot understand web-enrolled users/devices. Do not point an older public hub at a multi-user deployment without restricting access and restoring the appropriate pre-upgrade configuration/state. Preserve the version 2 accounts file privately for recovery; never commit it.
