import express from "express";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import pLimit from "p-limit";

const PORT = process.env.PORT || 3000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 10;
const RECIPE_REFRESH_INTERVAL = 1000 * 60 * 60 * 12;
const BAZAAR_REFRESH_INTERVAL = 1000 * 60 * 1;
const PRICE_CACHE_TTL = 1000 * 60 * 1; 

let db;

let bazaarPrices = {}; 
let lbinCache = {};

function nowTs() { return Date.now(); }
function formatInt(n) { return Math.round(n || 0); }
function formatWithCommas(n) { return formatInt(n).toLocaleString("en-US"); }

async function openDb() {
  db = await open({
    filename: "./craftcache.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      item TEXT PRIMARY KEY,
      json TEXT,
      updatedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS prices (
      item TEXT PRIMARY KEY,
      price INTEGER,
      source TEXT,     -- 'bazaar' | 'lbin' | 'craft' | 'easy'
      layers INTEGER,  -- how many craft layers used (0 = base)
      updatedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS craft_margins (
      item TEXT PRIMARY KEY,
      costPerUnit INTEGER,
      sellPrice INTEGER,
      profit INTEGER,
      marginPercent REAL,
      updatedAt INTEGER
    );
  `);
}

async function fetchBazaarPrices() {
  console.log("[bazaar] fetching bazaar prices...");
  try {
    const res = await fetch("https://api.hypixel.net/v2/skyblock/bazaar");
    const data = await res.json();
    if (!data || !data.products) throw new Error("Invalid bazaar response");
    const now = nowTs();
    const out = {};
    for (const [id, info] of Object.entries(data.products)) {
      out[id] = {
        buy: info.quick_status?.buyPrice ?? null,
        sell: info.quick_status?.sellPrice ?? null,
        updatedAt: now
      };
    }
    bazaarPrices = out;
    console.log("[bazaar] fetched", Object.keys(bazaarPrices).length, "items");
  } catch (err) {
    console.warn("[bazaar] fetch failed:", err.message);
  }
}

async function fetchAndStoreRecipe(itemName) {
  try {
    const res = await fetch(`https://sky.coflnet.com/api/craft/recipe/${itemName}`);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    let json;
    try { json = JSON.parse(text); } catch { return null; }
    const now = nowTs();
    await db.run(
      `INSERT INTO recipes (item, json, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(item) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt`,
      itemName, JSON.stringify(json), now
    );
    return json;
  } catch (err) {
    return null;
  }
}

async function getRecipeCached(itemName) {
  const row = await db.get(`SELECT json, updatedAt FROM recipes WHERE item = ?`, itemName);
  if (row) {
    try {
      const parsed = JSON.parse(row.json);
      return parsed;
    } catch {
      return null;
    }
  }
  return await fetchAndStoreRecipe(itemName);
}

async function fetchLBIN(itemName) {
  try {
    const res = await fetch(`https://sky.coflnet.com/api/auctions/tag/${itemName}/active/bin`);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    let arr;
    try { arr = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let min = Infinity;
    for (const a of arr) {
      const p = a.startingBid ?? a.price ?? a.bin ?? a.bid ?? null;
      if (typeof p === "number" && p < min) min = p;
    }
    if (!isFinite(min)) return null;
    const now = nowTs();
    lbinCache[itemName] = { price: min, updatedAt: now };
    await db.run(
      `INSERT INTO prices (item, price, source, layers, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item) DO UPDATE SET price=excluded.price, source=excluded.source, layers=excluded.layers, updatedAt=excluded.updatedAt`,
      itemName, Math.round(min), "lbin", 0, now
    );
    return min;
  } catch (err) {
    return null;
  }
}

function parseRecipeSlots(recipe) {
  const ingredients = [];
  let outputCount = 1;
  if (recipe.count != null) {
    const parsed = parseInt(recipe.count, 10);
    if (!Number.isNaN(parsed) && parsed > 0) outputCount = parsed;
  }
  for (const [k, v] of Object.entries(recipe)) {
    if (!/^[A-C][1-3]$/.test(k)) continue;
    if (!v) continue;
    if (typeof v === "string") {
      const parts = v.split(":");
      const id = parts[0].trim();
      const cnt = parts[1] ? parseInt(parts[1], 10) : 1;
      if (!id) continue;
      ingredients.push({ item: id, count: Number.isNaN(cnt) ? 1 : cnt });
    } else if (typeof v === "object" && v !== null) {
      if (v.item) ingredients.push({ item: v.item, count: v.count ?? 1 });
      else {
        const first = Object.values(v)[0];
        if (typeof first === "string") {
          const parts = first.split(":");
          ingredients.push({ item: parts[0], count: parts[1] ? parseInt(parts[1], 10) : 1 });
        }
      }
    }
  }
  return { ingredients, outputCount };
}

async function getItemPrice(itemName, visited = new Set()) {
  if (!itemName) return null;
  const name = itemName.toUpperCase();
  if (visited.has(name)) return null;
  visited.add(name);
  const now = nowTs();
  const pr = await db.get(`SELECT price, source, layers, updatedAt FROM prices WHERE item = ?`, name);
  if (pr) {
    if (now - pr.updatedAt < PRICE_CACHE_TTL) {
      return { price: pr.price, source: pr.source, layers: pr.layers };
    }
  }

  if (bazaarPrices[name] && bazaarPrices[name].buy != null) {
    const p = Math.round(bazaarPrices[name].buy);
    await db.run(
      `INSERT INTO prices (item, price, source, layers, updatedAt) VALUES (?, ?, 'bazaar', 0, ?)
       ON CONFLICT(item) DO UPDATE SET price=excluded.price, source=excluded.source, layers=excluded.layers, updatedAt=excluded.updatedAt`,
      name, p, now
    );
    return { price: p, source: "bazaar", layers: 0 };
  }

  const cachedLbin = lbinCache[name];
  if (cachedLbin && now - cachedLbin.updatedAt < PRICE_CACHE_TTL) {
    const p = Math.round(cachedLbin.price);
    await db.run(
      `INSERT INTO prices (item, price, source, layers, updatedAt) VALUES (?, ?, 'lbin', 0, ?)
       ON CONFLICT(item) DO UPDATE SET price=excluded.price, source=excluded.source, layers=excluded.layers, updatedAt=excluded.updatedAt`,
      name, p, now
    );
    return { price: p, source: "lbin", layers: 0 };
  }
  const lbin = await fetchLBIN(name);
  if (lbin != null) {
    const p = Math.round(lbin);
    return { price: p, source: "lbin", layers: 0 };
  }

  const recipe = await getRecipeCached(name);
  if (recipe) {
    const { ingredients, outputCount } = parseRecipeSlots(recipe);
    if (!ingredients || ingredients.length === 0) {
    } else {
      let total = 0;
      let maxLayer = 0;
      for (const ing of ingredients) {
        const ingName = ing.item.toUpperCase();
        const ingCount = ing.count || 1;
        const sub = await getItemPrice(ingName, visited); // recursive
        if (!sub || sub.price == null) {
          total = null;
          break; // can't price this recipe
        }
        total += sub.price * ingCount;
        if ((sub.layers ?? 0) + 1 > maxLayer) maxLayer = (sub.layers ?? 0) + 1;
      }

      if (total != null) {
        const perUnit = Math.round(total / (outputCount || 1));
        await db.run(
          `INSERT INTO prices (item, price, source, layers, updatedAt) VALUES (?, ?, 'craft', ?, ?)
           ON CONFLICT(item) DO UPDATE SET price=excluded.price, source=excluded.source, layers=excluded.layers, updatedAt=excluded.updatedAt`,
          name, perUnit, maxLayer, now
        );
        return { price: perUnit, source: "craft", layers: maxLayer };
      }
    }
  }

  if (easyItems[name] != null) {
    const p = Math.round(easyItems[name]);
    await db.run(
      `INSERT INTO prices (item, price, source, layers, updatedAt) VALUES (?, ?, 'easy', 0, ?)
       ON CONFLICT(item) DO UPDATE SET price=excluded.price, source=excluded.source, layers=excluded.layers, updatedAt=excluded.updatedAt`,
      name, p, now
    );
    return { price: p, source: "easy", layers: 0 };
  }
  return null;
}

async function computeMarginForItem(itemName) {
  const bz = bazaarPrices[itemName];
  if (!bz || bz.sell == null) return null;
  const recipe = await getRecipeCached(itemName);
  if (!recipe) return null;
  const parsed = parseRecipeSlots(recipe);
  if (!parsed.ingredients.length) return null;
  let total = 0;
  const breakdown = [];
  let maxLayers = 0;

  for (const ing of parsed.ingredients) {
    const ingName = ing.item.toUpperCase();
    const ingCount = ing.count || 1;
    const sub = await getItemPrice(ingName, new Set());
    if (!sub || sub.price == null) {
      return null;
    }
    total += sub.price * ingCount;
    breakdown.push({ item: ingName, count: ingCount, unitPrice: Math.round(sub.price), source: sub.source, layers: sub.layers ?? 0 });
    if ((sub.layers ?? 0) > maxLayers) maxLayers = sub.layers ?? 0;
  }

  const perOutput = Math.round(total / (parsed.outputCount || 1));
  const sell = Math.round(bz.sell);
  const profit = Math.round(sell - perOutput);
  const marginPercent = perOutput > 0 ? Number(((profit / perOutput) * 100).toFixed(2)) : 0;

  const now = nowTs();
  await db.run(
    `INSERT INTO craft_margins (item, costPerUnit, sellPrice, profit, marginPercent, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item) DO UPDATE SET costPerUnit=excluded.costPerUnit, sellPrice=excluded.sellPrice, profit=excluded.profit, marginPercent=excluded.marginPercent, updatedAt=excluded.updatedAt`,
    itemName, perOutput, sell, profit, marginPercent, now
  );

  return {
    item: itemName,
    costPerUnit: perOutput,
    sellPrice: sell,
    profit,
    marginPercent,
    breakdown,
    craftLayers: maxLayers
  };
}

async function initialLoadAndCompute() {
  console.log("[init] Starting initial preload + compute...");
  if (!bazaarPrices || Object.keys(bazaarPrices).length === 0) await fetchBazaarPrices();

  const items = Object.keys(bazaarPrices);
  console.log(`[init] will process ${items.length} bazaar items (recipes) with concurrency ${CONCURRENCY}`);

  const limit = pLimit(CONCURRENCY);
  let processed = 0;
  const tasks = items.map(item =>
    limit(async () => {
      await fetchAndStoreRecipe(item);
      processed++;
      if (processed % 100 === 0 || processed === items.length) {
        console.log(`[init] recipes fetched: ${processed}/${items.length}`);
      }
    })
  );

  await Promise.all(tasks);
  console.log("[init] recipe preload done. Now computing margins for each bazaar item...");
  processed = 0;
  const tasks2 = items.map(item =>
    limit(async () => {
      try {
        await computeMarginForItem(item);
      } catch (err) {
      }
      processed++;
      if (processed % 100 === 0 || processed === items.length) {
        console.log(`[init] margins computed: ${processed}/${items.length}`);
      }
    })
  );

  await Promise.all(tasks2);
  console.log("[init] initial compute done.");
}

async function startBackgroundWorkers() {
  setInterval(async () => {
    await fetchBazaarPrices();
  }, BAZAAR_REFRESH_INTERVAL);
  setInterval(async () => {
    try {
      const rows = await db.all(`SELECT item FROM craft_margins ORDER BY profit DESC LIMIT 200`);
      const items = rows.map(r => r.item);
      if (items.length === 0) return;
      const limit = pLimit(CONCURRENCY);
      const tasks = items.map(it => limit(() => computeMarginForItem(it)));
      await Promise.all(tasks);
      console.log("[bg] refreshed top craft margins");
    } catch (err) {
      console.warn("[bg] error refreshing top margins:", err.message);
    }
  }, 1000 * 60 * 1); 
  setInterval(async () => {
    try {
      const rows = await db.all(`SELECT item, updatedAt FROM recipes ORDER BY updatedAt ASC LIMIT 500`);
      const limit = pLimit(CONCURRENCY);
      const items = rows.map(r => r.item);
      await Promise.all(items.map(it => limit(() => fetchAndStoreRecipe(it))));
      console.log("[bg] refreshed some recipes");
    } catch (err) {
      console.warn("[bg] error refreshing recipes:", err.message);
    }
  }, RECIPE_REFRESH_INTERVAL);
}

async function getTop25Formatted() {
  const rows = await db.all(`
    SELECT item, costPerUnit, sellPrice, profit, marginPercent, updatedAt
    FROM craft_margins
    ORDER BY profit DESC
    LIMIT 25
  `);
  const out = [];
  for (const r of rows) {
    const priceRow = await db.get(`SELECT source, layers FROM prices WHERE item = ?`, r.item);
    out.push({
      item: r.item,
      sellPrice: formatWithCommas(r.sellPrice),
      costPerUnit: formatWithCommas(r.costPerUnit),
      profit: formatWithCommas(r.profit),
      marginPercent: Number(r.marginPercent).toFixed(2) + "%",
      priceSource: priceRow?.source ?? null,
      craftLayers: priceRow?.layers ?? null,
      updatedAt: r.updatedAt
    });
  }
  return out;
}

async function startServer() {
  await openDb();
  await fetchBazaarPrices();
  initialLoadAndCompute().catch(err => {
    console.warn("[init] initial load failed:", err.message);
  }).finally(() => {
    startBackgroundWorkers();
  });
  const app = express();
  app.get("/craft-margins", async (req, res) => {
    try {
      const top = await getTop25Formatted();
      res.json(top);
    } catch (err) {
      console.error("/craft-margins error:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/item-price/:item", async (req, res) => {
    const item = req.params.item.toUpperCase();
    try {
      const rec = await db.get(`SELECT json, updatedAt FROM recipes WHERE item = ?`, item);
      const priceRow = await db.get(`SELECT price, source, layers, updatedAt FROM prices WHERE item = ?`, item);
      const margin = await db.get(`SELECT costPerUnit, sellPrice, profit, marginPercent FROM craft_margins WHERE item = ?`, item);
      res.json({
        item,
        recipe: rec ? JSON.parse(rec.json) : null,
        priceRow,
        margin
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log("Endpoints: /craft-margins  /item-price/:ITEM_NAME");
  });
}

startServer().catch(err => {
  console.error("Fatal start error:", err);
  process.exit(1);
});
