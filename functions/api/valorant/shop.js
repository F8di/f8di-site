const CLIENT_PLATFORM =
  "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

const CURRENCIES = {
  "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": "vp",
  "e59aa87c-4cbf-517a-5983-6e81511be9b7": "rp",
  "85ca954a-41f2-ce94-9b45-8ca3dd39a00d": "kc",
};
const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";

const REGION_TO_SHARD = { na: "na", latam: "na", br: "na", pbe: "pbe", eu: "eu", ap: "ap", kr: "kr" };

const CACHED = { cf: { cacheTtl: 3600, cacheEverything: true } };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function riot(url, init, step) {
  const res = await fetch(url, init);
  if ([400, 401, 403].includes(res.status)) {
    throw new HttpError(401, "Riot rejected your login (it expires after about an hour). Sign in again.");
  }
  if (!res.ok) {
    const hint = res.status === 404 ? " Check that the right region is selected." : "";
    throw new HttpError(502, `Riot ${step} request failed (${res.status}).${hint}`);
  }
  return res.json();
}

async function detectRegion(accessToken, idToken) {
  try {
    const res = await fetch("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.affinities?.live || null;
  } catch {
    return null;
  }
}

async function loadSkinCatalog() {
  const [skinsRes, tiersRes] = await Promise.all([
    fetch("https://valorant-api.com/v1/weapons/skins", CACHED),
    fetch("https://valorant-api.com/v1/contenttiers", CACHED),
  ]);
  if (!skinsRes.ok || !tiersRes.ok) throw new HttpError(502, "Could not load skin data from valorant-api.com.");
  const tiers = {};
  for (const t of (await tiersRes.json()).data) {
    tiers[t.uuid] = { name: t.devName, color: `#${t.highlightColor.slice(0, 6)}`, icon: t.displayIcon };
  }
  const levels = {};
  for (const skin of (await skinsRes.json()).data) {
    const level = skin.levels?.[0];
    if (!level) continue;
    levels[level.uuid] = {
      name: skin.displayName,
      icon: level.displayIcon || skin.displayIcon || skin.chromas?.[0]?.fullRender || null,
      tier: tiers[skin.contentTierUuid] || null,
    };
  }
  return levels;
}

function vpCost(cost) {
  return cost?.[VP] ?? null;
}

function skinItem(catalog, itemId, extra) {
  const info = catalog[itemId] || { name: "Unknown item", icon: null, tier: null };
  return { id: itemId, ...info, ...extra };
}

async function loadBundle(bundle, catalog) {
  let info = null;
  try {
    const res = await fetch(`https://valorant-api.com/v1/bundles/${bundle.DataAssetID}`, CACHED);
    if (res.ok) info = (await res.json()).data;
  } catch {}
  return {
    name: info?.displayName || "Featured bundle",
    image: info?.displayIcon2 || info?.displayIcon || null,
    price: bundle.TotalDiscountedCost?.[VP] ?? null,
    basePrice: bundle.TotalBaseCost?.[VP] ?? null,
    remainingSeconds: bundle.DurationRemainingInSeconds ?? null,
    skins: (bundle.Items || [])
      .filter((i) => catalog[i.Item?.ItemID])
      .map((i) => skinItem(catalog, i.Item.ItemID, { price: i.DiscountedPrice })),
  };
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const { accessToken, idToken } = body || {};
  if (!accessToken) return json({ error: "Missing access token. Sign in first." }, 400);

  try {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const [entitlements, userinfo, version, catalog, detectedRegion] = await Promise.all([
      riot("https://entitlements.auth.riotgames.com/api/token/v1", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: "{}",
      }, "entitlements"),
      riot("https://auth.riotgames.com/userinfo", { headers: auth }, "userinfo"),
      fetch("https://valorant-api.com/v1/version", CACHED).then((r) => r.json()),
      loadSkinCatalog(),
      body.region && body.region !== "auto" ? null : detectRegion(accessToken, idToken),
    ]);

    const region = body.region && body.region !== "auto" ? body.region : detectedRegion;
    const shard = REGION_TO_SHARD[region];
    if (!shard) {
      return json({ error: "Could not detect your region. Pick it from the list and try again.", needRegion: true }, 400);
    }

    const puuid = userinfo.sub;
    const pd = `https://pd.${shard}.a.pvp.net`;
    const headers = {
      ...auth,
      "X-Riot-Entitlements-JWT": entitlements.entitlements_token,
      "X-Riot-ClientPlatform": CLIENT_PLATFORM,
      "X-Riot-ClientVersion": version.data.riotClientVersion,
      "Content-Type": "application/json",
    };

    const [store, wallet] = await Promise.all([
      riot(`${pd}/store/v3/storefront/${puuid}`, { method: "POST", headers, body: "{}" }, "storefront"),
      riot(`${pd}/store/v1/wallet/${puuid}`, { headers }, "wallet"),
    ]);

    const balances = {};
    for (const [id, amount] of Object.entries(wallet.Balances || {})) {
      if (CURRENCIES[id]) balances[CURRENCIES[id]] = amount;
    }

    const panel = store.SkinsPanelLayout || {};
    const daily = (panel.SingleItemStoreOffers || []).map((offer) =>
      skinItem(catalog, offer.Rewards?.[0]?.ItemID || offer.OfferID, { price: vpCost(offer.Cost) })
    );

    const bundles = await Promise.all(
      (store.FeaturedBundle?.Bundles || []).map((b) => loadBundle(b, catalog))
    );

    let nightMarket = null;
    if (store.BonusStore?.BonusStoreOffers?.length) {
      nightMarket = {
        remainingSeconds: store.BonusStore.BonusStoreRemainingDurationInSeconds ?? null,
        offers: store.BonusStore.BonusStoreOffers.map((o) =>
          skinItem(catalog, o.Offer?.Rewards?.[0]?.ItemID || o.Offer?.OfferID, {
            price: vpCost(o.DiscountCosts),
            basePrice: vpCost(o.Offer?.Cost),
            discountPercent: o.DiscountPercent ?? null,
          })
        ),
      };
    }

    return json({
      account: {
        name: userinfo.acct?.game_name ? `${userinfo.acct.game_name}#${userinfo.acct.tag_line}` : null,
        region,
      },
      balances,
      daily: { remainingSeconds: panel.SingleItemOffersRemainingDurationInSeconds ?? null, offers: daily },
      bundles,
      nightMarket,
    });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: "Something went wrong loading your shop." }, 500);
  }
}
