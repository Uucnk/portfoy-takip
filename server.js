import express from "express";
import path from "node:path";
import fs from "node:fs";
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
  maxAge: "1h",
  index: false
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

  const quotePromise = fetchJsonFromYahoo([
    `/v7/finance/quote?symbols=${encoded}`
  ]).catch(() => null);

  const [chartPayload, summaryPayload, quotePayload] = await Promise.all([chartPromise, summaryPromise, quotePromise]);

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
  const quoteRow = quotePayload?.quoteResponse?.result?.[0] || {};
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
    name: price.longName || price.shortName || quoteRow.longName || quoteRow.shortName || meta.longName || meta.shortName || symbol,
    currency: price.currency || quoteRow.currency || financial.financialCurrency || meta.currency || null,
    exchange: price.exchangeName || price.fullExchangeName || quoteRow.fullExchangeName || quoteRow.exchange || meta.fullExchangeName || meta.exchangeName || null,
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
    price: rawValue(financial, "currentPrice") ?? rawValue(price, "regularMarketPrice") ?? safeNumber(quoteRow.regularMarketPrice) ?? latestPrice,
    changePercent,
    trailingPE: rawValue(summary, "trailingPE") ?? rawValue(stats, "trailingPE") ?? safeNumber(quoteRow.trailingPE),
    priceToBook: rawValue(stats, "priceToBook") ?? safeNumber(quoteRow.priceToBook),
    bookValue: rawValue(stats, "bookValue"),
    beta: rawValue(stats, "beta") ?? safeNumber(quoteRow.beta),
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
    trailingEps: rawValue(stats, "trailingEps") ?? safeNumber(quoteRow.epsTrailingTwelveMonths),
    dividendYield: dividendYieldRaw === null ? null : dividendYieldRaw * 100,
    marketCap: rawValue(price, "marketCap") ?? rawValue(summary, "marketCap") ?? safeNumber(quoteRow.marketCap),
    floatShares,
    sharesOutstanding,
    floatRatio,
    debtToEquityComputed,
    currentRatio: rawValue(financial, "currentRatio"),
    netMargin: netMarginRaw === null ? null : netMarginRaw * 100,
    returnOnEquity: roeRaw === null ? null : roeRaw * 100,
    returnOnAssets: roaRaw === null ? null : roaRaw * 100,
    historicalVolatility100d: volatility,
    fiftyTwoWeekHigh: rawValue(summary, "fiftyTwoWeekHigh") ?? safeNumber(quoteRow.fiftyTwoWeekHigh) ?? safeNumber(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: rawValue(summary, "fiftyTwoWeekLow") ?? safeNumber(quoteRow.fiftyTwoWeekLow) ?? safeNumber(meta.fiftyTwoWeekLow),
    averageVolume: rawValue(summary, "averageVolume") ?? safeNumber(quoteRow.averageDailyVolume3Month) ?? safeNumber(quoteRow.averageDailyVolume10Day),
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


const FUND_CATEGORY_RULES=[["Para Piyasası",["PARA PİYASASI"]],["Borçlanma Araçları",["BORÇLANMA ARAÇLARI","EUROBOND","TAHVİL","BONO"]],["Hisse Senedi",["HİSSE SENEDİ"]],["Kıymetli Madenler",["KIYMETLİ MADEN","ALTIN","GÜMÜŞ"]],["Katılım",["KATILIM"]],["Fon Sepeti",["FON SEPETİ"]],["Değişken",["DEĞİŞKEN"]],["Karma",["KARMA"]],["Serbest",["SERBEST"]],["Garantili",["GARANTİLİ"]],["Koruma Amaçlı",["KORUMA AMAÇLI"]],["Özel",["ÖZEL"]],["Emeklilik",["EMEKLİLİK"]],["Borsa Yatırım Fonları",["BORSA YATIRIM FONU"]]];
function classifyFundServer(name=""){const u=String(name).toLocaleUpperCase("tr-TR");for(const [l,w] of FUND_CATEGORY_RULES)if(w.some(x=>u.includes(x)))return l;return"Diğer"}
function toNumberFlexible(v){if(v==null||v==="")return null;if(typeof v==="number")return Number.isFinite(v)?v:null;const n=Number(String(v).replace(/\./g,"").replace(",","."));return Number.isFinite(n)?n:null}
async function tefasPost(endpoint,payload){const r=await fetch(`https://www.tefas.gov.tr/api/funds/${endpoint}`,{method:"POST",headers:{"User-Agent":"Mozilla/5.0 Chrome/124 Safari/537.36","Accept":"application/json,text/plain,*/*","Content-Type":"application/json","Origin":"https://www.tefas.gov.tr","Referer":"https://www.tefas.gov.tr/"},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});const t=await r.text();if(!r.ok)throw new Error(`TEFAS HTTP ${r.status}`);try{return JSON.parse(t)}catch{throw new Error("TEFAS geçerli JSON döndürmedi")}}
function dateTR(d=new Date()){return new Intl.DateTimeFormat("tr-TR",{day:"2-digit",month:"2-digit",year:"numeric",timeZone:"Europe/Istanbul"}).format(d)}
function flattenTefasRows(p){if(Array.isArray(p))return p;for(const k of["data","Data","funds","fonlar","result","Result","items"])if(Array.isArray(p?.[k]))return p[k];return[]}
function normalizeFundRow(r,kind="YAT"){const code=r.FONKODU||r.FONKOD||r.fonKodu||r.fundCode||r.code||r.KOD,name=r.FONUNVAN||r.FONUNVANI||r.fonUnvan||r.fundName||r.name||r.UNVAN;if(!code||!name)return null;return{code:String(code).trim(),name:String(name).trim(),price:toNumberFlexible(r.FIYAT??r.SONFIYAT??r.price),dailyReturn:toNumberFlexible(r.GUNLUKGETIRI??r.dailyReturn),portfolioSize:toNumberFlexible(r.PORTFOYBUYUKLUK??r.FON_TOPLAM_DEGERI??r.portfolioSize),investorCount:toNumberFlexible(r.KISISAYISI??r.YATIRIMCISAYISI??r.investorCount),sharesOutstanding:toNumberFlexible(r.TEDPAYSAYISI??r.PAYADEDI??r.sharesOutstanding),manager:r.KURUCU||r.YONETICI||r.manager||null,kind:r.FONTUR||r.kind||kind,date:r.TARIH||r.date||null,category:classifyFundServer(name)}}
let tefasFundCache={at:0,funds:[]};

async function fetchAllTefasFunds(force=false){
 if(!force&&tefasFundCache.funds.length&&Date.now()-tefasFundCache.at<30*60*1000)return tefasFundCache.funds;
 const todayCompact=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"})
   .format(new Date()).replaceAll("-","");
 const kinds=["YAT","EMK","BYF","GYF","GSYF"];
 const all=[];
 for(const kind of kinds){
  const body={
   fonTipi:kind,fonKodu:null,aramaMetni:null,fonTurKod:null,fonGrubu:null,
   sfonTurKod:null,fonTurAciklama:null,kurucuKod:null,
   basTarih:todayCompact,bitTarih:todayCompact,basSira:1,bitSira:100000,
   dil:"TR",sFonTurKod:"",fonKod:"",fonGrup:"",fonUnvanTip:""
  };
  try{
   const result=await tefasPost("fonGnlBlgSiraliGetir",body);
   const rows=Array.isArray(result?.resultList)?result.resultList:[];
   for(const row of rows){
    const code=row.fonKodu;
    const name=row.fonUnvan;
    if(!code||!name)continue;
    all.push({
     code:String(code).trim().toUpperCase(),
     name:String(name).trim(),
     price:toNumberFlexible(row.fiyat),
     dailyReturn:null,
     portfolioSize:toNumberFlexible(row.portfoyBuyukluk),
     investorCount:toNumberFlexible(row.kisiSayisi),
     sharesOutstanding:toNumberFlexible(row.tedPaySayisi),
     manager:null,
     kind,
     date:row.tarih||null,
     category:classifyFundServer(name)
    });
   }
  }catch(error){
   console.warn(`TEFAS ${kind} alınamadı:`,error?.message);
  }
 }
 const unique=[...new Map(all.map(f=>[f.code,f])).values()].sort((a,b)=>a.code.localeCompare(b.code,"tr"));
 if(!unique.length){
  if(tefasFundCache.funds.length)return tefasFundCache.funds;
  throw new Error("TEFAS fon listesi şu anda alınamadı");
 }
 tefasFundCache={at:Date.now(),funds:unique};
 return unique;
}

function calculateFundStats(points){const prices=points.map(p=>toNumberFlexible(p.price??p.FIYAT??p.fiyat)).filter(Number.isFinite);if(prices.length<2)return{};const ret=d=>prices.length>d&&prices.at(-(d+1))?((prices.at(-1)/prices.at(-(d+1)))-1)*100:null,returns=[];for(let i=1;i<prices.length;i++)if(prices[i-1]>0&&prices[i]>0)returns.push(Math.log(prices[i]/prices[i-1]));let volatility=null,sharpe=null,maxDrawdown=0;if(returns.length>1){const avg=returns.reduce((a,b)=>a+b,0)/returns.length,v=returns.reduce((s,r)=>s+(r-avg)**2,0)/(returns.length-1);volatility=Math.sqrt(v)*Math.sqrt(252)*100;sharpe=v>0?(avg*252)/(Math.sqrt(v)*Math.sqrt(252)):null}let peak=prices[0];for(const p of prices){peak=Math.max(peak,p);maxDrawdown=Math.max(maxDrawdown,((peak-p)/peak)*100)}return{return1m:ret(21),return3m:ret(63),return6m:ret(126),return1y:ret(252),volatility,sharpe,maxDrawdown}}
app.get("/api/funds",async(req,res)=>{try{const funds=await fetchAllTefasFunds(req.query.refresh==="1");res.set("Cache-Control","public, max-age=600, s-maxage=600");res.json({source:"TEFAS",count:funds.length,funds})}catch(e){res.status(502).json({error:e?.message||"TEFAS fon verileri alınamadı"})}});
app.get("/api/funds/:code",async(req,res)=>{const code=String(req.params.code||"").trim().toUpperCase();try{const funds=await fetchAllTefasFunds(),base=funds.find(f=>f.code===code);if(!base)return res.status(404).json({error:"Fon bulunamadı"});let profile={},pricePayload=null;try{profile=await tefasPost("fonProfilDtyGetir",{fonKodu:code,dil:"TR"})}catch{}try{pricePayload=await tefasPost("fonFiyatBilgiGetir",{fonKodu:code,dil:"TR",periyod:12})}catch{}const stats=calculateFundStats(flattenTefasRows(pricePayload||{})),pr=flattenTefasRows(profile)[0]||profile?.data||profile||{};res.json({...base,return1m:toNumberFlexible(pr.GETIRI1A??pr.return1m)??stats.return1m,return3m:toNumberFlexible(pr.GETIRI3A??pr.return3m)??stats.return3m,return6m:toNumberFlexible(pr.GETIRI6A??pr.return6m)??stats.return6m,return1y:toNumberFlexible(pr.GETIRI1Y??pr.return1y)??stats.return1y,riskValue:toNumberFlexible(pr.RISKDEGERI??pr.riskValue),managementFee:toNumberFlexible(pr.YONETIMUCRETI??pr.managementFee),volatility:stats.volatility,sharpe:stats.sharpe,maxDrawdown:stats.maxDrawdown,source:"TEFAS halka açık fon servisleri"})}catch(e){res.status(502).json({error:e?.message||"Fon detayı alınamadı"})}});


const yahooSearchCache=new Map();
async function searchYahooProducts(query){
 const key=query.toUpperCase();
 const cached=yahooSearchCache.get(key);
 if(cached&&Date.now()-cached.at<5*60*1000)return cached.items;
 const url=`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=80&newsCount=0&enableFuzzyQuery=false&lang=tr-TR&region=TR`;
 const response=await fetch(url,{
  headers:{
   "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
   "Accept":"application/json,text/plain,*/*"
  },
  signal:AbortSignal.timeout(15000)
 });
 if(!response.ok)throw new Error(`Yahoo arama HTTP ${response.status}`);
 const data=await response.json();
 const items=(Array.isArray(data?.quotes)?data.quotes:[]).map(q=>({
  symbol:String(q.symbol||"").toUpperCase(),
  yahooSymbol:String(q.symbol||"").toUpperCase(),
  name:q.longname||q.shortname||q.symbol,
  type:q.quoteType||q.typeDisp||"Ürün",
  exchange:q.exchDisp||q.exchange||"",
  source:"Yahoo Finance"
 })).filter(x=>x.symbol);
 yahooSearchCache.set(key,{at:Date.now(),items});
 return items;
}
app.get("/api/search",async(req,res)=>{
 const query=String(req.query.q||"").trim().toUpperCase();
 if(!query)return res.json({items:[]});
 try{
  const [yahooResult,fundResult]=await Promise.allSettled([
   searchYahooProducts(query),
   fetchAllTefasFunds(false)
  ]);
  const yahoo=yahooResult.status==="fulfilled"?yahooResult.value:[];
  const funds=fundResult.status==="fulfilled"
   ?fundResult.value.filter(f=>f.code.startsWith(query)||f.name.toLocaleUpperCase("tr-TR").includes(query)).slice(0,80).map(f=>({
      symbol:f.code,yahooSymbol:f.code,name:f.name,type:"Fon",exchange:"TEFAS",isFund:true,source:"TEFAS"
    }))
   :[];
  const merged=[...funds,...yahoo];
  const unique=[...new Map(merged.map(x=>[`${x.symbol}|${x.exchange}`,x])).values()]
   .filter(x=>x.symbol.startsWith(query))
   .sort((a,b)=>a.symbol.localeCompare(b.symbol,"tr"))
   .slice(0,100);
  res.set("Cache-Control","public, max-age=60, s-maxage=60");
  res.json({query,count:unique.length,items:unique});
 }catch(error){
  res.status(502).json({error:error?.message||"Sembol araması yapılamadı",items:[]});
 }
});



const OPENBB_BASE_URL=String(process.env.OPENBB_BASE_URL||"").replace(/\/$/,"");
const OPENBB_TOKEN=String(process.env.OPENBB_TOKEN||"");
const openbbResearchCache=new Map();

function unwrapOpenBB(payload){
 if(Array.isArray(payload))return payload;
 if(Array.isArray(payload?.results))return payload.results;
 if(Array.isArray(payload?.data))return payload.data;
 return payload?.results||payload?.data||payload||{};
}
function hasOpenBBData(payload){
 const value=unwrapOpenBB(payload);
 return Array.isArray(value)?value.length>0:!!(value&&typeof value==="object"&&Object.keys(value).length);
}
async function fetchOpenBBRoute(route,params={}){
 if(!OPENBB_BASE_URL)throw new Error("OPENBB_BASE_URL yapılandırılmadı");
 const url=new URL(`${OPENBB_BASE_URL}${route}`);
 Object.entries(params).forEach(([key,value])=>{
  if(value!==undefined&&value!==null&&value!=="")url.searchParams.set(key,String(value));
 });
 const headers={Accept:"application/json"};
 if(OPENBB_TOKEN)headers.Authorization=`Bearer ${OPENBB_TOKEN}`;
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(45000)});
 const text=await response.text();
 if(!response.ok)throw new Error(`OpenBB ${route} HTTP ${response.status}: ${text.slice(0,180)}`);
 try{return JSON.parse(text)}catch{return{text}};
}
async function fetchOpenBBAny(routes,paramVariants){
 let lastError=null;
 const variants=Array.isArray(paramVariants)?paramVariants:[paramVariants];
 const expandedRoutes=[...new Set(routes.flatMap(route=>{
  const clean=route.replace(/^\/api\/v1/,"");
  return [route,clean,`/api/v1${clean}`];
 }))];
 for(const params of variants){
  for(const route of expandedRoutes){
   try{
    const value=await fetchOpenBBRoute(route,params);
    if(hasOpenBBData(value))return value;
   }catch(error){lastError=error}
  }
 }
 return{results:[],error:lastError?.message||"Veri bulunamadı"};
}
function yahooSymbolFor(symbol){
 const s=String(symbol||"").trim().toUpperCase();
 if(/^[A-Z0-9]{2,8}$/.test(s)&&["THYAO","ASELS","AKBNK","YKBNK","DOHOL","VESTL","GARAN","SISE","EREGL","TUPRS","KCHOL","SAHOL","BIMAS","FROTO","TOASO"].includes(s))return`${s}.IS`;
 return s;
}
async function yahooQuoteSummary(symbol){
 const modules="price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,recommendationTrend,earningsTrend";
 const url=`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
 const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`Yahoo quoteSummary HTTP ${response.status}`);
 const json=await response.json();
 return json?.quoteSummary?.result?.[0]||{};
}
function raw(v){return v&&typeof v==="object"&&"raw" in v?v.raw:v}
function yahooFallbackShape(y,symbol){
 const p=y.price||{}, sd=y.summaryDetail||{}, ks=y.defaultKeyStatistics||{}, fd=y.financialData||{}, ap=y.assetProfile||{};
 return{
  info:{results:[{
   symbol,name:p.longName||p.shortName,company_name:p.longName||p.shortName,
   exchange:p.exchangeName||p.exchange,sector:ap.sector,industry:ap.industry,country:ap.country,
   website:ap.website,long_business_summary:ap.longBusinessSummary,full_time_employees:ap.fullTimeEmployees,
   currency:p.currency
  }]},
  quote:{results:[{
   symbol,price:raw(p.regularMarketPrice),last_price:raw(p.regularMarketPrice),currency:p.currency,
   year_high:raw(sd.fiftyTwoWeekHigh),year_low:raw(sd.fiftyTwoWeekLow),
   market_cap:raw(p.marketCap)
  }]},
  metrics:{results:[{
   market_cap:raw(p.marketCap),pe_ratio:raw(sd.trailingPE),forward_pe:raw(ks.forwardPE),
   price_to_book:raw(ks.priceToBook),enterprise_value_over_ebitda:raw(ks.enterpriseToEbitda),
   enterprise_value_over_revenue:raw(ks.enterpriseToRevenue),peg_ratio:raw(ks.pegRatio),
   dividend_yield:(raw(sd.dividendYield)||0)*100,return_on_equity:(raw(fd.returnOnEquity)||0)*100,
   return_on_assets:(raw(fd.returnOnAssets)||0)*100,gross_margin:(raw(fd.grossMargins)||0)*100,
   operating_margin:(raw(fd.operatingMargins)||0)*100,net_profit_margin:(raw(fd.profitMargins)||0)*100,
   debt_to_equity:raw(fd.debtToEquity),current_ratio:raw(fd.currentRatio),quick_ratio:raw(fd.quickRatio),
   beta:raw(ks.beta),earnings_per_share:raw(ks.trailingEps),book_value_per_share:raw(ks.bookValue),
   free_cash_flow:raw(fd.freeCashflow),net_debt:(raw(fd.totalDebt)||0)-(raw(fd.totalCash)||0)
  }]},
  price_target:{results:[{
   target_consensus:raw(fd.targetMeanPrice),target_high:raw(fd.targetHighPrice),
   target_low:raw(fd.targetLowPrice),analyst_count:raw(fd.numberOfAnalystOpinions)
  }]}
 };
}
app.get("/api/chart/history",async(req,res)=>{
 try{
  const symbol=yahooSymbolFor(req.query.symbol);
  const range=String(req.query.range||"1y");
  const interval=String(req.query.interval||"1d");
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&events=div%2Csplits`;
  const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Yahoo chart HTTP ${response.status}`);
  const json=await response.json();
  const result=json?.chart?.result?.[0];
  if(!result)throw new Error(json?.chart?.error?.description||"Grafik verisi bulunamadı");
  const q=result.indicators?.quote?.[0]||{}, ts=result.timestamp||[];
  const candles=[],volume=[];
  ts.forEach((time,i)=>{
   const open=q.open?.[i],high=q.high?.[i],low=q.low?.[i],close=q.close?.[i],vol=q.volume?.[i];
   if([open,high,low,close].every(Number.isFinite)){
    candles.push({time,open,high,low,close});
    if(Number.isFinite(vol))volume.push({time,value:vol,color:close>=open?"rgba(38,166,154,.45)":"rgba(239,83,80,.45)"});
   }
  });
  res.json({symbol,candles,volume,currency:result.meta?.currency});
 }catch(error){res.status(502).json({error:error.message})}
});


const TRADINGVIEW_SCANNER_ROOT="https://scanner.tradingview.com";
const tvFundamentalCache=new Map();
const TV_CORE_COLUMNS=[
 "name","description","close","currency","market_cap_basic",
 "price_earnings_ttm","price_book_fq","enterprise_value_ebitda_ttm",
 "price_sales_current","dividends_yield_current","return_on_equity_fq",
 "return_on_assets_fq","debt_to_equity_fq","current_ratio_fq",
 "quick_ratio_fq","beta_1_year","earnings_per_share_diluted_ttm",
 "book_value_per_share_fq"
];
const TV_EXTENDED_COLUMNS=[
 "enterprise_value_revenue_ttm","price_earnings_growth_ttm",
 "gross_margin_ttm","operating_margin_ttm","net_margin_ttm",
 "free_cash_flow_ttm","total_debt_fq","total_cash_fq",
 "total_revenue_ttm","net_income_ttm","ebitda_ttm","change"
];
async function scanTradingViewColumns(ticker,columns,region="turkey"){
 const response=await fetch(`${TRADINGVIEW_SCANNER_ROOT}/${region}/scan`,{
  method:"POST",
  headers:{
   "Content-Type":"application/json","Accept":"application/json",
   "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortfolioTracker/6.9",
   "Origin":"https://www.tradingview.com","Referer":"https://www.tradingview.com/"
  },
  body:JSON.stringify({
   symbols:{tickers:[ticker],query:{types:[]}},
   columns
  }),
  signal:AbortSignal.timeout(20000)
 });
 if(!response.ok)throw new Error(`TradingView scanner HTTP ${response.status}`);
 const payload=await response.json();
 const row=payload?.data?.[0];
 if(!row||!Array.isArray(row.d))return{};
 return Object.fromEntries(columns.map((column,index)=>[column,row.d[index]??null]));
}
function tradingViewRegionAndTickers(symbol,exchangeHint=""){
 const plain=String(symbol||"").replace(/\.IS$/i,"").toUpperCase();
 const ex=String(exchangeHint||"").toUpperCase();
 if(String(symbol).toUpperCase().endsWith(".IS")||ex.includes("BIST"))return{region:"turkey",tickers:[`BIST:${plain}`]};
 if(ex.includes("NYSE"))return{region:"america",tickers:[`NYSE:${plain}`]};
 if(ex.includes("NASDAQ")||ex.includes("NMS")||ex.includes("NGM"))return{region:"america",tickers:[`NASDAQ:${plain}`]};
 if(ex.includes("AMEX")||ex.includes("ARCA"))return{region:"america",tickers:[`AMEX:${plain}`]};
 if(ex.includes("LSE"))return{region:"uk",tickers:[`LSE:${plain}`]};
 if(ex.includes("XETR")||ex.includes("GER"))return{region:"germany",tickers:[`XETR:${plain}`]};
 if(ex.includes("PAR")||ex.includes("EURONEXT"))return{region:"france",tickers:[`EURONEXT:${plain}`]};
 if(ex.includes("MIL"))return{region:"italy",tickers:[`MIL:${plain}`]};
 if(ex.includes("BME")||ex.includes("MCE"))return{region:"spain",tickers:[`BME:${plain}`]};
 if(ex.includes("TSX"))return{region:"canada",tickers:[`TSX:${plain}`]};
 if(ex.includes("ASX"))return{region:"australia",tickers:[`ASX:${plain}`]};
 if(ex.includes("TSE")||ex.includes("JPX"))return{region:"japan",tickers:[`TSE:${plain}`]};
 if(ex.includes("HKEX")||ex.includes("HKG"))return{region:"hongkong",tickers:[`HKEX:${plain}`]};
 if(ex.includes("NSE")||ex.includes("BSE"))return{region:"india",tickers:[`NSE:${plain}`,`BSE:${plain}`]};
 return{region:"america",tickers:[`NASDAQ:${plain}`,`NYSE:${plain}`,`AMEX:${plain}`]};
}
async function fetchTradingViewFundamentals(symbol,exchangeHint="",force=false){
 const plain=String(symbol||"").replace(/\.IS$/i,"").replace(/^BIST:/i,"").toUpperCase();
 if(!plain)return{};
 const resolution=tradingViewRegionAndTickers(symbol,exchangeHint);
 const cacheKey=`${resolution.region}|${resolution.tickers.join(",")}`,cached=tvFundamentalCache.get(cacheKey);
 if(!force&&cached&&Date.now()-cached.at<15*60*1000)return cached.data;
 let core={},extended={},errors=[],scannerTicker="";
 for(const ticker of resolution.tickers){
  try{
   const candidate=await scanTradingViewColumns(ticker,TV_CORE_COLUMNS,resolution.region);
   if(Object.values(candidate).some(v=>v!==null&&v!==undefined)){core=candidate;scannerTicker=ticker;break}
  }catch(error){errors.push(error.message)}
 }
 if(scannerTicker){
  try{extended=await scanTradingViewColumns(scannerTicker,TV_EXTENDED_COLUMNS,resolution.region)}catch(error){errors.push(error.message)}
 }
 const data={...core,...extended,symbol:plain,scanner_symbol:scannerTicker||resolution.tickers[0],scanner_region:resolution.region};
 if(data.total_debt_fq!=null||data.total_cash_fq!=null){
  data.net_debt=(Number(data.total_debt_fq)||0)-(Number(data.total_cash_fq)||0);
 }
 data.ok=Object.values(data).some(v=>typeof v==="number"&&Number.isFinite(v));
 data.errors=errors;
 tvFundamentalCache.set(cacheKey,{at:Date.now(),data});
 return data;
}
async function fetchYahooStatisticsPage(symbol){
 const encoded=encodeURIComponent(symbol);
 const urls=[
  `https://finance.yahoo.com/quote/${encoded}/key-statistics/`,
  `https://finance.yahoo.com/quote/${encoded}/`
 ];
 let html="",lastError=null;
 for(const url of urls){
  try{
   const response=await fetch(url,{
    headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36","Accept":"text/html,application/xhtml+xml"},
    signal:AbortSignal.timeout(20000)
   });
   if(response.ok){html=await response.text();if(html)break}
  }catch(error){lastError=error}
 }
 if(!html){if(lastError)throw lastError;return{}}
 const numberFor=key=>{
  const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const patterns=[
   new RegExp(`"${escaped}"\\s*:\\s*\\{\\s*"raw"\\s*:\\s*(-?[0-9.eE+]+)`),
   new RegExp(`\\\\"${escaped}\\\\"\\s*:\\s*\\{\\s*\\\\"raw\\\\"\\s*:\\s*(-?[0-9.eE+]+)`)
  ];
  for(const pattern of patterns){
   const match=html.match(pattern),value=match?Number(match[1]):null;
   if(Number.isFinite(value))return value;
  }
  return null;
 };
 return{
  trailingPE:numberFor("trailingPE"),forwardPE:numberFor("forwardPE"),
  priceToBook:numberFor("priceToBook"),enterpriseToEbitda:numberFor("enterpriseToEbitda"),
  enterpriseToRevenue:numberFor("enterpriseToRevenue"),pegRatio:numberFor("pegRatio"),
  dividendYield:numberFor("dividendYield"),returnOnEquity:numberFor("returnOnEquity"),
  returnOnAssets:numberFor("returnOnAssets"),grossMargins:numberFor("grossMargins"),
  operatingMargins:numberFor("operatingMargins"),profitMargins:numberFor("profitMargins"),
  debtToEquity:numberFor("debtToEquity"),currentRatio:numberFor("currentRatio"),
  quickRatio:numberFor("quickRatio"),beta:numberFor("beta"),trailingEps:numberFor("trailingEps"),
  bookValue:numberFor("bookValue"),freeCashflow:numberFor("freeCashflow"),
  totalDebt:numberFor("totalDebt"),totalCash:numberFor("totalCash"),
  marketCap:numberFor("marketCap")
 };
}
function tvPercent(value){const n=Number(value);return Number.isFinite(n)?(Math.abs(n)<=1?n*100:n):null}
function tradingViewToResearch(tv){
 if(!tv||typeof tv!=="object")return{};
 return{
  info:{results:[{
   symbol:tv.symbol,name:tv.description||tv.name||tv.symbol,
   company_name:tv.description||tv.name||tv.symbol,exchange:"BIST",currency:tv.currency||"TRY"
  }]},
  quote:{results:[{
   symbol:tv.symbol,price:tv.close,last_price:tv.close,currency:tv.currency||"TRY",
   market_cap:tv.market_cap_basic
  }]},
  metrics:{results:[{
   market_cap:tv.market_cap_basic,pe_ratio:tv.price_earnings_ttm,
   forward_pe:tv.price_earnings_forward,price_to_book:tv.price_book_fq,
   enterprise_value_over_ebitda:tv.enterprise_value_ebitda_ttm,
   enterprise_value_over_revenue:tv.enterprise_value_revenue_ttm,
   price_to_sales:tv.price_sales_current,peg_ratio:tv.price_earnings_growth_ttm,
   dividend_yield:tvPercent(tv.dividends_yield_current),return_on_equity:tvPercent(tv.return_on_equity_fq),
   return_on_assets:tvPercent(tv.return_on_assets_fq),gross_margin:tvPercent(tv.gross_margin_ttm),
   operating_margin:tvPercent(tv.operating_margin_ttm),net_profit_margin:tvPercent(tv.net_margin_ttm),
   debt_to_equity:tv.debt_to_equity_fq,current_ratio:tv.current_ratio_fq,
   quick_ratio:tv.quick_ratio_fq,beta:tv.beta_1_year,
   earnings_per_share:tv.earnings_per_share_diluted_ttm,
   book_value_per_share:tv.book_value_per_share_fq,free_cash_flow:tv.free_cash_flow_ttm,
   net_debt:tv.net_debt
  }]}
 };
}
function yahooPageToResearch(y,symbol){
 if(!y||typeof y!=="object")return{};
 return{metrics:{results:[{
  pe_ratio:y.trailingPE,forward_pe:y.forwardPE,price_to_book:y.priceToBook,
  enterprise_value_over_ebitda:y.enterpriseToEbitda,
  enterprise_value_over_revenue:y.enterpriseToRevenue,peg_ratio:y.pegRatio,
  dividend_yield:y.dividendYield==null?null:y.dividendYield*100,
  return_on_equity:y.returnOnEquity==null?null:y.returnOnEquity*100,
  return_on_assets:y.returnOnAssets==null?null:y.returnOnAssets*100,
  gross_margin:y.grossMargins==null?null:y.grossMargins*100,
  operating_margin:y.operatingMargins==null?null:y.operatingMargins*100,
  net_profit_margin:y.profitMargins==null?null:y.profitMargins*100,
  debt_to_equity:y.debtToEquity,current_ratio:y.currentRatio,quick_ratio:y.quickRatio,
  beta:y.beta,earnings_per_share:y.trailingEps,book_value_per_share:y.bookValue,
  free_cash_flow:y.freeCashflow,
  net_debt:(y.totalDebt==null&&y.totalCash==null)?null:(Number(y.totalDebt)||0)-(Number(y.totalCash)||0),
  market_cap:y.marketCap
 }]}}
}
function firstContainerRecord(container){
 if(Array.isArray(container))return container[0]||{};
 if(Array.isArray(container?.results))return container.results[0]||{};
 if(Array.isArray(container?.data))return container.data[0]||{};
 return container?.results||container?.data||container||{};
}
function mergeResearchContainer(...containers){
 const merged={};
 for(const container of containers.reverse()){
  const record=firstContainerRecord(container);
  for(const [key,value] of Object.entries(record||{})){
   if(value!==null&&value!==undefined&&value!=="")merged[key]=value;
  }
 }
 return{results:[merged]};
}

const SEC_COMPANY_TICKERS_URL="https://www.sec.gov/files/company_tickers.json";
const SEC_COMPANY_FACTS_ROOT="https://data.sec.gov/api/xbrl/companyfacts";
const SEC_USER_AGENT=process.env.SEC_USER_AGENT||"PortfolioTracker/7.0 contact@portfolio.local";
let secTickerCache={at:0,map:new Map()};

async function getSecTickerMap(){
 if(secTickerCache.map.size&&Date.now()-secTickerCache.at<24*60*60*1000)return secTickerCache.map;
 const response=await fetch(SEC_COMPANY_TICKERS_URL,{
  headers:{"User-Agent":SEC_USER_AGENT,"Accept":"application/json"},
  signal:AbortSignal.timeout(20000)
 });
 if(!response.ok)throw new Error(`SEC ticker map HTTP ${response.status}`);
 const payload=await response.json(),map=new Map();
 Object.values(payload||{}).forEach(row=>{
  if(row?.ticker&&row?.cik_str)map.set(String(row.ticker).toUpperCase(),String(row.cik_str).padStart(10,"0"));
 });
 secTickerCache={at:Date.now(),map};return map;
}
function secFactUnits(companyFacts,taxonomy,tag){
 return companyFacts?.facts?.[taxonomy]?.[tag]?.units||{};
}
function secFactRows(companyFacts,taxonomy,tag,preferredUnits=[]){
 const units=secFactUnits(companyFacts,taxonomy,tag);
 for(const unit of preferredUnits){if(Array.isArray(units[unit]))return units[unit]}
 const first=Object.values(units).find(Array.isArray);return first||[];
}
function latestSecInstant(companyFacts,taxonomy,tag,units){
 return secFactRows(companyFacts,taxonomy,tag,units)
  .filter(x=>["10-K","10-Q","20-F","40-F"].includes(x.form)&&x.val!=null)
  .sort((a,b)=>String(b.end||"").localeCompare(String(a.end||""))||String(b.filed||"").localeCompare(String(a.filed||"")))[0]?.val??null;
}
function latestSecAnnual(companyFacts,taxonomy,tag,units){
 const rows=secFactRows(companyFacts,taxonomy,tag,units)
  .filter(x=>["10-K","20-F","40-F"].includes(x.form)&&x.val!=null)
  .sort((a,b)=>String(b.filed||"").localeCompare(String(a.filed||"")));
 return rows[0]?.val??null;
}
async function fetchSecFundamentals(symbol,marketCap=null){
 const ticker=String(symbol||"").replace(/\..*$/,"").toUpperCase();
 const map=await getSecTickerMap(),cik=map.get(ticker);
 if(!cik)return{ok:false,error:"SEC CIK bulunamadı",symbol:ticker};
 const response=await fetch(`${SEC_COMPANY_FACTS_ROOT}/CIK${cik}.json`,{
  headers:{"User-Agent":SEC_USER_AGENT,"Accept":"application/json"},
  signal:AbortSignal.timeout(25000)
 });
 if(!response.ok)throw new Error(`SEC companyfacts HTTP ${response.status}`);
 const f=await response.json();
 const annual=(tags,unit=["USD"])=>{
  for(const tag of tags){const v=latestSecAnnual(f,"us-gaap",tag,unit);if(v!=null)return Number(v)}
  return null;
 };
 const instant=(tags,unit=["USD"])=>{
  for(const tag of tags){const v=latestSecInstant(f,"us-gaap",tag,unit);if(v!=null)return Number(v)}
  return null;
 };
 const revenue=annual(["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet"]);
 const netIncome=annual(["NetIncomeLoss","ProfitLoss"]);
 const operatingIncome=annual(["OperatingIncomeLoss"]);
 const da=annual(["DepreciationDepletionAndAmortization","DepreciationDepletionAndAmortizationPropertyPlantAndEquipment"]);
 const ebitda=(operatingIncome!=null&&da!=null)?operatingIncome+da:null;
 const equity=instant(["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
 const assets=instant(["Assets"]);
 const currentAssets=instant(["AssetsCurrent"]);
 const currentLiabilities=instant(["LiabilitiesCurrent"]);
 const debtCurrent=instant(["LongTermDebtCurrent","ShortTermBorrowings"]);
 const debtLong=instant(["LongTermDebtNoncurrent","LongTermDebt"]);
 const totalDebt=(debtCurrent??0)+(debtLong??0)||null;
 const cash=instant(["CashAndCashEquivalentsAtCarryingValue","CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]);
 const cfo=annual(["NetCashProvidedByUsedInOperatingActivities"]);
 const capex=annual(["PaymentsToAcquirePropertyPlantAndEquipment","PaymentsForAdditionsToPropertyPlantAndEquipment"]);
 const fcf=(cfo!=null&&capex!=null)?cfo-Math.abs(capex):null;
 const eps=annual(["EarningsPerShareDiluted"],["USD/shares"]);
 const shares=latestSecInstant(f,"dei","EntityCommonStockSharesOutstanding",["shares"])
  ??latestSecInstant(f,"us-gaap","CommonStocksIncludingAdditionalPaidInCapitalMember",["shares"]);
 const mc=Number(marketCap);
 const enterpriseValue=Number.isFinite(mc)?mc+(totalDebt||0)-(cash||0):null;
 const metrics={
  market_cap:Number.isFinite(mc)?mc:null,
  pe_ratio:Number.isFinite(mc)&&netIncome>0?mc/netIncome:null,
  price_to_book:Number.isFinite(mc)&&equity>0?mc/equity:null,
  price_to_sales:Number.isFinite(mc)&&revenue>0?mc/revenue:null,
  enterprise_value_over_ebitda:enterpriseValue!=null&&ebitda>0?enterpriseValue/ebitda:null,
  enterprise_value_over_revenue:enterpriseValue!=null&&revenue>0?enterpriseValue/revenue:null,
  return_on_equity:equity>0&&netIncome!=null?netIncome/equity*100:null,
  return_on_assets:assets>0&&netIncome!=null?netIncome/assets*100:null,
  operating_margin:revenue>0&&operatingIncome!=null?operatingIncome/revenue*100:null,
  net_profit_margin:revenue>0&&netIncome!=null?netIncome/revenue*100:null,
  debt_to_equity:equity>0&&totalDebt!=null?totalDebt/equity:null,
  current_ratio:currentLiabilities>0&&currentAssets!=null?currentAssets/currentLiabilities:null,
  earnings_per_share:eps,
  book_value_per_share:equity!=null&&shares>0?equity/shares:null,
  free_cash_flow:fcf,net_debt:(totalDebt==null&&cash==null)?null:(totalDebt||0)-(cash||0),
  total_revenue_ttm:revenue,net_income_ttm:netIncome,ebitda_ttm:ebitda
 };
 return{ok:Object.values(metrics).some(v=>v!=null),symbol:ticker,cik,company:f.entityName,metrics,source:"SEC Company Facts"};
}
function secToResearch(sec){
 return{metrics:{results:[sec?.metrics||{}]},info:{results:[{symbol:sec?.symbol,name:sec?.company,company_name:sec?.company,country:"United States"}]}};
}
function yahooDetailsToResearch(details){
 if(!details||typeof details!=="object")return{};
 return{
  info:{results:[{
   symbol:details.symbol,name:details.name,company_name:details.name,
   exchange:details.exchange,sector:details.sector,industry:details.industry,
   currency:details.currency
  }]},
  quote:{results:[{
   symbol:details.symbol,price:details.price,last_price:details.price,
   currency:details.currency,year_high:details.fiftyTwoWeekHigh,
   year_low:details.fiftyTwoWeekLow,market_cap:details.marketCap
  }]},
  metrics:{results:[{
   market_cap:details.marketCap,pe_ratio:details.trailingPE,
   price_to_book:details.priceToBook,
   enterprise_value_over_ebitda:details.enterpriseToEbitda,
   dividend_yield:details.dividendYield,return_on_equity:details.returnOnEquity,
   return_on_assets:details.returnOnAssets,net_profit_margin:details.netMargin,
   debt_to_equity:details.debtToEquityComputed,current_ratio:details.currentRatio,
   beta:details.beta,earnings_per_share:details.trailingEps,
   book_value_per_share:details.bookValue,
   net_debt:details.netCash==null?null:-details.netCash
  }]}
 };
}

app.get("/api/openbb/research",async(req,res)=>{
 const requested=String(req.query.symbol||"").trim().toUpperCase();
 if(!requested)return res.status(400).json({error:"Sembol gereklidir"});
 const isBist=requested.endsWith(".IS")||req.query.market==="BIST";
 const symbol=isBist?yahooSymbolFor(requested):requested;
 const preferred=String(req.query.provider||process.env.OPENBB_PROVIDER||"fmp").trim();
 const providers=isBist?["yfinance","fmp"]:[preferred,"fmp","yfinance"].filter((v,i,a)=>v&&a.indexOf(v)===i);
 const force=req.query.force==="1";
 const cacheKey=`research|${symbol}|${providers.join(",")}`,cached=openbbResearchCache.get(cacheKey);
 if(!force&&cached&&Date.now()-cached.at<10*60*1000)return res.json(cached.data);

 const empty={results:[]};
 let info=empty,quote=empty,metrics=empty,ratios=empty,income=empty,balance=empty,cash=empty,dividends=empty,priceTarget=empty,estimates=empty,news=empty;
 if(OPENBB_BASE_URL){
  const variants=(extra={})=>providers.map(provider=>({symbol,provider,...extra}));
  const periodVariants=(extra={})=>providers.map(provider=>({symbol,provider,period:"annual",limit:5,...extra}));
  [info,quote,metrics,ratios,income,balance,cash,dividends,priceTarget,estimates,news]=await Promise.all([
   fetchOpenBBAny(["/api/v1/equity/profile","/api/v1/equity/info"],variants()),
   fetchOpenBBAny(["/api/v1/equity/price/quote","/api/v1/equity/quote"],variants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/metrics"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/ratios"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/income"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/balance"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/cash"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/dividends"],variants({limit:20})),
   fetchOpenBBAny(["/api/v1/equity/estimates/price_target_consensus","/api/v1/equity/price_target/consensus"],variants()),
   fetchOpenBBAny(["/api/v1/equity/estimates/analyst","/api/v1/equity/estimates/historical"],variants({limit:12})),
   fetchOpenBBAny(["/api/v1/news/company","/api/v1/news/world"],variants({limit:30}))
  ]);
 }

 let yahooShape={},yahooPageShape={},tvShape={},tvFundamentals={},secShape={},secFundamentals={},yahooOk=false,robustYahooDetails=null;
 try{yahooShape=yahooFallbackShape(await yahooQuoteSummary(symbol),symbol);yahooOk=true}catch{}
 try{
  robustYahooDetails=await fetchYahooDetails(symbol);
  const robustYahoo=yahooDetailsToResearch(robustYahooDetails);
  yahooShape={
   ...yahooShape,
   info:mergeResearchContainer(yahooShape.info,robustYahoo.info),
   quote:mergeResearchContainer(yahooShape.quote,robustYahoo.quote),
   metrics:mergeResearchContainer(yahooShape.metrics,robustYahoo.metrics)
  };
  yahooOk=true;
 }catch(error){console.warn("Yahoo detay yedeklemesi alınamadı:",error?.message)}
 try{
  yahooPageShape=yahooPageToResearch(await fetchYahooStatisticsPage(symbol),symbol);
  if(Object.values(firstContainerRecord(yahooPageShape.metrics)).some(v=>v!=null))yahooOk=true;
 }catch(error){console.warn("Yahoo istatistik sayfası alınamadı:",error?.message)}
 try{
  tvFundamentals=await fetchTradingViewFundamentals(symbol,robustYahooDetails?.exchange||firstContainerRecord(yahooShape.info).exchange||"",force);
  tvShape=tradingViewToResearch(tvFundamentals);
 }catch(error){console.warn("TradingView temel verileri alınamadı:",error?.message)}
 if(!isBist){
  try{
   const marketCap=firstContainerRecord(tvShape.metrics).market_cap
    ??firstContainerRecord(yahooShape.metrics).market_cap
    ??robustYahooDetails?.marketCap;
   secFundamentals=await fetchSecFundamentals(symbol,marketCap);
   secShape=secToResearch(secFundamentals);
  }catch(error){secFundamentals={ok:false,error:error.message};console.warn("SEC temel verileri alınamadı:",error?.message)}
 }

 const mergedInfo=mergeResearchContainer(info,tvShape.info,secShape.info,yahooShape.info);
 const mergedQuote=mergeResearchContainer(quote,tvShape.quote,yahooShape.quote);
 const mergedMetrics=mergeResearchContainer(metrics,tvShape.metrics,secShape.metrics,yahooShape.metrics,yahooPageShape.metrics);
 const openbbCount=[info,quote,metrics,ratios,income,balance,cash,news].filter(hasOpenBBData).length;
 const data={
  configured:true,openbb_configured:Boolean(OPENBB_BASE_URL),symbol,provider:providers[0],
  source_note:isBist
   ?"BIST temel oranlarında TradingView Screener birinci doğrudan kaynak, Yahoo Finance ve OpenBB yedek kaynak olarak kullanılıyor."
   :"Yurt dışı hisselerinde TradingView global screener, SEC Company Facts, Yahoo Finance ve mevcut OpenBB sağlayıcıları birlikte kullanılıyor.",
  info:mergedInfo,quote:mergedQuote,metrics:mergedMetrics,ratios,
  income,balance,cash,dividends,price_target:priceTarget,estimates,news,
  tradingview_fundamentals:tvFundamentals,
  sec_fundamentals:secFundamentals,
  diagnostics:{
   tradingview_ok:Boolean(tvFundamentals?.ok),
   sec_ok:Boolean(secFundamentals?.ok),
   yahoo_ok:yahooOk,
   openbb_sections_with_data:openbbCount,
   providers_tried:providers,
   tradingview_errors:tvFundamentals?.errors||[]
  },
  fetchedAt:new Date().toISOString()
 };
 openbbResearchCache.set(cacheKey,{at:Date.now(),data});
 res.set("Cache-Control","public, max-age=300, s-maxage=300");
 res.json(data);
});

app.get("/api/fundamentals",async(req,res)=>{
 const requested=String(req.query.symbol||"").trim().toUpperCase();
 if(!requested)return res.status(400).json({error:"Sembol gereklidir"});
 const symbol=yahooSymbolFor(requested);
 let tradingview={},yahoo={},yahooPage={},sec={};
 try{yahoo=await fetchYahooDetails(symbol)}catch(error){yahoo={error:error.message}}
 try{tradingview=await fetchTradingViewFundamentals(symbol,yahoo.exchange||"",req.query.refresh==="1")}catch(error){tradingview={ok:false,error:error.message}}
 try{yahooPage=await fetchYahooStatisticsPage(symbol)}catch(error){yahooPage={error:error.message}}
 try{sec=await fetchSecFundamentals(symbol,tradingview.market_cap_basic??yahoo.marketCap)}catch(error){sec={ok:false,error:error.message}}
 res.json({symbol,tradingview,sec,yahoo,yahooPage,fetchedAt:new Date().toISOString()});
});



const TCMB_REFERENCE_URL="https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB+TR/Main+Menu/Istatistikler/Bankacilik+Verileri/Uye+Isyerlerine+Uygulanacak+Azami+Komisyon+Oranlari";
const ALNUS_VIOP_URL="https://www.alnusyatirim.com/viop";
const OYAK_VIOP_MARGIN_URL="https://www.oyakyatirim.com.tr/viop/baslangic-teminatlari-kaldirac-oranlari";
const DENIZ_VIOP_PSR_URL="https://www.denizyatirim.com/Teminatlar";

function decodeBasicHtml(value=""){
 return String(value)
  .replace(/&nbsp;|&#160;/gi," ")
  .replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
  .replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
  .replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
}
function trNumber(value){
 const clean=decodeBasicHtml(value).replace(/\./g,"").replace(",",".").replace(/[^\d.-]/g,"");
 const num=Number(clean);return Number.isFinite(num)?num:null;
}
async function fetchPublicText(url,timeout=25000){
 const response=await fetch(url,{
  headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) PortfolioTracker/6.7","Accept":"text/html,application/xhtml+xml"},
  signal:AbortSignal.timeout(timeout)
 });
 if(!response.ok)throw new Error(`HTTP ${response.status}`);
 return response.text();
}
app.get("/api/reference-rate",async(_req,res)=>{
 let monthly=3.11,annualCompound=45.15,period="01/08/2026 - 31/08/2026",live=false;
 try{
  const text=decodeBasicHtml(await fetchPublicText(TCMB_REFERENCE_URL));
  const rows=[...text.matchAll(/(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4})\s+(\d+[,.]\d+)\s+(\d+[,.]\d+)/g)];
  if(rows.length){
   period=rows[0][1];monthly=trNumber(rows[0][2])??monthly;annualCompound=trNumber(rows[0][3])??annualCompound;live=true;
  }
 }catch(error){console.warn("TCMB referans oranı alınamadı:",error.message)}
 res.json({monthly,annualCompound,period,live,source:"TCMB",sourceUrl:TCMB_REFERENCE_URL,fetchedAt:new Date().toISOString()});
});

const VIOP_FALLBACK_CONTRACTS=[
 {id:"F_XU030",code:"F_XU030",underlying:"XU030",name:"BIST 30 Endeks Vadeli",contractSize:10,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_PAY",code:"F_PAY",underlying:"PAY",name:"Pay Vadeli — Sembol Bazlı",contractSize:100,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_USDTRY",code:"F_USDTRY",underlying:"USDTRY",name:"Dolar/TL Vadeli",contractSize:1000,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_EURTRY",code:"F_EURTRY",underlying:"EURTRY",name:"Euro/TL Vadeli",contractSize:1000,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_XAUTRY",code:"F_XAUTRY",underlying:"XAUTRY",name:"Gram Altın/TL Vadeli",contractSize:1,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"}
];
const VIOP_SPECIAL_UNDERLYINGS=new Set(["XU030","USDTRY","EURTRY","EURUSD","XAUTRY","XAUUSD","TRYUSD","TRYEUR","TLREF","ELCBAS","ANR","PAMUK","BUGDAY"]);
let viopContractCache={at:0,contracts:[],live:false,error:null};

function parseTrDate(value){
 const s=decodeBasicHtml(value);
 let m=s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
 if(m)return`${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;
 const months={ocak:1,şubat:2,mart:3,nisan:4,mayıs:5,haziran:6,temmuz:7,ağustos:8,eylül:9,ekim:10,kasım:11,aralık:12,subat:2,agustos:8,eylul:9,ekim:10,kasim:11,aralik:12};
 m=s.toLocaleLowerCase("tr-TR").match(/(ocak|şubat|subat|mart|nisan|mayıs|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)\s+(\d{4})/);
 if(m){
  const month=months[m[1]],year=Number(m[2]);
  return`${year}-${String(month).padStart(2,"0")}-28`;
 }
 return null;
}
function contractUnderlying(code,asset=""){
 const c=String(code||"").toUpperCase();
 const m=c.match(/^F_([A-Z0-9]+?)(?:\d{4}|\d{6})$/);
 if(m)return m[1];
 const generic=c.match(/^F_([A-Z0-9]+)/);
 if(generic)return generic[1].replace(/\d+$/,"");
 return String(asset||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
}
function expiryFromContractCode(code){
 const c=String(code||"").toUpperCase();
 const m=c.match(/(\d{2})(\d{2})$/);
 if(!m)return null;
 const month=Number(m[1]),year=2000+Number(m[2]);
 if(month<1||month>12)return null;
 return`${year}-${String(month).padStart(2,"0")}-28`;
}
function normalizeUnderlyingName(value){
 return decodeBasicHtml(value).toUpperCase()
  .replace(/İ/g,"I").replace(/Ş/g,"S").replace(/Ğ/g,"G").replace(/Ü/g,"U").replace(/Ö/g,"O").replace(/Ç/g,"C")
  .replace(/[^A-Z0-9]/g,"");
}
const VIOP_PSR_FALLBACK={
 AEFES:14.1,AKBNK:15.7,AKSEN:14.3,ALARK:13.4,ARCLK:13.1,ASELS:15.8,ASTOR:16.1,
 BIMAS:12.7,BRSAN:15.5,CIMSA:13.4,DOAS:15.1,DOHOL:14.1,EKGYO:16.1,ENJSA:13.4,
 ENKAI:13.8,EREGL:14.0,KCHOL:14.0,KOZAL:15.0,PGSUS:16.0,SAHOL:14.0,SASA:18.0,
 SISE:14.0,TCELL:14.0,THYAO:15.0,TOASO:14.0,TUPRS:15.0,VAKBN:15.5,VESTL:17.0,
 YKBNK:15.5,XU030:10.0,USDTRY:10.0,EURTRY:10.4,XAUTRY:12.0
};
function parseDenizPsrRates(html){
 const rates=new Map(),rows=[...String(html||"").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
 for(const row of rows){
  const cells=[...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>decodeBasicHtml(x[1]));
  if(cells.length<2)continue;
  const symbol=normalizeUnderlyingName(cells[0]).replace(/^F_/,"");
  const percentCell=cells.find((x,i)=>i>0&&/%/.test(x))||cells.find((x,i)=>i>0&&/^\d{1,2}[,.]\d+$/.test(x.trim()));
  const rate=trNumber(percentCell);
  if(symbol&&rate!=null&&rate>0&&rate<100)rates.set(symbol,rate);
 }
 if(!rates.size){
  const text=decodeBasicHtml(html);
  for(const match of text.matchAll(/\b([A-ZÇĞİÖŞÜ]{3,12})\s+(\d{1,2}[,.]\d+)\s*%?/g)){
   const symbol=normalizeUnderlyingName(match[1]),rate=trNumber(match[2]);
   if(symbol&&rate>0&&rate<100)rates.set(symbol,rate);
  }
 }
 return rates;
}
async function viopReferencePrices(underlyings){
 const result=new Map();
 await Promise.all([...new Set(underlyings)].map(async underlying=>{
  const u=String(underlying||"").toUpperCase();
  const yahoo=u==="USDTRY"?"USDTRY=X":u==="EURTRY"?"EURTRY=X":u==="XAUTRY"?"GC=F":u==="XU030"?"^XU030":`${u}.IS`;
  try{
   const quote=await fetchYahooChart(yahoo);
   if(Number.isFinite(quote.price))result.set(u,{price:quote.price,yahooSymbol:yahoo});
  }catch{}
 }));
 return result;
}
function enrichViopMargins(contracts,psrRates,prices,fixedMargins){
 return contracts.map(contract=>{
  const underlying=normalizeUnderlyingName(contract.underlying);
  const fixed=fixedMargins.get(underlying);
  const psr=psrRates.get(underlying)??VIOP_PSR_FALLBACK[underlying]??null;
  const ref=prices.get(underlying);
  const size=Number(contract.contractSize)||contractSizeForUnderlying(underlying);
  let initial=Number(fixed??contract.initialMargin)||0;
  let marginSource=fixed?"Oyak sabit teminat":contract.initialMargin?"Alnus başlangıç teminatı":"";
  if(initial<=0&&psr&&ref?.price){
   initial=ref.price*size*psr/100;
   marginSource=psrRates.has(underlying)?"Deniz PSR + Yahoo referans fiyat":"Yedek PSR + Yahoo referans fiyat";
  }
  return{
   ...contract,underlying,contractSize:size,initialMargin:initial||null,
   maintenanceMargin:initial>0?initial*.75:null,marginRate:psr,
   referencePrice:ref?.price??null,yahooSymbol:ref?.yahooSymbol??contract.yahooSymbol??null,
   marginSource:marginSource||"Manuel teminat gerekli"
  };
 });
}
function parseOyakViopMargins(html){
 const margins=new Map();
 for(const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>decodeBasicHtml(x[1]));
  if(cells.length<2)continue;
  const underlying=normalizeUnderlyingName(cells[0]);
  const margin=trNumber(cells[1]);
  if(underlying&&margin!=null&&margin>0)margins.set(underlying,margin);
 }
 if(!margins.size){
  const text=decodeBasicHtml(html);
  for(const match of text.matchAll(/\b([A-ZÇĞİÖŞÜ]{2,12})\s+([\d.]+(?:,\d+)?)\s*TL\b/g)){
   const underlying=normalizeUnderlyingName(match[1]),margin=trNumber(match[2]);
   if(underlying&&margin)margins.set(underlying,margin);
  }
 }
 return margins;
}
function contractSizeForUnderlying(underlying){
 const u=String(underlying||"").toUpperCase();
 if(u==="XU030")return 10;
 if(["USDTRY","EURTRY","EURUSD","GBPUSD"].includes(u))return 1000;
 if(["XAUTRY","XAUUSD","XAGUSD"].includes(u))return 1;
 return 100;
}
function lastWeekdayOfMonth(year,monthIndex){
 const date=new Date(year,monthIndex+1,0);
 while(date.getDay()===0||date.getDay()===6)date.setDate(date.getDate()-1);
 return date;
}
function generatedContractsFromMargins(margins){
 const today=new Date(),contracts=[];
 for(const [underlying,initialMargin] of margins.entries()){
  for(let offset=0;offset<3;offset++){
   const date=new Date(today.getFullYear(),today.getMonth()+offset,1);
   const expiry=lastWeekdayOfMonth(date.getFullYear(),date.getMonth());
   const mm=String(date.getMonth()+1).padStart(2,"0"),yy=String(date.getFullYear()).slice(-2);
   const code=`F_${underlying}${mm}${yy}`;
   contracts.push({
    id:code,code,underlying,name:`${underlying} Vadeli`,maturityLabel:`${mm}/${date.getFullYear()}`,
    expiryDate:expiry.toISOString().slice(0,10),lastTradingDay:expiry.toLocaleDateString("tr-TR"),
    sortDate:expiry.toISOString().slice(0,10),contractSize:contractSizeForUnderlying(underlying),
    initialMargin,maintenanceMargin:initialMargin*.75,spreadMargin:null,currency:"TRY",
    marginMode:"fixed",source:"Oyak Yatırım",isActive:expiry>=today
   });
  }
 }
 return contracts;
}
function mergeOyakMargins(contracts,margins){
 return contracts.map(contract=>{
  const margin=margins.get(normalizeUnderlyingName(contract.underlying));
  return{
   ...contract,
   contractSize:Number(contract.contractSize)||contractSizeForUnderlying(contract.underlying),
   initialMargin:margin??contract.initialMargin,
   maintenanceMargin:(margin??contract.initialMargin)!=null?(margin??contract.initialMargin)*.75:contract.maintenanceMargin,
   marginSource:margin!=null?"Oyak Yatırım":contract.source
  };
 });
}
function parseAlnusViopRows(html){
 const contracts=[];
 const rowRegex=/<tr[^>]*>([\s\S]*?)<\/tr>/gi;
 for(const row of html.matchAll(rowRegex)){
  const cells=[...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>decodeBasicHtml(x[1]));
  if(cells.length<6)continue;
  const code=cells.find(x=>/^F_[A-Z0-9_]+$/i.test(x));
  if(!code)continue;
  const codeIndex=cells.indexOf(code);
  const asset=cells[Math.max(0,codeIndex-1)]||code;
  const maturityLabel=cells[codeIndex+1]||"";
  const contractSize=trNumber(cells[codeIndex+2]);
  const initialMargin=trNumber(cells[codeIndex+3]);
  const spreadMargin=trNumber(cells[codeIndex+4]);
  const currency=cells[codeIndex+5]||"TRY";
  const lastTradingDay=cells[codeIndex+6]||"";
  const expiryDate=parseTrDate(lastTradingDay)||parseTrDate(maturityLabel)||expiryFromContractCode(code);
  const underlying=contractUnderlying(code,asset);
  contracts.push({
   id:code,code,underlying,name:asset,maturityLabel,expiryDate,lastTradingDay,
   sortDate:expiryDate||"9999-12-31",contractSize,initialMargin,
   maintenanceMargin:initialMargin==null?null:initialMargin*.75,
   spreadMargin,currency,marginMode:"fixed",source:"Alnus Yatırım"
  });
 }
 const unique=[];const seen=new Set();
 for(const c of contracts){if(!seen.has(c.id)){seen.add(c.id);unique.push(c)}}
 const today=new Date().toISOString().slice(0,10);
 unique.forEach(c=>c.isActive=!c.expiryDate||c.expiryDate>=today);
 return unique.sort((a,b)=>String(a.sortDate).localeCompare(String(b.sortDate))||a.code.localeCompare(b.code));
}
function viopUnderlyingRows(contracts){
 const map=new Map();
 for(const c of contracts){
  if(!c.underlying)continue;
  if(!map.has(c.underlying))map.set(c.underlying,[]);
  map.get(c.underlying).push(c);
 }
 return[...map.entries()].map(([underlying,rows])=>{
  rows.sort((a,b)=>String(a.sortDate).localeCompare(String(b.sortDate)));
  const nearest=rows.find(x=>x.isActive!==false)||rows[0];
  return{
   symbol:underlying,underlying,yahooSymbol:VIOP_SPECIAL_UNDERLYINGS.has(underlying)?"":`${underlying}.IS`,
   name:nearest?.name||underlying,type:"VİOP Dayanak",exchange:"Borsa İstanbul VİOP",
   nearestContract:nearest,contracts:rows
  };
 }).sort((a,b)=>a.symbol.localeCompare(b.symbol,"tr"));
}
async function getViopContracts(force=false){
 if(!force&&viopContractCache.contracts.length&&Date.now()-viopContractCache.at<15*60*1000)return viopContractCache;
 let contracts=[],live=false,error=null,marginError=null,fixedMargins=new Map(),psrRates=new Map();
 try{
  const html=await fetchPublicText(ALNUS_VIOP_URL,30000);
  contracts=parseAlnusViopRows(html);live=contracts.length>0;
 }catch(err){error=err.message}
 try{
  const marginHtml=await fetchPublicText(OYAK_VIOP_MARGIN_URL,30000);
  fixedMargins=parseOyakViopMargins(marginHtml);
 }catch(err){marginError=err.message}
 try{
  const psrHtml=await fetchPublicText(DENIZ_VIOP_PSR_URL,30000);
  psrRates=parseDenizPsrRates(psrHtml);
 }catch(err){marginError=[marginError,err.message].filter(Boolean).join(" | ")}
 if(!contracts.length){
  const universe=new Map([...fixedMargins.keys(),...psrRates.keys(),...Object.keys(VIOP_PSR_FALLBACK)].map(x=>[x,fixedMargins.get(x)||0]));
  contracts=generatedContractsFromMargins(universe);
 }
 if(!contracts.length)contracts=VIOP_FALLBACK_CONTRACTS.map(x=>({...x,isActive:true,sortDate:x.expiryDate||"9999-12-31"}));
 const prices=await viopReferencePrices(contracts.map(x=>x.underlying));
 contracts=enrichViopMargins(contracts,psrRates,prices,fixedMargins);
 viopContractCache={
  at:Date.now(),contracts,live:live||psrRates.size>0||fixedMargins.size>0,
  error:[error,marginError].filter(Boolean).join(" | "),
  psrCount:psrRates.size,fixedCount:fixedMargins.size,pricedCount:prices.size
 };
 return viopContractCache;
}
app.get("/api/viop/contracts",async(req,res)=>{
 const cache=await getViopContracts(req.query.refresh==="1");
 res.set("Cache-Control","public, max-age=300, s-maxage=300");
 res.json({
  contracts:cache.contracts,underlyings:viopUnderlyingRows(cache.contracts),
  live:cache.live,error:cache.error,sourceLabel:"Alnus vade + Deniz PSR + Yahoo referans fiyat + Oyak yedek",
  sourceUrl:ALNUS_VIOP_URL,
  marginSourceUrl:OYAK_VIOP_MARGIN_URL,psrSourceUrl:DENIZ_VIOP_PSR_URL,asOf:new Date(cache.at).toISOString(),
  warning:"Pay VİOP başlangıç teminatı sabit tutar bulunamazsa güncel referans fiyat × kontrat büyüklüğü × PSR oranı ile hesaplanır. Sürdürme teminatı %75 olarak gösterilir; işlem öncesi kurum ekranı teyit edilmelidir."
 });
});
app.get("/api/viop/search",async(req,res)=>{
 const q=String(req.query.q||"").trim().toUpperCase();
 if(!q)return res.json({items:[]});
 const cache=await getViopContracts(false);
 const items=viopUnderlyingRows(cache.contracts)
  .filter(x=>x.symbol.startsWith(q)||String(x.name||"").toLocaleUpperCase("tr-TR").includes(q))
  .slice(0,50);
 res.set("Cache-Control","public, max-age=60, s-maxage=60");
 res.json({query:q,count:items.length,items,live:cache.live,source:"Alnus Yatırım"});
});


const AMP_FUTURES_MARGIN_URL="https://www.ampfutures.com/trading-info/margins";
const GLOBAL_FUTURES_CATALOG=[
 {id:"GC",code:"GC",name:"Gold Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"GC=F",tradingViewSymbol:"COMEX:GC1!",multiplier:100,marginRate:9,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"MGC",code:"MGC",name:"Micro Gold Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"MGC=F",tradingViewSymbol:"COMEX:MGC1!",multiplier:10,marginRate:9,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"SI",code:"SI",name:"Silver Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"SI=F",tradingViewSymbol:"COMEX:SI1!",multiplier:5000,marginRate:18,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"SIL",code:"SIL",name:"Micro Silver Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"SIL=F",tradingViewSymbol:"COMEX:SIL1!",multiplier:1000,marginRate:18,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"HG",code:"HG",name:"Copper Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"HG=F",tradingViewSymbol:"COMEX:HG1!",multiplier:25000,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"PL",code:"PL",name:"Platinum Futures",group:"Metals",exchange:"NYMEX",yahooSymbol:"PL=F",tradingViewSymbol:"NYMEX:PL1!",multiplier:50,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"PA",code:"PA",name:"Palladium Futures",group:"Metals",exchange:"NYMEX",yahooSymbol:"PA=F",tradingViewSymbol:"NYMEX:PA1!",multiplier:100,marginRate:14,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"CL",code:"CL",name:"WTI Crude Oil Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"CL=F",tradingViewSymbol:"NYMEX:CL1!",multiplier:1000,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"MCL",code:"MCL",name:"Micro WTI Crude Oil Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"MCL=F",tradingViewSymbol:"NYMEX:MCL1!",multiplier:100,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"BZ",code:"BZ",name:"Brent Crude Oil Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"BZ=F",tradingViewSymbol:"NYMEX:BB1!",multiplier:1000,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"NG",code:"NG",name:"Natural Gas Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"NG=F",tradingViewSymbol:"NYMEX:NG1!",multiplier:10000,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"QG",code:"QG",name:"E-mini Natural Gas Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"QG=F",tradingViewSymbol:"NYMEX:QG1!",multiplier:2500,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"RB",code:"RB",name:"RBOB Gasoline Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"RB=F",tradingViewSymbol:"NYMEX:RB1!",multiplier:42000,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"HO",code:"HO",name:"Heating Oil Futures",group:"Energy",exchange:"NYMEX",yahooSymbol:"HO=F",tradingViewSymbol:"NYMEX:HO1!",multiplier:42000,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZC",code:"ZC",name:"Corn Futures",group:"Grains",exchange:"CBOT",yahooSymbol:"ZC=F",tradingViewSymbol:"CBOT:ZC1!",multiplier:50,marginRate:10,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZW",code:"ZW",name:"Chicago Wheat Futures",group:"Grains",exchange:"CBOT",yahooSymbol:"ZW=F",tradingViewSymbol:"CBOT:ZW1!",multiplier:50,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"KE",code:"KE",name:"KC HRW Wheat Futures",group:"Grains",exchange:"CBOT",yahooSymbol:"KE=F",tradingViewSymbol:"CBOT:KE1!",multiplier:50,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZS",code:"ZS",name:"Soybean Futures",group:"Grains",exchange:"CBOT",yahooSymbol:"ZS=F",tradingViewSymbol:"CBOT:ZS1!",multiplier:50,marginRate:10,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZM",code:"ZM",name:"Soybean Meal Futures",group:"Grains",exchange:"CBOT",yahooSymbol:"ZM=F",tradingViewSymbol:"CBOT:ZM1!",multiplier:100,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZL",code:"ZL",name:"Soybean Oil Futures",group:"Grains",exchange:"CBOT",yahooSymbol:"ZL=F",tradingViewSymbol:"CBOT:ZL1!",multiplier:600,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"KC",code:"KC",name:"Coffee C Futures",group:"Softs",exchange:"ICE US",yahooSymbol:"KC=F",tradingViewSymbol:"ICEUS:KC1!",multiplier:375,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"SB",code:"SB",name:"Sugar No. 11 Futures",group:"Softs",exchange:"ICE US",yahooSymbol:"SB=F",tradingViewSymbol:"ICEUS:SB1!",multiplier:1120,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"CC",code:"CC",name:"Cocoa Futures",group:"Softs",exchange:"ICE US",yahooSymbol:"CC=F",tradingViewSymbol:"ICEUS:CC1!",multiplier:10,marginRate:18,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"CT",code:"CT",name:"Cotton No. 2 Futures",group:"Softs",exchange:"ICE US",yahooSymbol:"CT=F",tradingViewSymbol:"ICEUS:CT1!",multiplier:500,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"OJ",code:"OJ",name:"Orange Juice Futures",group:"Softs",exchange:"ICE US",yahooSymbol:"OJ=F",tradingViewSymbol:"ICEUS:OJ1!",multiplier:150,marginRate:18,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"LBR",code:"LBR",name:"Lumber Futures",group:"Forest",exchange:"CME",yahooSymbol:"LBR=F",tradingViewSymbol:"CME:LBR1!",multiplier:27.5,marginRate:18,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"LE",code:"LE",name:"Live Cattle Futures",group:"Livestock",exchange:"CME",yahooSymbol:"LE=F",tradingViewSymbol:"CME:LE1!",multiplier:400,marginRate:12,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"HE",code:"HE",name:"Lean Hogs Futures",group:"Livestock",exchange:"CME",yahooSymbol:"HE=F",tradingViewSymbol:"CME:HE1!",multiplier:400,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"GF",code:"GF",name:"Feeder Cattle Futures",group:"Livestock",exchange:"CME",yahooSymbol:"GF=F",tradingViewSymbol:"CME:GF1!",multiplier:500,marginRate:15,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ES",code:"ES",name:"E-mini S&P 500 Futures",group:"Equity Index",exchange:"CME",yahooSymbol:"ES=F",tradingViewSymbol:"CME_MINI:ES1!",multiplier:50,marginRate:8,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"MES",code:"MES",name:"Micro E-mini S&P 500 Futures",group:"Equity Index",exchange:"CME",yahooSymbol:"MES=F",tradingViewSymbol:"CME_MINI:MES1!",multiplier:5,marginRate:8,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"NQ",code:"NQ",name:"E-mini Nasdaq-100 Futures",group:"Equity Index",exchange:"CME",yahooSymbol:"NQ=F",tradingViewSymbol:"CME_MINI:NQ1!",multiplier:20,marginRate:10,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"MNQ",code:"MNQ",name:"Micro E-mini Nasdaq-100 Futures",group:"Equity Index",exchange:"CME",yahooSymbol:"MNQ=F",tradingViewSymbol:"CME_MINI:MNQ1!",multiplier:2,marginRate:10,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"YM",code:"YM",name:"E-mini Dow Futures",group:"Equity Index",exchange:"CBOT",yahooSymbol:"YM=F",tradingViewSymbol:"CBOT_MINI:YM1!",multiplier:5,marginRate:8,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"RTY",code:"RTY",name:"E-mini Russell 2000 Futures",group:"Equity Index",exchange:"CME",yahooSymbol:"RTY=F",tradingViewSymbol:"CME_MINI:RTY1!",multiplier:50,marginRate:10,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZB",code:"ZB",name:"30-Year U.S. Treasury Bond Futures",group:"Rates",exchange:"CBOT",yahooSymbol:"ZB=F",tradingViewSymbol:"CBOT:ZB1!",multiplier:1000,marginRate:4,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZN",code:"ZN",name:"10-Year U.S. Treasury Note Futures",group:"Rates",exchange:"CBOT",yahooSymbol:"ZN=F",tradingViewSymbol:"CBOT:ZN1!",multiplier:1000,marginRate:3,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZF",code:"ZF",name:"5-Year U.S. Treasury Note Futures",group:"Rates",exchange:"CBOT",yahooSymbol:"ZF=F",tradingViewSymbol:"CBOT:ZF1!",multiplier:1000,marginRate:3,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ZT",code:"ZT",name:"2-Year U.S. Treasury Note Futures",group:"Rates",exchange:"CBOT",yahooSymbol:"ZT=F",tradingViewSymbol:"CBOT:ZT1!",multiplier:2000,marginRate:2,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"BTC",code:"BTC",name:"CME Bitcoin Futures",group:"Crypto",exchange:"CME",yahooSymbol:"BTC=F",tradingViewSymbol:"CME:BTC1!",multiplier:5,marginRate:35,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"MBT",code:"MBT",name:"Micro Bitcoin Futures",group:"Crypto",exchange:"CME",yahooSymbol:"MBT=F",tradingViewSymbol:"CME:MBT1!",multiplier:.1,marginRate:35,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"ETH",code:"ETH",name:"CME Ether Futures",group:"Crypto",exchange:"CME",yahooSymbol:"ETH=F",tradingViewSymbol:"CME:ETH1!",multiplier:50,marginRate:35,quoteCurrency:"USD",marginCurrency:"USD"}
];
let globalFuturesCache={at:0,contracts:[],live:false,error:null};

function parseAmpMarginRows(html){
 const map=new Map();
 for(const row of String(html||"").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>decodeBasicHtml(x[1]));
  if(cells.length<3)continue;
  const upper=cells.map(x=>x.toUpperCase());
  const catalog=GLOBAL_FUTURES_CATALOG.find(item=>upper.some(x=>x===item.code||x===`/${item.code}`||x.includes(` ${item.code} `)));
  if(!catalog)continue;
  const nums=cells.map(trNumber).filter(x=>x!=null&&x>0);
  if(!nums.length)continue;
  const maintenance=nums.at(-1);
  const initial=maintenance*1.1;
  map.set(catalog.id,{initial,maintenance,source:"AMP maintenance × 1,10",estimated:true});
 }
 return map;
}
async function getGlobalFutures(force=false){
 if(!force&&globalFuturesCache.contracts.length&&Date.now()-globalFuturesCache.at<10*60*1000)return globalFuturesCache;
 let ampMargins=new Map(),error=null;
 try{ampMargins=parseAmpMarginRows(await fetchPublicText(AMP_FUTURES_MARGIN_URL,30000))}catch(err){error=err.message}
 const settled=await Promise.allSettled(GLOBAL_FUTURES_CATALOG.map(item=>fetchYahooChart(item.yahooSymbol)));
 const contracts=GLOBAL_FUTURES_CATALOG.map((item,index)=>{
  const quote=settled[index].status==="fulfilled"?settled[index].value:null;
  const price=quote?.price??null,amp=ampMargins.get(item.id);
  const calculated=price!=null?Math.abs(price*item.multiplier*item.marginRate/100):null;
  const initial=amp?.initial??calculated;
  const maintenance=amp?.maintenance??(initial!=null?initial*.9:null);
  return{
   ...item,price,changePercent:quote?.changePercent??null,delayed:true,
   initialMargin:initial,maintenanceMargin:maintenance,
   marginSource:amp?.source??`Notional × %${item.marginRate} risk tahmini`,
   marginEstimated:!amp,priceTime:quote?.marketTime??null
  };
 });
 globalFuturesCache={at:Date.now(),contracts,live:contracts.some(x=>x.price!=null),error,ampCount:ampMargins.size};
 return globalFuturesCache;
}
app.get("/api/global-futures/contracts",async(req,res)=>{
 const cache=await getGlobalFutures(req.query.refresh==="1");
 res.set("Cache-Control","public, max-age=120, s-maxage=120");
 res.json({
  contracts:cache.contracts,live:cache.live,error:cache.error,
  sourceLabel:`Yahoo gecikmeli fiyat + ${cache.ampCount?"AMP maintenance":"CME tarzı risk oranı tahmini"}`,
  sourceUrl:AMP_FUTURES_MARGIN_URL,asOf:new Date(cache.at).toISOString()
 });
});
app.get("/api/global-futures/search",async(req,res)=>{
 const q=String(req.query.q||"").trim().toUpperCase();
 const cache=await getGlobalFutures(false);
 const items=cache.contracts.filter(x=>!q||x.code.startsWith(q)||x.name.toUpperCase().includes(q)||x.group.toUpperCase().includes(q)).slice(0,60)
  .map(x=>({
   ...x,symbol:x.code,yahooSymbol:x.yahooSymbol,type:`Yurtdışı Futures · ${x.group}`,
   exchange:x.exchange,source:"Yahoo + AMP/CME",globalFutureId:x.id,futuresContract:x.code
  }));
 res.json({query:q,count:items.length,items,live:cache.live});
});

app.get("/api/data-diagnostic",async(req,res)=>{
 const symbol=String(req.query.symbol||"AAPL").trim().toUpperCase();
 const output={symbol,time:new Date().toISOString()};
 try{
  const details=await fetchYahooDetails(symbol);
  output.yahoo_ok=true;
  output.yahoo_fields={
   name:details.name,price:details.price,marketCap:details.marketCap,
   pe:details.trailingPE,priceToBook:details.priceToBook,
   currency:details.currency,sourceStatus:details.sourceStatus
  };
 }catch(error){
  output.yahoo_ok=false;output.yahoo_error=error.message;
 }
 res.json(output);
});

app.get("/api/openbb/status",async(req,res)=>{
 const result={
  configured:Boolean(OPENBB_BASE_URL),
  base_url:OPENBB_BASE_URL||null,
  provider:process.env.OPENBB_PROVIDER||"fmp",
  time:new Date().toISOString()
 };
 if(!OPENBB_BASE_URL)return res.json(result);
 try{
  const response=await fetch(`${OPENBB_BASE_URL}/openapi.json`,{
   headers:{Accept:"application/json"},
   signal:AbortSignal.timeout(20000)
  });
  result.openbb_http_status=response.status;
  result.openbb_reachable=response.ok;
  if(response.ok){
   const schema=await response.json();
   result.route_count=Object.keys(schema.paths||{}).length;
   result.sample_routes=Object.keys(schema.paths||{}).filter(x=>x.includes("equity")).slice(0,12);
  }
 }catch(error){
  result.openbb_reachable=false;
  result.error=error.message;
 }
 res.json(result);
});


function extractResponseText(payload){
 if(typeof payload?.output_text==="string")return payload.output_text;
 const parts=[];
 for(const item of payload?.output||[]){
  for(const content of item?.content||[]){
   if(typeof content?.text==="string")parts.push(content.text);
  }
 }
 return parts.join("\n").trim();
}
function financialLocalAnswer(question,context){
 const q=String(question||"").toLocaleLowerCase("tr-TR");
 const positions=Array.isArray(context?.positions)?context.positions:[];
 const found=positions.find(p=>q.includes(String(p.symbol||"").toLocaleLowerCase("tr-TR")));
 const positionText=found
  ?`\n\nPortföy bağlamı: ${found.symbol} ${found.direction}, açılış ${found.entry}, güncel ${found.currentPrice??"-"}, K/Z ${Number(found.pnlAmount||0).toLocaleString("tr-TR",{maximumFractionDigits:2})} ${found.currency||""}.`
  :"";
 const rules=[
  [["pd/dd","pd dd","defter değeri"],"PD/DD, piyasa değerini özkaynaklara böler. 1 altı defter değerinin altında fiyatlama gösterebilir; ancak düşük ROE, varlık kalitesi veya bilanço riski nedeniyle düşük kalabilir. Bankalarda ROE ve sermaye yeterliliğiyle, sanayi şirketlerinde varlıkların ekonomik değeriyle birlikte okunmalıdır."],
  [["f/k","fiyat kazanç"],"F/K, fiyatın hisse başına kâra oranıdır. Negatif değer zarar anlamına gelir. 10–20 genel olarak dengeli sayılabilse de büyüme, kâr kalitesi, döngüsellik ve sektör medyanı belirleyicidir."],
  [["fd/favök","favök"],"FD/FAVÖK borcu da firma değerine dahil ettiği için sermaye yapıları farklı şirketleri karşılaştırmada faydalıdır. 8 altı düşük, 8–12 dengeli, 12 üzeri primli olabilir; bankalarda uygun değildir."],
  [["viop","başlangıç teminatı","sürdürme teminatı"],"Başlangıç teminatı pozisyonu açmak için gereken tutardır. Sürdürme teminatı hesabın altına düşmemesi gereken eşiktir. Teminat azalırsa tamamlama çağrısı oluşabilir. Gerçek risk, teminat değil kontratın toplam pozisyon büyüklüğüdür."],
  [["stop","risk yönetimi"],"Profesyonel risk planı; teknik geçersizlik seviyesi, pozisyon büyüklüğü, portföy korelasyonu ve maksimum kabul edilen para kaybını birlikte belirler. Önce stop mesafesi, sonra risk bütçesi, en son kontrat/adet hesaplanmalıdır."],
  [["roe","özsermaye kârlılığı"],"ROE özkaynağın kâr üretme gücünü ölçer. %15 üzeri genellikle güçlüdür; fakat yüksek kaldıraç ROE’yi yapay biçimde yükseltebilir. Borç/özsermaye ve nakit akışıyla birlikte okunmalıdır."],
  [["teknik analiz","trend"],"Teknik analizde önce piyasa rejimi ve ana trend, sonra destek/direnç, hacim ve volatilite incelenmelidir. Tek bir indikatör yerine fiyat yapısı ile risk seviyesi birlikte kullanılmalıdır."]
 ];
 for(const [keys,answer] of rules)if(keys.some(k=>q.includes(k)))return answer+positionText;
 if(found)return`${found.symbol} için mevcut portföy verisine göre pozisyon büyüklüğü, stop mesafesi ve toplam portföy korelasyonunu birlikte kontrol etmelisiniz. Güncel K/Z tek başına karar ölçütü değildir.${positionText}`;
 return"Bu soruyu yerel Warren AI Lite yanıtlıyor. Daha kapsamlı doğal dil analizi için Render ortamına OPENAI_API_KEY ekleyebilirsiniz. Soruyu sembol, dönem ve istediğiniz analiz türüyle daha net yazın; örneğin “KCHOL PD/DD ve ROE karşılaştırması” veya “GC futures teminat ve kaldıraç analizi”.";
}
app.get("/api/ai/status",(_req,res)=>{
 const openai=Boolean(process.env.OPENAI_API_KEY);
 const compatible=!openai&&Boolean(process.env.AI_API_KEY&&process.env.AI_BASE_URL);
 res.json({
  provider:openai?"openai":compatible?"compatible":"local",
  model:openai?(process.env.OPENAI_MODEL||"gpt-5.6"):compatible?(process.env.AI_MODEL||"configured"):"Warren AI Lite"
 });
});
app.post("/api/ai/chat",express.json({limit:"200kb"}),async(req,res)=>{
 const messages=Array.isArray(req.body?.messages)?req.body.messages.slice(-20):[];
 const context=req.body?.context||null;
 const last=messages.filter(x=>x.role==="user").at(-1)?.content;
 if(!last)return res.status(400).json({error:"Soru gereklidir"});
 const systemInstruction="Sen Warren AI adlı finansal eğitim asistanısın. Türkçe cevap ver. Piyasa verisi verilmediyse güncel fiyat uydurma. Değerleme, risk, teknik analiz ve portföy yönetiminde net ve profesyonel ol. Kişiselleştirilmiş kesin al/sat emri verme; varsayımları belirt.";
 try{
  if(process.env.OPENAI_API_KEY){
   const response=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{"Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
     model:process.env.OPENAI_MODEL||"gpt-5.6",
     instructions:systemInstruction,
     input:[
      ...messages.map(m=>({role:m.role==="assistant"?"assistant":"user",content:String(m.content||"")})),
      ...(context?[{role:"user",content:`Portföy bağlamı JSON: ${JSON.stringify(context)}`}]:[])
     ]
    }),
    signal:AbortSignal.timeout(90000)
   });
   const payload=await response.json();
   if(!response.ok)throw new Error(payload?.error?.message||`OpenAI HTTP ${response.status}`);
   return res.json({answer:extractResponseText(payload)||"Yanıt üretilemedi.",provider:"openai",providerLabel:`OpenAI · ${process.env.OPENAI_MODEL||"gpt-5.6"}`});
  }
  if(process.env.AI_API_KEY&&process.env.AI_BASE_URL){
   const endpoint=String(process.env.AI_BASE_URL).replace(/\/$/,"")+"/chat/completions";
   const response=await fetch(endpoint,{
    method:"POST",
    headers:{"Authorization":`Bearer ${process.env.AI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
     model:process.env.AI_MODEL||"default",
     messages:[{role:"system",content:systemInstruction},...messages,...(context?[{role:"user",content:`Portföy bağlamı JSON: ${JSON.stringify(context)}`}]:[])]
    }),
    signal:AbortSignal.timeout(90000)
   });
   const payload=await response.json();
   if(!response.ok)throw new Error(payload?.error?.message||`AI HTTP ${response.status}`);
   return res.json({answer:payload?.choices?.[0]?.message?.content||"Yanıt üretilemedi.",provider:"compatible",providerLabel:`AI · ${process.env.AI_MODEL||"configured"}`});
  }
  return res.json({answer:financialLocalAnswer(last,context),provider:"local",providerLabel:"Warren AI Lite"});
 }catch(error){
  return res.status(502).json({error:error.message});
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

const uiEntryFile = path.join(publicDir, "app.html");

app.get("/__ui-diagnostic", (_req, res) => {
  try {
    const text = fs.readFileSync(uiEntryFile, "utf8");
    res.json({
      ok: true,
      uiEntryFile,
      exists: true,
      first80: text.slice(0, 80),
      size: Buffer.byteLength(text),
      startsWithDoctype: text.trimStart().toLowerCase().startsWith("<!doctype html>")
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      uiEntryFile,
      exists: false,
      error: error.message
    });
  }
});

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.sendFile(uiEntryFile);
});

app.get("*", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(uiEntryFile);
});

app.listen(PORT, () => {
  let uiStatus = "missing";
  try {
    const first = fs.readFileSync(uiEntryFile, "utf8").slice(0, 80);
    uiStatus = JSON.stringify(first);
  } catch (error) {
    uiStatus = `ERROR: ${error.message}`;
  }
  console.log(`Portfolio Tracker running on port ${PORT}`);
  console.log(`UI entry: ${uiEntryFile}`);
  console.log(`UI first bytes: ${uiStatus}`);
});
