# Deployment workflow

- The user's source of truth is the local checkout and GitHub repository `https://github.com/bitwaters/sol.git`.
- Edit source code, tracked configuration, deployment scripts and documentation locally. Test, commit and push before deploying.
- SEA deployment checkout: `/www/wwwroot/sol`. Never edit tracked files directly on SEA. Deploy only committed GitHub revisions using a fast-forward update; inspect and stop on unexpected remote changes.
- Keep original local history backups local; do not push backup branches or use force pushes without an explicit request.
- Secrets are not source code: prepare credentials locally and transfer them over SSH to `/etc/sol/sol.env` with mode 600. Never commit `.env`, private keys, wallet lists, raw API responses, databases or logs.
- Runtime data belongs in `/var/lib/sol`, outside the web root. Creating runtime data, backups and performing container operations are deployment tasks; they do not authorize editing server source files.
- Preserve `DRY_RUN=1` during deployment debugging unless the user explicitly authorizes Telegram delivery. Do not print credentials or raw private wallet data in deployment output.
- Follow the cycle: local edit → tests → GitHub push → SEA pull/deploy → runtime diagnostics → local edit.
