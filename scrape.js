#!/usr/bin/env node
/**
 * Standalone scraper — runs as a GitHub Actions cron job.
 * Writes public/data.json with matched scene releases vs RT in-theaters.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── helpers ──────────────────────────────────────────────────────────────

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePredbDesc(desc) {
  const fields = {};
  (desc || '').split('|').forEach(part => {
    const idx = part.indexOf(':');
    if (idx >= 0) {
      fields[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  });
  return fields;
}

function matchScore(titleA, titleB, yearA, yearB) {
  const a = normalizeTitle(titleA);
  const b = normalizeTitle(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length >  b.length ? a : b;
  if (shorter.length / longer.length >= 0.40 && longer.startsWith(shorter)) return 0.92;

  const aw = a.split(' ').filter(w => w.length > 2);
  const bw = b.split(' ').filter(w => w.length > 2);
  if (!aw.length || !bw.length) return 0;
  const bSet = new Set(bw);
  const overlap = aw.filter(w => bSet.has(w)).length;
  const union = new Set([...aw, ...bw]).size;
  const jaccard = overlap / union;
  const yearBonus = yearA && yearB && String(yearA) === String(yearB) ? 0.15 : 0;
  return Math.min(1.0, jaccard + yearBonus);
}

// ── predb ────────────────────────────────────────────────────────────────

async function fetchPredbMovies() {
  const sections = ['X264-HD', 'X264', 'X265', 'XVID', 'REMUX'];
  const results  = await Promise.allSettled(
    sections.map(s =>
      axios.get(`https://api.predb.net/feed/?section=${s}&limit=30`, {
        headers: { ...HEADERS, Accept: 'application/rss+xml,text/xml,*/*' },
        timeout: 12000,
      })
    )
  );

  const releases = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const $ = cheerio.load(r.value.data, { xmlMode: true });
    $('item').each((_, item) => {
      const rawTitle = $(item).find('title').text().trim();
      const fields   = parsePredbDesc($(item).find('description').text());
      if (fields['Type'] !== 'Movie' || !fields['Title']) return;
      releases.push({ title: fields['Title'], year: fields['Year'] || null, raw: rawTitle, section: fields['Section'] || sections[i] });
    });
  });

  const seen = new Set();
  return releases.filter(r => {
    const key = normalizeTitle(r.title) + (r.year || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Rotten Tomatoes ──────────────────────────────────────────────────────

async function fetchRTMovieList() {
  const resp = await axios.get('https://www.rottentomatoes.com/browse/movies_in_theaters', {
    headers: HEADERS,
    timeout: 15000,
  });
  const $ = cheerio.load(resp.data);

  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const d = JSON.parse($(el).text());
      if (d['@type'] !== 'ItemList') continue;
      let items = d.itemListElement;
      if (!Array.isArray(items)) items = items?.itemListElement;
      if (!Array.isArray(items)) continue;
      return items
        .filter(m => m['@type'] === 'Movie' && m.name)
        .map(m => ({
          title: m.name,
          year:  m.dateCreated ? String(m.dateCreated).substring(0, 4) : null,
          url:   m.url || null,
          poster: m.image || null,
          score: null,
        }));
    } catch { /* skip */ }
  }

  // Fallback: web components
  const movies = [];
  $('media-info-tile').each((_, tile) => {
    const title    = $(tile).find('[data-qa="discovery-media-list-item-title"]').text().trim();
    const mediaUrl = $(tile).find('[media-url]').first().attr('media-url');
    if (title) movies.push({ title, year: null, url: mediaUrl ? `https://www.rottentomatoes.com${mediaUrl}` : null, poster: null, score: null });
  });
  return movies;
}

async function fetchRTScore(rtUrl) {
  if (!rtUrl) return null;
  try {
    const resp = await axios.get(rtUrl, { headers: HEADERS, timeout: 10000 });
    const $    = cheerio.load(resp.data);
    for (const el of $('script[type="application/json"]').toArray()) {
      try {
        const d = JSON.parse($(el).text());
        if (!d.criticsScore) continue;
        const { likedCount = 0, notLikedCount = 0, reviewCount = 0 } = d.criticsScore;
        if (reviewCount === 0 && likedCount === 0) return null;
        const total = likedCount + notLikedCount;
        return total > 0 ? Math.round((likedCount / total) * 100) : null;
      } catch { /* skip */ }
    }
  } catch (e) {
    console.warn(`RT score failed for ${rtUrl}:`, e.message);
  }
  return null;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Scraping...`);

  const [predbResult, rtResult] = await Promise.allSettled([
    fetchPredbMovies(),
    fetchRTMovieList(),
  ]);

  const releases = predbResult.status === 'fulfilled' ? predbResult.value : [];
  const rtMovies = rtResult.status === 'fulfilled'    ? rtResult.value : [];
  const errors = {
    predb: predbResult.status === 'rejected' ? predbResult.reason.message : null,
    rt:    rtResult.status    === 'rejected' ? rtResult.reason.message    : null,
  };

  console.log(`predb: ${releases.length} releases — RT: ${rtMovies.length} films`);

  const THRESHOLD = 0.60;
  const matched   = [];
  const unmatchedReleases = [];

  for (const release of releases) {
    let best = { score: 0, movie: null };
    for (const movie of rtMovies) {
      const s = matchScore(release.title, movie.title, release.year, movie.year);
      if (s > best.score) best = { score: s, movie };
    }
    if (best.score >= THRESHOLD && best.movie) {
      matched.push({ release, movie: { ...best.movie }, matchConfidence: Math.round(best.score * 100) });
    } else {
      unmatchedReleases.push(release);
    }
  }

  if (matched.length > 0) {
    console.log(`Fetching RT scores for ${matched.length} matches...`);
    await Promise.allSettled(matched.map(async m => { m.movie.score = await fetchRTScore(m.movie.url); }));
  }

  matched.sort((a, b) => (b.movie.score ?? -1) - (a.movie.score ?? -1));

  const data = {
    matched,
    unmatchedReleases,
    allRtMovies: rtMovies,
    stats: { sceneTotal: releases.length, rtTotal: rtMovies.length, matchedCount: matched.length },
    errors,
    fetchedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, 'public', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`✓ Geschreven naar ${outPath} — ${matched.length} matches`);
}

main().catch(err => { console.error('Scraper mislukt:', err); process.exit(1); });
