#!/usr/bin/env node
// Fetches real market data for every public entity in data/ecosystem.json and writes
// data/market-caps.json (+ refreshes the inline fallback snapshot in index.html).
// No API key required. Sources, in order of preference:
//   1. Nasdaq quote API (api.nasdaq.com)   -> market cap (all share classes)
//   2. Yahoo Finance chart API (v8)        -> last price, previous close, daily % change
//   3. Fallback: last known shares (from a previous successful run) x live Yahoo price
// Private companies are copied from the config with their source + date (never estimated here).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "data", "ecosystem.json");
const OUT = path.join(ROOT, "data", "market-caps.json");
const HTML = path.join(ROOT, "index.html");
// Nasdaq wants a browser-like UA; Yahoo rate-limits full browser UAs without cookies (HTTP 429) but accepts a bare one.
const UA_BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const UA_SIMPLE = "Mozilla/5.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}, { tries = 3, timeoutMs = 20000, ua = UA_BROWSER } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const u = typeof url === "function" ? url(i) : url;
      const res = await fetch(u, {
        headers: { "User-Agent": ua, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", ...headers },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${typeof url === "function" ? url(0) : url} -> ${lastErr?.message || lastErr}`);
}

const num = (v) => {
  if (v == null) return NaN;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

async function yahooChart(symbol) {
  const d = await getJson((i) => `https://query${i % 2 ? 2 : 1}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {}, { ua: UA_SIMPLE });
  const m = d?.chart?.result?.[0]?.meta;
  if (!m || !Number.isFinite(m.regularMarketPrice)) throw new Error(`no Yahoo price for ${symbol}`);
  const prev = Number(m.chartPreviousClose ?? m.previousClose);
  const price = Number(m.regularMarketPrice);
  const changePct = Number.isFinite(m.regularMarketChangePercent)
    ? Number(m.regularMarketChangePercent)
    : (prev > 0 ? (price / prev - 1) * 100 : null);
  return {
    price, previousClose: Number.isFinite(prev) ? prev : null, changePct,
    currency: m.currency || "USD",
    marketTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    exchange: m.fullExchangeName || m.exchangeName || null
  };
}

async function nasdaqMarketCap(symbol) {
  const d = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`,
    { Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" }, { tries: 2, timeoutMs: 15000 });
  const cap = num(d?.data?.summaryData?.MarketCap?.value);
  if (!(cap > 0)) throw new Error(`no Nasdaq market cap for ${symbol}`);
  return cap;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const config = JSON.parse(await fs.readFile(CONFIG, "utf8"));
let previous = null;
try { previous = JSON.parse(await fs.readFile(OUT, "utf8")); } catch {}

const fx = {};
const failures = [];
const entities = {};
const generatedAt = new Date().toISOString();

// FX for non-USD listings
const currencies = new Set(Object.values(config.entities).filter((e) => e.type === "public" && e.currency && e.currency !== "USD").map((e) => e.currency));
for (const c of currencies) {
  try { fx[c] = (await yahooChart(`${c}=X`)).price; } // USD -> c (e.g. 18.47 MXN per USD)
  catch (e) { failures.push({ id: `FX:${c}`, error: e.message }); fx[c] = previous?.fx?.[c] ?? null; }
}

const publicIds = Object.keys(config.entities).filter((id) => config.entities[id].type === "public");
await mapLimit(publicIds, 4, async (id) => {
  const e = config.entities[id];
  const prev = previous?.entities?.[id];
  const rec = { id, name: e.name, type: "public", symbol: e.symbol, note: e.note || null };
  try {
    const q = await yahooChart(e.symbol);
    Object.assign(rec, q);
    let cap = NaN, capSource = null;
    if ((e.currency || "USD") === "USD") {
      try { cap = await nasdaqMarketCap(e.symbol); capSource = "Nasdaq quote API (market cap)"; }
      catch (err) { failures.push({ id, warn: err.message }); }
    }
    if (!(cap > 0) && e.sharesOutstanding > 0) {
      const rate = (e.currency && e.currency !== "USD") ? fx[e.currency] : 1;
      if (rate > 0) { cap = (q.price * e.sharesOutstanding) / rate; capSource = `Yahoo price x ${e.sharesOutstanding.toLocaleString("en-US")} shares (${e.sharesSource}, ${e.sharesAsOf})${rate !== 1 ? ` / USD${e.currency} ${rate}` : ""}`; }
    }
    if (!(cap > 0) && prev?.sharesImplied > 0) {
      cap = q.price * prev.sharesImplied; capSource = "Yahoo price x shares implied by last successful Nasdaq read";
    }
    if (!(cap > 0)) throw new Error("no market cap source succeeded");
    rec.marketCapUsd = Math.round(cap);
    rec.marketCapSource = capSource;
    rec.priceSource = "Yahoo Finance chart API";
    rec.sharesImplied = (e.currency || "USD") === "USD" ? Math.round(cap / q.price) : e.sharesOutstanding;
    rec.stale = false;
  } catch (err) {
    failures.push({ id, error: err.message });
    if (prev?.marketCapUsd) Object.assign(rec, prev, { stale: true });
    else rec.marketCapUsd = null;
  }
  entities[id] = rec;
});

for (const [id, e] of Object.entries(config.entities)) {
  if (e.type !== "private") continue;
  entities[id] = { id, name: e.name, type: "private", valuationUsd: e.valuationUsd, asOf: e.asOf, basis: e.basis, source: e.source, note: e.note || null };
}

// De-duplicated totals: every platform resolves to one owning entity; each entity counted once.
const used = [...new Set(config.platforms.map((p) => p.entity))];
let publicUsd = 0, privateUsd = 0, publicPrevUsd = 0, missing = [];
for (const id of used) {
  const r = entities[id];
  if (!r) { missing.push(id); continue; }
  if (r.type === "public") {
    if (!(r.marketCapUsd > 0)) { missing.push(id); continue; }
    publicUsd += r.marketCapUsd;
    const ch = Number(r.changePct);
    publicPrevUsd += Number.isFinite(ch) ? r.marketCapUsd / (1 + ch / 100) : r.marketCapUsd;
  } else {
    privateUsd += r.valuationUsd || 0;
  }
}
const lastMarketTime = Object.values(entities).map((r) => r.marketTime).filter(Boolean).sort().pop() || null;

const out = {
  schema: 1,
  generatedAt,
  marketDataAsOf: lastMarketTime,
  sources: {
    marketCap: "Nasdaq quote API (api.nasdaq.com/api/quote/{SYMBOL}/summary) — total market cap across share classes",
    price: "Yahoo Finance chart API (query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}) — last price and daily % change",
    private: "Latest publicly reported valuation, see each entity's source URL and asOf date",
    fx: "Yahoo Finance chart API ({CCY}=X)"
  },
  fx,
  totals: {
    ecosystemUsd: publicUsd + privateUsd,
    publicUsd,
    privateUsd,
    publicDailyChangePct: publicPrevUsd > 0 ? (publicUsd / publicPrevUsd - 1) * 100 : null,
    entityCount: used.length,
    publicEntityCount: used.filter((id) => entities[id]?.type === "public").length,
    privateEntityCount: used.filter((id) => entities[id]?.type === "private").length,
    platformCount: config.platforms.length,
    missing
  },
  entities,
  platforms: config.platforms,
  failures
};

await fs.writeFile(OUT, JSON.stringify(out, null, 2) + "\n");

// Refresh the inline fallback snapshot in index.html (used if data/market-caps.json can't be loaded).
try {
  const html = await fs.readFile(HTML, "utf8");
  const re = /(<script id="ssa-seed-snapshot" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (re.test(html)) {
    const seed = JSON.stringify(out).replace(/</g, "\\u003c");
    await fs.writeFile(HTML, html.replace(re, (_m, open, close) => open + seed + close)); // function form: "$" in data must not be treated as a pattern
  }
} catch (e) { console.warn("Could not refresh inline snapshot:", e.message); }

const fmt = (n) => "$" + (n / 1e12).toFixed(3) + "T";
console.log(`Ecosystem ${fmt(out.totals.ecosystemUsd)} = public ${fmt(publicUsd)} + private ${fmt(privateUsd)} across ${used.length} entities (${config.platforms.length} platforms)`);
if (failures.length) console.log("Issues:", JSON.stringify(failures, null, 1));
const hardFail = failures.filter((f) => f.error).length;
if (hardFail > publicIds.length / 2) { console.error("Too many failures; refusing to treat this as a good update."); process.exit(1); }
