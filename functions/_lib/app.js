// Entry point for everything under /stats. Every request is answered here (the middleware never
// falls through to static assets), and every non-public path requires an owner session.
import { ensureSchema, getDb } from "./db.js";
import { ensureDefaults, handleApi } from "./api.js";
import { LOGIN_CSRF_COOKIE, attemptLogin, authConfig, checkCsrf, clearSessionCookie, destroySession, getSession, sameOrigin } from "./auth.js";
import { tick } from "./collector.js";
import { ingest } from "./telemetry.js";
import { HttpError, cookie, escapeHtml, html, json, parseCookies, randomToken, safeEqual } from "./util.js";
import shellHtml from "./ui/shell.html";
import loginHtml from "./ui/login.html";
import clientJs from "./ui/client.js.txt";
import stylesCss from "./ui/styles.css.txt";

function securityHeaders(res, nonce) {
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store, private");
  h.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "same-origin"); // no-referrer would make browsers send "Origin: null" on same-origin POSTs
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data: https://*.rbxcdn.com; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function loginPage(nonce, csrf, error, status = 200) {
  const res = html(render(loginHtml, { NONCE: nonce, CSRF: csrf, ERROR: error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : "" }), status);
  res.headers.append("Set-Cookie", cookie(LOGIN_CSRF_COOKIE, csrf, { maxAge: 900 }));
  return res;
}

const redirect = (to, extraCookies = []) => {
  const h = new Headers({ Location: to });
  for (const c of extraCookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers: h });
};

async function route(ctx, path, nonce) {
  const { request, env } = ctx;
  const method = request.method;
  const cfg = authConfig(env);
  if (!cfg.ok) {
    console.error(`[stats] not configured, missing: ${cfg.missing.join(", ")}`);
    return html("<!doctype html><title>Unavailable</title><p>This page is not available.</p>", 503);
  }
  const db = getDb(env);
  await ensureSchema(db);
  await ensureDefaults(db);

  if (path === "ingest" && method === "POST") return json(await ingest(env, db, request));

  if (path === "api/cron" && method === "POST") {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.STATS_CRON_TOKEN || env.STATS_CRON_TOKEN.length < 32 || !safeEqual(token, env.STATS_CRON_TOKEN)) throw new HttpError(401, "Unauthorized");
    return json(await tick(env, { budgetMs: 25_000, maxJobs: 10 }));
  }

  if (path === "login") {
    if (method === "GET") {
      if (await getSession(env, db, request)) return redirect("/stats");
      return loginPage(nonce, randomToken(18));
    }
    if (method === "POST") {
      const form = await request.formData();
      const csrfCookie = parseCookies(request)[LOGIN_CSRF_COOKIE] || "";
      if (!sameOrigin(request) || !csrfCookie || !safeEqual(String(form.get("csrf") || ""), csrfCookie)) {
        return loginPage(nonce, randomToken(18), "Your session expired. Try again.", 400);
      }
      const result = await attemptLogin(env, db, request, { username: form.get("username"), password: form.get("password"), code: form.get("code") });
      if (result.throttled) return loginPage(nonce, randomToken(18), "Too many attempts. Wait 15 minutes and try again.", 429);
      if (!result.ok) return loginPage(nonce, randomToken(18), "Invalid credentials.", 401);
      return redirect("/stats", [result.session.cookie, cookie(LOGIN_CSRF_COOKIE, "", { maxAge: 0 })]);
    }
  }

  const session = await getSession(env, db, request);
  if (!session) {
    if (path.startsWith("api/") || path.startsWith("assets/")) throw new HttpError(401, "Unauthorized");
    return redirect("/stats/login");
  }

  if (path === "" && method === "GET") return html(render(shellHtml, { CSRF: session.csrf, NONCE: nonce }));
  if (path === "assets/app.js" && method === "GET") return new Response(clientJs, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
  if (path === "assets/app.css" && method === "GET") return new Response(stylesCss, { headers: { "Content-Type": "text/css; charset=utf-8" } });

  if (path.startsWith("api/")) {
    if (method !== "GET" && method !== "HEAD" && !checkCsrf(request, session)) throw new HttpError(403, "CSRF check failed");
    if (path === "api/logout" && method === "POST") {
      await destroySession(db, session.idHash);
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
    }
    if (path === "api/session" && method === "GET") return json({ expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt, owner: env.STATS_OWNER });
    return handleApi(env, db, request, ctx, path.slice(4));
  }
  throw new HttpError(404, "Not found");
}

export async function handleStats(ctx) {
  const url = new URL(ctx.request.url);
  const path = url.pathname.replace(/^\/stats\/?/, "").replace(/\/+$/, "");
  const nonce = randomToken(16);
  let res;
  try {
    res = await route(ctx, path, nonce);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err?.status === 429 ? 502 : 500;
    if (!(err instanceof HttpError)) console.error("[stats]", err?.stack || err);
    const message = err instanceof HttpError ? err.message : `Upstream or server error: ${String(err?.message || err).slice(0, 200)}`;
    res = json({ ok: false, error: message }, status);
  }
  return securityHeaders(res, nonce);
}
