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
 for(const params of variants){
  for(const route of routes){
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
app.get("/api/openbb/research",async(req,res)=>{
 const requested=String(req.query.symbol||"").trim().toUpperCase();
 if(!requested)return res.status(400).json({error:"Sembol gereklidir"});
 const isBist=requested.endsWith(".IS")||req.query.market==="BIST";
 const symbol=isBist?yahooSymbolFor(requested):requested;
 const preferred=String(req.query.provider||process.env.OPENBB_PROVIDER||"fmp").trim();
 const providers=isBist?["yfinance","fmp"]:[preferred,"fmp","yfinance"].filter((v,i,a)=>v&&a.indexOf(v)===i);
 const cacheKey=`${symbol}|${providers.join(",")}`;
 const force=req.query.force==="1",cached=openbbResearchCache.get(cacheKey);
 if(!force&&cached&&Date.now()-cached.at<10*60*1000)return res.json(cached.data);
 if(!OPENBB_BASE_URL)return res.json({configured:false,symbol,source_note:"OpenBB servisi yapılandırılmadı."});
 const variants=(extra={})=>providers.map(provider=>({symbol,provider,...extra}));
 const periodVariants=(extra={})=>providers.map(provider=>({symbol,provider,period:"annual",limit:5,...extra}));
 const [info,quote,metrics,ratios,income,balance,cash,dividends,priceTarget,estimates,news]=await Promise.all([
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
 let fallback={};
 try{fallback=yahooFallbackShape(await yahooQuoteSummary(symbol),symbol)}catch{}
 const choose=(primary,key)=>hasOpenBBData(primary)?primary:(fallback[key]||primary);
 const openbbCount=[info,quote,metrics,ratios,income,balance,cash,news].filter(hasOpenBBData).length;
 const data={
  configured:true,symbol,provider:providers[0],
  source_note:isBist
   ?"BIST verileri OpenBB yfinance sağlayıcısı üzerinden; eksik anlık alanlar Yahoo Finance yedeklemesiyle getiriliyor. TradingView, BIST sembollerini dış widget’larda lisans nedeniyle göstermediğinden teknik grafik TradingView Lightweight Charts motoruyla gecikmeli fiyat verisinden çiziliyor."
   :"Temel veriler OpenBB üzerinden getiriliyor; sağlayıcının döndürmediği özet alanlarda Yahoo Finance yedeklemesi kullanılıyor.",
  info:choose(info,"info"),quote:choose(quote,"quote"),metrics:choose(metrics,"metrics"),ratios,
  income,balance,cash,dividends,price_target:choose(priceTarget,"price_target"),estimates,news,
  diagnostics:{openbb_sections_with_data:openbbCount,providers_tried:providers},
  fetchedAt:new Date().toISOString()
 };
 openbbResearchCache.set(cacheKey,{at:Date.now(),data});
 res.set("Cache-Control","public, max-age=300, s-maxage=300");
 res.json(data);
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
