import { all, batch, first, getMeta, run, setMeta } from "./db.js";
import { computeMetrics, fmtPct, itemMetrics, trackedUniverseIds } from "./analytics.js";
import { fetchAssetIcons, fetchExploreSorts, fetchGameIcons, fetchGames, fetchItemDetails, fetchResaleData } from "./roblox.js";
import { DAY, HOUR, chunk, dayKey, hourKey, now } from "./util.js";

const MIN = 60_000;

export function settings(env) {
  const n = (k, d) => (Number.isFinite(parseInt(env[k], 10)) ? parseInt(env[k], 10) : d);
  return {
    trackedIntervalMin: n("STATS_TRACKED_INTERVAL_MIN", 15),
    discoveryIntervalMin: n("STATS_DISCOVERY_INTERVAL_MIN", 30),
    discoveryCap: n("STATS_DISCOVERY_CAP", 250),
    itemIntervalMin: n("STATS_ITEM_INTERVAL_MIN", 60),
    rollupIntervalMin: 30,
    snapshotRetentionDays: n("STATS_SNAPSHOT_RETENTION_DAYS", 90),
  };
}

// ---------- persistent job queue ----------

export async function enqueue(db, type, payload = {}, { delayMs = 0, maxAttempts = 5 } = {}) {
  const t = now();
  await run(db, "INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)", type, JSON.stringify(payload), maxAttempts, t + delayMs, t, t);
}

async function claimJob(db) {
  const t = now();
  return db
    .prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE (status = 'queued' AND run_after <= ?) OR (status = 'running' AND locked_until < ?) ORDER BY run_after, id LIMIT 1)
       RETURNING *`
    )
    .bind(t + 2 * MIN, t, t, t)
    .first();
}

// Atomically claims a schedule slot so concurrent ticks never enqueue the same periodic work twice.
async function due(db, name, intervalMs) {
  const t = now();
  await run(db, "INSERT OR IGNORE INTO meta (key, value) VALUES (?, '0')", `sched:${name}`);
  const res = await run(db, "UPDATE meta SET value = ? WHERE key = ? AND CAST(value AS INTEGER) <= ?", String(t), `sched:${name}`, t - intervalMs);
  return (res.meta?.changes || 0) > 0;
}

async function schedule(env, db) {
  const s = settings(env);
  const t = now();
  const tracked = await trackedUniverseIds(db);
  if (await due(db, "tracked", s.trackedIntervalMin * MIN - 30_000)) {
    for (const ids of chunk(tracked, 50)) await enqueue(db, "collect_games", { ids, raw: true });
  }
  if (await due(db, "discover", s.discoveryIntervalMin * MIN - 30_000)) {
    await enqueue(db, "discover", {});
    const trackedSet = new Set(tracked);
    const pool = (await all(db, "SELECT universe_id FROM games WHERE last_seen_at > ? ORDER BY last_seen_at DESC LIMIT ?", t - 3 * DAY, s.discoveryCap + tracked.length))
      .map((r) => r.universe_id)
      .filter((id) => !trackedSet.has(id))
      .slice(0, s.discoveryCap);
    for (const ids of chunk(pool, 50)) await enqueue(db, "collect_games", { ids, raw: false }, { delayMs: 5_000 });
  }
  if (await due(db, "items", s.itemIntervalMin * MIN - 30_000)) {
    const items = (await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items'")).map((r) => r.id);
    for (const ids of chunk(items, 50)) await enqueue(db, "collect_items", { ids });
  }
  if (await due(db, "resale", DAY)) {
    const items = (await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items'")).map((r) => r.id);
    for (const ids of chunk(items, 10)) await enqueue(db, "item_resale", { ids });
  }
  if (await due(db, "rollup", s.rollupIntervalMin * MIN - 30_000)) await enqueue(db, "rollup", {}, { delayMs: 60_000 });
  if (await due(db, "cleanup", DAY)) await enqueue(db, "cleanup", {});
  const utc = new Date(t);
  if (utc.getUTCHours() >= 1 && (await getMeta(db, "report:daily")) !== dayKey(t)) {
    await setMeta(db, "report:daily", dayKey(t));
    await enqueue(db, "report", { type: "daily_market" });
    await enqueue(db, "report", { type: "collectibles" });
    if (utc.getUTCDay() === 1) await enqueue(db, "report", { type: "weekly_genre" });
    if (utc.getUTCDate() === 1) await enqueue(db, "report", { type: "monthly_trends" });
  }
}

export async function tick(env, { budgetMs = 20_000, maxJobs = 8 } = {}) {
  const db = env.STATS_DB;
  const started = now();
  await setMeta(db, "last_tick_at", started);
  await schedule(env, db);
  const done = [];
  while (done.length < maxJobs && now() - started < budgetMs) {
    const job = await claimJob(db);
    if (!job) break;
    done.push(await runJob(env, db, job));
  }
  const remaining = await first(db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND run_after <= ?", now());
  return { ran: done, remaining: remaining?.n || 0 };
}

export async function runJob(env, db, job) {
  const startedAt = now();
  const runRow = await db.prepare("INSERT INTO collection_runs (job_id, job_type, started_at) VALUES (?, ?, ?) RETURNING id").bind(job.id, job.type, startedAt).first();
  try {
    const handler = HANDLERS[job.type];
    if (!handler) throw new Error(`Unknown job type ${job.type}`);
    const items = await handler(env, db, JSON.parse(job.payload || "{}"));
    await run(db, "UPDATE jobs SET status = 'done', last_error = NULL, locked_until = NULL, updated_at = ? WHERE id = ?", now(), job.id);
    await run(db, "UPDATE collection_runs SET finished_at = ?, ok = 1, items = ? WHERE id = ?", now(), items ?? null, runRow.id);
    return { id: job.id, type: job.type, ok: true, items };
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    const failed = job.attempts >= job.max_attempts;
    const backoff = Math.min(60, 2 ** job.attempts) * MIN;
    await run(db, "UPDATE jobs SET status = ?, last_error = ?, run_after = ?, locked_until = NULL, updated_at = ? WHERE id = ?", failed ? "failed" : "queued", msg, now() + backoff, now(), job.id);
    await run(db, "UPDATE collection_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?", now(), msg, runRow.id);
    return { id: job.id, type: job.type, ok: false, error: msg, willRetry: !failed };
  }
}

// ---------- handlers ----------

async function collectGames(env, db, { ids, raw }) {
  if (!ids?.length) return 0;
  const t = now();
  const data = await fetchGames(ids);
  const placeholders = ids.map(() => "?").join(",");
  const existing = new Map((await all(db, `SELECT universe_id, name, updated_at, icon_url, peak_playing FROM games WHERE universe_id IN (${placeholders})`, ...ids)).map((r) => [r.universe_id, r]));
  const needIcons = ids.filter((id) => data.has(id) && !existing.get(id)?.icon_url);
  const icons = needIcons.length ? await fetchGameIcons(needIcons).catch(() => new Map()) : new Map();
  const h = hourKey(t);
  const stmts = [];
  for (const [id, g] of data) {
    const ex = existing.get(id);
    if (!ex) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO games (universe_id, first_seen_at, discovered_via) VALUES (?, ?, 'manual')").bind(id, t));
    } else {
      if (ex.name && ex.name !== g.name) stmts.push(db.prepare("INSERT OR IGNORE INTO game_changes (universe_id, ts, field, old_value, new_value) VALUES (?, ?, 'name', ?, ?)").bind(id, t, ex.name, g.name));
      if (ex.updated_at && ex.updated_at !== g.updated) stmts.push(db.prepare("INSERT OR IGNORE INTO game_changes (universe_id, ts, field, old_value, new_value) VALUES (?, ?, 'updated_at', ?, ?)").bind(id, t, ex.updated_at, g.updated));
    }
    const changed = !ex || ex.name !== g.name || ex.updated_at !== g.updated || icons.has(id) || (g.playing || 0) > (ex.peak_playing || 0);
    if (changed) {
      stmts.push(
        db.prepare(
          `UPDATE games SET root_place_id = ?, name = ?, creator_id = ?, creator_name = ?, creator_type = ?, creator_verified = ?, genre = ?, genre_l1 = ?, genre_l2 = ?,
             max_players = ?, created_at = ?, updated_at = ?, price = ?, icon_url = COALESCE(?, icon_url), last_collected_at = ?,
             peak_playing_at = CASE WHEN ? > COALESCE(peak_playing, 0) THEN ? ELSE peak_playing_at END,
             peak_playing = MAX(COALESCE(peak_playing, 0), ?)
           WHERE universe_id = ?`
        ).bind(g.rootPlaceId, g.name, g.creatorId, g.creatorName, g.creatorType, g.creatorVerified, g.genre, g.genreL1, g.genreL2, g.maxPlayers, g.created, g.updated, g.price, icons.get(id) || null, t, g.playing || 0, t, g.playing || 0, id)
      );
    }
    stmts.push(
      db.prepare(
        `INSERT INTO game_hourly (universe_id, hour, samples, sum_playing, peak_playing, min_playing, visits, favorites, up_votes, down_votes)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (universe_id, hour) DO UPDATE SET samples = samples + 1, sum_playing = sum_playing + excluded.sum_playing,
           peak_playing = MAX(peak_playing, excluded.peak_playing), min_playing = MIN(min_playing, excluded.min_playing),
           visits = excluded.visits, favorites = excluded.favorites, up_votes = excluded.up_votes, down_votes = excluded.down_votes`
      ).bind(id, h, g.playing || 0, g.playing || 0, g.playing || 0, g.visits, g.favorites, g.upVotes, g.downVotes)
    );
    if (raw) stmts.push(db.prepare("INSERT OR REPLACE INTO game_snapshots (universe_id, ts, playing, visits, favorites, up_votes, down_votes) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, t, g.playing, g.visits, g.favorites, g.upVotes, g.downVotes));
  }
  // New rows need a second pass for the UPDATE to land after the INSERT in the same batch: order is preserved, so it already does.
  await batch(db, stmts);
  const missing = ids.filter((id) => !data.has(id));
  const neverResolved = missing.filter((id) => !existing.get(id)?.name);
  if (neverResolved.length) {
    // Ids Roblox doesn't recognise (bad input or deleted games) are dropped instead of retried forever.
    const ph = neverResolved.map(() => "?").join(",");
    await batch(db, [db.prepare(`DELETE FROM list_items WHERE target_id IN (${ph})`).bind(...neverResolved), db.prepare(`DELETE FROM games WHERE name IS NULL AND universe_id IN (${ph})`).bind(...neverResolved)]);
  }
  if (missing.length === ids.length && neverResolved.length < missing.length) throw new Error(`Roblox returned no data for ${missing.length} universes`);
  return data.size;
}

async function discover(env, db) {
  const t = now();
  const sorts = await fetchExploreSorts(3);
  const stmts = [];
  const seen = new Map();
  for (const s of sorts) {
    for (const g of s.games) {
      seen.set(g.universeId, s.sortId);
      stmts.push(
        db.prepare(
          `INSERT INTO discovery_sightings (universe_id, sort_id, first_ts, last_ts, best_position, last_position) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (universe_id, sort_id) DO UPDATE SET last_ts = excluded.last_ts, last_position = excluded.last_position, best_position = MIN(best_position, excluded.best_position)`
        ).bind(g.universeId, s.sortId, t, t, g.position, g.position)
      );
    }
  }
  for (const [id, sortId] of seen) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO games (universe_id, first_seen_at, discovered_via) VALUES (?, ?, ?)").bind(id, t, `sort:${sortId}`));
    stmts.push(db.prepare("UPDATE games SET last_seen_at = ? WHERE universe_id = ?").bind(t, id));
  }
  await batch(db, stmts);
  const fresh = (await all(db, "SELECT universe_id FROM games WHERE name IS NULL LIMIT 200")).map((r) => r.universe_id);
  for (const ids of chunk(fresh, 50)) await enqueue(db, "collect_games", { ids, raw: false });
  await setMeta(db, "discover_sorts", JSON.stringify(sorts.map((s) => ({ sortId: s.sortId, name: s.name, games: s.games.length }))));
  return seen.size;
}

async function collectItems(env, db, { ids }) {
  if (!ids?.length) return 0;
  const t = now();
  const data = await fetchItemDetails(ids);
  const placeholders = ids.map(() => "?").join(",");
  const noIcon = (await all(db, `SELECT asset_id FROM items WHERE icon_url IS NULL AND asset_id IN (${placeholders})`, ...ids)).map((r) => r.asset_id);
  const icons = noIcon.length ? await fetchAssetIcons(noIcon).catch(() => new Map()) : new Map();
  const stmts = [];
  for (const [id, d] of data) {
    stmts.push(
      db.prepare(
        `UPDATE items SET name = ?, asset_type = ?, item_type = ?, creator_name = ?, restrictions = ?, total_quantity = ?, collectible_item_id = ?, created_utc = ?, icon_url = COALESCE(?, icon_url), last_collected_at = ? WHERE asset_id = ?`
      ).bind(d.name, d.assetType, d.itemType, d.creatorName, d.restrictions, d.totalQuantity, d.collectibleItemId, d.createdUtc, icons.get(id) || null, t, id)
    );
    stmts.push(db.prepare("INSERT OR REPLACE INTO item_snapshots (asset_id, ts, lowest_price, lowest_resale_price, price, units_available, favorites, has_resellers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, t, d.lowestPrice, d.lowestResalePrice, d.price, d.unitsAvailable, d.favorites, d.hasResellers));
  }
  await batch(db, stmts);
  await evaluateItemAlerts(env, db, [...data.keys()]);
  if (!data.size) throw new Error(`Catalog returned no data for ${ids.length} items`);
  return data.size;
}

async function itemResale(env, db, { ids }) {
  let n = 0;
  const errors = [];
  for (const id of ids || []) {
    try {
      const r = await fetchResaleData(id);
      const stmts = [db.prepare("UPDATE items SET rap = ?, sales = ?, resale_points_through = ?, resale_checked_at = ? WHERE asset_id = ?").bind(r.rap, r.sales, r.points[0]?.day || null, now(), id)];
      for (const p of r.points) stmts.push(db.prepare("INSERT OR REPLACE INTO item_price_points (asset_id, day, value) VALUES (?, ?, ?)").bind(id, p.day, p.value));
      await batch(db, stmts);
      n++;
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  }
  if (errors.length === (ids || []).length && errors.length) throw new Error(errors.join("; ").slice(0, 400));
  return n;
}

async function rollup(env, db) {
  const t = now();
  const fromHour = hourKey(t - 2 * DAY);
  await run(
    db,
    `INSERT OR REPLACE INTO game_daily (universe_id, day, samples, avg_playing, peak_playing, min_playing, visits, favorites, up_votes, down_votes)
     SELECT universe_id, date(hour / 1000, 'unixepoch'), SUM(samples), SUM(sum_playing) * 1.0 / SUM(samples), MAX(peak_playing), MIN(min_playing), MAX(visits), MAX(favorites), MAX(up_votes), MAX(down_votes)
     FROM game_hourly WHERE hour >= ? GROUP BY universe_id, date(hour / 1000, 'unixepoch')`,
    Math.floor(fromHour / DAY) * DAY
  );
  const metrics = await computeMetrics(db);
  await detectEvents(db, metrics);
  await evaluateGameAlerts(env, db, metrics);
  return metrics.size;
}

async function cleanup(env, db) {
  const t = now();
  const s = settings(env);
  const stmts = [
    db.prepare("DELETE FROM jobs WHERE (status = 'done' AND updated_at < ?) OR (status = 'failed' AND updated_at < ?)").bind(t - 3 * DAY, t - 14 * DAY),
    db.prepare("DELETE FROM collection_runs WHERE started_at < ?").bind(t - 30 * DAY),
    db.prepare("DELETE FROM auth_attempts WHERE ts < ?").bind(t - 2 * DAY),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
    db.prepare("DELETE FROM rate_counters WHERE window_start < ?").bind(t - DAY),
    db.prepare("DELETE FROM game_snapshots WHERE ts < ?").bind(t - s.snapshotRetentionDays * DAY),
    db.prepare("DELETE FROM game_hourly WHERE hour < ?").bind(t - 21 * DAY),
    db.prepare("DELETE FROM game_metrics WHERE computed_at < ?").bind(t - 7 * DAY),
    db.prepare("DELETE FROM telemetry_events WHERE ts < ?").bind(t - 400 * DAY),
  ];
  await batch(db, stmts);
  return stmts.length;
}

async function report(env, db, { type, options }) {
  const { generateReport } = await import("./reports.js");
  const r = await generateReport(env, db, type, options || {});
  return r ? 1 : 0;
}

const HANDLERS = { collect_games: collectGames, discover, collect_items: collectItems, item_resale: itemResale, rollup, cleanup, report };

// ---------- events & alerts ----------

async function detectEvents(db, metrics) {
  const t = now();
  const tracked = [...metrics.values()].filter((m) => m.tracked && m.confidence >= 0.3);
  for (const m of tracked) {
    let kind = null;
    if ((m.z ?? 0) > 3 || (m.baselineRatio ?? 0) > 2) kind = "surge";
    else if ((m.growth24 ?? 0) > 0.5) kind = "growth";
    else if ((m.growth24 ?? 0) < -0.4 || (m.baselineRatio !== null && m.baselineRatio < 0.5)) kind = "drop";
    if (!kind) continue;
    const recent = await first(db, "SELECT id FROM game_events WHERE universe_id = ? AND kind = ? AND ts > ?", m.universeId, kind, t - DAY);
    if (recent) continue;
    const changes = await all(db, "SELECT ts, field, old_value, new_value FROM game_changes WHERE universe_id = ? AND ts > ? ORDER BY ts", m.universeId, t - 3 * DAY);
    const sightings = await all(db, "SELECT sort_id, first_ts, best_position FROM discovery_sightings WHERE universe_id = ? AND first_ts > ?", m.universeId, t - 3 * DAY);
    const observed = [
      `Average concurrent players: ${Math.round(m.avg24 ?? m.current)} over the last 24h vs ${m.avgPrev24 !== null ? Math.round(m.avgPrev24) : "n/a"} the 24h before (${fmtPct(m.growth24)}).`,
      m.baseline ? `Current ${m.current} players is ${m.baselineRatio.toFixed(2)}x the 7-day median baseline of ${Math.round(m.baseline)}.` : null,
      Number.isFinite(m.visitsPerHour) ? `Visits are accruing at ${Math.round(m.visitsPerHour).toLocaleString()}/hour${m.visitGrowth !== null ? ` (${fmtPct(m.visitGrowth)} vs prior 24h)` : ""}.` : null,
      Number.isFinite(m.favPerHour) ? `Favorites +${Math.round(m.favPerHour)}/hour.` : null,
    ].filter(Boolean);
    const inferred = [];
    for (const c of changes.filter((c) => c.field === "updated_at")) inferred.push(`The game was updated (Roblox "updated" timestamp moved to ${c.new_value}), which could explain the change.`);
    for (const c of changes.filter((c) => c.field === "name")) inferred.push(`The title changed from "${c.old_value}" to "${c.new_value}", often a sign of an update or event.`);
    for (const s of sightings) inferred.push(`The game newly appeared in Roblox's "${s.sort_id}" discovery sort (best position ${s.best_position}), which brings in extra traffic.`);
    if (!inferred.length) inferred.push("No public update, title change or new discovery placement was observed. The cause can't be determined from public data.");
    const severity = kind === "surge" || Math.abs(m.growth24 ?? 0) > 1 ? "high" : "medium";
    await run(
      db,
      "INSERT INTO game_events (universe_id, ts, kind, severity, summary, evidence) VALUES (?, ?, ?, ?, ?, ?)",
      m.universeId,
      t,
      kind,
      severity,
      `${kind === "drop" ? "Player drop" : kind === "surge" ? "Unusual surge" : "Rapid growth"}: ${fmtPct(m.growth24)} over 24h`,
      JSON.stringify({ observed, inferred, inferredLabel: "Inferred explanations (speculative, not confirmed)", confidence: m.confidence })
    );
  }
}

const GAME_METRICS = {
  playing_above: (m, th) => m.current >= th && `${m.current.toLocaleString()} players (>= ${th})`,
  playing_below: (m, th) => m.current <= th && `${m.current.toLocaleString()} players (<= ${th})`,
  growth_24h_above: (m, th) => (m.growth24 ?? -Infinity) * 100 >= th && `24h growth ${fmtPct(m.growth24)} (>= ${th}%)`,
  growth_24h_below: (m, th) => (m.growth24 ?? Infinity) * 100 <= th && `24h change ${fmtPct(m.growth24)} (<= ${th}%)`,
};
const ITEM_METRICS = {
  price_below: (m, th) => m.price !== null && m.price <= th && `Lowest resale ${m.price.toLocaleString()} R$ (<= ${th})`,
  price_above: (m, th) => m.price !== null && m.price >= th && `Lowest resale ${m.price.toLocaleString()} R$ (>= ${th})`,
  change_24h_abs_above: (m, th) => m.change24h !== null && Math.abs(m.change24h) * 100 >= th && `24h price change ${fmtPct(m.change24h)} (|x| >= ${th}%)`,
  unusual_move: (m) => m.unusual && `Statistically unusual move: ${m.zMove.toFixed(1)} sigma`,
};
export const ALERT_METRICS = { game: Object.keys(GAME_METRICS), item: Object.keys(ITEM_METRICS) };

async function fireRules(env, db, rules, lookup, table, nameOf) {
  const t = now();
  for (const r of rules) {
    const m = lookup(r.target_id);
    if (!m || !table[r.metric]) continue;
    if (r.last_triggered_at && r.last_triggered_at + r.cooldown_minutes * MIN > t) continue;
    const hit = table[r.metric](m, r.threshold);
    if (!hit) continue;
    const message = `${nameOf(m)}: ${hit}`;
    await run(db, "INSERT INTO alerts (rule_id, ts, target_type, target_id, message, value) VALUES (?, ?, ?, ?, ?, ?)", r.id, t, r.target_type, r.target_id, message, m.current ?? m.price ?? null);
    await run(db, "UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?", t, r.id);
    await notify(env, message);
  }
}

async function evaluateGameAlerts(env, db, metrics) {
  const rules = await all(db, "SELECT * FROM alert_rules WHERE enabled = 1 AND target_type = 'game'");
  if (!rules.length) return;
  const names = new Map((await all(db, `SELECT universe_id, name FROM games WHERE universe_id IN (${rules.map(() => "?").join(",")})`, ...rules.map((r) => r.target_id))).map((r) => [r.universe_id, r.name]));
  await fireRules(env, db, rules, (id) => metrics.get(id), GAME_METRICS, (m) => names.get(m.universeId) || m.universeId);
}

async function evaluateItemAlerts(env, db, ids) {
  const rules = (await all(db, "SELECT * FROM alert_rules WHERE enabled = 1 AND target_type = 'item'")).filter((r) => ids.includes(r.target_id));
  if (!rules.length) return;
  const ms = new Map((await itemMetrics(db, [...new Set(rules.map((r) => r.target_id))])).map((m) => [m.assetId, m]));
  await fireRules(env, db, rules, (id) => ms.get(id), ITEM_METRICS, (m) => m.name);
}

// Optional: push alerts to a private Discord channel. Never reuses the public contact webhook.
async function notify(env, message) {
  if (!env.STATS_ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.STATS_ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `[F8di Stats] ${message}`.slice(0, 1900), allowed_mentions: { parse: [] } }) });
  } catch {
    // alert is still stored in the dashboard
  }
}

export async function queueStatus(db) {
  const counts = await all(db, "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status");
  const failed = await all(db, "SELECT id, type, attempts, last_error, updated_at FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20");
  const retrying = await all(db, "SELECT id, type, attempts, last_error, run_after FROM jobs WHERE status = 'queued' AND attempts > 0 ORDER BY run_after LIMIT 20");
  const runs = await all(db, "SELECT job_type, started_at, finished_at, ok, items, error FROM collection_runs ORDER BY id DESC LIMIT 40");
  const lastOk = await all(db, "SELECT job_type, MAX(finished_at) AS at FROM collection_runs WHERE ok = 1 GROUP BY job_type");
  const errors24h = await all(db, "SELECT job_type, COUNT(*) AS n, MAX(error) AS sample FROM collection_runs WHERE ok = 0 AND started_at > ? GROUP BY job_type", now() - DAY);
  return { counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), failed, retrying, runs, lastOk: Object.fromEntries(lastOk.map((r) => [r.job_type, r.at])), errors24h, lastTickAt: Number(await getMeta(db, "last_tick_at")) || null };
}

export async function retryFailed(db) {
  await run(db, "UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, updated_at = ? WHERE status = 'failed'", now(), now());
}

export async function forceSchedule(db) {
  await run(db, "UPDATE meta SET value = '0' WHERE key LIKE 'sched:%' AND key NOT IN ('sched:cleanup', 'sched:resale')");
}
