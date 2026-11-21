// Statistical reports built only from stored observations. Numbers come from the database;
// the optional AI narrative (Workers AI binding "AI") only rephrases those numbers.
import { all, first, getMeta, run } from "./db.js";
import { fmtPct, leaderboards, loadMetrics, opportunityResearch, itemMetrics } from "./analytics.js";
import { economyAnalytics, experienceAnalytics } from "./telemetry.js";
import { SOURCES } from "./roblox.js";
import { DAY, mean, now } from "./util.js";

export const REPORT_TYPES = {
  daily_market: "Daily Roblox market report",
  weekly_genre: "Weekly genre research",
  monthly_trends: "Monthly trend summary",
  competitor: "Competitor performance report",
  collectibles: "Collectible price change report",
  private_experience: "Private experience performance report",
  opportunities: "New business opportunity report",
};

const n = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");
const gameRow = (m) => ({ name: m.name, universeId: m.universeId, players: m.current, avg24: n(m.avg24), growth24: fmtPct(m.growth24), growth7: fmtPct(m.growth7), pattern: m.pattern, confidence: m.confidence });

async function coverage(db, from) {
  const r = await first(db, "SELECT MIN(hour) AS a, MAX(hour) AS b, COUNT(DISTINCT universe_id) AS games FROM game_hourly WHERE hour >= ?", from);
  return { from: r?.a || null, to: r?.b || null, games: r?.games || 0 };
}

function projection(m, days) {
  if (!Number.isFinite(m.growth7) || !Number.isFinite(m.avg7)) return null;
  const weekly = Math.max(-0.9, Math.min(m.growth7, 3));
  return Math.round(m.avg7 * (1 + weekly) ** (days / 7));
}

async function marketReport(db, periodDays) {
  const t = now();
  const lb = await leaderboards(db, { limit: 10 });
  const ms = await loadMetrics(db);
  const cov = await coverage(db, t - periodDays * DAY);
  const total = ms.reduce((s, m) => s + (m.current || 0), 0);
  const withPrev = ms.filter((m) => Number.isFinite(m.avgPrev24));
  const totalGrowth = withPrev.length ? (withPrev.reduce((s, m) => s + m.avg24, 0) - withPrev.reduce((s, m) => s + m.avgPrev24, 0)) / Math.max(withPrev.reduce((s, m) => s + m.avgPrev24, 0), 1) : null;
  const findings = [];
  if (lb.fastestGrowing[0]) findings.push(`Fastest growing: ${lb.fastestGrowing[0].name} at ${fmtPct(lb.fastestGrowing[0].score)} over 24h (${n(lb.fastestGrowing[0].current)} players now).`);
  if (lb.biggestDeclines[0]) findings.push(`Biggest decline: ${lb.biggestDeclines[0].name} at ${fmtPct(lb.biggestDeclines[0].score)}.`);
  if (lb.trendingGenres[0]) findings.push(`Top genre momentum: ${lb.trendingGenres[0].genre} at ${fmtPct(lb.trendingGenres[0].growth24)} across ${lb.trendingGenres[0].games} games.`);
  if (lb.unexpectedBreakouts.length) findings.push(`${lb.unexpectedBreakouts.length} unexpected breakout(s) above 2.5x their baseline or 3 sigma.`);
  const conf = mean(ms.map((m) => m.confidence)) || 0;
  return {
    stats: [
      { label: "Games in observed pool", value: n(ms.length) },
      { label: "Concurrent players across pool (latest)", value: n(total) },
      { label: "Pool 24h change (avg players)", value: fmtPct(totalGrowth) },
      { label: "Games with sustained growth", value: n(ms.filter((m) => m.pattern === "sustained growth").length) },
      { label: "Games flagged as spikes", value: n(ms.filter((m) => m.pattern === "spike").length) },
    ],
    sections: [
      { heading: "Fastest growing (24h)", table: lb.fastestGrowing.map(gameRow) },
      { heading: "Biggest declines (24h)", table: lb.biggestDeclines.map(gameRow) },
      { heading: "Unexpected breakouts", table: lb.unexpectedBreakouts.map(gameRow) },
      { heading: "New releases (created < 30 days)", table: lb.newReleases.map(gameRow) },
      { heading: "Trending genres", table: lb.trendingGenres.map((g) => ({ genre: g.genre, games: g.games, players: n(g.playing), growth24: fmtPct(g.growth24), growth7: fmtPct(g.growth7), topShare: `${(g.topShare * 100).toFixed(0)}%` })) },
    ],
    findings,
    predictions: lb.fastestGrowing.slice(0, 5).map((m) => ({ name: m.name, projected7d: projection(m, 7), basis: `7-day growth ${fmtPct(m.growth7)} extended one week` })).filter((p) => p.projected7d !== null),
    coverage: cov,
    confidence: +conf.toFixed(2),
    limitations: [
      "Covers only games Roblox surfaced in public discovery sorts plus games you track; it is not the whole platform.",
      "Concurrent players are point-in-time samples every 15-30 minutes, so short peaks between samples are missed.",
      "Total visits are lifetime counters and are reported separately from current player activity.",
      cov.from && t - cov.from < 7 * DAY ? "Less than 7 days of history: weekly metrics are incomplete." : null,
    ].filter(Boolean),
    actions: [
      lb.fastestGrowing[0] ? `Open ${lb.fastestGrowing[0].name} and check its recent update timeline to see what drove growth.` : null,
      lb.trendingGenres[0] ? `Review the ${lb.trendingGenres[0].genre} genre page for saturation before committing to a concept there.` : null,
      "Add games you want hourly detail on to a tracking list.",
    ].filter(Boolean),
  };
}

async function genreReport(db) {
  const research = await opportunityResearch(db);
  const g = research.genres;
  return {
    stats: [{ label: "Genres analysed", value: n(g.length) }, { label: "Name patterns analysed", value: n(research.patterns.length) }],
    sections: [
      { heading: "Genre momentum and saturation", table: g.map((x) => ({ genre: x.genre, games: x.games, players: n(x.playing), growth24: fmtPct(x.growth24), growth7: fmtPct(x.growth7), topShare: `${(x.topShare * 100).toFixed(0)}%`, newGameShare: `${(x.newGameShare * 100).toFixed(0)}%`, score: x.score })) },
      { heading: "Rising title patterns", table: research.patterns.map((p) => ({ pattern: p.pattern, games: p.games, players: n(p.playing), avgGrowth24: fmtPct(p.avgGrowth24), growingShare: `${(p.growingShare * 100).toFixed(0)}%` })) },
    ],
    findings: g.slice(0, 3).map((x) => `${x.genre}: opportunity score ${x.score}, ${fmtPct(x.growth24)} 24h, top game holds ${(x.topShare * 100).toFixed(0)}% of players.`),
    predictions: [],
    coverage: { from: research.computedAt, to: research.computedAt },
    confidence: +(mean(g.map((x) => x.confidence)) || 0).toFixed(2),
    limitations: ["Genres use Roblox's genre_l1 labels, which some games do not set accurately.", "Saturation is measured within the observed pool only."],
    actions: g[0] ? [`Study the top 3 games in ${g[0].genre} for shared mechanics.`] : [],
  };
}

async function competitorReport(db, options) {
  const ids = options.universeId
    ? [Number(options.universeId)]
    : (await all(db, "SELECT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'games' AND l.name = 'Competitors'")).map((r) => r.id);
  const ms = (await loadMetrics(db)).filter((m) => ids.includes(m.universeId));
  const events = ids.length ? await all(db, `SELECT e.universe_id, e.ts, e.summary, e.evidence, g.name FROM game_events e JOIN games g ON g.universe_id = e.universe_id WHERE e.universe_id IN (${ids.map(() => "?").join(",")}) AND e.ts > ? ORDER BY e.ts DESC`, ...ids, now() - 7 * DAY) : [];
  const updates = ids.length ? await all(db, `SELECT c.universe_id, c.ts, c.new_value, g.name FROM game_changes c JOIN games g ON g.universe_id = c.universe_id WHERE c.field = 'updated_at' AND c.universe_id IN (${ids.map(() => "?").join(",")}) AND c.ts > ? ORDER BY c.ts DESC`, ...ids, now() - 30 * DAY) : [];
  const total = ms.reduce((s, m) => s + (m.current || 0), 0);
  return {
    stats: [{ label: "Competitors tracked", value: n(ids.length) }, { label: "Combined concurrent players", value: n(total) }, { label: "Updates observed (30d)", value: n(updates.length) }],
    sections: [
      { heading: "Performance", table: ms.sort((a, b) => b.current - a.current).map((m) => ({ ...gameRow(m), share: total ? `${((m.current / total) * 100).toFixed(1)}%` : "n/a", visitsPerHour: n(m.visitsPerHour), likeRatio: m.likeRatio !== null ? `${(m.likeRatio * 100).toFixed(1)}%` : "n/a" })) },
      { heading: "Update timeline (30d)", table: updates.map((u) => ({ game: u.name, observed: new Date(u.ts).toISOString(), robloxUpdated: u.new_value })) },
      { heading: "Major changes (7d)", items: events.map((e) => { const ev = JSON.parse(e.evidence || "{}"); return { title: `${e.name}: ${e.summary}`, observed: ev.observed, inferred: ev.inferred, inferredLabel: ev.inferredLabel }; }) },
    ],
    findings: ms.filter((m) => Math.abs(m.growth24 ?? 0) > 0.2).map((m) => `${m.name} moved ${fmtPct(m.growth24)} in 24h.`),
    predictions: ms.map((m) => ({ name: m.name, projected7d: projection(m, 7), basis: `7-day growth ${fmtPct(m.growth7)} extended one week` })).filter((p) => p.projected7d !== null),
    coverage: await coverage(db, now() - 7 * DAY),
    confidence: +(mean(ms.map((m) => m.confidence)) || 0).toFixed(2),
    limitations: ["Explanations for changes are inferred from public signals and labelled as such.", "Revenue and retention of competitors are not publicly available and are not estimated."],
    actions: ids.length ? ["Compare update cadence against your own release schedule."] : ["Add games to the Competitors list to populate this report."],
  };
}

async function collectiblesReport(db) {
  const ids = (await all(db, "SELECT DISTINCT li.target_id AS id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.kind = 'items'")).map((r) => r.id);
  const ms = await itemMetrics(db, ids);
  const moved = ms.filter((m) => m.change24h !== null).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  return {
    stats: [{ label: "Items watched", value: n(ms.length) }, { label: "Unusual moves", value: n(ms.filter((m) => m.unusual).length) }],
    sections: [{ heading: "Price changes", table: moved.map((m) => ({ item: m.name, lowestResale: n(m.price), change24h: fmtPct(m.change24h), change7d: fmtPct(m.change7d), volatility: m.volatility !== null ? `${(m.volatility * 100).toFixed(1)}%/day` : "n/a", rap: n(m.rap), unusual: m.unusual ? "yes" : "" })) }],
    findings: moved.slice(0, 3).map((m) => `${m.name}: ${fmtPct(m.change24h)} in 24h (lowest resale ${n(m.price)} R$).`),
    predictions: [],
    coverage: { from: Math.min(...ms.map((m) => m.priceAt || Infinity)), to: Math.max(...ms.map((m) => m.priceAt || 0)) },
    confidence: ms.length ? +Math.min(1, mean(ms.map((m) => m.observations)) / 48).toFixed(2) : 0,
    limitations: ["Prices are the lowest listed resale price at each sample, not completed sale prices.", "Roblox's public resale history (RAP, sales) can lag or stop updating; its last data point date is shown per item.", "Trade volume and liquidity are not available and are not estimated."],
    actions: ms.length ? [] : ["Add items to the Watchlist to populate this report."],
  };
}

async function experienceReport(db, options) {
  const exp = options.experienceId ? await first(db, "SELECT * FROM experiences WHERE id = ?", options.experienceId) : await first(db, "SELECT * FROM experiences ORDER BY id LIMIT 1");
  if (!exp) return { stats: [], sections: [], findings: ["No connected experiences."], predictions: [], coverage: {}, confidence: 0, limitations: [], actions: ["Connect an experience under My Experiences."] };
  const t = now();
  const a = await experienceAnalytics(db, exp.id, t - 7 * DAY, t);
  const e = await economyAnalytics(db, exp.id, t - 7 * DAY, t);
  const s = a.summary;
  return {
    stats: [
      { label: "Users (7d)", value: n(s.users) }, { label: "Avg DAU", value: n(s.avgDau) }, { label: "Avg session (min)", value: s.avgSessionSec ? (s.avgSessionSec / 60).toFixed(1) : "n/a" },
      { label: "Revenue (R$)", value: n(s.revenue) }, { label: "Conversion", value: s.conversion !== null ? `${(s.conversion * 100).toFixed(2)}%` : "n/a" }, { label: "ARPPU (R$)", value: n(s.arppu) },
    ],
    sections: [
      { heading: "Daily", table: a.daily.map((d) => ({ day: d.day, dau: d.dau, newUsers: d.newUsers, revenue: d.revenue, payers: d.payers })) },
      { heading: "Retention", table: a.retention.map((r) => ({ cohort: r.cohort, size: r.size, d1: r.d1 !== null ? `${(r.d1 * 100).toFixed(0)}%` : "", d7: r.d7 !== null ? `${(r.d7 * 100).toFixed(0)}%` : "" })) },
      { heading: "Products", table: a.products },
      { heading: "Economy recommendations", items: e.recommendations.map((r) => ({ title: r.text })) },
    ],
    findings: [`${exp.name || exp.universe_id}: ${n(s.users)} users and ${n(s.revenue)} R$ tracked purchases in 7 days.`],
    predictions: [],
    coverage: { from: t - 7 * DAY, to: exp.last_event_at },
    confidence: s.users > 100 ? 0.8 : s.users > 10 ? 0.5 : 0.2,
    limitations: ["Based only on telemetry your experience sends; events lost in transit are not counted.", "Revenue counts purchases your scripts reported, before Roblox's fees."],
    actions: e.recommendations.map((r) => r.text).slice(0, 3),
  };
}

async function opportunityReport(db) {
  const r = await opportunityResearch(db);
  return {
    stats: [{ label: "Genres scored", value: n(r.genres.length) }, { label: "Concepts generated", value: n(r.concepts.length) }],
    sections: [{ heading: "Concepts (generated from statistics)", items: r.concepts.map((c) => ({ title: `${c.title} (confidence ${c.confidence})`, observed: [c.explanation, `Competitors: ${c.competitors.map((x) => `${x.name} (${n(x.current)})`).join(", ")}`, `Complexity: ${c.complexity}. Monetization: ${c.monetization}`], inferred: c.risks, inferredLabel: "Risks" })) }],
    findings: r.genres.slice(0, 3).map((g) => `${g.genre}: score ${g.score}`),
    predictions: [],
    coverage: { from: r.computedAt, to: r.computedAt },
    confidence: +(mean(r.concepts.map((c) => c.confidence)) || 0).toFixed(2),
    limitations: ["Concepts are suggestions derived from observed patterns, not forecasts of success.", "Monetization of other games is not publicly observable; suggested models are genre conventions."],
    actions: r.concepts[0] ? [`Prototype a vertical slice of "${r.concepts[0].title}" and track the listed competitors.`] : [],
  };
}

const SOURCES_BY_TYPE = {
  default: [SOURCES.games, SOURCES.votes, SOURCES.explore],
  collectibles: [SOURCES.catalogDetails, SOURCES.resale],
  private_experience: ["Your experience's telemetry (/stats/ingest)"],
};

async function aiNarrative(env, report) {
  if (!env.AI) return null;
  try {
    const facts = JSON.stringify({ stats: report.stats, findings: report.findings, limitations: report.limitations }).slice(0, 6000);
    const res = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "Summarise the report facts in 3-5 sentences. Use only numbers present in the facts. Do not add new numbers, causes or predictions." },
        { role: "user", content: facts },
      ],
      max_tokens: 300,
    });
    return res?.response || null;
  } catch {
    return null;
  }
}

export async function generateReport(env, db, type, options = {}) {
  if (!REPORT_TYPES[type]) throw new Error(`Unknown report type ${type}`);
  const t = now();
  const builders = {
    daily_market: () => marketReport(db, 1),
    weekly_genre: () => genreReport(db),
    monthly_trends: () => marketReport(db, 30),
    competitor: () => competitorReport(db, options),
    collectibles: () => collectiblesReport(db),
    private_experience: () => experienceReport(db, options),
    opportunities: () => opportunityReport(db),
  };
  const body = await builders[type]();
  body.sources = SOURCES_BY_TYPE[type] || SOURCES_BY_TYPE.default;
  body.generatedAt = t;
  body.narrative = await aiNarrative(env, body);
  if (body.narrative) body.narrativeLabel = "AI-written summary of the statistics above; check numbers against the tables.";
  const title = `${REPORT_TYPES[type]} - ${new Date(t).toISOString().slice(0, 10)}`;
  const row = await db.prepare("INSERT INTO reports (type, title, created_at, period_start, period_end, confidence, body) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").bind(type, title, t, body.coverage?.from || null, body.coverage?.to || null, body.confidence ?? null, JSON.stringify(body)).first();
  return { id: row.id, title };
}
