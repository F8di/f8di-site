import { all, first, run, getMeta, setMeta } from "./db.js";
import { b64decode, clientIp, cookie, parseCookies, randomToken, safeEqual, sha256Hex, now, HOUR } from "./util.js";

export const SESSION_COOKIE = "__Host-f8di_stats";
export const LOGIN_CSRF_COOKIE = "__Host-f8di_stats_login";
const SESSION_ABSOLUTE_MS = 12 * HOUR;
const SESSION_IDLE_MS = 2 * HOUR;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 25;
const FAIL_WINDOW_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = HOUR;
const PBKDF2_MAX_ITERATIONS = 100_000; // Cloudflare's Web Crypto limit

export function authConfig(env) {
  const missing = [];
  for (const k of ["STATS_OWNER", "STATS_PASSWORD_HASH", "STATS_TOTP_SECRET", "STATS_SESSION_SECRET"]) {
    if (!env[k]) missing.push(k);
  }
  if (env.STATS_SESSION_SECRET && env.STATS_SESSION_SECRET.length < 32) missing.push("STATS_SESSION_SECRET (min 32 chars)");
  if (!env.STATS_DB) missing.push("STATS_DB (D1 binding)");
  return { ok: missing.length === 0, missing };
}

// Format: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 10_000 || iterations > PBKDF2_MAX_ITERATIONS) return false;
  const salt = b64decode(parts[2]);
  const expected = b64decode(parts[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8));
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

// Returns the matched time step, or null. Accepts one step of clock drift either way.
export async function verifyTotp(secret, code, at = now()) {
  if (!/^\d{6}$/.test(code || "")) return null;
  const bytes = base32Decode(secret);
  if (bytes.length < 10) return null;
  const step = Math.floor(at / 30_000);
  let match = null;
  for (const s of [step - 1, step, step + 1]) {
    if (safeEqual(await hotp(bytes, s), code)) match = s;
  }
  return match;
}

export async function ipKey(env, request) {
  return sha256Hex(`${env.STATS_SESSION_SECRET}|ip|${clientIp(request)}`);
}

export async function loginThrottled(db, ipHash) {
  const t = now();
  const ip = await first(db, "SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND ok = 0 AND ts > ?", ipHash, t - FAIL_WINDOW_MS);
  const global = await first(db, "SELECT COUNT(*) AS n FROM auth_attempts WHERE ok = 0 AND ts > ?", t - GLOBAL_WINDOW_MS);
  return (ip?.n || 0) >= MAX_FAILS_PER_IP || (global?.n || 0) >= MAX_FAILS_GLOBAL;
}

export async function recordAttempt(db, ipHash, ok) {
  await run(db, "INSERT INTO auth_attempts (key, ts, ok) VALUES (?, ?, ?)", ipHash, now(), ok ? 1 : 0);
}

export async function attemptLogin(env, db, request, { username, password, code }) {
  const ipHash = await ipKey(env, request);
  if (await loginThrottled(db, ipHash)) return { ok: false, throttled: true };
  // Always run every check so timing does not reveal which factor failed.
  const userOk = safeEqual(String(username || "").trim().toLowerCase(), String(env.STATS_OWNER).trim().toLowerCase());
  const passOk = await verifyPassword(String(password || ""), env.STATS_PASSWORD_HASH);
  const step = await verifyTotp(env.STATS_TOTP_SECRET, String(code || "").replace(/\s/g, ""));
  let totpOk = step !== null;
  if (totpOk) {
    const last = parseInt((await getMeta(db, "totp_last_step")) || "0", 10);
    if (step <= last) totpOk = false; // replayed code
  }
  const ok = userOk && passOk && totpOk;
  await recordAttempt(db, ipHash, ok);
  if (!ok) return { ok: false };
  await setMeta(db, "totp_last_step", step);
  const session = await createSession(env, db, request, ipHash);
  return { ok: true, session };
}

export async function createSession(env, db, request, ipHash) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const t = now();
  await run(
    db,
    "INSERT INTO sessions (id_hash, csrf, created_at, last_seen_at, expires_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(`${env.STATS_SESSION_SECRET}|session|${token}`),
    csrf,
    t,
    t,
    t + SESSION_ABSOLUTE_MS,
    ipHash,
    (request.headers.get("User-Agent") || "").slice(0, 200)
  );
  return { token, csrf, cookie: cookie(SESSION_COOKIE, token, { maxAge: SESSION_ABSOLUTE_MS / 1000 }) };
}

export async function getSession(env, db, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length < 32 || token.length > 64) return null;
  const idHash = await sha256Hex(`${env.STATS_SESSION_SECRET}|session|${token}`);
  const row = await first(db, "SELECT * FROM sessions WHERE id_hash = ?", idHash);
  const t = now();
  if (!row) return null;
  if (row.expires_at < t || row.last_seen_at + SESSION_IDLE_MS < t) {
    await run(db, "DELETE FROM sessions WHERE id_hash = ?", idHash);
    return null;
  }
  if (t - row.last_seen_at > 60_000) await run(db, "UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", t, idHash);
  return { idHash, csrf: row.csrf, createdAt: row.created_at, expiresAt: row.expires_at, idleExpiresAt: t + SESSION_IDLE_MS };
}

export async function destroySession(db, idHash) {
  await run(db, "DELETE FROM sessions WHERE id_hash = ?", idHash);
}

export async function listSessions(db) {
  return all(db, "SELECT substr(id_hash, 1, 8) AS id, created_at, last_seen_at, expires_at, user_agent FROM sessions ORDER BY last_seen_at DESC");
}

export async function destroyAllSessions(db) {
  await run(db, "DELETE FROM sessions");
}

export const clearSessionCookie = () => cookie(SESSION_COOKIE, "", { maxAge: 0 });

// Same-origin check for state-changing requests. The browser always sends Origin on
// cross-site POSTs; requests without it (same-origin forms in some browsers) still need the CSRF token.
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = request.headers.get("Host") || new URL(request.url).host;
    return o.host === host || o.host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function checkCsrf(request, session) {
  if (!sameOrigin(request)) return false;
  return safeEqual(request.headers.get("X-CSRF-Token") || "", session.csrf);
}
