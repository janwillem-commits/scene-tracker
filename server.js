const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

let cache = { data: null, timestamp: 0 };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Predb ──────────────────────────────────────────────────────────────

// Parse structured description: "Section: X264-HD | Title: Foo | Year: 2024 | Type: Movie"
function parsePredbDesc(desc) {
  const fields = {};
  (desc || '').split('|').forEach(part => {
    const idx = part.indexOf(':');
    if (idx >= 0) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      fields[key] = val;
    }
  });
  return fields;
}

async function fetchPredbMovies() {
  // Query multiple movie-relevant sections in parallel
  const sections = ['X264-HD', 'X264', 'X265', 'XVID', 'REMUX'];
  const results = await Promise.allSettled(
    sections.map(section =>
      axios.get(`https://api.predb.net/feed/?section=${section}&limit=30`, {
        headers: { ...HEADERS, Accept: 'application/rss+xml,text/xml,*/*' },
        timeout: 12000,
      })
    )
  );

  const releases = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.warn(`predb section ${sections[i]} failed:`, r.reason?.message);
      return;
    }
    const $ = cheerio.load(r.value.data, { xmlMode: true });
    $('item').each((_, item) => {
      const rawTitle = $(item).find('title').text().trim();
      const desc = $(item).find('description').text().trim();
      const fields = parsePredbDesc(desc);

      if (fields['Type'] !== 'Movie') return;

      const cleanTitle = fields['Title'];
      const year = fields['Year'] || null;

      if (!cleanTitle || cleanTitle.length < 2) return;

      releases.push({
        title: cleanTitle,
        year,
        raw: rawTitle,
        section: fields['Section'] || sections[i],
      });
    });
  });

  // Dedupe by normalised title + year
  const seen = new Set();
  return releases.filter(r => {
    const key = normalizeTitle(r.title) + (r.year || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Rotten Tomatoes ────────────────────────────────────────────────────

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Get the movie list from the RT in-theaters browse page (no scores yet)
async function fetchRTMovieList() {
  const resp = await axios.get('https://www.rottentomatoes.com/browse/movies_in_theaters', {
    headers: HEADERS,
    timeout: 15000,
  });

  const $ = cheerio.load(resp.data);

  // Primary: LD+JSON ItemList (server-rendered, reliable)
  const ldScripts = $('script[type="application/ld+json"]').toArray();
  for (const el of ldScripts) {
    try {
      const d = JSON.parse($(el).text());
      if (d['@type'] !== 'ItemList') continue;

      // RT wraps the list one level deep
      let items = d.itemListElement;
      if (!Array.isArray(items)) items = items?.itemListElement;
      if (!Array.isArray(items)) continue;

      return items
        .filter(m => m['@type'] === 'Movie' && m.name)
        .map(m => ({
          title: m.name,
          year: m.dateCreated ? String(m.dateCreated).substring(0, 4) : null,
          url: m.url || null,
          poster: m.image || null,
          score: null, // fetched separately per match
        }));
    } catch { /* skip bad JSON */ }
  }

  // Fallback: parse <media-info-tile> web components
  const movies = [];
  $('media-info-tile').each((_, tile) => {
    const titleEl = $(tile).find('[data-qa="discovery-media-list-item-title"]');
    const mediaUrl = $(tile).find('[media-url]').first().attr('media-url');
    const title = titleEl.text().trim();
    if (title) {
      movies.push({
        title,
        year: null,
        url: mediaUrl ? `https://www.rottentomatoes.com${mediaUrl}` : null,
        poster: null,
        score: null,
      });
    }
  });
  return movies;
}

// Fetch tomatometer for a single RT movie page
async function fetchRTScore(rtUrl) {
  if (!rtUrl) return null;
  try {
    const resp = await axios.get(rtUrl, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(resp.data);
    for (const el of $('script[type="application/json"]').toArray()) {
      try {
        const d = JSON.parse($(el).text());
        if (!d.criticsScore) continue;
        const { likedCount = 0, notLikedCount = 0, reviewCount = 0 } = d.criticsScore;
        if (reviewCount === 0 && likedCount === 0) return null;
        const total = likedCount + notLikedCount;
        if (total === 0) return null;
        return Math.round((likedCount / total) * 100);
      } catch { /* skip */ }
    }
  } catch (e) {
    console.warn(`RT score fetch failed for ${rtUrl}:`, e.message);
  }
  return null;
}

// ── Title matching ─────────────────────────────────────────────────────

function matchScore(titleA, titleB, yearA, yearB) {
  const a = normalizeTitle(titleA);
  const b = normalizeTitle(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  // Prefix match only when the shorter title is at least 40% of the longer
  // Avoids single-word titles like "Western" matching long titles
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length >  b.length ? a : b;
  if (shorter.length / longer.length >= 0.40 && longer.startsWith(shorter)) return 0.92;

  // Jaccard over significant words (>2 chars)
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

// ── Main pipeline ──────────────────────────────────────────────────────

async function fetchAndMatch() {
  const [predbResult, rtResult] = await Promise.allSettled([
    fetchPredbMovies(),
    fetchRTMovieList(),
  ]);

  const releases = predbResult.status === 'fulfilled' ? predbResult.value : [];
  const rtMovies = rtResult.status === 'fulfilled' ? rtResult.value : [];
  const errors = {
    predb: predbResult.status === 'rejected' ? predbResult.reason.message : null,
    rt: rtResult.status === 'rejected' ? rtResult.reason.message : null,
  };

  console.log(`predb: ${releases.length} releases — RT: ${rtMovies.length} films`);

  const THRESHOLD = 0.60;
  const matched = [];
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

  // Fetch RT scores for matched movies concurrently
  if (matched.length > 0) {
    console.log(`Fetching RT scores for ${matched.length} matches...`);
    await Promise.allSettled(
      matched.map(async m => {
        m.movie.score = await fetchRTScore(m.movie.url);
      })
    );
  }

  // Sort matched: score desc, unknowns last
  matched.sort((a, b) => (b.movie.score ?? -1) - (a.movie.score ?? -1));

  return {
    matched,
    unmatchedReleases,
    allRtMovies: rtMovies,
    stats: {
      sceneTotal: releases.length,
      rtTotal: rtMovies.length,
      matchedCount: matched.length,
    },
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Cache & scheduling ─────────────────────────────────────────────────

async function refreshCache() {
  try {
    console.log(`[${new Date().toISOString()}] Cache vernieuwen...`);
    const data = await fetchAndMatch();
    cache = { data, timestamp: Date.now() };
    // Also write data.json so the static frontend works locally
    fs.writeFileSync(path.join(__dirname, 'public', 'data.json'), JSON.stringify(data, null, 2));
    console.log(`Cache bijgewerkt: ${data.matched.length} matches`);
  } catch (err) {
    console.error('Cache refresh mislukt:', err.message);
  }
}

setInterval(refreshCache, CACHE_TTL);

// ── Routes ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/check', async (req, res) => {
  const force = req.query.force === '1';
  const now = Date.now();
  const age = now - cache.timestamp;

  if (!force && cache.data && age < CACHE_TTL) {
    return res.json({ ...cache.data, fromCache: true, cacheAgeSeconds: Math.round(age / 1000) });
  }

  await refreshCache();

  if (cache.data) {
    res.json({ ...cache.data, fromCache: false, cacheAgeSeconds: 0 });
  } else {
    res.status(503).json({ error: 'Kon geen data ophalen. Probeer het opnieuw.' });
  }
});

app.listen(PORT, () => {
  console.log(`Scene × RT Tracker → http://localhost:${PORT}`);
  refreshCache();
});
