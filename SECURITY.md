# Security and privacy

The production dashboard requires a password. Reporters use separate, source-bound bearer tokens; an agent token cannot read the dashboard or impersonate another source. Passwords use salted scrypt, sessions use HttpOnly/SameSite cookies, and HTTPS deployments use Secure cookies. Login and ingestion have rate limits. The hub binds only to loopback; put an HTTPS tunnel or trusted reverse proxy in front of it. Do not disable authentication at the proxy or remove application authentication.

Telemetry contains hostnames, OS usernames, process names, PIDs, resource usage and (optionally) Slurm jobs. Treat it as private. Full process command lines, environment variables, Slurm working directories and commands are not collected. Process names and job metadata can still contain sensitive information. OS permissions determine which processes are visible; never elevate privileges to bypass them.

Only the latest snapshots are persisted, with mode 0600. Configuration, enrollment tokens, login credentials, PM2 state and logs must stay outside the repository. PM2 dump files and backups may contain sensitive paths and configuration. Git ignore rules are defense in depth, not a replacement for reviewing staged files.

The service worker caches only public assets and an offline placeholder. It does not cache authenticated HTML or API responses. Logging out revokes the current session; restarting the hub invalidates all sessions. This is a single shared dashboard account, not a multi-tenant access-control system. There is no historical metrics database or audit trail.

To revoke a reporter, remove its entry from `hosts` or `slurmSources` in the private hub config and restart the hub. Stop that reporter. For replacement, enroll a new ID and distribute its new token. Rotate the dashboard password by generating a fresh random password and salt and deriving `scryptSync(password, salt, 64).toString('hex')` in a private local script; write the resulting salt/hash to the config with mode 0600, then restart the hub. Do not place plaintext credentials in CLI arguments, issues or shell history.

`npm run demo` serves only invented fixture data and has no authentication. It is bound to loopback and is separate from the production server. Never adapt it to serve real data or expose it as a production deployment.

For a vulnerability, use the repository's private vulnerability reporting channel if available. Otherwise open a minimal issue asking for a private contact; do not post credentials, exploit payloads against a live deployment, or private telemetry publicly.
