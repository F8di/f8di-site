import { all, batch, first, getMeta, setMeta } from "./db.js";
import { DAY, HOUR, clamp, dayKey, mean, median, now, pctChange, stdev } from "./util.js";

const MIN_DENOM = 20; // keeps tiny games from showing +5000% on a handful of players

export function growth(cur, prev) {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  return (cur - prev) / Math.max(prev, MIN_DENOM);
}

export async function trackedUniverseIds(db) {
  const rows = await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'games'");
  return rows.map((r) => r.id);
}

function weightedAvg(rows) {
  let s = 0;
  let n = 0;
  for (const r of rows) {
    s += r.sum_playing;
    n += r.samples;
  }
  return n ? s / n : null;
}

function nearestBefore(rows, t) {
  let best = null;
  for (const r of rows) if (r.hour <= t && (!best || r.hour > best.hour)) best = r;
  return best;
}

// Computes per-game trend metrics from hourly and daily aggregates. Run hourly by the rollup job.
export async function computeMetrics(db, { discoveryDays = 7 } = {}) {
  const t = now();
  const tracked = new Set(await trackedUniverseIds(db));
  const games = await all(db, "SELECT universe_id, name, genre, genre_l1, created_at, last_seen_at, first_seen_at FROM games WHERE name IS NOT NULL AND (last_seen_at > ? OR last_collected_at > ?)", t - discoveryDays * DAY, t - 2 * DAY);
  const pool = games.filter((g) => tracked.has(g.universe_id) || (g.last_seen_at || 0) > t - discoveryDays * DAY);
  const ids = new Set(pool.map((g) => g.universe_id));
  const hourly = await all(db, "SELECT universe_id, hour, samples, sum_playing, peak_playing, visits, favorites, up_votes, down_votes FROM game_hourly WHERE hour >= ?", t - 49 * HOUR);
  const daily = await all(db, "SELECT universe_id, day, avg_playing, peak_playing, visits, favorites FROM game_daily WHERE day >= ? ORDER BY day", dayKey(t - 31 * DAY));
  const byH = new Map();
  for (const r of hourly) if (ids.has(r.universe_id)) (byH.get(r.universe_id) || byH.set(r.universe_id, []).get(r.universe_id)).push(r);
  const byD = new Map();
  for (const r of daily) if (ids.has(r.universe_id)) (byD.get(r.universe_id) || byD.set(r.universe_id, []).get(r.universe_id)).push(r);
  const today = dayKey(t);

  const metrics = new Map();
  for (const g of pool) {
    const h = (byH.get(g.universe_id) || []).sort((a, b) => a.hour - b.hour);
    if (!h.length) continue;
    const latest = h[h.length - 1];
    const current = latest.sum_playing / latest.samples;
    const last24 = h.filter((r) => r.hour > t - 24 * HOUR);
    const prev24 = h.filter((r) => r.hour <= t - 24 * HOUR && r.hour > t - 48 * HOUR);
    const last6 = h.filter((r) => r.hour > t - 6 * HOUR);
    const prev6 = h.filter((r) => r.hour <= t - 6 * HOUR && r.hour > t - 12 * HOUR);
    const avg24 = weightedAvg(last24);
    const avgPrev24 = prev24.length >= 6 ? weightedAvg(prev24) : null;
    const avg6 = weightedAvg(last6);
    const avgPrev6 = prev6.length >= 3 ? weightedAvg(prev6) : null;

    const days = (byD.get(g.universe_id) || []).filter((d) => d.day < today);
    const dAvg = days.map((d) => d.avg_playing);
    const last7 = dAvg.slice(-7);
    const prev7 = dAvg.slice(-14, -7);
    const avg7 = last7.length >= 3 ? mean(last7) : null;
    const avgPrev7 = prev7.length >= 3 ? mean(prev7) : null;
    const growthYesterday = dAvg.length >= 2 ? growth(dAvg[dAvg.length - 1], dAvg[dAvg.length - 2]) : null;
    const growthDayBefore = dAvg.length >= 3 ? growth(dAvg[dAvg.length - 2], dAvg[dAvg.length - 3]) : null;
    const baseDays = dAvg.slice(-8, -1);
    const baseline = baseDays.length >= 3 ? median(baseDays) : null;
    const hist = dAvg.slice(-15);
    const sd = hist.length >= 5 ? stdev(hist) : null;
    const z = sd && avg6 !== null ? (avg6 - mean(hist)) / Math.max(sd, 1) : null;
    const last14 = dAvg.slice(-14);
    let upDays = 0;
    for (let i = 1; i < last14.length; i++) if (last14[i] > last14[i - 1]) upDays++;
    const upFrac = last14.length >= 4 ? upDays / (last14.length - 1) : null;
    const cv14 = last14.length >= 5 && mean(last14) > 0 ? stdev(last14) / mean(last14) : null;

    const v24 = nearestBefore(h, t - 24 * HOUR);
    const v48 = nearestBefore(h, t - 48 * HOUR + HOUR);
    const hoursSpan = v24 ? (latest.hour - v24.hour) / HOUR : null;
    const visitsPerHour = v24 && hoursSpan > 0 ? (latest.visits - v24.visits) / hoursSpan : null;
    const prevVisitsPerHour = v24 && v48 && v24.hour > v48.hour ? (v24.visits - v48.visits) / ((v24.hour - v48.hour) / HOUR) : null;
    const favPerHour = v24 && hoursSpan > 0 ? (latest.favorites - v24.favorites) / hoursSpan : null;
    const votes = (latest.up_votes || 0) + (latest.down_votes || 0);
    const likeRatio = votes > 0 ? latest.up_votes / votes : null;

    const growth24 = growth(avg24, avgPrev24);
    const growth6 = growth(avg6, avgPrev6);
    const growth7 = growth(avg7, avgPrev7);
    const acceleration = growthYesterday !== null && growthDayBefore !== null ? growthYesterday - growthDayBefore : null;
    const hoursCovered = h.filter((r) => r.hour > t - 48 * HOUR).length;
    const coverage = clamp(hoursCovered / 48, 0, 1);
    const history = clamp(days.length / 7, 0, 1);
    const size = clamp(Math.log10((avg24 || current || 0) + 1) / 3, 0, 1);
    const confidence = +(0.4 * coverage + 0.4 * history + 0.2 * size).toFixed(2);
    const baselineRatio = baseline ? current / Math.max(baseline, 1) : null;

    let pattern = "insufficient data";
    if (hoursCovered >= 12 || days.length >= 2) {
      const g24 = growth24 ?? growth6 ?? 0;
      if (g24 > 0.25 && (upFrac ?? 0) >= 0.6 && (growth7 ?? 0) > 0.15) pattern = "sustained growth";
      else if ((z !== null && z > 3) || (baselineRatio !== null && baselineRatio > 2)) pattern = (upFrac ?? 0) >= 0.6 ? "sustained growth" : "spike";
      else if (g24 < -0.2 || (growth7 ?? 0) < -0.2) pattern = "declining";
      else if (g24 > 0.1) pattern = "rising";
      else pattern = "stable";
    }

    metrics.set(g.universe_id, {
      universeId: g.universe_id,
      tracked: tracked.has(g.universe_id),
      current: Math.round(current),
      peakObserved: Math.max(...h.map((r) => r.peak_playing || 0), ...days.map((d) => d.peak_playing || 0)),
      avg6, avgPrev6, avg24, avgPrev24, avg7, avgPrev7,
      growth6, growth24, growth7, growthYesterday, acceleration,
      baseline, baselineRatio, z,
      visits: latest.visits, visitsPerHour, visitGrowth: pctChange(visitsPerHour, prevVisitsPerHour),
      favorites: latest.favorites, favPerHour,
      likeRatio, upFrac, cv14,
      daysObserved: days.length, hoursCovered, confidence, pattern,
      genre: g.genre_l1 || g.genre || "Unknown",
      createdAt: g.created_at,
      firstSeenAt: g.first_seen_at,
    });
  }

  const genres = genreMetrics([...metrics.values()], t);
  for (const m of metrics.values()) {
    const gm = genres.find((x) => x.genre === m.genre);
    const gScore = clamp(Math.max(m.growth7 ?? m.growth24 ?? 0, 0), 0, 1);
    const sScore = m.upFrac ?? 0.5;
    const gmScore = gm ? clamp(Math.max(gm.growth24 ?? 0, 0) / 0.3, 0, 1) : 0;
    const satScore = gm ? 1 - clamp(gm.hhi, 0, 1) : 0.5;
    const qScore = m.likeRatio ?? 0.5;
    m.opportunity = Math.round(100 * (0.35 * gScore + 0.2 * sScore + 0.15 * gmScore + 0.15 * satScore + 0.15 * qScore) * Math.sqrt(m.confidence));
  }

  const stmts = [...metrics.values()].map((m) =>
    db.prepare("INSERT OR REPLACE INTO game_metrics (universe_id, computed_at, data) VALUES (?, ?, ?)").bind(m.universeId, t, JSON.stringify(m))
  );
  await batch(db, stmts);
  await setMeta(db, "genre_metrics", JSON.stringify({ computedAt: t, genres }));
  await setMeta(db, "metrics_computed_at", t);
  return metrics;
}

export function genreMetrics(list, t = now()) {
  const groups = new Map();
  for (const m of list) (groups.get(m.genre) || groups.set(m.genre, []).get(m.genre)).push(m);
  const out = [];
  for (const [genre, ms] of groups) {
    const total = ms.reduce((s, m) => s + (m.current || 0), 0);
    const sum = (k) => ms.reduce((s, m) => s + (Number.isFinite(m[k]) ? m[k] : 0), 0);
    const withPrev24 = ms.filter((m) => Number.isFinite(m.avgPrev24) && Number.isFinite(m.avg24));
    const withPrev7 = ms.filter((m) => Number.isFinite(m.avgPrev7) && Number.isFinite(m.avg7));
    const shares = ms.map((m) => (total ? (m.current || 0) / total : 0));
    const hhi = shares.reduce((s, x) => s + x * x, 0);
    const recent = ms.filter((m) => m.createdAt && Date.parse(m.createdAt) > t - 90 * DAY);
    out.push({
      genre,
      games: ms.length,
      playing: total,
      growth24: withPrev24.length ? growth(withPrev24.reduce((s, m) => s + m.avg24, 0), withPrev24.reduce((s, m) => s + m.avgPrev24, 0)) : null,
      growth7: withPrev7.length ? growth(withPrev7.reduce((s, m) => s + m.avg7, 0), withPrev7.reduce((s, m) => s + m.avgPrev7, 0)) : null,
      hhi: +hhi.toFixed(3),
      topShare: shares.length ? +Math.max(...shares).toFixed(3) : 0,
      newGameShare: total ? +(recent.reduce((s, m) => s + (m.current || 0), 0) / total).toFixed(3) : 0,
      growingGames: ms.filter((m) => (m.growth24 ?? 0) > 0.1).length,
      favPerHour: sum("favPerHour"),
      confidence: +mean(ms.map((m) => m.confidence)).toFixed(2),
    });
  }
  return out.sort((a, b) => b.playing - a.playing);
}

export async function loadMetrics(db) {
  const rows = await all(
    db,
    `SELECT m.data, g.name, g.icon_url, g.creator_name, g.creator_type, g.root_place_id, g.created_at, g.updated_at, g.genre_l2
     FROM game_metrics m JOIN games g ON g.universe_id = m.universe_id`
  );
  return rows.map((r) => ({ ...JSON.parse(r.data), name: r.name, icon: r.icon_url, creator: r.creator_name, creatorType: r.creator_type, rootPlaceId: r.root_place_id, createdAt: r.created_at, updatedAt: r.updated_at, subgenre: r.genre_l2 }));
}

export async function leaderboards(db, { limit = 25 } = {}) {
  const t = now();
  const ms = await loadMetrics(db);
  const ok = (m, minConf = 0.25, minPlayers = 25) => m.confidence >= minConf && (m.avg24 ?? m.current) >= minPlayers;
  const by = (arr, key, dir = -1) => [...arr].filter((m) => Number.isFinite(m[key])).sort((a, b) => dir * (a[key] - b[key])).slice(0, limit);
  const createdWithin = (m, days) => m.createdAt && Date.parse(m.createdAt) > t - days * DAY;
  const genreData = JSON.parse((await getMeta(db, "genre_metrics")) || '{"genres":[]}');
  return {
    computedAt: Number(await getMeta(db, "metrics_computed_at")) || null,
    poolSize: ms.length,
    fastestGrowing: by(ms.filter((m) => ok(m)).map((m) => ({ ...m, score: m.growth24 ?? m.growth6 })), "score"),
    emerging: by(ms.filter((m) => ok(m, 0.2, 10) && createdWithin(m, 180) && ((m.growth24 ?? m.growth6 ?? 0) > 0.05)), "opportunity"),
    newReleases: by(ms.filter((m) => createdWithin(m, 30)), "current"),
    newlyDiscovered: by(ms.filter((m) => m.firstSeenAt > t - 2 * DAY), "current"),
    biggestDeclines: by(ms.filter((m) => ok(m, 0.25, 50)).map((m) => ({ ...m, score: m.growth24 ?? m.growth6 })), "score", 1),
    mostConsistent: by(ms.filter((m) => m.daysObserved >= 5 && Number.isFinite(m.cv14) && (m.growth7 ?? 0) >= -0.05).map((m) => ({ ...m, score: -m.cv14 })), "score"),
    unexpectedBreakouts: by(ms.filter((m) => ok(m, 0.2, 10) && ((m.z ?? 0) > 3 || (m.baselineRatio ?? 0) > 2.5)).map((m) => ({ ...m, score: m.baselineRatio ?? m.z })), "score"),
    acceleration: by(ms.filter((m) => ok(m, 0.4)), "acceleration"),
    opportunities: by(ms, "opportunity"),
    trendingGenres: [...genreData.genres].filter((g) => g.games >= 2 && Number.isFinite(g.growth24)).sort((a, b) => b.growth24 - a.growth24).slice(0, limit),
  };
}

const PATTERN_WORDS = ["simulator", "tycoon", "obby", "tower", "defense", "rng", "grow", "steal", "escape", "survive", "horror", "anime", "brainrot", "race", "fight", "battle", "farm", "fish", "pet", "dress", "roleplay", "rp", "story", "parkour", "clicker", "idle", "incremental", "merge", "hide", "seek", "slap", "lifting", "shooter", "fps", "zombie", "mining", "cook", "restaurant", "hatch", "trade", "plane", "car", "boat", "build", "dig", "spin", "gamble", "chess", "sword", "magic"];

export function namePatterns(ms) {
  const counts = new Map();
  for (const m of ms) {
    const words = new Set((m.name || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/));
    for (const w of PATTERN_WORDS) {
      if (!words.has(w)) continue;
      const c = counts.get(w) || { pattern: w, games: 0, growing: 0, playing: 0, sumGrowth: 0, examples: [] };
      c.games++;
      c.playing += m.current || 0;
      if ((m.growth24 ?? 0) > 0.1) c.growing++;
      c.sumGrowth += clamp(m.growth24 ?? 0, -1, 3);
      if (c.examples.length < 4) c.examples.push({ universeId: m.universeId, name: m.name });
      counts.set(w, c);
    }
  }
  return [...counts.values()]
    .filter((c) => c.games >= 2)
    .map((c) => ({ ...c, avgGrowth24: c.sumGrowth / c.games, growingShare: c.growing / c.games }))
    .sort((a, b) => b.avgGrowth24 - a.avgGrowth24);
}

const GENRE_PROFILES = {
  obby: { complexity: "Low", monetization: "Skips, checkpoints, cosmetic trails, and game passes" },
  simulator: { complexity: "Medium", monetization: "Multiplier game passes, pets/eggs as developer products, rebirth boosts" },
  tycoon: { complexity: "Medium", monetization: "Auto-collect and multiplier passes, premium droppers" },
  rpg: { complexity: "High", monetization: "Inventory/slot expansions, cosmetics, battle pass" },
  shooter: { complexity: "High", monetization: "Weapon skins, battle pass, private servers" },
  horror: { complexity: "Medium", monetization: "Revives, cosmetics, chapter unlocks" },
  roleplay: { complexity: "Medium", monetization: "Vehicles, houses, cosmetic passes" },
  party: { complexity: "Low", monetization: "Cosmetics, emotes, VIP servers" },
  default: { complexity: "Medium", monetization: "Cosmetics, convenience passes, developer products" },
};

function profileFor(genre, pattern) {
  const key = `${genre} ${pattern}`.toLowerCase();
  for (const k of Object.keys(GENRE_PROFILES)) if (key.includes(k)) return GENRE_PROFILES[k];
  if (key.includes("role")) return GENRE_PROFILES.roleplay;
  return GENRE_PROFILES.default;
}

// Research engine: genre momentum, saturation, new-game traction and rising name patterns,
// combined into concept suggestions. Concepts are generated from the statistics and labelled as such.
export async function opportunityResearch(db) {
  const ms = await loadMetrics(db);
  const genreData = JSON.parse((await getMeta(db, "genre_metrics")) || '{"genres":[]}');
  const genres = genreData.genres.filter((g) => g.games >= 3);
  const patterns = namePatterns(ms);
  const scored = genres
    .map((g) => {
      const momentum = clamp((g.growth24 ?? 0) / 0.3, -1, 1);
      const openness = 1 - clamp(g.topShare, 0, 1);
      const traction = clamp(g.newGameShare / 0.5, 0, 1);
      const score = Math.round(100 * clamp(0.4 * Math.max(momentum, 0) + 0.3 * openness + 0.3 * traction, 0, 1) * Math.sqrt(g.confidence || 0));
      return { ...g, momentum, openness, traction, score };
    })
    .sort((a, b) => b.score - a.score);
  const concepts = [];
  for (const g of scored.slice(0, 5)) {
    const inGenre = ms.filter((m) => m.genre === g.genre).sort((a, b) => (b.growth24 ?? 0) - (a.growth24 ?? 0));
    const pat = patterns.find((p) => p.examples.some((e) => inGenre.some((m) => m.universeId === e.universeId))) || patterns[0];
    const prof = profileFor(g.genre, pat?.pattern || "");
    const risks = [];
    if (g.topShare > 0.5) risks.push(`One game holds ${(g.topShare * 100).toFixed(0)}% of observed players in ${g.genre}`);
    if ((g.growth7 ?? null) === null) risks.push("Less than 2 weeks of history: weekly trend not yet measurable");
    const spikes = inGenre.filter((m) => m.pattern === "spike").length;
    if (spikes) risks.push(`${spikes} game(s) in this genre show spike patterns that may not last`);
    if (g.games < 6) risks.push("Small sample of games in the tracked pool");
    concepts.push({
      title: `${pat ? pat.pattern[0].toUpperCase() + pat.pattern.slice(1) + " " : ""}${g.genre} concept`,
      genre: g.genre,
      pattern: pat?.pattern || null,
      explanation: `${g.genre} players changed ${fmtPct(g.growth24)} over 24h across ${g.games} observed games; new games (created <90 days) hold ${(g.newGameShare * 100).toFixed(0)}% of its players${pat ? `, and "${pat.pattern}" titles average ${fmtPct(pat.avgGrowth24)} 24h growth` : ""}.`,
      competitors: inGenre.slice(0, 5).map((m) => ({ universeId: m.universeId, name: m.name, current: m.current, growth24: m.growth24 })),
      stats: { players: g.playing, growth24: g.growth24, growth7: g.growth7, topShare: g.topShare, hhi: g.hhi, newGameShare: g.newGameShare },
      complexity: prof.complexity,
      monetization: prof.monetization,
      risks,
      confidence: +(g.confidence * (g.games >= 6 ? 1 : 0.7)).toFixed(2),
      label: "Generated suggestion based on observed statistics; not a prediction of success.",
    });
  }
  return { computedAt: genreData.computedAt, genres: scored, patterns: patterns.slice(0, 20), concepts };
}

export const fmtPct = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%` : "n/a");

export async function gameDetail(db, universeId, from, to) {
  const game = await first(db, "SELECT * FROM games WHERE universe_id = ?", universeId);
  if (!game) return null;
  const span = to - from;
  // Use the finest resolution that has enough points for a readable chart.
  const candidates = [];
  if (span <= 7 * DAY) candidates.push(["raw", () => all(db, "SELECT ts, playing, visits, favorites, up_votes, down_votes FROM game_snapshots WHERE universe_id = ? AND ts BETWEEN ? AND ? ORDER BY ts", universeId, from, to)]);
  if (span <= 21 * DAY) candidates.push(["hourly", () => all(db, "SELECT hour AS ts, ROUND(sum_playing * 1.0 / samples) AS playing, peak_playing AS peak, visits, favorites, up_votes, down_votes FROM game_hourly WHERE universe_id = ? AND hour BETWEEN ? AND ? ORDER BY hour", universeId, from, to)]);
  candidates.push(["daily", async () => (await all(db, "SELECT day, ROUND(avg_playing) AS playing, peak_playing AS peak, visits, favorites, up_votes, down_votes FROM game_daily WHERE universe_id = ? AND day BETWEEN ? AND ? ORDER BY day", universeId, dayKey(from), dayKey(to))).map((r) => ({ ...r, ts: Date.parse(r.day) }))]);
  let series = [];
  let resolution = "raw";
  for (const [name, load] of candidates) {
    const rows = await load();
    if (rows.length > series.length) {
      series = rows;
      resolution = name;
    }
    if (rows.length >= 24) break;
  }
  const daily = await all(db, "SELECT day, avg_playing, peak_playing, visits, favorites FROM game_daily WHERE universe_id = ? ORDER BY day DESC LIMIT 400", universeId);
  const metricsRow = await first(db, "SELECT data FROM game_metrics WHERE universe_id = ?", universeId);
  const changes = await all(db, "SELECT ts, field, old_value, new_value FROM game_changes WHERE universe_id = ? ORDER BY ts DESC LIMIT 100", universeId);
  const events = await all(db, "SELECT id, ts, kind, severity, summary, evidence FROM game_events WHERE universe_id = ? ORDER BY ts DESC LIMIT 50", universeId);
  const sightings = await all(db, "SELECT sort_id, first_ts, last_ts, best_position, last_position FROM discovery_sightings WHERE universe_id = ? ORDER BY last_ts DESC", universeId);
  const lists = await all(db, "SELECT l.id, l.name FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.target_id = ? AND l.kind = 'games'", universeId);
  const metrics = metricsRow ? JSON.parse(metricsRow.data) : null;
  const periodChange = (days) => {
    const d = daily.slice().reverse();
    if (d.length < days + 1) return null;
    const cur = d[d.length - 1];
    const prev = d[d.length - 1 - days];
    return { players: pctChange(cur.avg_playing, prev.avg_playing), visits: cur.visits - prev.visits, favorites: cur.favorites - prev.favorites };
  };
  return {
    game,
    metrics,
    series,
    resolution,
    changes: { day: periodChange(1), week: periodChange(7), month: periodChange(30) },
    daily: daily.slice(0, 60),
    updates: changes.filter((c) => c.field === "updated_at"),
    nameChanges: changes.filter((c) => c.field === "name"),
    events: events.map((e) => ({ ...e, evidence: e.evidence ? JSON.parse(e.evidence) : null })),
    sightings,
    lists,
  };
}

export async function compareSeries(db, ids, from, to) {
  const out = [];
  for (const id of ids.slice(0, 8)) {
    const g = await first(db, "SELECT universe_id, name FROM games WHERE universe_id = ?", id);
    if (!g) continue;
    const span = to - from;
    const rows = span <= 21 * DAY
      ? await all(db, "SELECT hour AS ts, ROUND(sum_playing * 1.0 / samples) AS playing FROM game_hourly WHERE universe_id = ? AND hour BETWEEN ? AND ? ORDER BY hour", id, from, to)
      : (await all(db, "SELECT day, ROUND(avg_playing) AS playing FROM game_daily WHERE universe_id = ? AND day BETWEEN ? AND ? ORDER BY day", id, dayKey(from), dayKey(to))).map((r) => ({ ts: Date.parse(r.day), playing: r.playing }));
    const m = await first(db, "SELECT data FROM game_metrics WHERE universe_id = ?", id);
    out.push({ universeId: id, name: g.name, series: rows, metrics: m ? JSON.parse(m.data) : null });
  }
  return out;
}

export async function itemMetrics(db, assetIds) {
  const t = now();
  const out = [];
  for (const id of assetIds) {
    const item = await first(db, "SELECT * FROM items WHERE asset_id = ?", id);
    if (!item) continue;
    const snaps = await all(db, "SELECT ts, lowest_resale_price AS price, units_available, favorites FROM item_snapshots WHERE asset_id = ? AND ts > ? ORDER BY ts", id, t - 31 * DAY);
    const priced = snaps.filter((s) => Number.isFinite(s.price) && s.price > 0);
    const latest = priced[priced.length - 1] || null;
    const at = (ms) => {
      let best = null;
      for (const s of priced) if (s.ts <= t - ms) best = s;
      return best;
    };
    const p24 = at(DAY);
    const p7 = at(7 * DAY);
    // Volatility: standard deviation of daily log returns of the lowest resale price we observed.
    const byDay = new Map();
    for (const s of priced) byDay.set(dayKey(s.ts), s.price);
    const dayPrices = [...byDay.values()];
    const rets = [];
    for (let i = 1; i < dayPrices.length; i++) rets.push(Math.log(dayPrices[i] / dayPrices[i - 1]));
    const vol = rets.length >= 3 ? stdev(rets) : null;
    const lastRet = latest && p24 ? Math.log(latest.price / p24.price) : null;
    const zMove = vol && lastRet !== null ? lastRet / Math.max(vol, 0.005) : null;
    out.push({
      assetId: id,
      name: item.name,
      icon: item.icon_url,
      creator: item.creator_name,
      restrictions: item.restrictions,
      totalQuantity: item.total_quantity,
      price: latest?.price ?? null,
      priceAt: latest?.ts ?? null,
      change24h: latest && p24 ? pctChange(latest.price, p24.price) : null,
      change7d: latest && p7 ? pctChange(latest.price, p7.price) : null,
      rap: item.rap,
      sales: item.sales,
      resalePointsThrough: item.resale_points_through,
      volatility: vol,
      unusual: zMove !== null && Math.abs(zMove) >= 3,
      zMove,
      observations: priced.length,
      lastCollectedAt: item.last_collected_at,
    });
  }
  return out;
}
