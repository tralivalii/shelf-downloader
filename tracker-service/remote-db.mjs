// A private, dedicated D1 database keeps jobs and quotas across host restarts.
// Never retry an ambiguous write: the first request may already have committed.
export class RemoteDatabase {
  constructor(url, secret, fetcher = fetch) {
    if (new URL(url).protocol !== 'https:') throw new Error('state_requires_https');
    this.url = url; this.secret = secret; this.fetcher = fetcher;
  }
  async request(operation, sql, params = []) {
    const response = await this.fetcher(this.url, {
      method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + this.secret, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, sql, params }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('state_unavailable');
    const data = await response.json();
    if (!data.ok) throw new Error('state_unavailable');
    return data.value;
  }
  exec(sql) { return this.request('exec', sql); }
  prepare(sql) {
    return Object.fromEntries(['get', 'all', 'run'].map(operation =>
      [operation, (...params) => this.request(operation, sql, params)]));
  }
}
