/**
 * KOL CONTENT TRACKER — Cloudflare Worker + D1
 * -----------------------------------------------
 * D1 is the real database. Google Sheets is a read-only mirror that
 * gets overwritten daily (cron) or on demand (the "Sync to Sheets"
 * button). The Worker never talks to Google directly — it hands the
 * data to your existing Apps Script Web App, which already has free,
 * built-in access to the Sheet. No Google Cloud project, no service
 * account, no billing screen.
 *
 * SECRETS THIS WORKER NEEDS (set with `wrangler secret put <NAME>`):
 *   APIFY_TOKEN       — your Apify API token
 *   APPS_SCRIPT_URL   — your existing Apps Script Web App URL (the
 *                        one ending in /exec you already deployed)
 *
 * ROUTES:
 *   GET  /api/list                       — all tracked content
 *   GET  /api/summary                    — monthly rollups
 *   GET  /api/reports?contentId=X        — 7/15/30-day checkpoints for one item
 *   POST /api/submit                     — log new content {kol, platform, url, feePaid, datePosted, notes}
 *   POST /api/test-fetch                 — fetch one item's performance right now {contentId}
 *   POST /api/sync-sheets                — push current D1 data into Google Sheets now
 *   (scheduled) daily cron               — fetches performance for all active content, then pushes to Sheets
 */

const ACTOR_INSTAGRAM_POST = 'apidojo~instagram-scraper';
const ACTOR_TIKTOK_VIDEO = 'clockworks~tiktok-scraper';
const REPORT_CHECKPOINTS = [7, 15, 30];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/api/list' && request.method === 'GET') {
        return json(await listContent(env.DB, url.searchParams.get('source')), cors);
      }
      if (url.pathname === '/api/summary' && request.method === 'GET') {
        return json(await monthlySummary(env.DB, url.searchParams.get('source')), cors);
      }
      if (url.pathname === '/api/reports' && request.method === 'GET') {
        return json(await reportsFor(env.DB, url.searchParams.get('contentId')), cors);
      }
      if (url.pathname === '/api/history' && request.method === 'GET') {
        return json(await historyFor(env.DB, url.searchParams.get('contentId')), cors);
      }
      if (url.pathname === '/api/submit' && request.method === 'POST') {
        const body = await request.json();
        return json(await submitContent(env.DB, body), cors);
      }
      if (url.pathname === '/api/test-fetch' && request.method === 'POST') {
        const body = await request.json();
        return json(await testFetch(env, body.contentId), cors);
      }
      if (url.pathname === '/api/sync-sheets' && request.method === 'POST') {
        await pushToSheets(env);
        return json({ success: true }, cors);
      }
      if (url.pathname === '/api/delete' && request.method === 'POST') {
        const body = await request.json();
        return json(await deleteContent(env.DB, body.contentId), cors);
      }
      return json({ error: 'Not found' }, cors, 404);
    } catch (err) {
      return json({ error: String(err) }, cors, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyPipeline(env));
  },
};

async function runDailyPipeline(env) {
  await syncAllActiveContent(env);
  await pushToSheets(env);
}

// ---------- D1 QUERIES ----------

async function listContent(db, source) {
  const query = source ? db.prepare('SELECT * FROM content WHERE source = ? ORDER BY created_at DESC').bind(source) : db.prepare('SELECT * FROM content ORDER BY created_at DESC');
  const { results } = await query.all();
  return { rows: results };
}

async function submitContent(db, params) {
  if (!params.url || !params.kol || !params.platform) {
    return { error: 'kol, platform, and url are all required.' };
  }
  const check = validatePostUrl(params.platform, params.url);
  if (!check.ok) return { error: check.error };

  const source = params.source === 'Owned' ? 'Owned' : 'KOL';
  const id = 'C' + crypto.randomUUID().slice(0, 8);
  await db
    .prepare(
      `INSERT INTO content (id, kol, platform, url, date_posted, fee_paid, status, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?)`
    )
    .bind(id, params.kol, params.platform, params.url, params.datePosted || null, params.feePaid || 0, params.notes || null, source)
    .run();

  return { success: true, contentId: id };
}

// Removes a content row and all of its recorded snapshots — used when
// something was logged by mistake.
async function deleteContent(db, contentId) {
  if (!contentId) return { error: 'Missing contentId.' };
  await db.prepare('DELETE FROM snapshots WHERE content_id = ?').bind(contentId).run();
  const result = await db.prepare('DELETE FROM content WHERE id = ?').bind(contentId).run();
  if (result.meta.changes === 0) return { error: 'No content found with that ID.' };
  return { success: true };
}

function validatePostUrl(platform, url) {
  const lower = String(url).toLowerCase();
  if (platform === 'Instagram') {
    const ok = ['/p/', '/reel/', '/tv/'].some((s) => lower.includes(s));
    if (!ok) return { ok: false, error: 'That looks like a profile link, not a specific post. Paste the direct post or reel link.' };
  }
  if (platform === 'TikTok') {
    if (!lower.includes('/video/') && !lower.includes('/photo/')) {
      return { ok: false, error: 'That looks like a profile link, not a specific video or photo post. Paste the direct link.' };
    }
  }
  return { ok: true };
}

async function testFetch(env, contentId) {
  if (!contentId) return { error: 'Missing contentId.' };
  const row = await env.DB.prepare('SELECT * FROM content WHERE id = ?').bind(contentId).first();
  if (!row) return { error: 'No content found with that ID.' };

  const results = await fetchBatch(row.platform, [row.url], env.APIFY_TOKEN);
  const item = results[row.url];
  if (!item || item.error) return { error: (item && item.error) || 'Apify returned no data.' };

  await insertSnapshot(env.DB, contentId, item);
  return { success: true, ...item };
}

async function insertSnapshot(db, contentId, item) {
  const rate =
    item.views && Number(item.views) > 0
      ? (Number(item.likes || 0) + Number(item.comments || 0) + Number(item.shares || 0)) / Number(item.views)
      : null;
  await db
    .prepare(
      `INSERT INTO snapshots (content_id, views, likes, comments, shares, engagement_rate, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(contentId, item.views || null, item.likes || null, item.comments || null, item.shares || null, rate, item.notes || null)
    .run();
}

async function syncAllActiveContent(env) {
  const { results } = await env.DB.prepare("SELECT * FROM content WHERE status = 'Active'").all();
  const ig = results.filter((r) => r.platform === 'Instagram');
  const tt = results.filter((r) => r.platform === 'TikTok');

  const igResults = ig.length ? await fetchBatch('Instagram', ig.map((r) => r.url), env.APIFY_TOKEN) : {};
  const ttResults = tt.length ? await fetchBatch('TikTok', tt.map((r) => r.url), env.APIFY_TOKEN) : {};

  for (const row of results) {
    const map = row.platform === 'TikTok' ? ttResults : igResults;
    const item = map[row.url];
    if (item && !item.error) await insertSnapshot(env.DB, row.id, item);
  }
}

// ---------- REPORTS (checkpoints from first snapshot) ----------

async function reportsFor(db, contentId) {
  if (!contentId) return { error: 'Missing contentId.' };
  const { results } = await db
    .prepare('SELECT * FROM snapshots WHERE content_id = ? ORDER BY timestamp ASC')
    .bind(contentId)
    .all();
  if (!results.length) return { rows: [] };

  const first = new Date(results[0].timestamp + 'Z');
  const rows = [];
  for (const days of REPORT_CHECKPOINTS) {
    const target = new Date(first.getTime() + days * 86400000);
    if (target > new Date()) continue;
    const closest = closestAtOrBefore(results, target);
    rows.push({ days: days + '-day', snapshotDate: closest.timestamp, ...closest });
  }
  return { rows };
}

function closestAtOrBefore(sortedSnaps, target) {
  let best = sortedSnaps[0];
  for (const s of sortedSnaps) {
    if (new Date(s.timestamp + 'Z') <= target) best = s;
  }
  return best;
}

// Every check ever recorded for one piece of content, oldest first —
// this is the raw timeline behind the "History" view on the frontend.
async function historyFor(db, contentId) {
  if (!contentId) return { error: 'Missing contentId.' };
  const { results } = await db
    .prepare('SELECT * FROM snapshots WHERE content_id = ? ORDER BY timestamp ASC')
    .bind(contentId)
    .all();
  return { rows: results };
}

// ---------- MONTHLY SUMMARY ----------

async function monthlySummary(db, source) {
  const content = source
    ? (await db.prepare('SELECT * FROM content WHERE source = ?').bind(source).all()).results
    : (await db.prepare('SELECT * FROM content').all()).results;
  const contentIds = new Set(content.map((c) => c.id));
  const snapshots = (await db.prepare('SELECT * FROM snapshots ORDER BY timestamp ASC').all()).results.filter((s) =>
    contentIds.has(s.content_id)
  );

  const firstSnapByContent = {};
  const latestSnapByContent = {};
  let mostRecentTimestamp = null;
  for (const s of snapshots) {
    if (!firstSnapByContent[s.content_id]) firstSnapByContent[s.content_id] = s.timestamp;
    latestSnapByContent[s.content_id] = s; // last write wins since sorted ascending
    if (!mostRecentTimestamp || s.timestamp > mostRecentTimestamp) mostRecentTimestamp = s.timestamp;
  }

  const months = {};
  for (const c of content) {
    const ref = firstSnapByContent[c.id] || c.date_posted;
    if (!ref) continue;
    const monthKey = String(ref).slice(0, 7); // "YYYY-MM"
    if (!months[monthKey]) months[monthKey] = { count: 0, views: 0, engagements: 0, spend: 0, rateSum: 0, rateCount: 0, top: null };
    const b = months[monthKey];
    b.count += 1;
    b.spend += Number(c.fee_paid) || 0;
    const latest = latestSnapByContent[c.id];
    if (latest) {
      b.views += Number(latest.views) || 0;
      b.engagements += (Number(latest.likes) || 0) + (Number(latest.comments) || 0) + (Number(latest.shares) || 0);
      if (latest.engagement_rate) {
        b.rateSum += latest.engagement_rate;
        b.rateCount += 1;
      }
      if (!b.top || (latest.views || 0) > b.top.views) b.top = { id: c.id, views: latest.views || 0 };
    }
  }

  const rows = Object.keys(months)
    .sort()
    .map((month) => {
      const b = months[month];
      return {
        month,
        totalContentSeeded: b.count,
        totalViews: b.views,
        totalEngagements: b.engagements,
        avgEngagementRate: b.rateCount ? b.rateSum / b.rateCount : null,
        topPerformer: b.top ? b.top.id : null,
        totalSpend: b.spend,
        blendedCostPer1k: b.views > 0 ? (b.spend / b.views) * 1000 : null,
        lastUpdated: mostRecentTimestamp,
      };
    });

  return { rows };
}

// ---------- APIFY ----------

async function fetchBatch(platform, urls, token) {
  const actorId = platform === 'TikTok' ? ACTOR_TIKTOK_VIDEO : ACTOR_INSTAGRAM_POST;
  // timeout=90 tells Apify itself to give up and return whatever it has
  // after 90s rather than running indefinitely — this actor can be slow.
  const endpoint = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=90`;
  const input =
    platform === 'TikTok'
      ? { postURLs: urls, shouldDownloadVideos: false }
      : { startUrls: urls, maxItems: urls.length };

  let items;
  try {
    // A second, harder cutoff on our side — if Apify itself hangs past
    // its own timeout param (shouldn't happen, but just in case), this
    // stops the Worker from waiting forever and returning nothing to
    // the browser, which is what "fetching forever" looks like.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100000);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    items = await res.json();
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Timed out after 100 seconds waiting on Apify.' : String(err);
    const failed = {};
    urls.forEach((u) => (failed[u] = { error: message }));
    return failed;
  }

  const byUrl = {};
  for (const item of items) {
    const matched = matchUrl(platform, item, urls);
    if (matched) byUrl[matched] = normalizeItem(platform, item);
  }

  // If nothing matched, say exactly why instead of a generic "no data" —
  // either the actor genuinely found nothing, or it found something that
  // our matching logic couldn't line up with the URL we submitted.
  if (Object.keys(byUrl).length === 0) {
    const diagnostic =
      items.length === 0
        ? 'Actor completed but returned 0 items — this post type may not be supported by this actor.'
        : `Actor returned ${items.length} item(s), but none matched the submitted URL. First returned URL: ${
            items[0].url || items[0].webVideoUrl || '(none)'
          }`;
    urls.forEach((u) => (byUrl[u] = { error: diagnostic }));
  }

  return byUrl;
}

function matchUrl(platform, item, urls) {
  const returned = item.url || item.webVideoUrl || '';
  const direct = urls.find((u) => u === returned);
  if (direct) return direct;
  const code = platform === 'TikTok' ? extractTikTokId(returned) : item.shortCode;
  if (!code) return returned || null;
  return urls.find((u) => u.includes(code)) || returned || null;
}

function extractTikTokId(url) {
  const m = String(url).match(/\/(?:video|photo)\/(\d+)/);
  return m ? m[1] : null;
}

function normalizeItem(platform, item) {
  if (platform === 'TikTok') {
    const views = item.playCount || null;
    return {
      views,
      likes: item.diggCount || null,
      comments: item.commentCount || null,
      shares: item.shareCount || null,
      notes: views ? '' : 'No view count returned (photo posts sometimes report views differently than videos)',
    };
  }
  const views = item.videoPlayCount || item.videoViewCount || null;
  return {
    views,
    likes: item.likesCount || null,
    comments: item.commentsCount || null,
    shares: null,
    notes: views ? 'Shares unavailable for Instagram (platform limitation)' : 'No view count (likely a photo/carousel post)',
  };
}

// ---------- SHEETS SYNC (via your existing Apps Script, not Google's API) ----------
//
// This avoids Google Cloud entirely — your Apps Script Web App already has
// free, built-in access to the Sheet, so the Worker just hands it the data.

async function pushToSheets(env) {
  const content = (await env.DB.prepare("SELECT * FROM content WHERE source = 'KOL' ORDER BY created_at").all()).results;
  const ownedContent = (await env.DB.prepare("SELECT * FROM content WHERE source = 'Owned' ORDER BY created_at").all()).results;
  const summary = (await monthlySummary(env.DB, 'KOL')).rows;
  const ownedSummary = (await monthlySummary(env.DB, 'Owned')).rows;

  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, summary, ownedContent, ownedSummary }),
  });

  const data = await res.json();
  if (data.error) throw new Error('Apps Script sync failed: ' + data.error);
}

// ---------- UTIL ----------

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}
