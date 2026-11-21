// Public Roblox web APIs. None of these need an account; all calls are read-only.
import { chunk } from "./util.js";

const UA = "f8di-stats/1.0 (+https://f8di.com)";
export const SOURCES = {
  games: "https://games.roblox.com/v1/games",
  votes: "https://games.roblox.com/v1/games/votes",
  icons: "https://thumbnails.roblox.com/v1/games/icons",
  placeToUniverse: "https://apis.roblox.com/universes/v1/places/{placeId}/universe",
  explore: "https://apis.roblox.com/explore-api/v1/get-sorts",
  search: "https://apis.roblox.com/search-api/omni-search",
  catalogSearch: "https://catalog.roblox.com/v1/search/items/details",
  catalogDetails: "https://catalog.roblox.com/v1/catalog/items/details",
  resale: "https://economy.roblox.com/v1/assets/{assetId}/resale-data",
  assetIcons: "https://thumbnails.roblox.com/v1/assets",
  openCloudUniverse: "https://apis.roblox.com/cloud/v2/universes/{universeId}",
};

export class RobloxError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout || 12_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new RobloxError(`${new URL(url).host}${new URL(url).pathname} -> HTTP ${res.status} ${text}`, res.status);
  }
  return res.json();
}

const uuid = () => crypto.randomUUID();

export async function fetchGames(universeIds) {
  const out = new Map();
  for (const ids of chunk(universeIds, 50)) {
    const [games, votes] = await Promise.all([
      getJson(`${SOURCES.games}?universeIds=${ids.join(",")}`),
      getJson(`${SOURCES.votes}?universeIds=${ids.join(",")}`).catch(() => ({ data: [] })),
    ]);
    const voteMap = new Map((votes.data || []).map((v) => [v.id, v]));
    const wanted = new Set(ids.map(Number));
    for (const g of games.data || []) {
      if (!g.id || !wanted.has(g.id)) continue; // Roblox returns id 0 placeholders for unknown ids
      const v = voteMap.get(g.id) || {};
      out.set(g.id, {
        universeId: g.id,
        rootPlaceId: g.rootPlaceId,
        name: g.name,
        creatorId: g.creator?.id ?? null,
        creatorName: g.creator?.name ?? null,
        creatorType: g.creator?.type ?? null,
        creatorVerified: g.creator?.hasVerifiedBadge ? 1 : 0,
        genre: g.genre ?? null,
        genreL1: g.genre_l1 ?? null,
        genreL2: g.genre_l2 ?? null,
        maxPlayers: g.maxPlayers ?? null,
        created: g.created ?? null,
        updated: g.updated ?? null,
        price: g.price ?? null,
        playing: g.playing ?? null,
        visits: g.visits ?? null,
        favorites: g.favoritedCount ?? null,
        upVotes: v.upVotes ?? null,
        downVotes: v.downVotes ?? null,
      });
    }
  }
  return out;
}

export async function fetchGameIcons(universeIds) {
  const out = new Map();
  for (const ids of chunk(universeIds, 100)) {
    const data = await getJson(`${SOURCES.icons}?universeIds=${ids.join(",")}&size=150x150&format=Webp&isCircular=false`);
    for (const d of data.data || []) if (d.state === "Completed" && d.imageUrl) out.set(d.targetId, d.imageUrl);
  }
  return out;
}

export async function placeToUniverse(placeId) {
  const data = await getJson(SOURCES.placeToUniverse.replace("{placeId}", placeId));
  return data.universeId || null;
}

// Accepts "u:<universeId>", "p:<placeId>", a roblox.com/games/<placeId>/... URL, or a bare number.
// A bare number is tried as a place id first (what Roblox URLs show), then as a universe id.
export async function resolveGameRef(ref) {
  const s = String(ref || "").trim();
  const m = s.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i);
  if (m) return placeToUniverse(m[1]).catch(() => null);
  const pre = s.match(/^([up]):(\d{1,20})$/i);
  const asUniverse = async (id) => ((await fetchGames([Number(id)]).catch(() => new Map())).size ? Number(id) : null);
  if (pre) return pre[1].toLowerCase() === "u" ? asUniverse(pre[2]) : placeToUniverse(pre[2]).catch(() => null);
  if (!/^\d{1,20}$/.test(s)) return null;
  return (await placeToUniverse(s).catch(() => null)) || asUniverse(s);
}

export async function searchGames(query) {
  const url = `${SOURCES.search}?searchQuery=${encodeURIComponent(query)}&sessionId=${uuid()}&pageType=all`;
  const data = await getJson(url);
  const out = [];
  for (const group of data.searchResults || []) {
    if (group.contentGroupType !== "Game") continue;
    for (const c of group.contents || []) {
      if (!c.universeId) continue;
      out.push({ universeId: c.universeId, rootPlaceId: c.rootPlaceId, name: c.name, playing: c.playerCount ?? null, upVotes: c.totalUpVotes ?? null, downVotes: c.totalDownVotes ?? null, sponsored: !!c.isSponsored });
    }
  }
  return out;
}

// Roblox's discovery sorts (Top Trending, Up-and-Coming, ...). Sponsored slots are skipped.
export async function fetchExploreSorts(pages = 2) {
  const sessionId = uuid();
  const sorts = [];
  let token = "";
  for (let p = 0; p < pages; p++) {
    const url = `${SOURCES.explore}?sessionId=${sessionId}${token ? `&sortsPageToken=${encodeURIComponent(token)}` : ""}`;
    const data = await getJson(url);
    for (const s of data.sorts || []) {
      if (s.contentType !== "Games" || !Array.isArray(s.games)) continue;
      sorts.push({
        sortId: s.sortId,
        name: s.sortDisplayName,
        games: s.games.filter((g) => !g.isSponsored && g.universeId).map((g, i) => ({ universeId: g.universeId, position: i + 1, playing: g.playerCount ?? null, genreL1: g.genreL1 ?? null })),
      });
    }
    token = data.nextSortsPageToken;
    if (!token) break;
  }
  return sorts;
}

let catalogCsrf = "";
async function catalogPost(url, body) {
  // Roblox issues per-server CSRF tokens behind a load balancer, so a fresh token can be rejected by the next server.
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", "X-CSRF-TOKEN": catalogCsrf },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 403 && res.headers.get("x-csrf-token")) {
      catalogCsrf = res.headers.get("x-csrf-token");
      continue;
    }
    if (!res.ok) throw new RobloxError(`catalog details -> HTTP ${res.status}`, res.status);
    return res.json();
  }
  throw new RobloxError("catalog details -> CSRF negotiation failed", 403);
}

function mapCatalogItem(d) {
  return {
    assetId: d.id,
    itemType: d.itemType,
    assetType: d.assetType ?? null,
    name: d.name,
    creatorName: d.creatorName ?? null,
    restrictions: (d.itemRestrictions || []).join(","),
    totalQuantity: d.totalQuantity ?? null,
    collectibleItemId: d.collectibleItemId ?? null,
    createdUtc: d.itemCreatedUtc ?? null,
    price: d.price ?? null,
    lowestPrice: d.lowestPrice ?? null,
    lowestResalePrice: d.lowestResalePrice ?? null,
    unitsAvailable: d.unitsAvailableForConsumption ?? null,
    favorites: d.favoriteCount ?? null,
    hasResellers: d.hasResellers ? 1 : 0,
    offSale: !!d.isOffSale,
  };
}

export async function fetchItemDetails(assetIds) {
  const out = new Map();
  for (const ids of chunk(assetIds, 50)) {
    const data = await catalogPost(SOURCES.catalogDetails, { items: ids.map((id) => ({ itemType: "Asset", id })) });
    for (const d of data.data || []) out.set(d.id, mapCatalogItem(d));
  }
  return out;
}

export async function searchCatalog(keyword, { collectiblesOnly = true, cursor = "" } = {}) {
  const p = new URLSearchParams({ Keyword: keyword, Limit: "30" });
  if (collectiblesOnly) p.set("SalesTypeFilter", "2");
  if (cursor) p.set("Cursor", cursor);
  const data = await getJson(`${SOURCES.catalogSearch}?${p}`);
  return { items: (data.data || []).filter((d) => d.itemType === "Asset").map(mapCatalogItem), nextCursor: data.nextPageCursor || null };
}

export async function fetchResaleData(assetId) {
  const d = await getJson(SOURCES.resale.replace("{assetId}", assetId));
  return {
    rap: d.recentAveragePrice ?? null,
    sales: d.sales ?? null,
    points: (d.priceDataPoints || []).map((p) => ({ day: p.date.slice(0, 10), value: p.value })),
  };
}

export async function fetchAssetIcons(assetIds) {
  const out = new Map();
  for (const ids of chunk(assetIds, 100)) {
    const data = await getJson(`${SOURCES.assetIcons}?assetIds=${ids.join(",")}&size=150x150&format=Webp`);
    for (const d of data.data || []) if (d.state === "Completed" && d.imageUrl) out.set(d.targetId, d.imageUrl);
  }
  return out;
}

export async function openCloudUniverse(apiKey, universeId) {
  return getJson(SOURCES.openCloudUniverse.replace("{universeId}", universeId), { headers: { "x-api-key": apiKey } });
}
