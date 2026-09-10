# Audiobook downloader

A companion service for a Telegram audiobook bot. It searches a privately
configured Jackett service, downloads a selected torrent with aria2, validates
MP3/M4A audio with FFmpeg, and sends playable Telegram tracks. Files over 49 MB
are split without re-encoding. This repository contains the downloader only;
it does not include a Telegram chat frontend, source accounts, or credentials.

## Render deployment

Use `tracker-service/Dockerfile.render` with the repository root as build context.
The image runs Node 24 and a loopback-only Jackett instance as an unprivileged
user. Set private runtime environment variables:

| Variable | Purpose |
| --- | --- |
| `TRACKER_SERVICE_SECRET` | At least 32 characters; authenticates every HTTP route |
| `JACKETT_API_KEY` | Private local Jackett API credential |
| `STATE_SERVICE_URL`, `STATE_SERVICE_SECRET` | Authenticated persistent SQL service |
| `TELEGRAM_RELAY_URL`, `DELIVERY_RELAY_SECRET` | Authenticated Telegram upload relay |
| `BOT_TOKEN` | Alternative to a relay; not needed when a relay is configured |

The launcher writes secrets to private files, then removes their plaintext
variables before launching child processes. It does not create or log into any
source account. Source configuration is a separate deployment prerequisite.

`GET /health` and `POST /jobs` require the shared bearer credential. The service
limits each user to one active job, processes one download at a time, and uses
a database lease to prevent simultaneous downloader instances. Uncertain uploads
are not automatically retried. Known terminal-job files are cleaned up.

The default SQLite database is unsuitable for an ephemeral host. Configure the
persistent state service to retain selections, quotas and jobs across restarts.
Downloaded audio is temporary and must be downloaded again after a restart.

## Limits and verification

Render Free has limited CPU, memory, bandwidth and uptime behavior. Read the
[current Free documentation](https://render.com/docs/free) before deployment;
a successful startup does not establish long-term suitability for large downloads.
Use only material you are authorized to download and distribute.

An optional `DEPLOYMENT_TEST_ID` and `DEPLOYMENT_TEST_CHAT_ID` enables one clearly
labelled five-second generated-audio delivery check. It needs the state service
and Telegram relay, claims the test ID durably before sending, and never retries
an uncertain upload automatically. Remove these settings after verification.
This check does not validate source login, search or an external BitTorrent swarm.
