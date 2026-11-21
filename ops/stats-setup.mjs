#!/usr/bin/env node
// Generates the owner credentials for /stats. Run locally: node ops/stats-setup.mjs
// Prints values to store as encrypted Cloudflare Pages secrets. Nothing is written to disk.
import { webcrypto as crypto } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ITERATIONS = 100_000; // Cloudflare Workers' PBKDF2 maximum
const b64url = (b) => Buffer.from(b).toString("base64url");

function base32(bytes) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += a[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += a[(value << (5 - bits)) & 31];
  return out;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

const rl = createInterface({ input: stdin, output: stdout });
const owner = (await rl.question("Owner username: ")).trim();
const password = await rl.question("Password (min 14 chars; input is visible, clear your terminal afterwards): ");
rl.close();
if (!owner || password.length < 14) {
  console.error("Username required and password must be at least 14 characters.");
  process.exit(1);
}
const totp = base32(crypto.getRandomValues(new Uint8Array(20)));
const vals = {
  STATS_OWNER: owner,
  STATS_PASSWORD_HASH: await hashPassword(password),
  STATS_TOTP_SECRET: totp,
  STATS_SESSION_SECRET: b64url(crypto.getRandomValues(new Uint8Array(48))),
  STATS_CRON_TOKEN: b64url(crypto.getRandomValues(new Uint8Array(32))),
};
console.log("\nAdd these as encrypted secrets (Pages > Settings > Variables and Secrets, type Secret):\n");
for (const [k, v] of Object.entries(vals)) console.log(`${k}=${v}`);
console.log(`\nAuthenticator app: add an account manually with secret ${totp} (TOTP, SHA1, 6 digits, 30s),`);
console.log(`or open: otpauth://totp/F8di%20Stats:${encodeURIComponent(owner)}?secret=${totp}&issuer=F8di%20Stats&algorithm=SHA1&digits=6&period=30`);
console.log("\nAlso add STATS_CRON_TOKEN and your site URL as GitHub Actions secrets for scheduled collection (see ops/STATS.md).");
