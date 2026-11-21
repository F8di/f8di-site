// Telemetry sent by the owner's own Roblox experiences (HttpService), plus analytics built on it.
import { all, batch, first, run } from "./db.js";
import { DAY, HttpError, dayKey, mean, median, now, randomToken, safeEqual, sha256Hex, stdev } from "./util.js";

const TYPES = new Set(["session_start", "session_end", "purchase", "currency", "item", "progress", "error", "perf", "custom"]);
const MAX_EVENTS = 200;
const MAX_BODY = 128 * 1024;
const RATE_PER_MIN = 120;

export async function createExperience(env, db, { universeId, name }) {
  const ingestKey = `exp_${randomToken(9)}`;
  const token = randomToken(32);
  await run(db, "INSERT INTO experiences (universe_id, name, ingest_key, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", universeId, name || null, ingestKey, await sha256Hex(`${env.STATS_SESSION_SECRET}|ingest|${token}`), now());
  return { ingestKey, token };
}

export async function rotateToken(env, db, id) {
  const token = randomToken(32);
  await run(db, "UPDATE experiences SET token_hash = ? WHERE id = ?", await sha256Hex(`${env.STATS_SESSION_SECRET}|ingest|${token}`), id);
  return token;
}

async function rateLimit(db, key, limit) {
  const t = now();
  const win = Math.floor(t / 60_000) * 60_000;
  const row = await db
    .prepare("INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count")
    .bind(key, win)
    .first();
  return (row?.count || 0) <= limit;
}

export async function ingest(env, db, request) {
  const key = request.headers.get("X-Experience-Key") || "";
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^exp_[A-Za-z0-9_-]{8,20}$/.test(key) || auth.length < 32) throw new HttpError(401, "Unauthorized");
  const exp = await first(db, "SELECT id, token_hash FROM experiences WHERE ingest_key = ?", key);
  const hash = await sha256Hex(`${env.STATS_SESSION_SECRET}|ingest|${auth}`);
  if (!exp || !safeEqual(hash, exp.token_hash)) throw new HttpError(401, "Unauthorized");
  if (!(await rateLimit(db, `ingest:${exp.id}`, RATE_PER_MIN))) throw new HttpError(429, "Rate limited");
  const len = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (len > MAX_BODY) throw new HttpError(413, "Payload too large");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Payload too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  const received = Array.isArray(body?.events) ? body.events : [];
  if (received.length > MAX_EVENTS) throw new HttpError(413, `At most ${MAX_EVENTS} events per request`);
  const events = received;
  const t = now();
  const str = (v, n = 80) => (v === undefined || v === null ? null : String(v).slice(0, n));
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const stmts = [];
  for (const e of events) {
    if (!TYPES.has(e?.type)) continue;
    const ts = Number.isFinite(e.ts) && Math.abs(e.ts * 1000 - t) < 2 * DAY ? Math.round(e.ts * 1000) : t;
    // Player ids are pseudonymised before storage.
    const player = e.player !== undefined ? (await sha256Hex(`${env.STATS_SESSION_SECRET}|player|${exp.id}|${e.player}`)).slice(0, 16) : null;
    stmts.push(
      db.prepare("INSERT INTO telemetry_events (experience_id, ts, type, player, session, name, amount, currency, source, rarity, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        exp.id, ts, e.type, player, str(e.session, 40), str(e.name, 120), num(e.amount ?? e.value), str(e.currency, 40), str(e.source, 80), str(e.rarity, 40), e.data ? JSON.stringify(e.data).slice(0, 1000) : null
      )
    );
  }
  await batch(db, stmts);
  await run(db, "UPDATE experiences SET last_event_at = ? WHERE id = ?", t, exp.id);
  return { accepted: stmts.length, dropped: events.length - stmts.length };
}

async function events(db, expId, type, from, to) {
  return all(db, "SELECT ts, player, session, name, amount, currency, source, rarity, data FROM telemetry_events WHERE experience_id = ? AND type = ? AND ts BETWEEN ? AND ? ORDER BY ts", expId, type, from, to);
}

export async function experienceAnalytics(db, expId, from, to) {
  const starts = await events(db, expId, "session_start", from - 30 * DAY, to);
  const ends = await events(db, expId, "session_end", from, to);
  const purchases = await events(db, expId, "purchase", from, to);
  const errors = await events(db, expId, "error", from, to);
  const perf = await events(db, expId, "perf", from, to);
  const custom = await events(db, expId, "custom", from, to);

  const dau = new Map();
  // First-ever session per player, over all history, so returning players aren't counted as new.
  const firstRows = await all(db, "SELECT player, MIN(ts) AS ts FROM telemetry_events WHERE experience_id = ? AND type = 'session_start' AND ts <= ? GROUP BY player", expId, to);
  const firstSeen = new Map(firstRows.map((r) => [r.player, dayKey(r.ts)]));
  const activeDays = new Map();
  for (const s of starts) {
    const d = dayKey(s.ts);
    (activeDays.get(s.player) || activeDays.set(s.player, new Set()).get(s.player)).add(d);
    if (s.ts >= from) (dau.get(d) || dau.set(d, new Set()).get(d)).add(s.player);
  }
  const revenue = new Map();
  const payers = new Map();
  const products = new Map();
  for (const p of purchases) {
    const d = dayKey(p.ts);
    revenue.set(d, (revenue.get(d) || 0) + (p.amount || 0));
    (payers.get(d) || payers.set(d, new Set()).get(d)).add(p.player);
    const kind = p.source || "product";
    const k = `${kind}:${p.name || "unknown"}`;
    const pr = products.get(k) || { kind, name: p.name || "unknown", purchases: 0, robux: 0, buyers: new Set() };
    pr.purchases++;
    pr.robux += p.amount || 0;
    pr.buyers.add(p.player);
    products.set(k, pr);
  }
  // Every calendar day from the first day with data to the end of the range, so inactive days count as zero.
  const seenDays = [...new Set([...dau.keys(), ...revenue.keys()])].sort();
  const days = [];
  if (seenDays.length) for (let t = Date.parse(seenDays[0]); t <= Math.min(to, Date.now()); t += DAY) days.push(dayKey(t));
  const daily = days.map((d) => {
    const users = dau.get(d)?.size || 0;
    const pay = payers.get(d)?.size || 0;
    const rev = revenue.get(d) || 0;
    return { day: d, dau: users, payers: pay, revenue: rev, conversion: users ? pay / users : null, arppu: pay ? rev / pay : null, newUsers: [...firstSeen.values()].filter((x) => x === d).length };
  });
  const retention = [];
  const cohorts = new Map();
  for (const [player, d] of firstSeen) if (Date.parse(d) >= from - 30 * DAY && activeDays.has(player)) (cohorts.get(d) || cohorts.set(d, []).get(d)).push(player);
  for (const [d, players] of [...cohorts].sort()) {
    const r = { cohort: d, size: players.length };
    for (const n of [1, 7, 30]) {
      const target = dayKey(Date.parse(d) + n * DAY);
      r[`d${n}`] = Date.parse(target) > to ? null : players.filter((p) => activeDays.get(p)?.has(target)).length / players.length;
    }
    retention.push(r);
  }
  const durations = ends.map((e) => e.amount).filter((x) => Number.isFinite(x) && x > 0 && x < 86400);
  const errorTop = new Map();
  for (const e of errors) errorTop.set(e.name, (errorTop.get(e.name) || 0) + 1);
  const perfBy = new Map();
  for (const p of perf) (perfBy.get(p.name) || perfBy.set(p.name, []).get(p.name)).push(p.amount);
  const customBy = new Map();
  for (const c of custom) {
    const x = customBy.get(c.name) || { name: c.name, count: 0, sum: 0, players: new Set() };
    x.count++;
    x.sum += c.amount || 0;
    x.players.add(c.player);
    customBy.set(c.name, x);
  }
  const totalUsers = new Set(starts.filter((s) => s.ts >= from).map((s) => s.player)).size;
  const totalRevenue = purchases.reduce((s, p) => s + (p.amount || 0), 0);
  const totalPayers = new Set(purchases.map((p) => p.player)).size;
  return {
    summary: {
      users: totalUsers,
      avgDau: mean(daily.map((d) => d.dau)),
      sessions: starts.filter((s) => s.ts >= from).length,
      avgSessionSec: mean(durations),
      medianSessionSec: median(durations),
      revenue: totalRevenue,
      payers: totalPayers,
      conversion: totalUsers ? totalPayers / totalUsers : null,
      arppu: totalPayers ? totalRevenue / totalPayers : null,
      sessionsPerUser: totalUsers ? starts.filter((s) => s.ts >= from).length / totalUsers : null,
      errors: errors.length,
    },
    daily,
    retention,
    products: [...products.values()].map((p) => ({ kind: p.kind, name: p.name, purchases: p.purchases, robux: p.robux, buyers: p.buyers.size })).sort((a, b) => b.robux - a.robux),
    errors: [...errorTop].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 25),
    perf: [...perfBy].map(([name, v]) => ({ name, avg: mean(v), p95: v.sort((a, b) => a - b)[Math.floor(v.length * 0.95)] ?? null, samples: v.length })),
    custom: [...customBy.values()].map((c) => ({ name: c.name, count: c.count, sum: c.sum, players: c.players.size })).sort((a, b) => b.count - a.count),
  };
}

export async function economyAnalytics(db, expId, from, to) {
  const cur = await events(db, expId, "currency", from, to);
  const items = await events(db, expId, "item", from, to);
  const progress = await events(db, expId, "progress", from, to);
  const byCurrency = new Map();
  const perPlayerDay = new Map();
  for (const e of cur) {
    const c = byCurrency.get(e.currency || "default") || { currency: e.currency || "default", earned: 0, spent: 0, sources: new Map(), sinks: new Map(), daily: new Map() };
    const amt = e.amount || 0;
    const d = dayKey(e.ts);
    const dd = c.daily.get(d) || { day: d, earned: 0, spent: 0 };
    if (amt >= 0) {
      c.earned += amt;
      dd.earned += amt;
      c.sources.set(e.source || "unknown", (c.sources.get(e.source || "unknown") || 0) + amt);
      const k = `${c.currency}|${e.player}|${d}`;
      perPlayerDay.set(k, (perPlayerDay.get(k) || 0) + amt);
    } else {
      c.spent += -amt;
      dd.spent += -amt;
      c.sinks.set(e.source || "unknown", (c.sinks.get(e.source || "unknown") || 0) - amt);
    }
    c.daily.set(d, dd);
    byCurrency.set(c.currency, c);
  }
  const currencies = [];
  const recommendations = [];
  const anomalies = [];
  for (const c of byCurrency.values()) {
    const ratio = c.spent ? c.earned / c.spent : null;
    currencies.push({
      currency: c.currency, earned: c.earned, spent: c.spent, netFlow: c.earned - c.spent, earnSpendRatio: ratio,
      sources: [...c.sources].map(([name, v]) => ({ name, amount: v })).sort((a, b) => b.amount - a.amount),
      sinks: [...c.sinks].map(([name, v]) => ({ name, amount: v })).sort((a, b) => b.amount - a.amount),
      daily: [...c.daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    });
    if (ratio !== null && ratio > 1.5) recommendations.push({ severity: "warning", text: `${c.currency}: players earn ${ratio.toFixed(2)}x what they spend. Add sinks or reduce top source "${[...c.sources].sort((a, b) => b[1] - a[1])[0]?.[0]}" to slow inflation.` });
    if (ratio !== null && ratio < 0.7) recommendations.push({ severity: "info", text: `${c.currency}: spending exceeds earning (${ratio.toFixed(2)}x). Players may be draining savings; check progression pacing.` });
    const vals = [...perPlayerDay].filter(([k]) => k.startsWith(`${c.currency}|`)).map(([k, v]) => ({ k, v }));
    const m = mean(vals.map((x) => x.v));
    const sd = stdev(vals.map((x) => x.v));
    if (sd && vals.length >= 20) for (const x of vals) if ((x.v - m) / sd > 4) anomalies.push({ currency: c.currency, player: x.k.split("|")[1], day: x.k.split("|")[2], earned: x.v, zScore: (x.v - m) / sd });
  }
  if (anomalies.length) recommendations.push({ severity: "warning", text: `${anomalies.length} player-day(s) earned more than 4 standard deviations above normal. Review for exploits.` });
  const itemAgg = new Map();
  const rarity = new Map();
  for (const e of items) {
    const name = e.name || "unknown";
    const x = itemAgg.get(name) || { name, created: 0, consumed: 0 };
    const q = Math.abs(e.amount || 1);
    if ((e.source || "create") === "consume") x.consumed += q;
    else {
      x.created += q;
      if (e.rarity) rarity.set(e.rarity, (rarity.get(e.rarity) || 0) + q);
    }
    itemAgg.set(name, x);
  }
  const prog = new Map();
  for (const p of progress) {
    const d = dayKey(p.ts);
    const x = prog.get(d) || { day: d, values: [] };
    x.values.push(p.amount || 0);
    prog.set(d, x);
  }
  const progression = [...prog.values()].sort((a, b) => a.day.localeCompare(b.day)).map((x) => ({ day: x.day, avg: mean(x.values), max: Math.max(...x.values), events: x.values.length }));
  if (progression.length >= 3) {
    const first = progression[0].avg;
    const last = progression[progression.length - 1].avg;
    if (first && last / first > 3) recommendations.push({ severity: "info", text: `Average progression value rose ${(last / first).toFixed(1)}x over the period. Check that content depth keeps up.` });
  }
  return {
    currencies,
    items: [...itemAgg.values()].sort((a, b) => b.created - a.created).slice(0, 50),
    rarity: [...rarity].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    progression,
    anomalies: anomalies.sort((a, b) => b.zScore - a.zScore).slice(0, 50),
    recommendations,
    eventCount: cur.length + items.length + progress.length,
  };
}
