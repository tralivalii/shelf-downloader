import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, stat, realpath, statfs } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { searchJackett } from './catalogue.mjs';
import { inspectTorrent } from './torrent.mjs';
import { cleanupFinishedJobs } from './cleanup.mjs';
import { prepareAudio } from './audio.mjs';
import { RemoteDatabase } from './remote-db.mjs';
import { acquireLease, renewLease } from './lease.mjs';

async function secret(name) {
  if (!process.env[name + '_FILE']) throw new Error(name + '_FILE is required');
  return (await readFile(process.env[name + '_FILE'], 'utf8')).trim();
}

export function authorised(header, expected) {
  const actual = Buffer.from(String(header || ''));
  const wanted = Buffer.from('Bearer ' + expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_000) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function ariaProgress(output) {
  const match = output.match(/\[#[a-f0-9]+\s+[^\r\n(]*\((\d{1,3})%\)/i);
  return match ? Math.min(100, Number(match[1])) : null;
}

async function run(command, args, timeoutMs, cwd, onProgress, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', onProgress ? 'pipe' : 'ignore', 'ignore'] });
    let pending = Promise.resolve();
    let notifying = false;
    let last = 0;
    let tail = '';
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => {
      tail = (tail + chunk.toString()).slice(-4096);
      const percent = ariaProgress(tail);
      if (percent === null || notifying || Date.now() - last < 15_000) return;
      last = Date.now(); notifying = true;
      pending = Promise.resolve().then(() => onProgress(percent)).catch(() => {}).finally(() => { notifying = false; });
      tail = '';
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new Error('missing_runtime')); });
    child.on('close', async code => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer); await pending;
      code === 0 ? resolve() : reject(new Error(timedOut ? 'torrent_timeout' : 'torrent_download_failed'));
    });
  });
}

export function jobFailure(error) {
  const code = error?.code === 'ENOSPC' ? 'insufficient_disk_space' : error?.message;
  const reasons = {
    insufficient_disk_space: 'The server does not have enough free disk space.',
    unsupported_audio_format: 'This recording is not available entirely as MP3/M4A audio. Choose another release.',
    no_supported_audio: 'This torrent contains no supported audiobook tracks.',
    invalid_audio: 'The downloaded file is not valid supported audio.',
    telegram_failed: 'Telegram did not confirm the upload. Some tracks may already have arrived.',
    torrent_timeout: 'The download exceeded its time limit. The torrent may be stalled.',
    torrent_download_failed: 'The torrent download failed or stopped making progress. Try a release with more seeders.',
    torrent_unavailable: 'The source could not provide this torrent. Its login may have expired.',
    audiobook_too_large: 'This recording exceeds the shared service download limit.',
  };
  return reasons[code] || 'The recording could not be fully delivered. Please try another release.';
}

async function telegram(config, method, body) {
  const form = body instanceof FormData;
  const endpoint = config.telegramRelayURL ? config.telegramRelayURL + '/delivery/' + method
    : 'https://api.telegram.org/bot' + config.botToken + '/' + method;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...(config.telegramRelayURL ? { authorization: 'Bearer ' + config.telegramRelaySecret } : {}) },
    redirect: 'error',
    body: form ? body : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(config.signal ? [config.signal] : [])]),
  });
  if (!response.ok) throw new Error('telegram_failed');
  const data = await response.json();
  if (!data.ok) throw new Error('telegram_failed');
  return data.result;
}

function chatAllowed(config, body) {
  return Number.isSafeInteger(body.userID) && body.userID > 0 && body.chatID === body.userID &&
    (config.publicAccess === true || config.allowed?.has(String(body.userID)));
}

export async function createService(config, db, { search = searchJackett, now = Date.now } = {}) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, callback_id TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL,
      result TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS search_limits (
      user_id INTEGER NOT NULL, bucket INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY (user_id, bucket)
    );
    CREATE TABLE IF NOT EXISTS downloader_lease (
      slot INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL
    );
  `);
  const columns = new Set((await db.prepare('PRAGMA table_info(jobs)').all()).map(column => column.name));
  if (!columns.has('phase')) await db.exec("ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'");
  if (!columns.has('progress')) await db.exec('ALTER TABLE jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0');
  const enqueue = async (body, selected, response) => {
    const previous = await db.prepare('SELECT id, status, user_id FROM jobs WHERE callback_id = ?').get(body.callbackID);
    if (previous) {
      if (previous.user_id !== body.userID) return reply(response, 403, { error: 'forbidden' });
      return reply(response, 200, { jobID: previous.id, status: previous.status });
    }
    const duplicate = await db.prepare("SELECT id, status FROM jobs WHERE user_id = ? AND status IN ('pending','processing') AND result = ?")
      .get(body.userID, selected);
    if (duplicate) return reply(response, 200, { jobID: duplicate.id, status: duplicate.status });
    const counts = await db.prepare(`SELECT
      sum(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS active,
      sum(CASE WHEN user_id = ? AND status IN ('pending','processing') THEN 1 ELSE 0 END) AS user_active,
      sum(CASE WHEN created > ? THEN 1 ELSE 0 END) AS daily,
      sum(CASE WHEN user_id = ? AND created > ? THEN 1 ELSE 0 END) AS user_daily FROM jobs`)
      .get(body.userID, now() - 86400_000, body.userID, now() - 86400_000);
    if (counts.active >= 3) return reply(response, 429, { error: 'queue_full' });
    if (counts.user_active >= 1) return reply(response, 429, { error: 'download_already_active' });
    if (counts.user_daily >= (config.maxUserDailyJobs ?? 3) || counts.daily >= (config.maxDailyJobs ?? 10)) {
      return reply(response, 429, { error: 'daily_download_limit' });
    }
    const id = randomBytes(16).toString('hex');
    // One conditional statement makes admission atomic across overlapping hosts.
    const admitted = await db.prepare(`INSERT INTO jobs (id, callback_id, user_id, result, created)
      SELECT ?, ?, ?, ?, ? WHERE
      (SELECT count(*) FROM jobs WHERE status IN ('pending','processing')) < 3 AND
      NOT EXISTS (SELECT 1 FROM jobs WHERE user_id = ? AND status IN ('pending','processing')) AND
      (SELECT count(*) FROM jobs WHERE created > ?) < ? AND
      (SELECT count(*) FROM jobs WHERE user_id = ? AND created > ?) < ?
      RETURNING id`).get(id, body.callbackID, body.userID, selected, now(), body.userID,
        now() - 86400_000, config.maxDailyJobs ?? 10, body.userID, now() - 86400_000, config.maxUserDailyJobs ?? 3);
    if (!admitted) return reply(response, 429, { error: 'download_limit' });
    return reply(response, 202, { jobID: id, status: 'pending' });
  };
  return async (request, response) => {
    if (!authorised(request.headers.authorization, config.secret)) return reply(response, 403, { error: 'forbidden' });
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        return reply(response, 200, { ok: true, indexers: config.jackett.indexers });
      }
      if (url.pathname === '/admin/configure-rutracker') {
        if (request.method !== 'POST') return reply(response, 404, { error: 'not_found' });
        const body = await readJSON(request);
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        const cookie = String(body.cookie || '').trim();
        if (!cookie && (!username || !password)) return reply(response, 400, { error: 'invalid_credentials' });
        const jackettDir = path.resolve(config.dataDirectory, '../jackett/Indexers');
        const secretsDir = path.resolve(config.dataDirectory, 'secrets');
        await mkdir(jackettDir, { recursive: true, mode: 0o700 });
        await mkdir(secretsDir, { recursive: true, mode: 0o700 });
        const configItems = [];
        if (username) configItems.push({ id: 'username', value: username });
        if (password) configItems.push({ id: 'password', value: password });
        if (cookie) configItems.push({ id: 'cookie', value: cookie });
        await writeFile(path.join(jackettDir, 'rutracker.json'), JSON.stringify(configItems, null, 2), { mode: 0o600 });
        await writeFile(path.join(secretsDir, 'rutracker_config.json'), JSON.stringify({ username, password, cookie }, null, 2), { mode: 0o600 });
        return reply(response, 200, { ok: true });
      }
      if (request.method !== 'POST') return reply(response, 404, { error: 'not_found' });
      const body = await readJSON(request);
      if (!chatAllowed(config, body)) return reply(response, 403, { error: 'private_bot' });
      if (url.pathname === '/jobs') {
        const jobs = (await db.prepare('SELECT id, result, status, phase, progress, sent FROM jobs WHERE user_id = ? ORDER BY created DESC, rowid DESC LIMIT 5')
          .all(body.userID)).map(({ result, ...job }) => ({ ...job, title: String(JSON.parse(result).title || '').slice(0, 240) }));
        return reply(response, 200, { jobs });
      }
      if (url.pathname === '/retry') {
        if (!/^[a-f0-9]{32}$/.test(body.jobID) || typeof body.callbackID !== 'string' ||
          body.callbackID.length < 1 || body.callbackID.length > 256) return reply(response, 400, { error: 'invalid_selection' });
        const original = await db.prepare("SELECT result FROM jobs WHERE id = ? AND user_id = ? AND status IN ('failed','interrupted')")
          .get(body.jobID, body.userID);
        if (!original) return reply(response, 404, { error: 'job_not_retryable' });
        return await enqueue(body, original.result, response);
      }
      if (url.pathname === '/search') {
        if (typeof body.query !== 'string' || body.query.length < 1 || body.query.length > 120) {
          return reply(response, 400, { error: 'invalid_query' });
        }
        const bucket = Math.floor(now() / 60_000);
        await db.prepare('DELETE FROM search_limits WHERE bucket < ?').run(bucket);
        const admitted = await db.prepare(`INSERT INTO search_limits
          SELECT ?, ?, 1 WHERE COALESCE((SELECT sum(used) FROM search_limits WHERE bucket = ?), 0) < 60
          ON CONFLICT(user_id, bucket) DO UPDATE SET used = used + 1 WHERE used < 5 RETURNING used`)
          .get(body.userID, bucket, bucket);
        if (!admitted) return reply(response, 429, { error: 'search_limit' });
        const data = await search(config.jackett, body.query);
        await db.prepare('DELETE FROM results WHERE expires < ?').run(Date.now());
        for (const result of data.results) {
          await db.prepare('INSERT INTO results VALUES (?, ?, ?, ?)').run(result.id, body.userID, JSON.stringify(result), Date.now() + 86400_000);
        }
        return reply(response, 200, {
          results: data.results.map(({ downloadURL, ...publicResult }) => publicResult),
          unavailable: data.unavailable,
        });
      }
      if (url.pathname === '/downloads') {
        if (!/^[a-f0-9]{32}$/.test(body.resultID) || typeof body.callbackID !== 'string' ||
          body.callbackID.length < 1 || body.callbackID.length > 256) return reply(response, 400, { error: 'invalid_selection' });
        const previous = await db.prepare('SELECT id, status, user_id FROM jobs WHERE callback_id = ?').get(body.callbackID);
        if (previous) {
          if (previous.user_id !== body.userID) return reply(response, 403, { error: 'forbidden' });
          return reply(response, 200, { jobID: previous.id, status: previous.status });
        }
        const selected = await db.prepare('SELECT value FROM results WHERE id = ? AND user_id = ? AND expires > ?')
          .get(body.resultID, body.userID, Date.now());
        if (!selected) return reply(response, 404, { error: 'result_expired' });
        return await enqueue(body, selected.value, response);
      }
      return reply(response, 404, { error: 'not_found' });
    } catch {
      return reply(response, 502, { error: 'service_unavailable' });
    }
  };
}

async function torrentBytes(config, downloadURL) {
  const target = new URL(downloadURL);
  const jackett = new URL(config.jackett.url);
  // Jackett's download proxy owns tracker cookies. No client-provided URLs or
  // credentials are passed to aria2, and arbitrary internal HTTP URLs are denied.
  if (target.origin !== jackett.origin || !target.pathname.startsWith('/dl/')) throw new Error('invalid_download_proxy');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('torrent_unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4_000_000) throw new Error('torrent_metadata_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function deliverJob(config, db, job, { send = telegram, downloadTimeoutMs = 90 * 60_000 } = {}) {
  if (!chatAllowed(config, { userID: job.user_id, chatID: job.user_id })) throw new Error('access_revoked');
  const result = JSON.parse(job.result);
  const directory = path.join(config.dataDirectory, 'downloads', job.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await torrentBytes(config, result.downloadURL);
  const files = inspectTorrent(metadata);
  const disk = await statfs(directory);
  const selectedBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (disk.bavail * disk.bsize < selectedBytes * 2 + 512_000_000) throw new Error('insufficient_disk_space');
  await writeFile(path.join(directory, 'source.torrent'), metadata, { mode: 0o600 });
  const notification = await send(config, 'sendMessage', {
    chat_id: job.user_id,
    text: 'Downloading “' + result.title + '” from ' + result.source + '. I will send the audio here when it is ready.',
  });
  const progress = async (phase, percent, text) => {
    config.signal?.throwIfAborted();
    await db.prepare('UPDATE jobs SET phase = ?, progress = ? WHERE id = ?').run(phase, percent, job.id);
    if (notification?.message_id) {
      try { await send(config, 'editMessageText', { chat_id: job.user_id, message_id: notification.message_id, text }); }
      catch {} // Losing a status edit must not cancel an otherwise valid download.
    }
  };
  await progress('downloading', 0, 'Downloading “' + result.title + '”…');
  await run(config.aria2, [
    '--no-conf=true', '--enable-rpc=false', '--file-allocation=none', '--check-integrity=true',
    '--seed-time=0', '--max-upload-limit=64K', '--bt-stop-timeout=180',
    '--max-overall-download-limit=8M', '--max-connection-per-server=2',
    '--auto-file-renaming=false', '--allow-overwrite=false', '--follow-torrent=false',
    '--summary-interval=15', '--show-console-readout=true', '--enable-color=false', '--console-log-level=error',
    '--select-file=' + files.map(file => file.index).join(','), '--dir=' + directory,
    path.join(directory, 'source.torrent'),
  ], downloadTimeoutMs, directory, percent => progress('downloading', percent, 'Downloading “' + result.title + '” — ' + percent + '%'), config.signal);

  await progress('preparing', 100, 'Download complete. Checking the audio and preparing Telegram tracks…');
  const audio = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const original = await realpath(path.join(directory, file.path));
    if (!original.startsWith(directory + path.sep)) throw new Error('unsafe_audio_path');
    if ((await stat(original)).size !== file.size) throw new Error('incomplete_download');
    audio.push(...await prepareAudio(original, path.join(directory, 'parts-' + index), config));
    if (audio.length > 300) throw new Error('too_many_tracks');
  }
  for (let index = job.sent; index < audio.length; index++) {
    if (!chatAllowed(config, { userID: job.user_id, chatID: job.user_id })) throw new Error('access_revoked');
    const file = audio[index];
    await progress('uploading', Math.floor(index / audio.length * 100), 'Sending “' + result.title + '” — track ' + (index + 1) + ' of ' + audio.length);
    if ((await stat(file)).size > 49_000_000) throw new Error('telegram_file_too_large');
    const form = new FormData();
    form.set('chat_id', String(job.user_id));
    form.set('title', String(index + 1).padStart(3, '0') + ' · ' + result.title.slice(0, 55));
    form.set('caption', (index + 1) + '/' + audio.length + ' · ' + result.title);
    form.set('disable_notification', 'true');
    form.set('audio', await openAsBlob(file), path.basename(file));
    await send(config, 'sendAudio', form);
    await db.prepare('UPDATE jobs SET sent = ? WHERE id = ?').run(index + 1, job.id);
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  await send(config, 'sendMessage', {
    chat_id: job.user_id,
    text: 'Ready: “' + result.title + '” — ' + audio.length + ' playable audio tracks. Tap any track to listen.',
  });
}

export async function main() {
  process.umask(0o077);
  const config = {
    secret: await secret('TRACKER_SERVICE_SECRET'),
    botToken: process.env.TELEGRAM_RELAY_URL ? '' : await secret('BOT_TOKEN'),
    telegramRelayURL: process.env.TELEGRAM_RELAY_URL,
    telegramRelaySecret: process.env.TELEGRAM_RELAY_URL ? await secret('DELIVERY_RELAY_SECRET') : '',
    publicAccess: process.env.PUBLIC_ACCESS === 'true',
    allowed: new Set(process.env.PUBLIC_ACCESS === 'true' ? [] : (await secret('ALLOWED_USER_IDS')).split(',').map(value => value.trim())),
    maxUserDailyJobs: Number(process.env.MAX_USER_DAILY_JOBS || 3),
    maxDailyJobs: Number(process.env.MAX_DAILY_JOBS || 10),
    jackett: {
      url: process.env.JACKETT_URL || 'http://127.0.0.1:9117',
      apiKey: await secret('JACKETT_API_KEY'),
      indexers: (process.env.JACKETT_INDEXERS || 'rutracker').split(','),
    },
    dataDirectory: path.resolve(process.env.SHELF_DATA_DIRECTORY || './work/tracker-data'),
    aria2: process.env.ARIA2_PATH || 'aria2c',
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  };
  const validTelegram = config.telegramRelayURL
    ? /^https:\/\/[^/?#]+$/.test(config.telegramRelayURL) && config.telegramRelaySecret.length >= 32
    : /^\d+:[\w-]{20,}$/.test(config.botToken);
  if (config.secret.length < 32 || !validTelegram ||
    ![...config.allowed].every(id => /^[1-9]\d{0,15}$/.test(id)) ||
    ![config.maxUserDailyJobs, config.maxDailyJobs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000)) throw new Error('invalid_configuration');
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const db = process.env.STATE_SERVICE_URL
    ? new RemoteDatabase(process.env.STATE_SERVICE_URL, await secret('STATE_SERVICE_SECRET'))
    : new DatabaseSync(path.join(config.dataDirectory, 'shelf.sqlite'));
  const handler = await createService(config, db);
  await cleanupFinishedJobs(db, config.dataDirectory);
  http.createServer(handler).listen(Number(process.env.PORT || 8788), process.env.LISTEN_HOST || '127.0.0.1');
  console.log('Shelf tracker service listening; credentials are never logged.');
  let busy = false;
  let polling = false;
  let renewing = false;
  let leaseExpires = 0;
  let controller = new AbortController();
  const owner = randomBytes(16).toString('hex');
  const loseLease = () => { leaseExpires = 0; controller.abort(new Error('lease_lost')); };
  // Local deadline enforcement still stops uploads if the state service becomes
  // unreachable. A replacement host cannot acquire the lease before it expires.
  setInterval(() => { if (leaseExpires && Date.now() >= leaseExpires) loseLease(); }, 250);
  setInterval(async () => {
    if (!leaseExpires || renewing) return;
    renewing = true;
    const activeController = controller;
    try {
      const expires = await renewLease(db, owner);
      if (activeController.signal.aborted || activeController !== controller) return;
      if (!expires || Date.now() >= expires) loseLease();
      else leaseExpires = expires;
    } catch { loseLease(); }
    finally { renewing = false; }
  }, 10_000);
  setInterval(async () => {
    if (busy || polling || renewing) return;
    polling = true;
    let job;
    try {
      if (!leaseExpires) {
        leaseExpires = await acquireLease(db, owner);
        if (!leaseExpires) return;
        controller = new AbortController();
        // Only the elected downloader can recover an abandoned processing job.
        await db.exec("UPDATE jobs SET status = 'interrupted', phase = 'interrupted' WHERE status = 'processing'");
      }
      controller.signal.throwIfAborted();
      job = await db.prepare(`UPDATE jobs SET status = 'processing'
        WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY created LIMIT 1)
        AND EXISTS (SELECT 1 FROM downloader_lease WHERE owner = ? AND expires > ?)
        RETURNING *`).get(owner, Date.now());
      if (!job) return;
      busy = true;
      await deliverJob({ ...config, signal: controller.signal }, db, job);
      controller.signal.throwIfAborted();
      await db.prepare("UPDATE jobs SET status = 'complete', phase = 'complete', progress = 100 WHERE id = ?").run(job.id);
    } catch (error) {
      if (!job || controller.signal.aborted) return;
      try {
        await db.prepare("UPDATE jobs SET status = 'failed', phase = 'failed' WHERE id = ? AND status = 'processing'").run(job.id);
        await telegram(config, 'sendMessage', {
          chat_id: job.user_id,
          text: jobFailure(error) + '\nUse /status for retry options, or search for another recording.',
        });
      } catch {}
    } finally {
      if (job) {
        try { await cleanupFinishedJobs(db, config.dataDirectory); }
        catch { console.error('Temporary audio cleanup failed; check storage permissions.'); }
      }
      busy = false;
      polling = false;
    }
  }, 1500);
  process.once('SIGTERM', () => { loseLease(); process.exit(0); });
  process.once('SIGINT', () => { loseLease(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Shelf could not start. Check secret files and runtime configuration.'); process.exitCode = 1; });
}
