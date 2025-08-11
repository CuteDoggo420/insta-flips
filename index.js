import express from "express";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import pLimit from "p-limit";

const PORT = 3000;
const CONCURRENCY = 10;
const CACHE_UPDATE_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Open SQLite DB (file: craftcache.db)
let db;
async function openDb() {
  db = await open({
    filename: "./craftcache.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS craft_margins (
      item TEXT PRIMARY KEY,
      cost REAL,
      sellPrice REAL,
      profit REAL,
      marginPercent REAL,
      updatedAt INTEGER
    )
  `);
}

// Fetch Bazaar prices from Hypixel API
async function getBazaarPrices() {
  console.log("Fetching Bazaar prices...");
  const res = await fetch("https://api.hypixel.net/skyblock/bazaar");
  const data = await res.json();
  const prices = {};
  for (const [id, info] of Object.entries(data.products)) {
    prices[id] = {
      buy: info.quick_status.buyPrice,
      sell: info.quick_status.sellPrice,
    };
  }
  console.log("Bazaar prices fetched.");
  return prices;
}

// Fetch recipe from Coflnet API with error handling
async function getRecipe(itemName) {
  try {
    const res = await fetch(`https://sky.coflnet.com/api/craft/recipe/${itemName}`);

    if (!res.ok) {
      // Not found or error — no recipe
      return null;
    }

    const text = await res.text();

    if (!text) {
      // Empty response
      return null;
    }

    try {
      const data = JSON.parse(text);
      return data;
    } catch {
      // Invalid JSON
      return null;
    }
  } catch (err) {
    // Network or other error
    return null;
  }
}


// Calculate crafting cost from recipe and prices
async function calcCraftCost(recipe, prices) {
  let totalCost = 0;
  for (const slot of Object.keys(recipe)) {
    if (!/^[A-C][1-3]$/.test(slot)) continue;
    if (!recipe[slot]) continue;

    const [id, countRaw] = recipe[slot].split(":");
    const count = parseInt(countRaw || "1", 10);

    if (!prices[id]) return null; // missing ingredient price
    totalCost += prices[id].buy * count;
  }
  return totalCost;
}

// Update or insert profit data for an item into DB
async function upsertProfitData({ item, cost, sellPrice, profit, marginPercent }) {
  const now = Date.now();
  await db.run(
    `
    INSERT INTO craft_margins (item, cost, sellPrice, profit, marginPercent, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item) DO UPDATE SET
      cost=excluded.cost,
      sellPrice=excluded.sellPrice,
      profit=excluded.profit,
      marginPercent=excluded.marginPercent,
      updatedAt=excluded.updatedAt
    `,
    item,
    cost,
    sellPrice,
    profit,
    marginPercent,
    now
  );
}

// Process a single item: fetch recipe, calculate profit, save to DB
async function processItem(item, prices) {
  const recipe = await getRecipe(item);
  if (!recipe) {
    // console.log(`No recipe for ${item}`);
    return;
  }

  const cost = await calcCraftCost(recipe, prices);
  const sellPrice = prices[item]?.sell;

  if (!cost || !sellPrice) return;

  const profit = sellPrice - cost;
  const marginPercent = (profit / cost) * 100;

  if (profit > 0) {
    await upsertProfitData({
      item,
      cost,
      sellPrice,
      profit,
      marginPercent,
    });
    console.log(`Processed ${item}: profit ${profit.toFixed(1)}, margin ${marginPercent.toFixed(2)}%`);
  }
}

// Initial bulk load with concurrency limit
async function initialLoad(prices, items) {
  console.log(`Starting initial load for ${items.length} items...`);
  const limit = pLimit(CONCURRENCY);

  let count = 0;
  const tasks = items.map((item) =>
    limit(async () => {
      await processItem(item, prices);
      count++;
      if (count % 50 === 0 || count === items.length) {
        console.log(`Progress: ${count} / ${items.length} items processed.`);
      }
    })
  );

  await Promise.all(tasks);
  console.log("Initial load complete.");
}

// Periodically update cached items one by one (round robin)
async function periodicUpdate(prices, items) {
  let index = 0;
  setInterval(async () => {
    const item = items[index];
    await processItem(item, prices);
    index = (index + 1) % items.length;
  }, 5000); // update one item every 5 seconds
}

// API handler returns top 25 by profit from DB
async function getTopCraftMargins() {
  return db.all(`
    SELECT item, cost, sellPrice, profit, marginPercent
    FROM craft_margins
    ORDER BY profit DESC
    LIMIT 25
  `);
}

async function start() {
  await openDb();
  const prices = await getBazaarPrices();
  const items = Object.keys(prices);

  // Kick off initial bulk fetch + process
  initialLoad(prices, items).then(() => {
    console.log("Starting periodic updates...");
    periodicUpdate(prices, items);
  });

  const app = express();

  app.get("/craft-margins", async (req, res) => {
    try {
      const top = await getTopCraftMargins();
      res.json(top);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start();
