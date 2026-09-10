import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RemoteDatabase } from './remote-db.mjs';
import { prepareAudio, probeAudio } from './audio.mjs';

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
  const large = process.env.DEPLOYMENT_TEST_LARGE === 'true';
  let phase = 'generate';
  try {
    let file = directory + '/render-delivery-test.mp3';
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=5', '-af', 'volume=0.03', '-c:a', 'libmp3lame', '-b:a', large ? '320k' : '64k', file]);
    if (large) {
      const extended = directory + '/large-test.mp3';
      await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-stream_loop', '-1', '-i', file,
        '-t', '1300', '-c:a', 'copy', extended], { timeout: 120000 });
      file = extended;
      if ((await stat(file)).size <= 50_000_000) throw new Error('test_input_too_small');
    }
    phase = 'prepare';
    const original = await probeAudio(file);
    const parts = await prepareAudio(file, directory + '/parts');
    const durations = await Promise.all(parts.map(part => probeAudio(part)));
    if (Math.abs(durations.reduce((sum, part) => sum + part.duration, 0) - original.duration) > 1)
      throw new Error('test_duration_mismatch');
    await db.exec('CREATE TABLE IF NOT EXISTS deployment_test_parts (test_id TEXT, part INTEGER, bytes INTEGER, duration REAL, message_id INTEGER, status TEXT, PRIMARY KEY(test_id,part))');
    await db.prepare("INSERT INTO deployment_test_parts (test_id,part,bytes,duration,status) VALUES (?,0,?,?,'source')")
      .run(id, (await stat(file)).size, original.duration);
    let totalBytes = 0;
    let lastMessage;
    for (const [index, part] of parts.entries()) {
      phase = 'upload';
      const audio = await readFile(part);
      if (audio.length > 49_000_000) throw new Error('test_part_too_large');
      await db.prepare("INSERT INTO deployment_test_parts (test_id,part,bytes,duration,status) VALUES (?,?,?,?,'attempted')")
        .run(id, index + 1, audio.length, durations[index].duration);
      const form = new FormData(); form.set('chat_id', chat);
      form.set('title', large ? `Large-file delivery test — part ${index + 1}/${parts.length}` : 'Render delivery test'); form.set('performer', 'Shelf');
      form.set('caption', large ? `Generated quiet test tone, split from a file over 50 MB on Render. Part ${index + 1}/${parts.length}. This tests large-file processing and Telegram delivery, not RuTracker search.`
        : 'Generated 5-second test audio sent from the deployed Render service. This checks hosting and Telegram upload; RuTracker search is not part of this test.');
      form.set('disable_notification', 'true');
      form.set('audio', new Blob([audio], { type: 'audio/mpeg' }), 'render-delivery-test.mp3');
      const response = await fetch(process.env.TELEGRAM_RELAY_URL + '/delivery/sendAudio', {
        method: 'POST', headers: { authorization: 'Bearer ' + relaySecret }, body: form,
        redirect: 'error', signal: AbortSignal.timeout(180000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.result?.audio) throw new Error('test_delivery_failed');
      if (result.result.audio.file_size !== audio.length) throw new Error('test_upload_size_mismatch');
      lastMessage = result.result.message_id;
      totalBytes += audio.length;
      await db.prepare("UPDATE deployment_test_parts SET status='delivered', message_id=? WHERE test_id=? AND part=?")
        .run(lastMessage, id, index + 1);
    }
    await db.prepare("UPDATE deployment_tests SET status='delivered', message_id=?, bytes=? WHERE id=?")
      .run(lastMessage, totalBytes, id);
    console.log('Deployment audio test delivered successfully.');
  } catch {
    await db.prepare('UPDATE deployment_tests SET status=? WHERE id=?').run('unconfirmed_' + phase, id).catch(() => {});
    console.error('Deployment audio test did not confirm delivery; no automatic retry.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
