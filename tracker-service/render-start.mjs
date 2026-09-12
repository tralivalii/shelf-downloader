import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deploymentTest } from './deployment-test.mjs';

process.umask(0o077);
const directory = path.resolve(process.env.SHELF_DATA_DIRECTORY || '/data');
const secrets = path.join(directory, 'secrets');
const jackettDirectory = path.join(directory, 'jackett');
const children = [];
let stopping = false;
function stop(code = 1) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 3000);
}
async function start() {
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await mkdir(jackettDirectory, { recursive: true, mode: 0o700 });
  const indexersDirectory = path.join(jackettDirectory, 'Indexers');
  await mkdir(indexersDirectory, { recursive: true, mode: 0o700 });
  // Render's secret environment variables become private files at runtime.
  for (const name of ['BOT_TOKEN', 'TRACKER_SERVICE_SECRET', 'JACKETT_API_KEY', 'STATE_SERVICE_SECRET', 'DELIVERY_RELAY_SECRET']) {
    if (!process.env[name]) continue;
    const file = path.join(secrets, name.toLowerCase());
    await writeFile(file, process.env[name], { mode: 0o600 });
    process.env[name + '_FILE'] = file;
    delete process.env[name];
  }

  const rutrackerCookie = process.env.RUTRACKER_COOKIE || '';
  const rutrackerUser = process.env.RUTRACKER_USERNAME || process.env.RUTRACKER_USER || '';
  const rutrackerPass = process.env.RUTRACKER_PASSWORD || process.env.RUTRACKER_PASS || '';

  if (rutrackerCookie || (rutrackerUser && rutrackerPass)) {
    const configItems = [];
    if (rutrackerUser) configItems.push({ id: 'username', value: rutrackerUser });
    if (rutrackerPass) configItems.push({ id: 'password', value: rutrackerPass });
    if (rutrackerCookie) configItems.push({ id: 'cookie', value: rutrackerCookie });
    await writeFile(path.join(indexersDirectory, 'rutracker.json'), JSON.stringify(configItems, null, 2), { mode: 0o600 });
  }
  delete process.env.RUTRACKER_COOKIE;
  delete process.env.RUTRACKER_USERNAME;
  delete process.env.RUTRACKER_USER;
  delete process.env.RUTRACKER_PASSWORD;
  delete process.env.RUTRACKER_PASS;
  const apiKey = (await readFile(process.env.JACKETT_API_KEY_FILE, 'utf8')).trim();
  await writeFile(path.join(jackettDirectory, 'ServerConfig.json'), JSON.stringify({
    Port: 9117, LocalBindAddress: '127.0.0.1', AllowExternal: false,
    APIKey: apiKey, UpdateDisabled: true, CacheEnabled: false,
  }), { mode: 0o600 });
  // Source accounts are deliberately not created or logged in by this launcher.
  const jackett = spawn('/opt/jackett/jackett', ['--NoUpdates', '--ListenPrivate', '--DataFolder', jackettDirectory], {
    stdio: 'ignore', env: { ...process.env, DOTNET_GCHeapHardLimit: '0x08000000' },
  });
  children.push(jackett);
  jackett.on('error', () => stop()); jackett.on('exit', () => stop());
  let ready = false;
  for (let attempt = 0; attempt < 90 && !stopping; attempt++) {
    try { const response = await fetch('http://127.0.0.1:9117/', { signal: AbortSignal.timeout(2000) }); ready = response.status < 500; }
    catch {}
    if (ready) break;
    await delay(1000);
  }
  if (!ready) throw new Error('source_service_start_failed');
  await deploymentTest();
  const bot = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: process.env });
  children.push(bot);
  bot.on('error', () => stop()); bot.on('exit', () => stop());
  process.once('SIGTERM', () => stop(0)); process.once('SIGINT', () => stop(0));
}
start().catch(() => { console.error('Downloader startup failed. Check private runtime configuration.'); stop(); });
