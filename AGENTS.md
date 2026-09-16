# Instructions for coding and deployment agents

Read [the deployment runbook](docs/DEPLOYMENT_FOR_AGENTS.md) before installing anything. It specifies the required central server, domain/Quick Tunnel decision, host enrollment, PM2, optional boot recovery and verification.

- Runtime configuration and telemetry belong outside this checkout. Never print, commit or upload passwords, tokens, private host inventories, raw process listings or live dashboard screenshots.
- Use the synthetic demo for screenshots. Do not connect the demo to a real hub.
- Default to user-space installation. Do not use sudo, modify global services, enable lingering, or overwrite SSH/Cloudflare/PM2 settings. Preserve unrelated processes and crontab entries.
- On managed clusters, respect the site's monitoring and scheduler-query policies. Confirm permission for the intended persistent collector; no test GPU job is needed for installation.
- Keep source-bound tokens, strict origin checking, secure cookies and the private-data service-worker exclusions intact. Never work around failures by disabling TLS verification or authentication.
- Run `npm test` and `python -m unittest discover -s tests -p 'test_*.py'` after relevant code changes. Keep both UI languages in sync.
- Do not invent domain names, SSH destinations or administrator permissions. Ask only for missing deployment facts, and continue independent local preparation where possible.
