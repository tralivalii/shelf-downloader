import path from 'node:path';
import { lstat, realpath, rm } from 'node:fs/promises';

// Delete only a terminal job known to SQLite. Never scan and remove arbitrary
// directories, follow symlinks, or touch pending/active downloads.
export async function cleanupFinishedJobs(db, dataDirectory) {
  const root = path.join(dataDirectory, 'downloads');
  let rootInfo;
  try { rootInfo = await lstat(root); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const dataRoot = await realpath(dataDirectory);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
      await realpath(root) !== path.join(dataRoot, 'downloads')) throw new Error('unsafe_cleanup_root');
  for (const job of await db.prepare("SELECT id FROM jobs WHERE status IN ('complete', 'failed', 'interrupted')").all()) {
    if (!/^[a-f0-9]{32}$/.test(job.id)) continue;
    const directory = path.join(root, job.id);
    let info;
    try { info = await lstat(directory); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    await rm(directory, { recursive: true, force: true });
  }
}
