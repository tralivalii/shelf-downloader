import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

// Never include FFmpeg output in errors: filenames/metadata are untrusted and
// can contain private tracker information. Collect only bounded probe JSON.
async function execute(binary, args, timeoutMs, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = '';
    let failure;
    const stop = code => { failure = code; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('audio_process_timeout'), timeoutMs);
    child.stdout?.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 64_000) stop('invalid_audio');
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('missing_audio_runtime')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(failure || 'invalid_audio'));
      else resolve(output);
    });
  });
}

function inputOptions(file) {
  const extension = path.extname(file).toLowerCase();
  const format = { '.mp3': 'mp3', '.m4a': 'mov' }[extension];
  if (!format) throw new Error('unsupported_audio_format');
  return ['-protocol_whitelist', 'file,pipe', '-f', format,
    ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-i', file];
}

export async function probeAudio(file, ffprobe = 'ffprobe') {
  const data = JSON.parse(await execute(ffprobe, ['-v', 'error', ...inputOptions(file),
    '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json'], 30_000, true));
  const duration = Number(data.format?.duration);
  const streams = data.streams?.filter(stream => stream.codec_type === 'audio') || [];
  if (!Number.isFinite(duration) || duration <= 0 || streams.length !== 1 ||
      !['mp3', 'aac', 'alac'].includes(streams[0].codec_name)) throw new Error('invalid_audio');
  return { duration, codec: streams[0].codec_name };
}

export async function prepareAudio(file, outputDirectory, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', maxBytes = 49_000_000 } = {}) {
  const info = await probeAudio(file, ffprobe);
  const size = (await stat(file)).size;
  if (size <= maxBytes) return [file];
  // Copy compressed audio packets. This preserves source quality and needs
  // very little CPU compared with transcoding on a shared free instance.
  const extension = path.extname(file).toLowerCase();
  let seconds = Math.min(2400, info.duration * maxBytes * 0.9 / size);
  await mkdir(outputDirectory, { mode: 0o700 });
  for (let attempt = 0; attempt < 8; attempt++, seconds /= 2) {
    const attemptDirectory = path.join(outputDirectory, String(attempt));
    await mkdir(attemptDirectory, { mode: 0o700 });
    await execute(ffmpeg, ['-nostdin', '-v', 'error', ...inputOptions(file),
      '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-c:a', 'copy',
      '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1',
      '-segment_format', extension === '.mp3' ? 'mp3' : 'mp4',
      path.join(attemptDirectory, '%04d' + extension)], 30 * 60_000);
    const parts = (await readdir(attemptDirectory)).sort().map(name => path.join(attemptDirectory, name));
    if (!parts.length || parts.length > 300) throw new Error('too_many_tracks');
    const sizes = await Promise.all(parts.map(async part => (await stat(part)).size));
    if (sizes.every(bytes => bytes > 0 && bytes <= maxBytes)) return parts;
    await rm(attemptDirectory, { recursive: true });
  }
  throw new Error('telegram_file_too_large');
}
