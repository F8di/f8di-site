// "Connect Roblox account": Roblox OAuth 2.0 (authorization code + PKCE) and import of the official
// Analytics Query API metrics for the owner's own experiences. Tokens are stored AES-GCM encrypted in D1.
import { all, first, getMeta, run, setMeta } from "./db.js";
import { DAY, HttpError, b64decode, b64url, now, randomToken, safeEqual, sha256Hex } from "./util.js";

const AUTHORIZE_URL = "https://apis.roblox.com/oauth/v1/authorize";
const TOKEN_URL = "https://apis.roblox.com/oauth/v1/token";
const REVOKE_URL = "https://apis.roblox.com/oauth/v1/token/revoke";
const RESOURCES_URL = "https://apis.roblox.com/oauth/v1/token/resources";
const USERINFO_URL = "https://apis.roblox.com/oauth/v1/userinfo";
const QUERY_URL = "https://apis.roblox.com/analytics-query-api/v1/universes/{universeId}/metrics";
const QUERY_BASE = "https://apis.roblox.com/analytics-query-api/";
export const STATE_COOKIE = "__Host-f8di_roblox_state";
const DEFAULT_SCOPES = "openid profile universe.analytics:read";

// Metric names from https://create.roblox.com/docs/cloud/guides/analytics/metrics (OneDay granularity).
export const OFFICIAL_METRICS = {
  DailyActiveUsers: "Daily active users",
  MonthlyActiveUsers: "Monthly active users",
  Visits: "Sessions",
  AverageSessionLengthMinutes: "Average session (min)",
  AveragePlayTimeMinutesPerDAU: "Playtime per DAU (min)",
  TotalPlayTimeHours: "Total playtime (h)",
  ForwardD1Retention: "D1 retention",
  ForwardD7Retention: "D7 retention",
  ForwardD30Retention: "D30 retention",
  DailyRevenue: "Revenue (R$)",
  PayingUsers: "Paying users",
  AverageRevenuePerPayingUser: "ARPPU (R$)",
  PayingUsersCVR: "Payer conversion",
  PeakConcurrentPlayers: "Peak concurrent players",
};
const SHORT_HISTORY = new Set(["PeakConcurrentPlayers"]); // performance metrics keep 28 days

export function oauthConfig(env) {
  return { ok: !!(env.ROBLOX_OAUTH_CLIENT_ID && env.ROBLOX_OAUTH_CLIENT_SECRET), clientId: env.ROBLOX_OAUTH_CLIENT_ID, clientSecret: env.ROBLOX_OAUTH_CLIENT_SECRET, scopes: env.ROBLOX_OAUTH_SCOPES || DEFAULT_SCOPES };
}

// ---------- encryption ----------
async function aesKey(env) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STATS_SESSION_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("f8di-stats"), info: new TextEncoder().encode("roblox-oauth-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(JSON.stringify(obj)));
  return `${b64url(iv)}.${b64url(ct)}`;
}
async function open(env, sealed) {
  if (!sealed) return null;
  try {
    const [iv, ct] = sealed.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, await aesKey(env), b64decode(ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null; // secret rotated or tampered: treat as disconnected
  }
}

// ---------- OAuth flow ----------
async function tokenRequest(env, params) {
  const cfg = oauthConfig(env);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Roblox token endpoint: HTTP ${res.status} ${data.error || ""} ${data.error_description || ""}`.trim());
  return data;
}

export async function startConnect(env, db, origin) {
  const cfg = oauthConfig(env);
  if (!cfg.ok) throw new HttpError(400, "ROBLOX_OAUTH_CLIENT_ID and ROBLOX_OAUTH_CLIENT_SECRET are not configured");
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const redirectUri = `${origin}/stats/roblox/callback`;
  await setMeta(db, "roblox_oauth_pending", await seal(env, { stateHash: await sha256Hex(state), verifier, redirectUri, exp: now() + 10 * 60_000 }));
  const p = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scopes, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "consent" });
  return { url: `${AUTHORIZE_URL}?${p}`, state };
}

// The callback arrives as a cross-site navigation, so the SameSite=Strict session cookie is absent.
// It is authorised by the one-time state that only a signed-in owner could create, bound to this browser by a Lax cookie.
export async function finishConnect(env, db, url, stateCookie) {
  const pending = await open(env, await getMeta(db, "roblox_oauth_pending"));
  const state = url.searchParams.get("state") || "";
  if (!pending || pending.exp < now() || !stateCookie || !safeEqual(state, stateCookie) || !safeEqual(await sha256Hex(state), pending.stateHash)) {
    throw new HttpError(400, "This Roblox sign-in link expired or was already used. Start again from Settings.");
  }
  // One-time use: only the request that wins this delete may redeem the code.
  const claimed = await run(db, "DELETE FROM meta WHERE key = 'roblox_oauth_pending'");
  if (!(claimed.meta?.changes > 0)) throw new HttpError(400, "This Roblox sign-in link was already used. Start again from Settings.");
  if (url.searchParams.get("error")) throw new HttpError(400, `Roblox sign-in was cancelled (${url.searchParams.get("error")}).`);
  const tokens = await tokenRequest(env, { grant_type: "authorization_code", code: url.searchParams.get("code") || "", code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
  const user = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(12_000) }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  await saveTokens(env, db, tokens, { id: user.sub || null, username: user.preferred_username || null, displayName: user.nickname || user.name || null });
  await refreshResources(env, db).catch(() => {});
  return user;
}

async function saveTokens(env, db, tokens, user) {
  const prev = (await loadAccount(env, db)) || {};
  const account = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || prev.refreshToken,
    accessExpiresAt: now() + (Number(tokens.expires_in) || 900) * 1000,
    refreshExpiresAt: tokens.refresh_token ? now() + 90 * DAY : prev.refreshExpiresAt,
    scope: tokens.scope || prev.scope || "",
    user: user || prev.user || {},
    connectedAt: prev.connectedAt || now(),
    universes: prev.universes || [],
  };
  await setMeta(db, "roblox_oauth", await seal(env, account));
  return account;
}

async function loadAccount(env, db) {
  return open(env, await getMeta(db, "roblox_oauth"));
}

// Refresh tokens are single-use, so only one request may refresh at a time.
export async function accessToken(env, db) {
  for (let i = 0; i < 6; i++) {
    const acc = await loadAccount(env, db);
    if (!acc) return null;
    if (acc.accessExpiresAt - now() > 60_000) return acc.accessToken;
    await run(db, "INSERT OR IGNORE INTO meta (key, value) VALUES ('roblox_oauth_lock', '0')");
    const lock = await run(db, "UPDATE meta SET value = ? WHERE key = 'roblox_oauth_lock' AND CAST(value AS INTEGER) < ?", String(now()), now() - 30_000);
    if ((lock.meta?.changes || 0) > 0) {
      try {
        const fresh = await loadAccount(env, db); // another caller may have refreshed before we got the lock
        if (!fresh) return null;
        if (fresh.accessExpiresAt - now() > 60_000) return fresh.accessToken;
        acc.refreshToken = fresh.refreshToken;
        const tokens = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: acc.refreshToken });
        return (await saveTokens(env, db, tokens, acc.user)).accessToken;
      } catch (e) {
        await setMeta(db, "roblox_oauth_error", String(e.message).slice(0, 300));
        throw e;
      } finally {
        await run(db, "UPDATE meta SET value = '0' WHERE key = 'roblox_oauth_lock'");
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new HttpError(503, "Roblox token refresh is already in progress; try again shortly");
}

export async function refreshResources(env, db) {
  const cfg = oauthConfig(env);
  const token = await accessToken(env, db);
  if (!token) return [];
  const res = await fetch(RESOURCES_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, client_id: cfg.clientId, client_secret: cfg.clientSecret }), signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new HttpError(502, `Roblox token resources: HTTP ${res.status}`);
  const data = await res.json();
  const ids = [...new Set((data.resource_infos || []).flatMap((r) => r.resources?.universe?.ids || []).filter((x) => /^\d+$/.test(x)).map(Number))];
  const acc = await loadAccount(env, db);
  if (acc) await setMeta(db, "roblox_oauth", await seal(env, { ...acc, universes: ids }));
  return ids;
}

export async function disconnect(env, db) {
  const acc = await loadAccount(env, db);
  const cfg = oauthConfig(env);
  if (acc?.refreshToken && cfg.ok) {
    await fetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: acc.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }), signal: AbortSignal.timeout(12_000) }).catch(() => {});
  }
  await run(db, "DELETE FROM meta WHERE key IN ('roblox_oauth', 'roblox_oauth_pending', 'roblox_oauth_error')");
}

export async function accountStatus(env, db) {
  const cfg = oauthConfig(env);
  const acc = await loadAccount(env, db);
  return {
    configured: cfg.ok,
    connected: !!acc,
    user: acc?.user || null,
    scope: acc?.scope || null,
    universes: acc?.universes || [],
    connectedAt: acc?.connectedAt || null,
    refreshExpiresAt: acc?.refreshExpiresAt || null,
    apiKeyFallback: !!env.ROBLOX_OPEN_CLOUD_KEY,
    lastSyncAt: Number(await getMeta(db, "official_sync_at")) || null,
    lastError: (await getMeta(db, "roblox_oauth_error")) || null,
  };
}

// ---------- Analytics Query API ----------
async function analyticsFetch(url, auth, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...auth, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) {
    const e = new HttpError(res.status === 429 ? 429 : 502, `analytics ${res.status}: ${text.slice(0, 200)}`);
    e.upstream = res.status;
    throw e;
  }
  return JSON.parse(text || "{}");
}

async function queryMetric(auth, universeId, metric, startTime, endTime) {
  let op = await analyticsFetch(QUERY_URL.replace("{universeId}", universeId), auth, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metric, granularity: "OneDay", startTime, endTime }),
  });
  for (let i = 0; !op.done && op.path && i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    op = await analyticsFetch(QUERY_BASE + op.path.replace(/^\//, ""), auth);
  }
  if (!op.done) throw new HttpError(503, `analytics query for ${metric} is still running; it will be retried`);
  if (op.error) throw new HttpError(502, `analytics query for ${metric} failed: ${JSON.stringify(op.error).slice(0, 200)}`);
  return (op.response?.values?.[0]?.dataPoints || []).filter((p) => p.time && Number.isFinite(Number(p.value))).map((p) => ({ day: p.time.slice(0, 10), value: Number(p.value) }));
}

async function credentialsFor(env, db, universeId) {
  const out = [];
  const acc = await loadAccount(env, db);
  if (acc && (!acc.universes.length || acc.universes.includes(Number(universeId)))) {
    const token = await accessToken(env, db).catch(() => null);
    if (token) out.push({ source: "oauth", auth: { Authorization: `Bearer ${token}` } });
  }
  if (env.ROBLOX_OPEN_CLOUD_KEY) out.push({ source: "api_key", auth: { "x-api-key": env.ROBLOX_OPEN_CLOUD_KEY } });
  return out;
}

export async function hasOfficialCredentials(env, db) {
  return !!env.ROBLOX_OPEN_CLOUD_KEY || !!(await getMeta(db, "roblox_oauth"));
}

// Imports daily official metrics for every connected experience. Returns the number of data points stored.
export async function syncOfficial(env, db, { universeIds, days } = {}) {
  const exps = universeIds?.length ? universeIds.map((u) => ({ universe_id: u })) : await all(db, "SELECT universe_id FROM experiences");
  let stored = 0;
  const errors = [];
  const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
  for (const { universe_id: u } of exps) {
    const creds = await credentialsFor(env, db, u);
    if (!creds.length) continue;
    for (const metric of Object.keys(OFFICIAL_METRICS)) {
      const have = await first(db, "SELECT COUNT(*) AS n FROM official_metrics WHERE universe_id = ? AND metric = ?", u, metric);
      const span = days || (have?.n ? 35 : 90);
      const start = new Date(end.getTime() - Math.min(span, SHORT_HISTORY.has(metric) ? 27 : span) * DAY);
      let points = null;
      let lastErr = null;
      for (const c of creds) {
        try {
          const got = await queryMetric(c.auth, u, metric, start.toISOString(), end.toISOString());
          if (got.length) await db.batch(got.map((p) => db.prepare("INSERT INTO official_metrics (universe_id, metric, day, value, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (universe_id, metric, day) DO UPDATE SET value = excluded.value, source = excluded.source, fetched_at = excluded.fetched_at").bind(u, metric, p.day, p.value, c.source, now())));
          points = got;
          break;
        } catch (e) {
          lastErr = e;
          if (e.upstream !== 401 && e.upstream !== 403) break; // only fall back to the next credential on auth errors
        }
      }
      if (points) stored += points.length;
      else if (lastErr) errors.push(`${u} ${metric}: ${lastErr.message}`);
    }
  }
  await setMeta(db, "official_sync_at", String(now()));
  if (errors.length && !stored) throw new Error(errors.slice(0, 3).join("; ").slice(0, 480));
  await setMeta(db, "official_sync_errors", errors.slice(0, 20).join("\n"));
  return stored;
}

export async function officialMetrics(db, universeId, from, to) {
  const fromDay = new Date(from).toISOString().slice(0, 10);
  const toDay = new Date(to).toISOString().slice(0, 10);
  const rows = await all(db, "SELECT metric, day, value, source, fetched_at FROM official_metrics WHERE universe_id = ? AND day BETWEEN ? AND ? ORDER BY day", universeId, fromDay, toDay);
  const series = {};
  for (const r of rows) (series[r.metric] ||= []).push({ day: r.day, value: r.value });
  const avg = (m) => (series[m]?.length ? series[m].reduce((s, p) => s + p.value, 0) / series[m].length : null);
  const sum = (m) => (series[m]?.length ? series[m].reduce((s, p) => s + p.value, 0) : null);
  const last = (m) => series[m]?.at(-1)?.value ?? null;
  return {
    labels: OFFICIAL_METRICS,
    series,
    summary: {
      avgDau: avg("DailyActiveUsers"), mau: last("MonthlyActiveUsers"), sessions: sum("Visits"),
      avgSessionMin: avg("AverageSessionLengthMinutes"), d1: avg("ForwardD1Retention"), d7: avg("ForwardD7Retention"), d30: avg("ForwardD30Retention"),
      revenue: sum("DailyRevenue"), payingUsers: sum("PayingUsers"), arppu: avg("AverageRevenuePerPayingUser"), conversion: avg("PayingUsersCVR"), peakCcu: series.PeakConcurrentPlayers?.length ? Math.max(...series.PeakConcurrentPlayers.map((p) => p.value)) : null,
    },
    sources: [...new Set(rows.map((r) => r.source))],
    fetchedAt: rows.length ? Math.max(...rows.map((r) => r.fetched_at)) : null,
  };
}
