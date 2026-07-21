import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

async function fetchJsonFromYahoo(paths, timeoutMs = 12000) {
  const hosts = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];
  let lastError = null;

  for (const host of hosts) {
    for (const pathValue of paths) {
      try {
        const response = await fetch(host + pathValue, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://finance.yahoo.com",
            "Referer": "https://finance.yahoo.com/"
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          lastError = new Error(`Yahoo Finance HTTP ${response.status}`);
          continue;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error("Yahoo Finance bağlantısı kurulamadı");
}

function stripHtml(value = "") {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}


app.disable("x-powered-by");
app.use(express.static(publicDir, {
  etag: true,
  maxAge: "1h"
}));

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

async function fetchYahooChart(symbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("interval", "5m");
  url.searchParams.set("range", "1d");
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PortfolioTracker/1.0)",
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance HTTP ${response.status}`);
  }

  const data = await response.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    const description = data?.chart?.error?.description || "Sembol bulunamadı";
    throw new Error(description);
  }

  const meta = result.meta || {};
  const price = safeNumber(meta.regularMarketPrice);
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(Number.isFinite);
  const previousClose =
    safeNumber(meta.chartPreviousClose) ??
    safeNumber(meta.previousClose);

  let changePercent = null;
  if (price !== null && previousClose !== null && previousClose !== 0) {
    changePercent = ((price - previousClose) / previousClose) * 100;
  }

  return {
    symbol,
    price,
    previousClose,
    changePercent,
    currency: meta.currency || null,
    exchange: meta.exchangeName || meta.fullExchangeName || null,
    marketTime: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : null,
    timezone: meta.exchangeTimezoneName || null,
    instrumentType: meta.instrumentType || null,
    delay: meta.exchangeDataDelayedBy ?? null,
    sparkline: closes.length > 90 ? closes.filter((_,i)=>i % Math.ceil(closes.length/90) === 0) : closes
  };
}


const SP500_FALLBACK = [
"AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","BRK-B","AVGO","TSLA","LLY","JPM","WMT","V","ORCL","MA","XOM","COST","NFLX","JNJ","HD","PG","BAC","ABBV","KO","PLTR","CRM","CSCO","CVX","IBM","WFC","PM","GE","ABT","MCD","NOW","DIS","INTU","AXP","CAT","TMO","MRK","ISRG","GS","PEP","QCOM","TXN","RTX","AMGN","AMD"
];

let sp500Cache = { at: 0, items: [] };
async function fetchSP500Universe() {
  if (sp500Cache.items.length && Date.now() - sp500Cache.at < 24 * 60 * 60 * 1000) return sp500Cache.items;
  try {
    const response = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", {
      headers: { "User-Agent": "PortfolioTracker/2.0" },
      signal: AbortSignal.timeout(12000)
    });
    const page = await response.text();
    const table = page.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i)?.[0] || "";
    const symbols = [...table.matchAll(/<tr>[\s\S]*?<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi)]
      .map(m => m[1].trim().replace(".", "-"))
      .filter(Boolean);
    const unique = [...new Set(symbols)];
    if (unique.length > 400) {
      sp500Cache = { at: Date.now(), items: unique.map(s => ({ s, n: s, sub: "S&P 500" })) };
      return sp500Cache.items;
    }
  } catch {}
  return SP500_FALLBACK.map(s => ({ s, n: s, sub: "S&P 500 (özet)" }));
}


let usMostActiveCache = { at: 0, items: [] };

async function fetchUSMostActive() {
  if (usMostActiveCache.items.length && Date.now() - usMostActiveCache.at < 5 * 60 * 1000) {
    return usMostActiveCache.items;
  }

  const fallback = [
    "AAPL","NVDA","TSLA","AMD","AMZN","MSFT","META","INTC","PLTR","BAC",
    "F","SOFI","AAL","NIO","PFE","T","LCID","RIVN","MARA","CCL",
    "SNAP","WBD","VALE","NU","UBER","GOOGL","GOOG","CSCO","MU","AVGO",
    "JPM","WFC","XOM","CVX","KO","DIS","NFLX","PYPL","SHOP","COIN",
    "HOOD","ARM","SMCI","QCOM","ORCL","CRM","IBM","GE","BA","GM",
    "DAL","UAL","LUV","C","GS","MS","V","MA","WMT","TGT",
    "NKE","SBUX","MCD","PEP","ABNB","RBLX","DKNG","ROKU","BABA","JD",
    "PDD","LI","XPEV","TME","BIDU","MRVL","ON","TXN","AMAT","LRCX",
    "KLAC","ASML","TSM","DELL","HPQ","HPE","PANW","CRWD","NET","SNOW",
    "PATH","AI","IONQ","RGTI","QBTS","OKLO","SMR","SOUN","RKLB","ASTS"
  ].map((s) => ({ s, n: s, sub: "US Stocks" }));

  try {
    const json = await fetchJsonFromYahoo([
      "/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100&start=0",
      "/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100"
    ]);
    const quotes = json?.finance?.result?.[0]?.quotes || [];
    const items = quotes
      .filter((q) => q?.symbol)
      .slice(0, 100)
      .map((q) => ({
        s: q.symbol,
        n: q.shortName || q.longName || q.symbol,
        sub: "US Stocks"
      }));
    if (items.length >= 20) {
      usMostActiveCache = { at: Date.now(), items };
      return items;
    }
  } catch {}

  try {
    const response = await fetch("https://finance.yahoo.com/markets/stocks/most-active/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(12000)
    });
    const page = await response.text();
    const symbols = [...page.matchAll(/"symbol":"([A-Z0-9.\-^=]+)"/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith("^"));
    const unique = [...new Set(symbols)].slice(0, 100);
    if (unique.length >= 20) {
      const items = unique.map((s) => ({ s, n: s, sub: "US Stocks" }));
      usMostActiveCache = { at: Date.now(), items };
      return items;
    }
  } catch {}

  return fallback;
}

app.get("/api/universe/us-most-active", async (_req, res) => {
  const items = await fetchUSMostActive();
  res.set("Cache-Control", "public, max-age=120, s-maxage=120");
  res.json({ items, count: items.length });
});

app.get("/api/universe/sp500", async (_req, res) => {
  const items = await fetchSP500Universe();
  res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.json({ items, count: items.length });
});



function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function momentumFromCloses(closes, periods) {
  if (!Array.isArray(closes) || closes.length <= periods) return null;
  const current = closes.at(-1);
  const past = closes.at(-(periods + 1));
  if (!Number.isFinite(current) || !Number.isFinite(past) || past === 0) return null;
  return ((current - past) / past) * 100;
}

function detectAssetType(symbol, meta = {}, quoteType = "") {
  const type = String(quoteType || meta.instrumentType || "").toUpperCase();
  if (type.includes("ETF") || type.includes("MUTUALFUND")) return "etf";
  if (type.includes("CRYPTO") || symbol.endsWith("-USD")) return "crypto";
  if (type.includes("CURRENCY") || symbol.endsWith("=X")) return "fx";
  if (type.includes("FUTURE") || symbol.endsWith("=F")) return "future";
  if (type.includes("INDEX") || symbol.startsWith("^") || symbol.startsWith("XU")) return "index";
  return "equity";
}

function assetTypeLabel(type) {
  return {
    equity: "Hisse Senedi",
    etf: "ETF / Fon",
    crypto: "Kripto Varlık",
    fx: "Döviz Paritesi",
    future: "Vadeli Kontrat / Emtia",
    commodity: "Emtia",
    index: "Endeks"
  }[type] || type;
}

function parseFxPair(symbol) {
  const clean = symbol.replace("=X", "");
  if (clean === "TRY") return { base: "USD", quote: "TRY" };
  if (clean === "JPY") return { base: "USD", quote: "JPY" };
  if (clean.length >= 6) return { base: clean.slice(0, 3), quote: clean.slice(3, 6) };
  return { base: null, quote: null };
}

function rawValue(obj, key) {
  const value = obj?.[key];
  if (value && typeof value === "object" && "raw" in value) return safeNumber(value.raw);
  return safeNumber(value);
}

async function fetchHistoricalVolatility100d(symbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("range", "6mo");
  url.searchParams.set("events", "div,splits");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PortfolioTracker/4.0)",
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) return null;
  const data = await response.json();
  const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
    .filter(Number.isFinite)
    .slice(-101);

  if (closes.length < 20) return null;

  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

async function fetchYahooDetails(symbol) {
  const encoded = encodeURIComponent(symbol);

  const chartPromise = fetchJsonFromYahoo([
    `/v8/finance/chart/${encoded}?interval=1d&range=1y&events=div%2Csplits`,
    `/v8/finance/chart/${encoded}?interval=1d&range=6mo&events=div%2Csplits`
  ]);

  const summaryPromise = fetchJsonFromYahoo([
    `/v10/finance/quoteSummary/${encoded}?modules=price%2CsummaryDetail%2CdefaultKeyStatistics%2CfinancialData%2CassetProfile%2CincomeStatementHistory%2CbalanceSheetHistory`
  ]).catch(() => null);

  const [chartPayload, summaryPayload] = await Promise.all([chartPromise, summaryPromise]);

  const chartResult = chartPayload?.chart?.result?.[0];
  if (!chartResult) {
    throw new Error(chartPayload?.chart?.error?.description || "Fiyat bilgisi bulunamadı");
  }

  const meta = chartResult.meta || {};
  const quoteSeries = chartResult?.indicators?.quote?.[0] || {};
  const closes = (quoteSeries.close || []).filter(Number.isFinite);
  const highs = (quoteSeries.high || []).filter(Number.isFinite);
  const lows = (quoteSeries.low || []).filter(Number.isFinite);
  const opens = (quoteSeries.open || []).filter(Number.isFinite);
  const volumes = (quoteSeries.volume || []).filter(Number.isFinite);
  const latestPrice = safeNumber(meta.regularMarketPrice) ?? closes.at(-1) ?? null;
  const previousClose =
    safeNumber(meta.chartPreviousClose) ??
    safeNumber(meta.previousClose) ??
    (closes.length > 1 ? closes.at(-2) : null);

  const changePercent =
    latestPrice !== null && previousClose !== null && previousClose !== 0
      ? ((latestPrice - previousClose) / previousClose) * 100
      : null;

  const sma50 = closes.length >= 50 ? average(closes.slice(-50)) : null;
  const sma200 = closes.length >= 200 ? average(closes.slice(-200)) : null;
  const distanceFromSma50 =
    latestPrice !== null && sma50 ? ((latestPrice - sma50) / sma50) * 100 : null;
  const distanceFromSma200 =
    latestPrice !== null && sma200 ? ((latestPrice - sma200) / sma200) * 100 : null;

  let volatility20d = null;
  const vol20Closes = closes.slice(-21);
  if (vol20Closes.length >= 10) {
    const rets = [];
    for (let i = 1; i < vol20Closes.length; i++) {
      if (vol20Closes[i - 1] > 0 && vol20Closes[i] > 0) {
        rets.push(Math.log(vol20Closes[i] / vol20Closes[i - 1]));
      }
    }
    if (rets.length > 1) {
      const mean20 = average(rets);
      const variance20 = rets.reduce((sum, r) => sum + (r - mean20) ** 2, 0) / (rets.length - 1);
      volatility20d = Math.sqrt(variance20) * Math.sqrt(252) * 100;
    }
  }

  const dayHigh = highs.at(-1) ?? null;
  const dayLow = lows.at(-1) ?? null;
  const dayOpen = opens.at(-1) ?? null;
  const currentVolume = volumes.at(-1) ?? null;
  const dailyRangePercent =
    dayHigh !== null && dayLow !== null && previousClose
      ? ((dayHigh - dayLow) / previousClose) * 100
      : null;

  let volatility = null;
  const volatilityCloses = closes.slice(-101);
  if (volatilityCloses.length >= 20) {
    const returns = [];
    for (let i = 1; i < volatilityCloses.length; i++) {
      if (volatilityCloses[i - 1] > 0 && volatilityCloses[i] > 0) {
        returns.push(Math.log(volatilityCloses[i] / volatilityCloses[i - 1]));
      }
    }
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
      volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }
  }

  const result = summaryPayload?.quoteSummary?.result?.[0] || {};
  const price = result.price || {};
  const summary = result.summaryDetail || {};
  const stats = result.defaultKeyStatistics || {};
  const financial = result.financialData || {};
  const profile = result.assetProfile || {};
  const quoteType = price.quoteType || meta.instrumentType || "";
  const assetType = detectAssetType(symbol, meta, quoteType);
  const fxPair = assetType === "fx" ? parseFxPair(symbol) : { base: null, quote: null };
  const income = result.incomeStatementHistory?.incomeStatementHistory?.[0] || {};
  const balance = result.balanceSheetHistory?.balanceSheetStatements?.[0] || {};

  const dividendYieldRaw = rawValue(summary, "dividendYield");
  const totalCash = rawValue(financial, "totalCash");
  const totalDebt = rawValue(financial, "totalDebt");
  const netCash =
    totalCash !== null && totalDebt !== null ? totalCash - totalDebt : null;
  const sharesOutstanding = rawValue(stats, "sharesOutstanding");
  const floatShares = rawValue(stats, "floatShares");
  const floatRatio =
    sharesOutstanding && floatShares ? (floatShares / sharesOutstanding) * 100 : null;
  const debtToEquityComputed =
    rawValue(financial, "debtToEquity") ??
    (
      totalDebt !== null &&
      (rawValue(balance, "stockholdersEquity") ?? rawValue(balance, "totalStockholderEquity"))
        ? totalDebt /
          (rawValue(balance, "stockholdersEquity") ?? rawValue(balance, "totalStockholderEquity"))
        : null
    );
  const netMarginRaw = rawValue(financial, "profitMargins");
  const roeRaw = rawValue(financial, "returnOnEquity");
  const roaRaw = rawValue(financial, "returnOnAssets");

  return {
    symbol,
    name: price.longName || price.shortName || meta.longName || meta.shortName || symbol,
    currency: price.currency || financial.financialCurrency || meta.currency || null,
    exchange: price.exchangeName || price.fullExchangeName || meta.fullExchangeName || meta.exchangeName || null,
    assetType,
    assetTypeLabel: assetTypeLabel(assetType),
    open: dayOpen,
    previousClose,
    dayHigh,
    dayLow,
    volume: currentVolume,
    dailyRangePercent,
    volatility20d,
    sma50,
    sma200,
    distanceFromSma50,
    distanceFromSma200,
    momentum20d: momentumFromCloses(closes, 20),
    momentum50d: momentumFromCloses(closes, 50),
    momentum200d: momentumFromCloses(closes, 200),
    sector: profile.sector || null,
    industry: profile.industry || null,
    price: rawValue(financial, "currentPrice") ?? rawValue(price, "regularMarketPrice") ?? latestPrice,
    changePercent,
    trailingPE: rawValue(summary, "trailingPE") ?? rawValue(stats, "trailingPE"),
    priceToBook: rawValue(stats, "priceToBook"),
    bookValue: rawValue(stats, "bookValue"),
    beta: rawValue(stats, "beta"),
    enterpriseToEbitda: rawValue(stats, "enterpriseToEbitda"),
    enterpriseValue: rawValue(stats, "enterpriseValue"),
    totalCash,
    totalDebt,
    netCash,
    netIncome: rawValue(income, "netIncome"),
    stockholdersEquity:
      rawValue(balance, "stockholdersEquity") ??
      rawValue(balance, "totalStockholderEquity"),
    ebitda: rawValue(financial, "ebitda"),
    trailingEps: rawValue(stats, "trailingEps"),
    dividendYield: dividendYieldRaw === null ? null : dividendYieldRaw * 100,
    marketCap: rawValue(price, "marketCap") ?? rawValue(summary, "marketCap"),
    floatShares,
    sharesOutstanding,
    floatRatio,
    debtToEquityComputed,
    currentRatio: rawValue(financial, "currentRatio"),
    netMargin: netMarginRaw === null ? null : netMarginRaw * 100,
    returnOnEquity: roeRaw === null ? null : roeRaw * 100,
    returnOnAssets: roaRaw === null ? null : roaRaw * 100,
    historicalVolatility100d: volatility,
    fiftyTwoWeekHigh: rawValue(summary, "fiftyTwoWeekHigh") ?? safeNumber(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: rawValue(summary, "fiftyTwoWeekLow") ?? safeNumber(meta.fiftyTwoWeekLow),
    averageVolume: rawValue(summary, "averageVolume"),
    contractSymbol: assetType === "future" ? symbol : null,
    expirationDate: meta.expireDate
      ? new Date(meta.expireDate * 1000).toISOString().slice(0, 10)
      : null,
    openInterest: rawValue(summary, "openInterest"),
    contractSize: safeNumber(meta.contractSize),
    underlying: meta.underlyingSymbol || null,
    baseCurrency: fxPair.base,
    quoteCurrency: fxPair.quote,
    circulatingSupply: rawValue(summary, "circulatingSupply"),
    totalSupply: rawValue(summary, "totalSupply"),
    volume24h: rawValue(summary, "volume24Hr") ?? currentVolume,
    indexWeight: null,
    indexImpact: null,
    fetchedAt: new Date().toISOString(),
    sourceStatus: summaryPayload ? "Yahoo Finance fiyat ve temel veriler" : "Yahoo Finance fiyat verileri; temel veriler geçici olarak erişilemiyor"
  };
}

app.get("/api/details", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "Sembol gereklidir." });

  try {
    const details = await fetchYahooDetails(symbol);
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");
    res.json(details);
  } catch (error) {
    res.status(502).json({ error: error?.message || "Finansal bilgiler alınamadı." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "portfolio-tracker" });
});

app.get("/api/quotes", async (req, res) => {
  const symbols = String(req.query.symbols || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);

  if (!symbols.length) {
    return res.status(400).json({ error: "En az bir sembol gereklidir." });
  }

  const settled = await Promise.allSettled(symbols.map(fetchYahooChart));
  const quotes = {};
  const errors = {};

  settled.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === "fulfilled") {
      quotes[symbol] = result.value;
    } else {
      errors[symbol] = result.reason?.message || "Veri alınamadı";
    }
  });

  res.set("Cache-Control", "public, max-age=20, s-maxage=20");
  res.json({
    source: "Yahoo Finance (unofficial endpoint)",
    delayed: true,
    fetchedAt: new Date().toISOString(),
    quotes,
    errors
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Portfolio Tracker running on port ${PORT}`);
});
