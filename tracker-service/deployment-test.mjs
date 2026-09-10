import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RemoteDatabase } from './remote-db.mjs';

// Explicit, one-shot deployment check. The durable claim prevents duplicate
// Telegram messages across restarts, including an uncertain upload response.
export async function deploymentTest() {
  const id = process.env.DEPLOYMENT_TEST_ID;
  if (!id) return;
  const chat = process.env.DEPLOYMENT_TEST_CHAT_ID;
  if (!/^[a-z0-9-]{1,64}$/.test(id) || !/^[1-9]\d{0,15}$/.test(chat || '')) throw new Error('invalid_test_configuration');
  const stateSecret = (await readFile(process.env.STATE_SERVICE_SECRET_FILE, 'utf8')).trim();
  const relaySecret = (await readFile(process.env.DELIVERY_RELAY_SECRET_FILE, 'utf8')).trim();
  const db = new RemoteDatabase(process.env.STATE_SERVICE_URL, stateSecret);
  await db.exec('CREATE TABLE IF NOT EXISTS deployment_tests (id TEXT PRIMARY KEY, status TEXT NOT NULL, message_id INTEGER, bytes INTEGER)');
  const claimed = await db.prepare("INSERT INTO deployment_tests (id,status) VALUES (?,'attempted') ON CONFLICT DO NOTHING RETURNING id").get(id);
  if (!claimed) return;
  const directory = await mkdtemp('/data/deployment-test-');
  try {
    const file = directory + '/render-delivery-test.mp3';
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=5', '-af', 'volume=0.03', '-c:a', 'libmp3lame', '-b:a', '64k', file]);
    const audio = await readFile(file);
    const form = new FormData(); form.set('chat_id', chat);
    form.set('title', 'Render delivery test'); form.set('performer', 'Shelf');
    form.set('caption', 'Generated 5-second test audio sent from the deployed Render service. This checks hosting and Telegram upload; RuTracker search is not part of this test.');
    form.set('disable_notification', 'true');
    form.set('audio', new Blob([audio], { type: 'audio/mpeg' }), 'render-delivery-test.mp3');
    const response = await fetch(process.env.TELEGRAM_RELAY_URL + '/delivery/sendAudio', {
      method: 'POST', headers: { authorization: 'Bearer ' + relaySecret }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.result?.audio) throw new Error('test_delivery_failed');
    await db.prepare("UPDATE deployment_tests SET status='delivered', message_id=?, bytes=? WHERE id=?")
      .run(result.result.message_id, result.result.audio.file_size, id);
    console.log('Deployment audio test delivered successfully.');
  } catch {
    console.error('Deployment audio test did not confirm delivery; no automatic retry.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
