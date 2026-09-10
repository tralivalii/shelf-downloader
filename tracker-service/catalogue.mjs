import { randomBytes } from 'node:crypto';

function words(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [];
}

// Relevance is the first sort key. Availability only breaks equally relevant
// matches, so a popular unrelated release cannot crowd out the requested book.
export function rankReleases(releases, query) {
  const requested = [...new Set(words(query))];
  const relevance = release => {
    const titleWords = new Set(words(release.title));
    return requested.filter(word => titleWords.has(word)).length;
  };
  const ranked = [...releases].sort((a, b) => relevance(b) - relevance(a) || b.seeders - a.seeders ||
    a.title.localeCompare(b.title));
  const seen = new Set();
  return ranked.filter(release => {
    // A full release label includes narrator/quality when supplied. Do not
    // collapse different recordings merely because book titles match.
    const key = release.size > 0 ? JSON.stringify([words(release.title), release.size]) : release.sourceURL;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normaliseRelease(release, indexer) {
  const title = String(release?.Title || '').trim();
  const audio = (release?.Category || []).map(Number).includes(3030) ||
    /аудиокниг|аудиоспектакл|audiobook|\bmp3\b|\bm4[ab]\b/iu.test(title);
  if (!audio || !title || !release.Link || !release.Details) return null;
  let source;
  try { source = new URL(release.Details); } catch { return null; }
  if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) return null;
  source.protocol = 'https:';
  return {
    id: randomBytes(16).toString('hex'),
    title: title.slice(0, 240),
    source: indexer === 'rutracker' ? 'RuTracker' : indexer === 'booktracker' ? 'BookTracker' : indexer,
    sourceURL: source.href,
    size: Number(release.Size) || 0,
    seeders: Math.max(0, Number(release.Seeders) || 0),
    downloadURL: String(release.Link),
  };
}

export async function searchJackett(config, query, fetcher = fetch) {
  const answers = await Promise.allSettled(config.indexers.map(async indexer => {
    if (!/^[a-z0-9-]+$/.test(indexer)) throw new Error('invalid_indexer');
    const url = new URL('/api/v2.0/indexers/' + indexer + '/results', config.url);
    url.searchParams.set('apikey', config.apiKey);
    url.searchParams.set('query', query);
    // BookTracker's Jackett adapter labels everything as ebooks, so category
    // 3030 alone would hide its audiobooks. Filter actual result metadata below.
    if (indexer !== 'booktracker') url.searchParams.append('Category[]', '3030');
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('indexer_unavailable');
    const data = await response.json();
    if (!Array.isArray(data.Results) || data.Indexers?.some(item => item.Error)) throw new Error('indexer_unavailable');
    return data.Results.map(release => normaliseRelease(release, indexer)).filter(Boolean);
  }));
  const results = answers.flatMap(answer => answer.status === 'fulfilled' ? answer.value : []);
  const unique = [...new Map(results.map(result => [result.sourceURL, result])).values()];
  return {
    results: rankReleases(unique, query).slice(0, 6),
    unavailable: config.indexers.filter((_, index) => answers[index].status === 'rejected'),
  };
}
