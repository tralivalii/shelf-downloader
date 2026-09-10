export async function acquireLease(db, owner, now = Date.now(), ttl = 30_000) {
  const row = await db.prepare(`INSERT INTO downloader_lease VALUES (1, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET owner = excluded.owner, expires = excluded.expires
    WHERE downloader_lease.expires <= ? OR downloader_lease.owner = excluded.owner
    RETURNING expires`).get(owner, now + ttl, now);
  return row?.expires || 0;
}

export async function renewLease(db, owner, now = Date.now(), ttl = 30_000) {
  const row = await db.prepare(`UPDATE downloader_lease SET expires = ?
    WHERE slot = 1 AND owner = ? AND expires > ? RETURNING expires`).get(now + ttl, owner, now);
  return row?.expires || 0;
}
