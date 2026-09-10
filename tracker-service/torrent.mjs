import path from 'node:path';

// Read the metadata before starting any download: only audio files are selected,
// torrent paths are checked, and the complete selected size is capped.
export function inspectTorrent(buffer, maxBytes = 2_000_000_000) {
  if (buffer.length > 4_000_000) throw new Error('torrent_metadata_too_large');
  let offset = 0;
  let nodes = 0;
  function read(depth = 0) {
    if (depth > 30 || ++nodes > 100_000 || offset >= buffer.length) throw new Error('invalid_torrent');
    const tag = String.fromCharCode(buffer[offset]);
    if (tag === 'i') {
      const end = buffer.indexOf(101, ++offset);
      const raw = buffer.subarray(offset, end).toString();
      if (end < 0 || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('invalid_torrent');
      offset = end + 1;
      return Number(raw);
    }
    if (tag === 'l' || tag === 'd') {
      offset++;
      const result = tag === 'l' ? [] : Object.create(null);
      while (buffer[offset] !== 101) {
        const key = read(depth + 1);
        if (tag === 'l') result.push(key);
        else {
          if (!Buffer.isBuffer(key)) throw new Error('invalid_torrent');
          result[key.toString()] = read(depth + 1);
        }
      }
      offset++;
      return result;
    }
    const colon = buffer.indexOf(58, offset);
    const raw = buffer.subarray(offset, colon).toString();
    if (colon < 0 || !/^\d+$/.test(raw)) throw new Error('invalid_torrent');
    const size = Number(raw);
    offset = colon + 1;
    if (!Number.isSafeInteger(size) || size > buffer.length - offset) throw new Error('invalid_torrent');
    const value = buffer.subarray(offset, offset + size);
    offset += size;
    return value;
  }
  const metadata = read();
  if (offset !== buffer.length || !metadata.info) throw new Error('invalid_torrent');
  const info = metadata.info;
  const name = String(info['name.utf-8'] || info.name || '');
  const safePart = value => value && value !== '.' && value !== '..' && !/[\\/\x00-\x1f]/.test(value);
  if (!safePart(name)) throw new Error('unsafe_torrent_path');
  const rawFiles = info.files || [{ length: info.length, path: [] }];
  if (!Array.isArray(rawFiles) || rawFiles.length > 5000) throw new Error('invalid_torrent');
  const files = rawFiles.map((file, i) => {
    const parts = (file['path.utf-8'] || file.path || []).map(String);
    if (!parts.every(safePart) || !Number.isSafeInteger(file.length) || file.length < 0 ||
      String(file.attr || '').includes('l') || file['symlink path']) throw new Error('unsafe_torrent_file');
    return { index: i + 1, path: path.join(name, ...parts), size: file.length };
  });
  // A mixed-format release must not silently deliver only some chapters.
  // Version 1 uses the formats documented for Telegram's built-in audio player.
  const audio = files.filter(file => /\.(mp3|m4a|m4b|ogg|flac|wav|opus|aac)$/i.test(file.path) && file.size > 0);
  if (audio.some(file => !/\.(mp3|m4a)$/i.test(file.path))) throw new Error('unsupported_audio_format');
  files.length = 0;
  files.push(...audio);
  if (!files.length || files.length > 200) throw new Error('no_supported_audio');
  if (files.reduce((sum, file) => sum + file.size, 0) > maxBytes) throw new Error('audiobook_too_large');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  return files;
}
