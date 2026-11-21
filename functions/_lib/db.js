import { SCHEMA_SQL as schemaSql } from "./schema.js";

export const SCHEMA_VERSION = "1";
let schemaReady = false;

export function getDb(env) {
  return env.STATS_DB || null;
}

export async function ensureSchema(db) {
  if (schemaReady) return;
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
    if (row?.value === SCHEMA_VERSION) {
      schemaReady = true;
      return;
    }
  } catch {
    // meta table missing: fall through and create everything
  }
  const statements = schemaSql
    .split(";")
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean)
    .map((s) => db.prepare(s));
  await db.batch(statements);
  await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").bind(SCHEMA_VERSION).run();
  schemaReady = true;
}

export async function getMeta(db, key) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, String(value)).run();
}

export async function all(db, sql, ...params) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || [];
}

export async function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export async function batch(db, stmts) {
  if (!stmts.length) return [];
  const out = [];
  for (let i = 0; i < stmts.length; i += 50) out.push(...(await db.batch(stmts.slice(i, i + 50))));
  return out;
}
