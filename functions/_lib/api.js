import { all, first, getMeta, run, setMeta } from "./db.js";
import { compareSeries, coverage, creatorLeaderboard, gameDetail, leaderboards, loadMetrics, opportunityResearch, itemMetrics } from "./analytics.js";
import { ALERT_METRICS, enqueue, forceSchedule, queueStatus, retryFailed, settings, tick } from "./collector.js";
import { REPORT_TYPES, generateReport } from "./reports.js";
import { createExperience, economyAnalytics, experienceAnalytics, rotateToken } from "./telemetry.js";
import { fetchBadges, fetchGamePasses, fetchItemDetails, lookupGroup, lookupUser, openCloudUniverse, popularCollectibles, resolveGameRef, searchCatalog, searchGames } from "./roblox.js";
import { destroyAllSessions, listSessions } from "./auth.js";
import { STATE_COOKIE, accountStatus, disconnect, oauthConfig, officialMetrics, refreshResources, startConnect, syncOfficial } from "./robloxAccount.js";
import { DAY, HttpError, cookie, intParam, json, now, rangeFrom } from "./util.js";

const DEFAULT_LISTS = [["Tracking", "games"], ["Bookmarks", "games"], ["Competitors", "games"], ["Watchlist", "items"]];

export async function ensureDefaults(db) {
  if ((await getMeta(db, "defaults_v1")) === "1") return;
  for (const [name, kind] of DEFAULT_LISTS) await run(db, "INSERT OR IGNORE INTO lists (name, kind, created_at) VALUES (?, ?, ?)", name, kind, now());
  await run(db, "INSERT OR REPLACE INTO meta (key, value) VALUES ('defaults_v1', '1')");
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

const id = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "Invalid id");
  return n;
};

async function addToList(db, listId, targetId) {
  await run(db, "INSERT OR IGNORE INTO list_items (list_id, target_id, added_at) VALUES (?, ?, ?)", listId, targetId, now());
}

async function trackGame(env, db, ref, listId) {
  const universeId = await resolveGameRef(ref);
  if (!universeId) throw new HttpError(404, "Game not found. Use a universe id, place id or roblox.com/games URL.");
  await run(db, "INSERT OR IGNORE INTO games (universe_id, first_seen_at, discovered_via) VALUES (?, ?, 'manual')", universeId, now());
  const list = listId ? await first(db, "SELECT id FROM lists WHERE id = ? AND kind = 'games'", listId) : await first(db, "SELECT id FROM lists WHERE kind = 'games' AND name = 'Tracking'");
  if (!list) throw new HttpError(400, "Unknown list");
  await addToList(db, list.id, universeId);
  await enqueue(db, "collect_games", { ids: [universeId], raw: true });
  return universeId;
}

async function trackItem(db, assetId, listId) {
  const details = await fetchItemDetails([assetId]);
  const d = details.get(assetId);
  if (!d) throw new HttpError(404, "Item not found in the catalog");
  await run(db, "INSERT OR IGNORE INTO items (asset_id, name, first_seen_at) VALUES (?, ?, ?)", assetId, d.name, now());
  const list = listId ? await first(db, "SELECT id FROM lists WHERE id = ? AND kind = 'items'", listId) : await first(db, "SELECT id FROM lists WHERE kind = 'items' ORDER BY id LIMIT 1");
  if (!list) throw new HttpError(400, "Unknown list");
  await addToList(db, list.id, assetId);
  await enqueue(db, "collect_items", { ids: [assetId] });
  await enqueue(db, "item_resale", { ids: [assetId] });
  return assetId;
}

export function configStatus(env) {
  const s = settings(env);
  return {
    database: !!env.STATS_DB,
    cronToken: !!env.STATS_CRON_TOKEN,
    alertWebhook: !!env.STATS_ALERT_WEBHOOK_URL,
    workersAi: !!env.AI,
    openCloudKey: !!env.ROBLOX_OPEN_CLOUD_KEY,
    robloxOAuth: oauthConfig(env).ok,
    settings: s,
  };
}

const DATASETS = {
  game_snapshots: { sql: "SELECT universe_id, ts, playing, visits, favorites, up_votes, down_votes FROM game_snapshots WHERE ts BETWEEN ? AND ?", idCol: "universe_id", order: "ts DESC" },
  game_hourly: { sql: "SELECT universe_id, hour, samples, ROUND(sum_playing * 1.0 / samples, 1) AS avg_playing, peak_playing, min_playing, visits, favorites, up_votes, down_votes FROM game_hourly WHERE hour BETWEEN ? AND ?", idCol: "universe_id", order: "hour DESC" },
  game_daily: { sql: "SELECT universe_id, day, samples, ROUND(avg_playing, 1) AS avg_playing, peak_playing, min_playing, visits, favorites, up_votes, down_votes FROM game_daily WHERE day BETWEEN date(? / 1000, 'unixepoch') AND date(? / 1000, 'unixepoch')", idCol: "universe_id", order: "day DESC" },
  games: { sql: "SELECT universe_id, root_place_id, name, creator_name, genre, genre_l1, genre_l2, created_at, updated_at, first_seen_at, last_seen_at, peak_playing, peak_playing_at, discovered_via FROM games WHERE first_seen_at BETWEEN ? AND ?", idCol: "universe_id", order: "first_seen_at DESC", ignoreRange: true },
  game_changes: { sql: "SELECT universe_id, ts, field, old_value, new_value FROM game_changes WHERE ts BETWEEN ? AND ?", idCol: "universe_id", order: "ts DESC" },
  game_events: { sql: "SELECT id, universe_id, ts, kind, severity, summary FROM game_events WHERE ts BETWEEN ? AND ?", idCol: "universe_id", order: "ts DESC" },
  discovery_sightings: { sql: "SELECT universe_id, sort_id, first_ts, last_ts, best_position, last_position FROM discovery_sightings WHERE last_ts BETWEEN ? AND ?", idCol: "universe_id", order: "last_ts DESC" },
  item_snapshots: { sql: "SELECT asset_id, ts, lowest_price, lowest_resale_price, price, units_available, favorites, has_resellers FROM item_snapshots WHERE ts BETWEEN ? AND ?", idCol: "asset_id", order: "ts DESC" },
  item_price_points: { sql: "SELECT asset_id, day, value FROM item_price_points WHERE day BETWEEN date(? / 1000, 'unixepoch') AND date(? / 1000, 'unixepoch')", idCol: "asset_id", order: "day DESC" },
  alerts: { sql: "SELECT id, rule_id, ts, target_type, target_id, message, value, acknowledged FROM alerts WHERE ts BETWEEN ? AND ?", idCol: "target_id", order: "ts DESC" },
  collection_runs: { sql: "SELECT id, job_id, job_type, started_at, finished_at, ok, items, error FROM collection_runs WHERE started_at BETWEEN ? AND ?", idCol: "job_id", order: "id DESC" },
  telemetry_events: { sql: "SELECT experience_id, ts, type, player, session, name, amount, currency, source, rarity FROM telemetry_events WHERE ts BETWEEN ? AND ?", idCol: "experience_id", order: "ts DESC" },
};

async function explorer(db, url) {
  const ds = DATASETS[url.searchParams.get("dataset")];
  if (!ds) throw new HttpError(400, `dataset must be one of: ${Object.keys(DATASETS).join(", ")}`);
  const { from, to } = ds.ignoreRange && !url.searchParams.get("range") && !url.searchParams.get("from") ? { from: 0, to: now() } : rangeFrom(url);
  const limit = intParam(url.searchParams.get("limit"), 500, 1, 10_000);
  const target = url.searchParams.get("id");
  let sql = ds.sql;
  const params = [from, to];
  if (target) {
    sql += ` AND ${ds.idCol} = ?`;
    params.push(id(target));
  }
  sql += ` ORDER BY ${ds.order} LIMIT ?`;
  params.push(limit);
  return { rows: await all(db, sql, ...params), from, to, limit };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

// First-run starter set so the tracked-game and collectible pages have data without manual setup.
// Runs once; removing the items afterwards is respected.
export async function seedStarter(db) {
  if ((await getMeta(db, "starter_v1")) === "1") return { games: 0, items: 0 };
  const ms = (await loadMetrics(db)).sort((a, b) => (b.current || 0) - (a.current || 0));
  if (!ms.length) return { games: 0, items: 0 };
  await run(db, "INSERT OR REPLACE INTO meta (key, value) VALUES ('starter_v1', '1')");
  const out = { games: 0, items: 0 };
  const hasGames = await first(db, "SELECT 1 AS x FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'games' LIMIT 1");
  const tracking = await first(db, "SELECT id FROM lists WHERE kind = 'games' ORDER BY id LIMIT 1");
  if (!hasGames && tracking) {
    const top = ms.slice(0, 12).map((m) => m.universeId);
    for (const u of top) await addToList(db, tracking.id, u);
    await enqueue(db, "collect_games", { ids: top, raw: true });
    out.games = top.length;
  }
  const hasItems = await first(db, "SELECT 1 AS x FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items' LIMIT 1");
  const watch = await first(db, "SELECT id FROM lists WHERE kind = 'items' ORDER BY id LIMIT 1");
  if (!hasItems && watch) {
    try {
      const items = (await popularCollectibles()).filter((i) => i.lowestResalePrice > 0).slice(0, 10);
      for (const i of items) {
        await run(db, "INSERT OR IGNORE INTO items (asset_id, name, first_seen_at) VALUES (?, ?, ?)", i.assetId, i.name, now());
        await addToList(db, watch.id, i.assetId);
      }
      const ids = items.map((i) => i.assetId);
      if (ids.length) {
        await enqueue(db, "collect_items", { ids });
        await enqueue(db, "item_resale", { ids });
      }
      out.items = ids.length;
    } catch { /* catalog unavailable: games are still seeded */ }
  }
  return out;
}

async function overview(env, db, ctx) {
  const t = now();
  const seeded = await seedStarter(db).catch(() => ({ games: 0, items: 0 }));
  if (seeded.games || seeded.items) await setMeta(db, "last_tick_at", 0).catch(() => {});
  const lastTick = Number(await getMeta(db, "last_tick_at")) || 0;
  if (t - lastTick > 10 * 60_000) ctx.waitUntil(tick(env, { budgetMs: 25_000 }).catch(() => {}));
  const counts = await first(
    db,
    `SELECT (SELECT COUNT(*) FROM games WHERE name IS NOT NULL) AS games,
            (SELECT COUNT(DISTINCT li.target_id) FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'games') AS tracked,
            (SELECT COUNT(*) FROM items) AS items,
            (SELECT COUNT(*) FROM alerts WHERE acknowledged = 0) AS openAlerts,
            (SELECT COUNT(*) FROM experiences) AS experiences,
            (SELECT COUNT(*) FROM reports) AS reports,
            (SELECT COUNT(*) FROM game_hourly) AS hourlyRows`
  );
  const lb = await leaderboards(db, { limit: 8 });
  const ms = await loadMetrics(db);
  const trackedMs = ms.filter((m) => m.tracked).sort((a, b) => b.current - a.current).slice(0, 12);
  const events = await all(db, "SELECT e.id, e.universe_id, e.ts, e.kind, e.severity, e.summary, g.name FROM game_events e JOIN games g ON g.universe_id = e.universe_id ORDER BY e.ts DESC LIMIT 10");
  const alerts = await all(db, "SELECT id, ts, message FROM alerts WHERE acknowledged = 0 ORDER BY ts DESC LIMIT 10");
  const poolSeries = await all(db, "SELECT hour AS ts, SUM(sum_playing * 1.0 / samples) AS playing, COUNT(*) AS games FROM game_hourly WHERE hour > ? GROUP BY hour ORDER BY hour", t - 7 * DAY);
  return { counts, leaderboards: lb, tracked: trackedMs, events, alerts, poolSeries, queue: await queueStatus(db), sorts: JSON.parse((await getMeta(db, "discover_sorts")) || "[]") };
}

export async function handleApi(env, db, request, ctx, path) {
  const url = new URL(request.url);
  const m = request.method;
  const seg = path.split("/").filter(Boolean);
  const [a, b, c, d] = seg;

  if (a === "overview" && m === "GET") return json(await overview(env, db, ctx));
  if (a === "status" && m === "GET") return json({ config: configStatus(env), queue: await queueStatus(db), coverage: await coverage(db), metricsComputedAt: Number(await getMeta(db, "metrics_computed_at")) || null });

  if (a === "search" && m === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
    if (!q) return json({ results: [] });
    const results = await searchGames(q);
    const tracked = new Set((await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'games'")).map((r) => r.id));
    return json({ results: results.map((r) => ({ ...r, tracked: tracked.has(r.universeId) })), source: "apis.roblox.com/search-api/omni-search", fetchedAt: now() });
  }

  if (a === "games") {
    if (!b && m === "GET") {
      const ms = await loadMetrics(db);
      const list = url.searchParams.get("list");
      let ids = null;
      if (list === "tracked") ids = new Set(ms.filter((x) => x.tracked).map((x) => x.universeId));
      else if (list) ids = new Set((await all(db, "SELECT target_id FROM list_items WHERE list_id = ?", id(list))).map((r) => r.target_id));
      let rows = ids ? ms.filter((x) => ids.has(x.universeId)) : ms;
      if (ids) {
        const pending = await all(db, `SELECT universe_id, name FROM games WHERE universe_id IN (${[...ids].map(() => "?").join(",") || "NULL"})`, ...ids);
        const have = new Set(rows.map((r) => r.universeId));
        rows = rows.concat(pending.filter((p) => !have.has(p.universe_id)).map((p) => ({ universeId: p.universe_id, name: p.name || `Universe ${p.universe_id}`, pending: true })));
      }
      const genre = url.searchParams.get("genre");
      if (genre) rows = rows.filter((x) => x.genre === genre);
      return json({ games: rows });
    }
    if (!b && m === "POST") {
      const p = await body(request);
      const universeId = await trackGame(env, db, p.ref ?? (p.universeId ? `u:${p.universeId}` : null), p.listId ? id(p.listId) : null);
      ctx.waitUntil(tick(env, { budgetMs: 15_000, maxJobs: 3 }).catch(() => {}));
      return json({ universeId });
    }
    if (b && c === "store" && m === "GET") {
      const [passes, badges] = await Promise.all([fetchGamePasses(id(b)).catch(() => null), fetchBadges(id(b)).catch(() => null)]);
      return json({ passes, badges, fetchedAt: now() });
    }
    if (b && m === "GET") {
      const { from, to } = rangeFrom(url);
      const detail = await gameDetail(db, id(b), from, to);
      if (!detail) throw new HttpError(404, "Game not tracked or observed yet");
      return json(detail);
    }
  }

  if (a === "creators" && m === "GET") return json({ creators: (await creatorLeaderboard(db)).slice(0, 300) });
  if (a === "lookup" && m === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    if (!q) throw new HttpError(400, "Enter a username, id or profile link");
    const res = b === "group" ? await lookupGroup(q) : b === "user" ? await lookupUser(q) : null;
    if (!res) throw new HttpError(404, b === "group" ? "Group not found" : "User not found");
    return json({ result: res, fetchedAt: now() });
  }

  if (a === "compare" && m === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).map(id);
    const { from, to } = rangeFrom(url);
    return json({ series: await compareSeries(db, ids, from, to) });
  }
  if (a === "trends" && m === "GET") return json(await leaderboards(db, { limit: intParam(url.searchParams.get("limit"), 25, 5, 100) }));
  if (a === "genres" && m === "GET") {
    const g = JSON.parse((await getMeta(db, "genre_metrics")) || '{"genres":[]}');
    const series = await all(db, "SELECT d.day, COALESCE(g.genre_l1, g.genre, 'Unknown') AS genre, SUM(d.avg_playing) AS playing FROM game_daily d JOIN games g ON g.universe_id = d.universe_id WHERE d.day >= date(? / 1000, 'unixepoch') GROUP BY d.day, 2 ORDER BY d.day", now() - 30 * DAY);
    return json({ ...g, series });
  }
  if (a === "opportunities" && m === "GET") return json(await opportunityResearch(db));
  if (a === "events" && m === "GET") {
    const rows = await all(db, "SELECT e.*, g.name FROM game_events e JOIN games g ON g.universe_id = e.universe_id ORDER BY e.ts DESC LIMIT 100");
    return json({ events: rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null })) });
  }

  if (a === "lists") {
    if (!b && m === "GET") {
      const lists = await all(db, "SELECT l.id, l.name, l.kind, l.created_at, COUNT(li.target_id) AS size FROM lists l LEFT JOIN list_items li ON li.list_id = l.id GROUP BY l.id ORDER BY l.kind, l.id");
      return json({ lists });
    }
    if (!b && m === "POST") {
      const p = await body(request);
      const name = String(p.name || "").trim().slice(0, 60);
      if (!name || !["games", "items"].includes(p.kind)) throw new HttpError(400, "name and kind (games|items) required");
      await run(db, "INSERT OR IGNORE INTO lists (name, kind, created_at) VALUES (?, ?, ?)", name, p.kind, now());
      return json({ ok: true });
    }
    if (b && !c && m === "DELETE") {
      await run(db, "DELETE FROM list_items WHERE list_id = ?", id(b));
      await run(db, "DELETE FROM lists WHERE id = ?", id(b));
      return json({ ok: true });
    }
    if (b && c === "items" && !d && m === "POST") {
      const list = await first(db, "SELECT * FROM lists WHERE id = ?", id(b));
      if (!list) throw new HttpError(404, "List not found");
      const p = await body(request);
      if (list.kind === "games") return json({ universeId: await trackGame(env, db, p.ref ?? (p.targetId ? `u:${p.targetId}` : null), list.id) });
      return json({ assetId: await trackItem(db, id(p.ref ?? p.targetId), list.id) });
    }
    if (b && c === "items" && d && m === "DELETE") {
      await run(db, "DELETE FROM list_items WHERE list_id = ? AND target_id = ?", id(b), id(d));
      return json({ ok: true });
    }
  }

  if (a === "collectibles") {
    if (!b && m === "GET") {
      const list = url.searchParams.get("list");
      const ids = list
        ? (await all(db, "SELECT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items' AND l.id = ?", id(list))).map((r) => r.id)
        : (await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items'")).map((r) => r.id);
      return json({ items: await itemMetrics(db, ids) });
    }
    if (b === "popular" && m === "GET") {
      const watched = new Set((await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items'")).map((r) => r.id));
      return json({ items: (await popularCollectibles()).map((i) => ({ ...i, watched: watched.has(i.assetId) })), fetchedAt: now() });
    }
    if (b === "search" && m === "GET") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      if (!q) return json({ items: [] });
      return json({ ...(await searchCatalog(q, { collectiblesOnly: url.searchParams.get("all") !== "1" })), source: "catalog.roblox.com/v1/search/items/details" });
    }
    if (!b && m === "POST") {
      const p = await body(request);
      return json({ assetId: await trackItem(db, id(p.assetId), p.listId ? id(p.listId) : null) });
    }
    if (b && m === "GET") {
      const assetId = id(b);
      const [metrics] = await itemMetrics(db, [assetId]);
      if (!metrics) throw new HttpError(404, "Item not watched");
      const { from, to } = rangeFrom(url);
      const snapshots = await all(db, "SELECT ts, lowest_price, lowest_resale_price, units_available, favorites FROM item_snapshots WHERE asset_id = ? AND ts BETWEEN ? AND ? ORDER BY ts", assetId, from, to);
      const points = await all(db, "SELECT day, value FROM item_price_points WHERE asset_id = ? ORDER BY day", assetId);
      return json({ metrics, snapshots, resalePoints: points });
    }
  }

  if (a === "alerts") {
    if (b === "rules" && !c && m === "GET") {
      const rules = await all(db, `SELECT r.*, COALESCE(g.name, i.name) AS target_name FROM alert_rules r LEFT JOIN games g ON r.target_type = 'game' AND g.universe_id = r.target_id LEFT JOIN items i ON r.target_type = 'item' AND i.asset_id = r.target_id ORDER BY r.id DESC`);
      return json({ rules, metrics: ALERT_METRICS });
    }
    if (b === "rules" && !c && m === "POST") {
      const p = await body(request);
      if (!ALERT_METRICS[p.targetType]?.includes(p.metric)) throw new HttpError(400, "Invalid target type or metric");
      const threshold = Number(p.threshold ?? 0);
      if (!Number.isFinite(threshold)) throw new HttpError(400, "Invalid threshold");
      await run(db, "INSERT INTO alert_rules (target_type, target_id, metric, threshold, cooldown_minutes, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", p.targetType, id(p.targetId), p.metric, threshold, intParam(p.cooldownMinutes, 360, 5, 10_080), String(p.label || "").slice(0, 80) || null, now());
      return json({ ok: true });
    }
    if (b === "rules" && c && m === "DELETE") {
      await run(db, "DELETE FROM alert_rules WHERE id = ?", id(c));
      return json({ ok: true });
    }
    if (b === "rules" && c && m === "PATCH") {
      const p = await body(request);
      await run(db, "UPDATE alert_rules SET enabled = ? WHERE id = ?", p.enabled ? 1 : 0, id(c));
      return json({ ok: true });
    }
    if (!b && m === "GET") return json({ alerts: await all(db, "SELECT * FROM alerts ORDER BY ts DESC LIMIT 200") });
    if (b === "ack-all" && m === "POST") {
      await run(db, "UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0");
      return json({ ok: true });
    }
    if (b && c === "ack" && m === "POST") {
      await run(db, "UPDATE alerts SET acknowledged = 1 WHERE id = ?", id(b));
      return json({ ok: true });
    }
  }

  if (a === "reports") {
    if (!b && m === "GET") return json({ reports: await all(db, "SELECT id, type, title, created_at, confidence FROM reports ORDER BY id DESC LIMIT 200"), types: REPORT_TYPES });
    if (!b && m === "POST") {
      const p = await body(request);
      if (!REPORT_TYPES[p.type]) throw new HttpError(400, "Unknown report type");
      return json(await generateReport(env, db, p.type, p.options || {}));
    }
    if (b && m === "GET") {
      const r = await first(db, "SELECT * FROM reports WHERE id = ?", id(b));
      if (!r) throw new HttpError(404, "Report not found");
      return json({ ...r, body: JSON.parse(r.body) });
    }
    if (b && m === "DELETE") {
      await run(db, "DELETE FROM reports WHERE id = ?", id(b));
      return json({ ok: true });
    }
  }

  if (a === "roblox") {
    if (!b && m === "GET") return json(await accountStatus(env, db));
    if (b === "connect" && m === "POST") {
      const origin = request.headers.get("Origin") || url.origin;
      const { url: to, state } = await startConnect(env, db, origin);
      return json({ url: to }, 200, { "Set-Cookie": cookie(STATE_COOKIE, state, { maxAge: 600, sameSite: "Lax" }) });
    }
    if (b === "disconnect" && m === "POST") {
      await disconnect(env, db);
      return json({ ok: true });
    }
    if (b === "resources" && m === "POST") return json({ universes: await refreshResources(env, db) });
    if (b === "sync" && m === "POST") return json({ stored: await syncOfficial(env, db) });
  }

  if (a === "experiences") {
    if (!b && m === "GET") return json({ experiences: await all(db, "SELECT id, universe_id, name, ingest_key, created_at, last_event_at, cloud_checked_at, cloud_status FROM experiences ORDER BY id"), openCloudKey: !!env.ROBLOX_OPEN_CLOUD_KEY });
    if (!b && m === "POST") {
      const p = await body(request);
      const universeId = await resolveGameRef(p.ref ?? (p.universeId ? `u:${p.universeId}` : null));
      if (!universeId) throw new HttpError(404, "Experience not found");
      const g = await first(db, "SELECT name FROM games WHERE universe_id = ?", universeId);
      const created = await createExperience(env, db, { universeId, name: p.name || g?.name || null });
      return json({ universeId, ...created, note: "Copy the token now; it is stored hashed and cannot be shown again." });
    }
    if (b && c === "rotate" && m === "POST") return json({ token: await rotateToken(env, db, id(b)) });
    if (b && !c && m === "DELETE") {
      await run(db, "DELETE FROM telemetry_events WHERE experience_id = ?", id(b));
      const exp = await first(db, "SELECT universe_id FROM experiences WHERE id = ?", id(b));
      if (exp) await run(db, "DELETE FROM official_metrics WHERE universe_id = ?", exp.universe_id);
      await run(db, "DELETE FROM experiences WHERE id = ?", id(b));
      return json({ ok: true });
    }
    if (b && c === "cloud-check" && m === "POST") {
      const exp = await first(db, "SELECT * FROM experiences WHERE id = ?", id(b));
      if (!exp) throw new HttpError(404, "Experience not found");
      if (!env.ROBLOX_OPEN_CLOUD_KEY) throw new HttpError(400, "ROBLOX_OPEN_CLOUD_KEY is not configured");
      let status;
      try {
        const u = await openCloudUniverse(env.ROBLOX_OPEN_CLOUD_KEY, exp.universe_id);
        status = JSON.stringify({ ok: true, displayName: u.displayName, visibility: u.visibility, updateTime: u.updateTime });
      } catch (e) {
        status = JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) });
      }
      await run(db, "UPDATE experiences SET cloud_checked_at = ?, cloud_status = ? WHERE id = ?", now(), status, exp.id);
      return json(JSON.parse(status));
    }
    if (b && c === "official" && m === "GET") {
      const exp = await first(db, "SELECT universe_id FROM experiences WHERE id = ?", id(b));
      if (!exp) throw new HttpError(404, "Experience not found");
      const { from, to } = rangeFrom(url);
      return json(await officialMetrics(db, exp.universe_id, from, to));
    }
    if (b && (c === "analytics" || c === "economy") && m === "GET") {
      const { from, to } = rangeFrom(url);
      return json(c === "analytics" ? await experienceAnalytics(db, id(b), from, to) : await economyAnalytics(db, id(b), from, to));
    }
  }

  if ((a === "explorer" || a === "export") && m === "GET") {
    const res = await explorer(db, url);
    if (url.searchParams.get("format") === "csv") {
      return new Response(toCsv(res.rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${url.searchParams.get("dataset")}.csv"` } });
    }
    if (a === "export") return new Response(JSON.stringify(res.rows, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${url.searchParams.get("dataset")}.json"` } });
    return json({ ...res, datasets: Object.keys(DATASETS) });
  }

  if (a === "sessions" && !b && m === "GET") return json({ sessions: await listSessions(db) });
  if (a === "sessions" && b === "revoke-all" && m === "POST") {
    await destroyAllSessions(db);
    return json({ ok: true });
  }
  if (a === "collect" && m === "POST") {
    await forceSchedule(db);
    return json(await tick(env, { budgetMs: 25_000, maxJobs: 10 }));
  }
  if (a === "jobs" && b === "retry-failed" && m === "POST") {
    await retryFailed(db);
    return json({ ok: true });
  }

  throw new HttpError(404, "Not found");
}
