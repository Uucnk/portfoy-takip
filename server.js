import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL || "";
const SESSION_COOKIE = "portfolio_session";
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const scryptAsync = promisify(crypto.scrypt);
const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    })
  : null;
let databaseReady = false;
let databaseError = DATABASE_URL ? null : "DATABASE_URL tanımlı değil";
const loginAttempts = new Map();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  next();
});
app.use(express.json({ limit: "3mb" }));

function normalizeUsername(value="") {
  return String(value).trim().toLocaleLowerCase("tr-TR");
}
function publicUser(row) {
  return {
    id: String(row.id), username: row.username, firstName: row.first_name,
    lastName: row.last_name, role: row.role, createdAt: row.created_at
  };
}
function parseCookies(header="") {
  return Object.fromEntries(String(header).split(";").map(x=>x.trim()).filter(Boolean).map(part=>{
    const i=part.indexOf("=");return i<0?[part,""]:[part.slice(0,i),decodeURIComponent(part.slice(i+1))];
  }));
}
function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
async function hashPassword(password) {
  const salt=crypto.randomBytes(16);const derived=await scryptAsync(password,salt,64,{N:16384,r:8,p:1});
  return `scrypt$16384$8$1$${salt.toString("base64")}$${Buffer.from(derived).toString("base64")}`;
}
async function verifyPassword(password,stored) {
  try {
    const [kind,n,r,p,salt64,hash64]=String(stored).split("$");if(kind!=="scrypt")return false;
    const expected=Buffer.from(hash64,"base64");const actual=Buffer.from(await scryptAsync(password,Buffer.from(salt64,"base64"),expected.length,{N:Number(n),r:Number(r),p:Number(p)}));
    return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
  } catch { return false; }
}
function validateRegistration(body) {
  const username=normalizeUsername(body.username),firstName=String(body.firstName||"").trim(),lastName=String(body.lastName||"").trim(),password=String(body.password||""),passwordConfirm=String(body.passwordConfirm||"");
  if(!/^[a-z0-9._-]{3,24}$/.test(username))throw new Error("Kullanıcı adı 3–24 karakter olmalı; yalnızca harf, rakam, nokta, alt çizgi ve tire kullanılabilir.");
  if(firstName.length<2||firstName.length>50||lastName.length<2||lastName.length>50)throw new Error("İsim ve soyisim 2–50 karakter olmalıdır.");
  if(password.length<8||password.length>128)throw new Error("Şifre en az 8 karakter olmalıdır.");
  if(password!==passwordConfirm)throw new Error("Şifreler birbiriyle aynı değil.");
  return {username,firstName,lastName,password};
}
async function initializeDatabase() {
  if(!dbPool)return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(24) NOT NULL UNIQUE,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50) NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(user_id);
      CREATE INDEX IF NOT EXISTS app_sessions_expires_idx ON app_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS app_user_state (
        user_id BIGINT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await dbPool.query("DELETE FROM app_sessions WHERE expires_at < NOW()");
    const adminPassword=process.env.ADMIN_PASSWORD;
    if(adminPassword){
      const username=normalizeUsername(process.env.ADMIN_USERNAME||"uucnk");
      const existing=await dbPool.query("SELECT id,role FROM app_users WHERE username=$1",[username]);
      if(!existing.rowCount){
        const passwordHash=await hashPassword(adminPassword);
        await dbPool.query("INSERT INTO app_users(username,first_name,last_name,password_hash,role) VALUES($1,$2,$3,$4,'admin')",[username,process.env.ADMIN_FIRST_NAME||"Umut",process.env.ADMIN_LAST_NAME||"Canik",passwordHash]);
        console.log(`Admin account created: ${username}`);
      }else if(existing.rows[0].role!=="admin"){
        await dbPool.query("UPDATE app_users SET role='admin',updated_at=NOW() WHERE id=$1",[existing.rows[0].id]);
      }
    }
    databaseReady=true;databaseError=null;
  } catch(error) {
    databaseReady=false;databaseError=error.message;console.error("Database initialization error:",error);
  }
}
async function createSession(res,req,userId,remember=false) {
  const token=crypto.randomBytes(32).toString("base64url");
  const maxAge=remember?REMEMBER_DAYS*86400:SESSION_HOURS*3600;
  await dbPool.query("INSERT INTO app_sessions(user_id,token_hash,expires_at,user_agent) VALUES($1,$2,NOW()+($3||' seconds')::interval,$4)",[userId,tokenHash(token),String(maxAge),String(req.headers["user-agent"]||"").slice(0,500)]);
  const secure=req.secure||req.headers["x-forwarded-proto"]==="https";
  res.setHeader("Set-Cookie",`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?"; Secure":""}`);
}
function clearSessionCookie(res,req) {
  const secure=req.secure||req.headers["x-forwarded-proto"]==="https";
  res.setHeader("Set-Cookie",`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?"; Secure":""}`);
}
async function resolveAuth(req) {
  if(!dbPool||!databaseReady)return null;
  const token=parseCookies(req.headers.cookie||"")[SESSION_COOKIE];if(!token)return null;
  const result=await dbPool.query(`SELECT u.*,s.id AS session_id FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`,[tokenHash(token)]);
  if(!result.rowCount)return null;
  req.sessionToken=token;req.sessionId=result.rows[0].session_id;req.user=result.rows[0];
  dbPool.query("UPDATE app_sessions SET last_seen_at=NOW() WHERE id=$1",[req.sessionId]).catch(()=>{});
  return req.user;
}
async function authRequired(req,res,next) {
  try{const user=await resolveAuth(req);if(!user)return res.status(401).json({error:"Oturum açmanız gerekiyor."});next()}catch(error){res.status(500).json({error:"Oturum doğrulanamadı."})}
}
async function adminRequired(req,res,next) {
  await authRequired(req,res,()=>{if(req.user.role!=="admin")return res.status(403).json({error:"Bu alan yalnızca ana hesaba açıktır."});next()});
}
function loginRateKey(req,username){return`${req.ip}|${username}`}
function checkLoginRate(req,username){const key=loginRateKey(req,username),now=Date.now(),row=loginAttempts.get(key);if(!row||now-row.first>15*60*1000){loginAttempts.set(key,{count:0,first:now});return}if(row.count>=8)throw new Error("Çok fazla başarısız giriş denemesi. 15 dakika bekleyin.")}
function recordLoginFailure(req,username){const key=loginRateKey(req,username),row=loginAttempts.get(key)||{count:0,first:Date.now()};row.count++;loginAttempts.set(key,row)}

app.get("/api/auth/status",(_req,res)=>res.json({databaseConfigured:Boolean(DATABASE_URL),ready:databaseReady,error:databaseReady?null:databaseError,registrationEnabled:process.env.ALLOW_REGISTRATION!=="false"}));
app.get("/api/auth/me",authRequired,(req,res)=>{res.set("Cache-Control","no-store");res.json({user:publicUser(req.user)})});
app.post("/api/auth/register",async(req,res)=>{
  if(!dbPool||!databaseReady)return res.status(503).json({error:"Veritabanı bağlantısı hazır değil."});
  if(process.env.ALLOW_REGISTRATION==="false")return res.status(403).json({error:"Yeni kayıt şu anda kapalı."});
  try{
    const data=validateRegistration(req.body||{}),passwordHash=await hashPassword(data.password);
    const result=await dbPool.query("INSERT INTO app_users(username,first_name,last_name,password_hash,role) VALUES($1,$2,$3,$4,'user') RETURNING *",[data.username,data.firstName,data.lastName,passwordHash]);
    await createSession(res,req,result.rows[0].id,true);res.status(201).json({user:publicUser(result.rows[0])});
  }catch(error){if(error.code==="23505")return res.status(409).json({error:"Bu kullanıcı adı daha önce alınmış."});res.status(400).json({error:error.message})}
});
app.post("/api/auth/login",async(req,res)=>{
  if(!dbPool||!databaseReady)return res.status(503).json({error:"Veritabanı bağlantısı hazır değil."});
  const username=normalizeUsername(req.body?.username),password=String(req.body?.password||"");
  try{checkLoginRate(req,username)}catch(error){return res.status(429).json({error:error.message})}
  const result=await dbPool.query("SELECT * FROM app_users WHERE username=$1",[username]);
  if(!result.rowCount||!(await verifyPassword(password,result.rows[0].password_hash))){recordLoginFailure(req,username);return res.status(401).json({error:"Kullanıcı adı veya şifre hatalı."})}
  loginAttempts.delete(loginRateKey(req,username));await createSession(res,req,result.rows[0].id,Boolean(req.body?.remember));res.json({user:publicUser(result.rows[0])});
});
app.post("/api/account/change-password",authRequired,async(req,res)=>{
  try{
    const currentPassword=String(req.body?.currentPassword||"");
    const newPassword=String(req.body?.newPassword||"");
    const confirmPassword=String(req.body?.confirmPassword||"");
    if(currentPassword.length<1)return res.status(400).json({error:"Mevcut şifrenizi girin."});
    if(newPassword.length<8||newPassword.length>128)return res.status(400).json({error:"Yeni şifre 8–128 karakter arasında olmalıdır."});
    if(newPassword!==confirmPassword)return res.status(400).json({error:"Yeni şifreler birbiriyle aynı değil."});
    const result=await dbPool.query("SELECT password_hash FROM app_users WHERE id=$1",[req.user.id]);
    if(!result.rowCount)return res.status(404).json({error:"Kullanıcı hesabı bulunamadı."});
    const currentHash=result.rows[0].password_hash;
    if(!(await verifyPassword(currentPassword,currentHash)))return res.status(401).json({error:"Mevcut şifre hatalı."});
    if(await verifyPassword(newPassword,currentHash))return res.status(400).json({error:"Yeni şifre mevcut şifreden farklı olmalıdır."});
    const newHash=await hashPassword(newPassword);
    await dbPool.query("BEGIN");
    try{
      await dbPool.query("UPDATE app_users SET password_hash=$1,updated_at=NOW() WHERE id=$2",[newHash,req.user.id]);
      await dbPool.query("DELETE FROM app_sessions WHERE user_id=$1 AND id<>$2",[req.user.id,req.sessionId]);
      await dbPool.query("COMMIT");
    }catch(error){
      await dbPool.query("ROLLBACK");
      throw error;
    }
    res.json({ok:true,message:"Şifren başarıyla değiştirildi. Diğer cihazlardaki oturumlar kapatıldı."});
  }catch(error){
    console.error("Password change error:",error);
    res.status(500).json({error:"Şifre güncellenirken bir sunucu hatası oluştu."});
  }
});

app.post("/api/auth/logout",async(req,res)=>{try{await resolveAuth(req);if(req.sessionId)await dbPool.query("DELETE FROM app_sessions WHERE id=$1",[req.sessionId])}catch{}clearSessionCookie(res,req);res.json({ok:true})});
app.get("/api/state",authRequired,async(req,res)=>{const result=await dbPool.query("SELECT state,updated_at FROM app_user_state WHERE user_id=$1",[req.user.id]);res.set("Cache-Control","no-store");res.json({hasState:Boolean(result.rowCount),state:result.rows[0]?.state||{},updatedAt:result.rows[0]?.updated_at||null})});
app.put("/api/state",authRequired,async(req,res)=>{const state=req.body?.state;if(!state||typeof state!=="object"||Array.isArray(state))return res.status(400).json({error:"Geçerli hesap verisi gereklidir."});const size=Buffer.byteLength(JSON.stringify(state));if(size>2500000)return res.status(413).json({error:"Hesap verisi 2,5 MB sınırını aşıyor."});const result=await dbPool.query("INSERT INTO app_user_state(user_id,state,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW() RETURNING updated_at",[req.user.id,JSON.stringify(state)]);res.json({ok:true,updatedAt:result.rows[0].updated_at})});
app.get("/api/admin/users",adminRequired,async(_req,res)=>{const result=await dbPool.query(`SELECT u.id,u.username,u.first_name,u.last_name,u.role,u.created_at,st.updated_at AS state_updated_at,MAX(s.last_seen_at) AS last_seen_at FROM app_users u LEFT JOIN app_user_state st ON st.user_id=u.id LEFT JOIN app_sessions s ON s.user_id=u.id GROUP BY u.id,st.updated_at ORDER BY CASE WHEN u.role='admin' THEN 0 ELSE 1 END,u.first_name,u.last_name`);res.set("Cache-Control","no-store");res.json({users:result.rows.map(row=>({...publicUser(row),stateUpdatedAt:row.state_updated_at,lastSeenAt:row.last_seen_at}))})});
app.get("/api/admin/users/:id/state",adminRequired,async(req,res)=>{if(!/^\d+$/.test(req.params.id))return res.status(400).json({error:"Geçersiz hesap."});const result=await dbPool.query("SELECT u.*,st.state,st.updated_at AS state_updated_at FROM app_users u LEFT JOIN app_user_state st ON st.user_id=u.id WHERE u.id=$1",[req.params.id]);if(!result.rowCount)return res.status(404).json({error:"Hesap bulunamadı."});res.set("Cache-Control","no-store");res.json({user:publicUser(result.rows[0]),state:result.rows[0].state||{},updatedAt:result.rows[0].state_updated_at||null})});


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
    country: profile.country || null,
    website: profile.website || null,
    longBusinessSummary: profile.longBusinessSummary || null,
    fullTimeEmployees: profile.fullTimeEmployees || null,
    quoteType,
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
  currency:q.currency||null,
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

async function fetchYahooModuleSet(symbol,modules){
 const encoded=encodeURIComponent(symbol),moduleString=modules.join(",");
 return fetchJsonFromYahoo([`/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent(moduleString)}`]).then(json=>json?.quoteSummary?.result?.[0]||{});
}
async function fetchYahooResearchBundle(symbol){
 const sets=[
  ["price","quoteType","summaryDetail","defaultKeyStatistics","financialData","assetProfile","calendarEvents","recommendationTrend","earningsTrend","earningsHistory","earnings"],
  ["incomeStatementHistory","incomeStatementHistoryQuarterly","balanceSheetHistory","balanceSheetHistoryQuarterly","cashflowStatementHistory","cashflowStatementHistoryQuarterly"],
  ["fundProfile","topHoldings","fundPerformance","fundOwnership","majorHoldersBreakdown","institutionOwnership"]
 ];
 const values=await Promise.all(sets.map(modules=>fetchYahooModuleSet(symbol,modules).catch(()=>({}))));
 return Object.assign({},...values);
}
function flatYahooRow(row,source="Yahoo Finance"){
 const rawEnd=row?.endDate?.raw,period=row?.endDate?.fmt||(rawEnd?new Date(Number(rawEnd)*1000).toISOString().slice(0,10):"-");
 const output={period,source};
 for(const [key,value] of Object.entries(row||{})){
  if(["maxAge","endDate"].includes(key))continue;
  const v=raw(value);if(v!==null&&v!==undefined&&v!=="")output[key.replace(/[A-Z]/g,m=>"_"+m.toLowerCase())]=v;
 }
 return output;
}
function yahooStatementShape(bundle){
 const incomeAnnual=bundle?.incomeStatementHistory?.incomeStatementHistory||[];
 const incomeQuarter=bundle?.incomeStatementHistoryQuarterly?.incomeStatementHistory||[];
 const balanceAnnual=bundle?.balanceSheetHistory?.balanceSheetStatements||[];
 const balanceQuarter=bundle?.balanceSheetHistoryQuarterly?.balanceSheetStatements||[];
 const cashAnnual=bundle?.cashflowStatementHistory?.cashflowStatements||[];
 const cashQuarter=bundle?.cashflowStatementHistoryQuarterly?.cashflowStatements||[];
 return{
  income:{results:incomeAnnual.map(x=>flatYahooRow(x))},income_quarterly:{results:incomeQuarter.map(x=>flatYahooRow(x))},
  balance:{results:balanceAnnual.map(x=>flatYahooRow(x))},balance_quarterly:{results:balanceQuarter.map(x=>flatYahooRow(x))},
  cash:{results:cashAnnual.map(x=>flatYahooRow(x))},cash_quarterly:{results:cashQuarter.map(x=>flatYahooRow(x))}
 };
}
function yahooAnalystShape(bundle){
 const fd=bundle?.financialData||{},trend=bundle?.recommendationTrend?.trend||[],earnings=bundle?.earningsTrend?.trend||[];
 return{
  price_target:{results:[{
   target_consensus:raw(fd.targetMeanPrice),target_high:raw(fd.targetHighPrice),target_low:raw(fd.targetLowPrice),
   analyst_count:raw(fd.numberOfAnalystOpinions),recommendation_key:fd.recommendationKey,
   recommendation_mean:raw(fd.recommendationMean)
  }]},
  recommendation_trend:{results:trend.map(x=>({period:x.period,strongBuy:x.strongBuy,buy:x.buy,hold:x.hold,sell:x.sell,strongSell:x.strongSell}))},
  earnings_estimates:{results:earnings.map(x=>({
   period:x.period,end_date:x.endDate,earnings_avg:raw(x.earningsEstimate?.avg),earnings_low:raw(x.earningsEstimate?.low),earnings_high:raw(x.earningsEstimate?.high),
   earnings_growth:raw(x.earningsEstimate?.growth),revenue_avg:raw(x.revenueEstimate?.avg),revenue_low:raw(x.revenueEstimate?.low),revenue_high:raw(x.revenueEstimate?.high),revenue_growth:raw(x.revenueEstimate?.growth)
  }))},
  analyst_summary:{recommendation_key:fd.recommendationKey,recommendation_mean:raw(fd.recommendationMean)}
 };
}
function normalizeYahooPercent(v){const n=Number(raw(v));return Number.isFinite(n)?(Math.abs(n)<=1?n*100:n):null}
function yahooEtfShape(bundle,symbol){
 const price=bundle?.price||{},quoteType=String(price.quoteType||bundle?.quoteType?.quoteType||"").toUpperCase();
 const fp=bundle?.fundProfile||{},th=bundle?.topHoldings||{},perf=bundle?.fundPerformance||{},sd=bundle?.summaryDetail||{};
 const isEtf=["ETF","MUTUALFUND"].includes(quoteType)||Boolean(fp.categoryName||th.holdings?.length);
 if(!isEtf)return{is_etf:false};
 const fees=fp.feesExpensesInvestment||{};
 const holdings=(th.holdings||[]).map(x=>({symbol:x.symbol,name:x.holdingName,weight:normalizeYahooPercent(x.holdingPercent)}));
 const sectors=(th.sectorWeightings||[]).flatMap(obj=>Object.entries(obj||{}).map(([name,weight])=>({name,weight:normalizeYahooPercent(weight)})));
 const returns=perf.trailingReturns||{};
 return{
  is_etf:quoteType==="ETF",is_fund:true,symbol,source:"Yahoo Finance fon modülleri",
  family:fp.family,category:fp.categoryName,legal_type:fp.legalType,currency:price.currency,
  description:fp.description||fp.longBusinessSummary||`${price.longName||price.shortName||symbol} bir borsa yatırım fonu / yatırım fonudur.`,
  total_assets:raw(sd.totalAssets)||raw(price.marketCap),expense_ratio:normalizeYahooPercent(fees.annualReportExpenseRatio||fees.netExpRatio),
  yield:normalizeYahooPercent(sd.yield||sd.dividendYield),ytd_return:normalizeYahooPercent(returns.ytd),
  three_year_return:normalizeYahooPercent(returns.threeYear),five_year_return:normalizeYahooPercent(returns.fiveYear),
  inception_date:fp.fundInceptionDate?.fmt||fp.fundInceptionDate,holdings,sectors,
  equity_holdings:th.equityHoldings||null,bond_holdings:th.bondHoldings||null
 };
}
async function fetchYahooNews(query,symbol){
 const url=`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query||symbol)}&quotesCount=0&newsCount=40&enableFuzzyQuery=true&lang=en-US&region=US`;
 const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`Yahoo news HTTP ${response.status}`);
 const json=await response.json();
 return(json.news||[]).map(x=>({title:x.title,url:x.link,publisher:x.publisher,source:x.publisher||"Yahoo Finance",source_key:"yahoo",published_date:x.providerPublishTime?new Date(x.providerPublishTime*1000).toISOString():"",summary:x.summary||"",uuid:x.uuid}));
}
function decodeXml(value=""){return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim()}
async function fetchGoogleNews(query,isTr=false){
 const lang=isTr?"tr":"en-US",gl=isTr?"TR":"US",ceid=isTr?"TR:tr":"US:en";
 const url=`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=${gl}&ceid=${ceid}`;
 const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/rss+xml,application/xml,text/xml"},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`Google News HTTP ${response.status}`);
 const xml=await response.text(),items=[];
 for(const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)){
  const part=match[1],read=tag=>decodeXml(part.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,`i`))?.[1]||"");
  const source=read("source")||"Google News";items.push({title:read("title"),url:read("link"),source,source_key:"google",published_date:read("pubDate"),summary:read("description")});
 }
 return items.slice(0,40);
}
function dedupeNews(items){const seen=new Set();return items.filter(x=>{const key=String(x.title||"").toLocaleLowerCase("tr-TR").replace(/[^a-z0-9çğıöşü]+/gi," ").trim();if(!key||seen.has(key))return false;seen.add(key);return true}).sort((a,b)=>new Date(b.published_date||b.date||0)-new Date(a.published_date||a.date||0));}

async function yahooQuoteSummary(symbol){
 const modules="price,quoteType,summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,recommendationTrend,earningsTrend,earningsHistory,earnings";
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
    headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36","Accept":"text/html,text/csv,text/plain,application/xhtml+xml,*/*"},
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
function recordList(container){
 if(Array.isArray(container))return container;
 if(Array.isArray(container?.results))return container.results;
 if(Array.isArray(container?.data))return container.data;
 if(container?.results&&typeof container.results==="object")return[container.results];
 if(container?.data&&typeof container.data==="object")return[container.data];
 return[];
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

function secAnnualFactRows(companyFacts,taxonomy,tag,units,instant=false){
 const rows=secFactRows(companyFacts,taxonomy,tag,units).filter(x=>["10-K","20-F","40-F"].includes(x.form)&&x.val!=null);
 const chosen=new Map();
 for(const row of rows){
  const year=Number(row.fy)||(row.end?Number(String(row.end).slice(0,4)):null);if(!year)continue;
  if(!instant&&row.start&&row.end){const days=(new Date(row.end)-new Date(row.start))/86400000;if(days<250)continue}
  const old=chosen.get(year);if(!old||String(row.filed||"")>String(old.filed||""))chosen.set(year,row);
 }
 return chosen;
}
function secStatementSeries(companyFacts,definitions,instant=false){
 const years=new Set(),series={};
 for(const [key,tags,units] of definitions){
  let map=new Map();for(const tag of tags){const candidate=secAnnualFactRows(companyFacts,"us-gaap",tag,units,instant);for(const [year,row] of candidate)if(!map.has(year))map.set(year,row)}
  series[key]=map;for(const year of map.keys())years.add(year);
 }
 return[...years].sort((a,b)=>b-a).slice(0,5).map(year=>{
  const row={period:`${year} FY`,fiscal_year:year,source:"SEC EDGAR XBRL"};
  for(const [key] of definitions)row[key]=series[key].get(year)?.val??null;
  return row;
 });
}
function buildSecStatements(companyFacts){
 const incomeDefs=[
  ["revenue",["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet"],["USD"]],
  ["cost_of_revenue",["CostOfRevenue","CostOfGoodsAndServicesSold","CostOfGoodsSold"],["USD"]],
  ["gross_profit",["GrossProfit"],["USD"]],["research_and_development",["ResearchAndDevelopmentExpense"],["USD"]],
  ["selling_general_administrative",["SellingGeneralAndAdministrativeExpense","GeneralAndAdministrativeExpense"],["USD"]],
  ["operating_income",["OperatingIncomeLoss"],["USD"]],["interest_expense",["InterestExpenseNonOperating","InterestExpense"],["USD"]],
  ["pretax_income",["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest","IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],["USD"]],
  ["income_tax_expense",["IncomeTaxExpenseBenefit"],["USD"]],["net_income",["NetIncomeLoss","ProfitLoss"],["USD"]],
  ["diluted_eps",["EarningsPerShareDiluted"],["USD/shares"]]
 ];
 const balanceDefs=[
  ["cash_and_equivalents",["CashAndCashEquivalentsAtCarryingValue","CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],["USD"]],
  ["receivables",["AccountsReceivableNetCurrent","AccountsNotesAndLoansReceivableNetCurrent"],["USD"]],["inventory",["InventoryNet"],["USD"]],
  ["current_assets",["AssetsCurrent"],["USD"]],["total_assets",["Assets"],["USD"]],
  ["current_liabilities",["LiabilitiesCurrent"],["USD"]],["total_liabilities",["Liabilities"],["USD"]],
  ["short_term_debt",["LongTermDebtCurrent","ShortTermBorrowings"],["USD"]],["long_term_debt",["LongTermDebtNoncurrent","LongTermDebt"],["USD"]],
  ["stockholders_equity",["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],["USD"]]
 ];
 const cashDefs=[
  ["operating_cash_flow",["NetCashProvidedByUsedInOperatingActivities"],["USD"]],
  ["capital_expenditures",["PaymentsToAcquirePropertyPlantAndEquipment","PaymentsForAdditionsToPropertyPlantAndEquipment"],["USD"]],
  ["investing_cash_flow",["NetCashProvidedByUsedInInvestingActivities"],["USD"]],["financing_cash_flow",["NetCashProvidedByUsedInFinancingActivities"],["USD"]],
  ["dividends_paid",["PaymentsOfDividends","PaymentsOfDividendsCommonStock"],["USD"]],["share_repurchases",["PaymentsForRepurchaseOfCommonStock"],["USD"]],
  ["depreciation_amortization",["DepreciationDepletionAndAmortization","DepreciationDepletionAndAmortizationPropertyPlantAndEquipment"],["USD"]]
 ];
 const income=secStatementSeries(companyFacts,incomeDefs,false),balance=secStatementSeries(companyFacts,balanceDefs,true),cash=secStatementSeries(companyFacts,cashDefs,false);
 for(const row of cash)if(row.operating_cash_flow!=null&&row.capital_expenditures!=null)row.free_cash_flow=Number(row.operating_cash_flow)-Math.abs(Number(row.capital_expenditures));
 for(const row of balance)row.total_debt=(Number(row.short_term_debt)||0)+(Number(row.long_term_debt)||0)||null;
 return{income:{results:income},balance:{results:balance},cash:{results:cash}};
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
 const statements=buildSecStatements(f);
 return{ok:Object.values(metrics).some(v=>v!=null),symbol:ticker,cik,company:f.entityName,metrics,statements,source:"SEC Company Facts"};
}
function secToResearch(sec){
 return{metrics:{results:[sec?.metrics||{}]},info:{results:[{symbol:sec?.symbol,name:sec?.company,company_name:sec?.company,country:"United States"}]}};
}

const KAP_COMPANIES_URL="https://www.kap.org.tr/tr/bist-sirketler";
const KAP_DISCLOSURE_API="https://www.kap.org.tr/tr/api/disclosure/members/byCriteria";
const KAP_FINANCIAL_SUBJECT="4028328c594bfdca01594c0af9aa0057";
let kapCompanyCache={at:0,map:new Map()};
async function getKapCompanyMap(){
 if(kapCompanyCache.map.size&&Date.now()-kapCompanyCache.at<24*60*60*1000)return kapCompanyCache.map;
 const html=await fetchPublicText(KAP_COMPANIES_URL,30000),decoded=decodeBasicHtml(html).replace(/\\\"/g,'"');
 const map=new Map(),pattern=/"mkkMemberOid":"([^"]+)","kapMemberTitle":"([^"]+)","relatedMemberTitle":"([^"]*)","stockCode":"([^"]+)","cityName":"([^"]*)"/g;
 for(const m of decoded.matchAll(pattern))for(const ticker of m[4].split(",").map(x=>x.trim()).filter(Boolean))map.set(ticker,{company_id:m[1],name:m[2],auditor:m[3],ticker,city:m[5],summary_page:`https://www.kap.org.tr/tr/sirket/${ticker}`});
 if(!map.size)throw new Error("KAP şirket listesi ayrıştırılamadı");kapCompanyCache={at:Date.now(),map};return map;
}
async function kapPost(payload){
 const response=await fetch(KAP_DISCLOSURE_API,{method:"POST",headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json","Content-Type":"application/json","Origin":"https://www.kap.org.tr","Referer":"https://www.kap.org.tr/tr/bildirim-sorgu"},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error(`KAP HTTP ${response.status}`);return response.json();
}
function isoDateDaysAgo(days){const d=new Date(Date.now()-days*86400000);return d.toISOString().slice(0,10)}
async function fetchKapDisclosures(symbol,{days=730,financialOnly=false}={}){
 const plain=String(symbol||"").replace(/\.IS$/i,"").toUpperCase(),company=(await getKapCompanyMap()).get(plain);if(!company)return{company:null,items:[]};
 const base={fromDate:isoDateDaysAgo(days),toDate:new Date().toISOString().slice(0,10),subjectList:financialOnly?[KAP_FINANCIAL_SUBJECT]:[],mkkMemberOidList:[company.company_id],inactiveMkkMemberOidList:[],bdkMemberOidList:[],fromSrc:false,disclosureIndexList:[]};
 const variants=financialOnly?[{...base,disclosureClass:"FR"}]:[base,{...base,disclosureClass:"ODA"},{...base,disclosureClass:"DG"},{...base,disclosureClass:"FR"}];
 const combined=[];let lastError=null;
 for(const payload of variants){try{const result=await kapPost(payload);if(Array.isArray(result))combined.push(...result)}catch(error){lastError=error}}
 const seen=new Set(),items=combined.filter(item=>{const key=String(item.disclosureIndex||item.id||`${item.title}|${item.publishDate}`);if(seen.has(key))return false;seen.add(key);return true}).sort((a,b)=>String(b.publishDate||b.date||"").localeCompare(String(a.publishDate||a.date||"")));
 if(!items.length&&lastError&&financialOnly)throw lastError;
 return{company,items};
}
function classifyKapStatement(role,label){
 const r=String(role||"").toLocaleUpperCase("tr-TR"),l=String(label||"").toLocaleUpperCase("tr-TR");
 if(/CASH|NAKİT AKIŞ|NAKIT AKIS/.test(r+l))return"cash";
 if(/BALANCE|FINANCIALPOSITION|BİLANÇO|BILANCO|VARLIKLAR|YÜKÜMLÜLÜKLER|OZKAYNAK|ÖZKAYNAK/.test(r+l))return"balance";
 if(/INCOME|PROFITLOSS|GELİR|GELIR|HASILAT|KAR VEYA ZARAR|KÂR VEYA ZARAR/.test(r+l))return"income";
 return null;
}
function parseKapFinancialPage(html,period){
 const out={income:{period,source:"KAP"},balance:{period,source:"KAP"},cash:{period,source:"KAP"}};
 for(const row of String(html||"").matchAll(/<tr[^>]*class="([^"]*data-input-row[^"]*)"[^>]*>([\s\S]*?)<\/tr>/gi)){
  const role=row[1],body=row[2];
  const labelMatch=body.match(/class="[^"]*multi-language-content[^\"]*content-tr[^"]*"[^>]*>([\s\S]*?)<\//i)||body.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
  const label=decodeBasicHtml(labelMatch?.[1]||"");if(!label)continue;
  const vals=[...body.matchAll(/class="[^"]*taxonomy-context-value[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>decodeBasicHtml(x[1])).filter(Boolean);
  const value=trNumber(vals[0]);if(value==null)continue;
  const type=classifyKapStatement(role,label);if(!type)continue;
  let key=label.toLocaleLowerCase("tr-TR").replace(/[ç]/g,"c").replace(/[ğ]/g,"g").replace(/[ı]/g,"i").replace(/[ö]/g,"o").replace(/[ş]/g,"s").replace(/[ü]/g,"u").replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
  if(key&&out[type][key]===undefined)out[type][key]=value;
 }
 return out;
}
async function fetchKapFinancialStatements(symbol){
 const result=await fetchKapDisclosures(symbol,{days:1900,financialOnly:true}),reports=result.items.slice(0,5),income=[],balance=[],cash=[];
 for(const item of reports){
  const index=item.disclosureIndex;if(!index)continue;
  try{
   const page=await fetchPublicText(`https://www.kap.org.tr/tr/Bildirim/${index}`,30000),period=`${item.year||""} ${item.ruleType||item.ruleTypeTerm||item.period||""}`.trim();
   const parsed=parseKapFinancialPage(page,period);if(Object.keys(parsed.income).length>2)income.push(parsed.income);if(Object.keys(parsed.balance).length>2)balance.push(parsed.balance);if(Object.keys(parsed.cash).length>2)cash.push(parsed.cash);
  }catch{}
 }
 return{company:result.company,income:{results:income},balance:{results:balance},cash:{results:cash},reportCount:reports.length};
}
function kapDisclosuresToNews(result){
 return(result.items||[]).map(x=>({title:x.title||x.subject||x.disclosureType||"KAP Bildirimi",url:`https://www.kap.org.tr/tr/Bildirim/${x.disclosureIndex}`,source:"KAP",source_key:"kap",published_date:x.publishDate||x.date||"",summary:x.summary||x.ruleType||"",disclosureIndex:x.disclosureIndex}));
}

function yahooDetailsToResearch(details){
 if(!details||typeof details!=="object")return{};
 return{
  info:{results:[{
   symbol:details.symbol,name:details.name,company_name:details.name,
   exchange:details.exchange,sector:details.sector,industry:details.industry,country:details.country,
   website:details.website,long_business_summary:details.longBusinessSummary,full_time_employees:details.fullTimeEmployees,quote_type:details.quoteType,
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
 const requested=String(req.query.symbol||"").trim().toUpperCase();if(!requested)return res.status(400).json({error:"Sembol gereklidir"});
 const isBist=requested.endsWith(".IS")||req.query.market==="BIST",symbol=isBist?yahooSymbolFor(requested):requested,force=req.query.force==="1";
 const cacheKey=`research-v73|${symbol}`,cached=openbbResearchCache.get(cacheKey);if(!force&&cached&&Date.now()-cached.at<10*60*1000)return res.json(cached.data);
 const empty={results:[]};let info=empty,quote=empty,metrics=empty,ratios=empty,income=empty,balance=empty,cash=empty,incomeQuarter=empty,balanceQuarter=empty,cashQuarter=empty,dividends=empty,priceTarget=empty,estimates=empty,news=empty;
 let openbbCount=0;
 if(OPENBB_BASE_URL){
  const providers=isBist?["yfinance","fmp"]:[String(req.query.provider||process.env.OPENBB_PROVIDER||"fmp"),"fmp","yfinance"].filter((v,i,a)=>v&&a.indexOf(v)===i);
  const variants=(extra={})=>providers.map(provider=>({symbol,provider,...extra})),periodVariants=(extra={})=>providers.map(provider=>({symbol,provider,period:"annual",limit:5,...extra}));
  [info,quote,metrics,ratios,income,balance,cash,dividends,priceTarget,estimates,news]=await Promise.all([
   fetchOpenBBAny(["/api/v1/equity/profile","/api/v1/equity/info"],variants()),fetchOpenBBAny(["/api/v1/equity/price/quote","/api/v1/equity/quote"],variants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/metrics"],periodVariants()),fetchOpenBBAny(["/api/v1/equity/fundamental/ratios"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/income"],periodVariants()),fetchOpenBBAny(["/api/v1/equity/fundamental/balance"],periodVariants()),fetchOpenBBAny(["/api/v1/equity/fundamental/cash"],periodVariants()),
   fetchOpenBBAny(["/api/v1/equity/fundamental/dividends"],variants({limit:20})),fetchOpenBBAny(["/api/v1/equity/estimates/price_target_consensus","/api/v1/equity/price_target/consensus"],variants()),
   fetchOpenBBAny(["/api/v1/equity/estimates/analyst","/api/v1/equity/estimates/historical"],variants({limit:12})),fetchOpenBBAny(["/api/v1/news/company","/api/v1/news/world"],variants({limit:30}))
  ]);openbbCount=[info,quote,metrics,ratios,income,balance,cash,news].filter(hasOpenBBData).length;
 }
 let bundle={},yahooShape={},yahooStatements={},yahooAnalysts={},etfProfile={is_etf:false},robustYahooDetails=null,yahooOk=false;
 try{bundle=await fetchYahooResearchBundle(symbol);yahooShape=yahooFallbackShape(bundle,symbol);yahooStatements=yahooStatementShape(bundle);yahooAnalysts=yahooAnalystShape(bundle);etfProfile=yahooEtfShape(bundle,symbol);yahooOk=true}catch(error){console.warn("Yahoo bundle:",error?.message)}
 try{robustYahooDetails=await fetchYahooDetails(symbol);const robust=yahooDetailsToResearch(robustYahooDetails);yahooShape={...yahooShape,info:mergeResearchContainer(yahooShape.info,robust.info),quote:mergeResearchContainer(yahooShape.quote,robust.quote),metrics:mergeResearchContainer(yahooShape.metrics,robust.metrics)};yahooOk=true}catch(error){console.warn("Yahoo details:",error?.message)}
 let yahooPageShape={};try{yahooPageShape=yahooPageToResearch(await fetchYahooStatisticsPage(symbol),symbol)}catch{}
 let tvFundamentals={},tvShape={};try{tvFundamentals=await fetchTradingViewFundamentals(symbol,robustYahooDetails?.exchange||firstContainerRecord(yahooShape.info).exchange||"",force);tvShape=tradingViewToResearch(tvFundamentals)}catch(error){console.warn("TradingView:",error?.message)}
 let secFundamentals={},secShape={},secStatements={income:empty,balance:empty,cash:empty};
 if(!isBist&&!etfProfile.is_fund){try{const marketCap=firstContainerRecord(tvShape.metrics).market_cap??firstContainerRecord(yahooShape.metrics).market_cap??robustYahooDetails?.marketCap;secFundamentals=await fetchSecFundamentals(symbol,marketCap);secShape=secToResearch(secFundamentals);secStatements=secFundamentals.statements||secStatements}catch(error){secFundamentals={ok:false,error:error.message}}}
 let kapResult={company:null,items:[]},kapStatements={income:empty,balance:empty,cash:empty,reportCount:0};
 if(isBist){try{kapResult=await fetchKapDisclosures(symbol,{days:730});kapStatements=await fetchKapFinancialStatements(symbol)}catch(error){console.warn("KAP:",error?.message)}}
 const kapInfo=kapResult.company?{results:[{symbol:requested.replace(/\.IS$/,""),name:kapResult.company.name,company_name:kapResult.company.name,country:"Türkiye",city:kapResult.company.city,auditor:kapResult.company.auditor,website:kapResult.company.summary_page,long_business_summary:`${kapResult.company.name}, Borsa İstanbul'da ${requested.replace(/\.IS$/i,"")} koduyla işlem gören ve kamuyu aydınlatma yükümlülüklerini KAP üzerinden yerine getiren bir şirkettir.`}]}:empty;
 const mergedInfo=mergeResearchContainer(info,yahooShape.info,kapInfo,secShape.info,tvShape.info),mergedQuote=mergeResearchContainer(quote,tvShape.quote,yahooShape.quote),mergedMetrics=mergeResearchContainer(metrics,tvShape.metrics,secShape.metrics,yahooShape.metrics,yahooPageShape.metrics);
 const chooseRows=(...containers)=>containers.find(x=>recordList(x).length)||empty;
 income=chooseRows(kapStatements.income,secStatements.income,yahooStatements.income,income);balance=chooseRows(kapStatements.balance,secStatements.balance,yahooStatements.balance,balance);cash=chooseRows(kapStatements.cash,secStatements.cash,yahooStatements.cash,cash);
 incomeQuarter=yahooStatements.income_quarterly||empty;balanceQuarter=yahooStatements.balance_quarterly||empty;cashQuarter=yahooStatements.cash_quarterly||empty;
 priceTarget=mergeResearchContainer(priceTarget,yahooAnalysts.price_target);const recommendationTrend=yahooAnalysts.recommendation_trend||empty,earningsEstimates=recordList(yahooAnalysts.earnings_estimates).length?yahooAnalysts.earnings_estimates:estimates;
 const companyName=firstContainerRecord(mergedInfo).name||firstContainerRecord(mergedInfo).company_name||symbol,plain=symbol.replace(/\.IS$/i,"");
 let yahooNews=[],googleNews=[];try{yahooNews=await fetchYahooNews(companyName,plain)}catch{}try{googleNews=await fetchGoogleNews(`${companyName} ${plain}`,isBist)}catch{}
 const openbbNews=recordList(news).map(x=>({...x,source_key:"openbb",source:x.source||x.publisher||"OpenBB"})),kapNews=kapDisclosuresToNews(kapResult);
 const combinedNews=dedupeNews([...kapNews,...yahooNews,...googleNews,...openbbNews]).slice(0,80);
 const statementSources=[
  {label:"KAP Finansal Rapor",ok:recordList(kapStatements.income).length+recordList(kapStatements.balance).length+recordList(kapStatements.cash).length>0,note:isBist?`${kapStatements.reportCount||0} bildirim`:"BIST dışı"},
  {label:"SEC EDGAR XBRL",ok:Boolean(secFundamentals?.statements&&recordList(secStatements.income).length),note:!isBist&&!etfProfile.is_fund?"Resmî":"Uygulanamaz"},
  {label:"Yahoo Finance Tabloları",ok:recordList(yahooStatements.income).length+recordList(yahooStatements.balance).length+recordList(yahooStatements.cash).length>0,note:"Yıllık / çeyreklik"},
  {label:"OpenBB",ok:openbbCount>0,note:OPENBB_BASE_URL?"Yedek":"Bağlı değil"}
 ];
 const data={configured:true,openbb_configured:Boolean(OPENBB_BASE_URL),symbol,
  source_note:"KAP/SEC resmî bildirimleri, Yahoo Finance, TradingView, Google News ve mevcut OpenBB verileri tek ekranda birleştirildi.",
  info:mergedInfo,quote:mergedQuote,metrics:mergedMetrics,ratios,income,balance,cash,income_quarterly:incomeQuarter,balance_quarterly:balanceQuarter,cash_quarterly:cashQuarter,dividends,
  price_target:priceTarget,recommendation_trend:recommendationTrend,earnings_estimates:earningsEstimates,analyst_summary:yahooAnalysts.analyst_summary||{},news:{results:combinedNews},etf_profile:etfProfile,
  tradingview_fundamentals:tvFundamentals,sec_fundamentals:secFundamentals,statement_sources:statementSources,
  statement_note:isBist?"BIST şirketlerinde KAP resmî finansal raporu önceliklidir; KAP ayrıştırılamazsa Yahoo/OpenBB yedeği kullanılır.":"ABD şirketlerinde SEC EDGAR XBRL önceliklidir; diğer piyasalarda Yahoo/OpenBB yedeği kullanılır.",
  analyst_sources:[{label:"Yahoo Finance Konsensüsü",ok:Boolean(firstContainerRecord(yahooAnalysts.price_target).analyst_count||firstContainerRecord(yahooAnalysts.price_target).target_consensus||recordList(yahooAnalysts.recommendation_trend).length)},{label:"OpenBB Tahminleri",ok:recordList(estimates).length>0}],
  diagnostics:{tradingview_ok:Boolean(tvFundamentals?.ok),sec_ok:Boolean(secFundamentals?.ok),yahoo_ok:yahooOk,kap_ok:Boolean(kapResult.company),openbb_sections_with_data:openbbCount},fetchedAt:new Date().toISOString()};
 openbbResearchCache.set(cacheKey,{at:Date.now(),data});res.set("Cache-Control","public, max-age=300, s-maxage=300");res.json(data);
});

app.get("/api/fundamentals",async(req,res)=>{
 const requested=String(req.query.symbol||"").trim().toUpperCase();
 if(!requested)return res.status(400).json({error:"Sembol gereklidir"});
 const symbol=yahooSymbolFor(requested);
 let tradingview={},yahoo={},yahooPage={},sec={},bundle={},etf={},statements={};
 try{yahoo=await fetchYahooDetails(symbol)}catch(error){yahoo={error:error.message}}
 try{bundle=await fetchYahooResearchBundle(symbol);etf=yahooEtfShape(bundle,symbol);statements=yahooStatementShape(bundle)}catch(error){bundle={error:error.message}}
 try{tradingview=await fetchTradingViewFundamentals(symbol,yahoo.exchange||"",req.query.refresh==="1")}catch(error){tradingview={ok:false,error:error.message}}
 try{yahooPage=await fetchYahooStatisticsPage(symbol)}catch(error){yahooPage={error:error.message}}
 try{sec=await fetchSecFundamentals(symbol,tradingview.market_cap_basic??yahoo.marketCap)}catch(error){sec={ok:false,error:error.message}}
 res.json({symbol,tradingview,sec,yahoo,yahooPage,etf,statements,fetchedAt:new Date().toISOString()});
});



const TCMB_REFERENCE_URL="https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB+TR/Main+Menu/Istatistikler/Bankacilik+Verileri/Uye+Isyerlerine+Uygulanacak+Azami+Komisyon+Oranlari";
const ALNUS_VIOP_URL="https://www.alnusyatirim.com/viop";
const BIST_VIOP_MARKET_MAKING_URL="https://www.borsaistanbul.com/piyasalar/viop/piyasa-isleyisi/piyasa-yapicilik";
const ISYATIRIM_VIOP_MARKET_URL="https://www.isyatirim.com.tr/en-us/analysis/Pages/derivatives-market.aspx";
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


const BIST_TLREF_URL="https://borsaistanbul.com/endeksler";
const BIST_TLREF_DETAIL_URL="https://borsaistanbul.com/endeksler/tlref";
const TAKASBANK_REPO_DIRECTORY="https://wwwdata.takasbank.com.tr/RepoAllocationPrice/PROD/";
let nemaRateCache={at:0,data:null};

function medianRate(values){
 const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);
 if(!rows.length)return null;
 const middle=Math.floor(rows.length/2);
 return rows.length%2?rows[middle]:(rows[middle-1]+rows[middle])/2;
}
function normalizeOfficialDate(value){
 const raw=String(value||"").trim();
 let match=raw.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
 if(match)return`${match[3]}-${String(match[2]).padStart(2,"0")}-${String(match[1]).padStart(2,"0")}`;
 match=raw.match(/(\d{4})(\d{2})(\d{2})/);
 return match?`${match[1]}-${match[2]}-${match[3]}`:null;
}
function parseTlrefCsv(text){
 const lines=String(text||"").split(/\r?\n/).filter(Boolean);
 for(const line of lines.reverse()){
  const cells=line.split(/[;,]/).map(cell=>cell.trim().replace(/^"|"$/g,""));
  const valueDate=normalizeOfficialDate(cells[0])||normalizeOfficialDate(cells.find(cell=>/\d{8}|\d{1,2}[./-]\d{1,2}[./-]\d{4}/.test(cell)));
  const candidates=cells.map(cell=>Number(String(cell).replace(",", "."))).filter(value=>Number.isFinite(value)&&value>5&&value<100);
  if(valueDate&&candidates.length)return{annual:candidates.at(-1),valueDate};
 }
 return null;
}
async function fetchBistTlref(){
 for(const url of [BIST_TLREF_URL,BIST_TLREF_DETAIL_URL]){
  try{
   const raw=await fetchPublicText(url,15000);
   const csvMatch=raw.match(/href=["']([^"']*tlref[^"']*\.csv[^"']*)["']/i);
   if(csvMatch){
    const csvUrl=new URL(csvMatch[1].replace(/&amp;/g,"&"),url).href;
    const parsed=parseTlrefCsv(await fetchPublicText(csvUrl,30000));
    if(parsed)return{...parsed,source:"Borsa İstanbul TLREF",sourceUrl:csvUrl,proxy:false};
   }
   const text=decodeBasicHtml(raw);
   const patterns=[
    /TURK LIRASI GECELIK REFERANS FAIZ ORANI\s*\|\s*TLREF\s*\|\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*\|\s*(\d+[,.]\d+)/i,
    /TLREF\s*\|\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s*\|\s*(\d+[,.]\d+)/i,
    /(\d{1,2}[./-]\d{1,2}[./-]\d{4})[^|]{0,100}TLREF[^0-9]{0,80}(\d+[,.]\d+)/i
   ];
   for(const pattern of patterns){
    const match=text.match(pattern);
    if(!match)continue;
    const annual=Number(String(match[2]).replace(",","."));
    const valueDate=normalizeOfficialDate(match[1]);
    if(Number.isFinite(annual)&&annual>5&&annual<100&&valueDate)return{annual,valueDate,source:"Borsa İstanbul TLREF",sourceUrl:url,proxy:false};
   }
  }catch(error){console.warn("BIST TLREF alınamadı:",error.message)}
 }
 return null;
}
async function fetchTakasbankRepoProxy(){
 const directory=await fetchPublicText(TAKASBANK_REPO_DIRECTORY,30000);
 const files=[...directory.matchAll(/RepoAllocationPrices_(\d{8})\.csv/gi)].map(match=>match[1]).sort();
 if(!files.length)throw new Error("Takasbank günlük repo dosyası bulunamadı");
 const fileDate=files.at(-1),url=`${TAKASBANK_REPO_DIRECTORY}RepoAllocationPrices_${fileDate}.csv`;
 const csv=await fetchPublicText(url,15000);
 const rates=String(csv).split(/\r?\n/).slice(1).map(line=>line.split(",")).filter(cells=>/\.NP$/i.test(cells[0]||"")).map(cells=>Number(cells[1])).filter(value=>Number.isFinite(value)&&value>5&&value<100);
 const annual=medianRate(rates);
 if(!annual)throw new Error("Takasbank repo tahsis oranı ayrıştırılamadı");
 return{annual,valueDate:normalizeOfficialDate(fileDate),source:"Takasbank Repo Tahsis Oranı (proxy)",sourceUrl:url,proxy:true};
}
async function fetchTcmbNemaFallback(){
 let annual=45.15,valueDate=new Date().toISOString().slice(0,10);
 try{
  const text=decodeBasicHtml(await fetchPublicText(TCMB_REFERENCE_URL));
  const rows=[...text.matchAll(/(\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4})\s+(\d+[,.]\d+)\s+(\d+[,.]\d+)/g)];
  if(rows.length){
   annual=trNumber(rows[0][3])??annual;
   valueDate=normalizeOfficialDate(rows[0][1].split("-")[0])||valueDate;
  }
 }catch(error){console.warn("TCMB nema yedeği alınamadı:",error.message)}
 return{annual,valueDate,source:"TCMB yıllık bileşik referans (yedek)",sourceUrl:TCMB_REFERENCE_URL,proxy:true};
}
app.get("/api/nema-rate",async(req,res)=>{
 try{
  if(req.query.refresh!=="1"&&nemaRateCache.data&&Date.now()-nemaRateCache.at<30*60*1000)return res.json(nemaRateCache.data);
  const [bistResult,takasResult]=await Promise.allSettled([fetchBistTlref(),fetchTakasbankRepoProxy()]);
  const bist=bistResult.status==="fulfilled"?bistResult.value:null;
  const takas=takasResult.status==="fulfilled"?takasResult.value:null;
  if(takasResult.status==="rejected")console.warn("Takasbank nema proxy alınamadı:",takasResult.reason?.message||takasResult.reason);
  const data=bist||takas||(await fetchTcmbNemaFallback());
  const payload={...data,live:!data.proxy,fetchedAt:new Date().toISOString(),note:"Gerçek hesaba yatan net nema; vergi, yasal kesinti, Takasbank komisyonu ve aracı kurum uygulamasına göre farklı olabilir."};
  nemaRateCache={at:Date.now(),data:payload};
  res.set("Cache-Control","public, max-age=300, s-maxage=300");
  res.json(payload);
 }catch(error){res.status(502).json({error:error.message})}
});

const VIOP_FALLBACK_CONTRACTS=[
 {id:"F_XU030",code:"F_XU030",underlying:"XU030",name:"BIST 30 Endeks Vadeli",contractSize:10,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_PAY",code:"F_PAY",underlying:"PAY",name:"Pay Vadeli — Sembol Bazlı",contractSize:100,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_USDTRY",code:"F_USDTRY",underlying:"USDTRY",name:"Dolar/TL Vadeli",contractSize:1000,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_EURTRY",code:"F_EURTRY",underlying:"EURTRY",name:"Euro/TL Vadeli",contractSize:1000,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"},
 {id:"F_XAUTRY",code:"F_XAUTRY",underlying:"XAUTRY",name:"Gram Altın/TL Vadeli",contractSize:1,currency:"TRY",marginMode:"fixed",initialMargin:null,maintenanceMargin:null,expiryDate:null,maturityLabel:"Yakın Vade"}
];
const VIOP_OFFICIAL_PAY_UNDERLYINGS_FALLBACK=new Set([
 "AKBNK","ASELS","ASTOR","BIMAS","EKGYO","EREGL","GARAN","ISCTR","KCHOL","SAHOL","SASA","THYAO","TRALT","TUPRS","YKBNK",
 "AEFES","GUBRF","HALKB","KONTR","KRDMD","MGROS","PETKM","PGSUS","SISE","TAVHL","TCELL","TOASO","TRMET","TTKOM","VAKBN",
 "AKSEN","ALARK","ARCLK","BRSAN","CIMSA","DOAS","DOHOL","ENJSA","ENKAI","FROTO","HEKTS","ODAS","OYAKC","SOKM","TKFEN","TSKB","ULKER","VESTL"
]);
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
 SISE:14.0,TCELL:14.0,THYAO:15.0,TOASO:14.0,TUPRS:15.0,VAKBN:15.5,VESTL:17.0,ODAS:17.63,
 YKBNK:15.5,XU030:10.0,USDTRY:10.0,EURTRY:10.4,XAUTRY:12.0
};

const VIOP_CONTRACT_MARGIN_SNAPSHOT_FALLBACK={
 "F_ODAS0826":{initialMargin:114.76,spreadMargin:50.00,asOf:"2026-07-28",source:"Alnus VİOP 28.07.2026 snapshot"}
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
  const u=normalizeUnderlyingName(underlying);
  const quote=await fetchBistSpotReference(u);
  if(quote&&Number.isFinite(quote.price))result.set(u,quote);
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


const TR_MONTH_TO_NUMBER={
 "ocak":"01","subat":"02","şubat":"02","mart":"03","nisan":"04","mayis":"05","mayıs":"05","haziran":"06",
 "temmuz":"07","agustos":"08","ağustos":"08","eylul":"09","eylül":"09","ekim":"10","kasim":"11","kasım":"11","aralik":"12","aralık":"12"
};
function viopContractMonthKey(underlying,year,month){
 return`${normalizeUnderlyingName(underlying)}|${year}-${String(month).padStart(2,"0")}`;
}
function contractMonthKeyFromContract(contract){
 const expiry=String(contract?.expiryDate||"");
 if(/^\d{4}-\d{2}/.test(expiry))return`${normalizeUnderlyingName(contract.underlying)}|${expiry.slice(0,7)}`;
 const code=String(contract?.code||"").toUpperCase();
 const match=code.match(/(\d{2})(\d{2})$/);
 return match?`${normalizeUnderlyingName(contract.underlying)}|20${match[2]}-${match[1]}`:"";
}
function parseIsYatirimViopQuotes(html){
 const quotes=new Map();
 for(const rowMatch of String(html||"").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)){
  const cells=[...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
   .map(match=>decodeBasicHtml(match[1]).replace(/\s+/g," ").trim());
  if(cells.length<2)continue;
  const label=cells[0];
  const normalized=label.toLocaleLowerCase("tr-TR")
   .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
   .replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c");
  const m=normalized.match(/\b([a-z0-9]{3,12})\s+(ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\s+(\d{4})\s+vadeli\b/i);
  if(!m)continue;
  const underlying=normalizeUnderlyingName(m[1]),month=TR_MONTH_TO_NUMBER[m[2]],year=m[3];
  if(!underlying||!month)continue;
  const price=trNumber(cells[1]),changePercent=trNumber(cells[2]),volumeValue=trNumber(cells[4]),volumeLots=trNumber(cells[5]);
  if(price==null||price<=0)continue;
  quotes.set(viopContractMonthKey(underlying,year,month),{
   underlying,year:Number(year),month:Number(month),price,changePercent,
   volumeValue,volumeLots,label,source:"İş Yatırım VİOP piyasa tablosu"
  });
 }
 return quotes;
}
async function fetchIsYatirimViopQuotes(){
 const html=await fetchPublicText(ISYATIRIM_VIOP_MARKET_URL,30000);
 return parseIsYatirimViopQuotes(html);
}
async function fetchBistSpotReference(underlying){
 const u=normalizeUnderlyingName(underlying);
 if(!u)return null;
 if(u==="USDTRY"||u==="EURTRY"||u==="XAUTRY"||u==="XU030"){
  const map=u==="USDTRY"?"USDTRY=X":u==="EURTRY"?"EURTRY=X":u==="XAUTRY"?"GC=F":"^XU030";
  try{
   const quote=await fetchYahooChart(map);
   if(Number.isFinite(quote.price)&&quote.price>0)return{price:quote.price,yahooSymbol:map,source:"Yahoo Finance"};
  }catch{}
  return null;
 }
 // For BIST shares, prefer TradingView scanner because Yahoo's intraday
 // metadata can occasionally return a mis-scaled value for local shares.
 try{
  const tv=await scanTradingViewColumns(`BIST:${u}`,["close","currency"],"turkey");
  const price=Number(tv.close);
  if(Number.isFinite(price)&&price>0)return{price,yahooSymbol:`${u}.IS`,source:"TradingView scanner"};
 }catch{}
 try{
  const quote=await fetchYahooChart(`${u}.IS`);
  if(Number.isFinite(quote.price)&&quote.price>0)return{price:quote.price,yahooSymbol:`${u}.IS`,source:"Yahoo Finance"};
 }catch{}
 return null;
}

function parseBistViopPayUnderlyings(html){
 const result=new Set();
 const text=decodeBasicHtml(html)
  .replace(/\s+/g," ")
  .replace(/İ/g,"I").replace(/Ş/g,"S").replace(/Ğ/g,"G").replace(/Ü/g,"U").replace(/Ö/g,"O").replace(/Ç/g,"C");
 // Borsa İstanbul page contains "Grup 1 / Grup 2 / Grup 3" pay-futures underlyings.
 // Restrict parsing to that section to avoid collecting unrelated uppercase navigation tokens.
 const start=text.search(/Grup\s*1/i);
 const end=text.search(/\bPAZAR\b/i);
 const section=start>=0?text.slice(start,end>start?end:Math.min(text.length,start+5000)):"";
 for(const match of section.matchAll(/\b[A-Z]{4,6}\b/g)){
  const symbol=match[0];
  if(["GRUP","BIST","VIOP","PAZAR"].includes(symbol))continue;
  result.add(symbol);
 }
 return result;
}
async function getOfficialViopPayUnderlyings(){
 const merged=new Set(VIOP_OFFICIAL_PAY_UNDERLYINGS_FALLBACK);
 let live=false,error=null;
 try{
  const html=await fetchPublicText(BIST_VIOP_MARKET_MAKING_URL,30000);
  const parsed=parseBistViopPayUnderlyings(html);
  if(parsed.size>=20){
   parsed.forEach(symbol=>merged.add(symbol));
   live=true;
  }
 }catch(err){error=err.message}
 return{underlyings:merged,live,error};
}
function generatedContractsForUnderlyings(underlyings,fixedMargins=new Map()){
 const marginMap=new Map([...underlyings].map(symbol=>[symbol,Number(fixedMargins.get(symbol))||0]));
 return generatedContractsFromMargins(marginMap).map(contract=>({
  ...contract,
  source:"Borsa İstanbul pay vadeli dayanak evreni",
  marginSource:contract.initialMargin>0?"Oyak Yatırım":"PSR/teminat seçildiğinde güncellenecek"
 }));
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

async function fetchFreshAlnusViopContract(contractCode){
 const code=String(contractCode||"").trim().toUpperCase();
 if(!code)return null;
 try{
  const html=await fetchPublicText(ALNUS_VIOP_URL,30000);
  const rows=parseAlnusViopRows(html);
  const contract=rows.find(row=>String(row.code||"").toUpperCase()===code);
  if(contract)return{...contract,live:true};
 }catch{}
 const fallback=VIOP_CONTRACT_MARGIN_SNAPSHOT_FALLBACK[code];
 if(fallback){
  const underlying=contractUnderlying(code);
  return{
   id:code,code,underlying,contractSize:contractSizeForUnderlying(underlying),
   initialMargin:fallback.initialMargin,maintenanceMargin:fallback.initialMargin*.75,
   spreadMargin:fallback.spreadMargin,currency:"TRY",marginMode:"fixed",
   marginSource:fallback.source,source:fallback.source,live:false
  };
 }
 return null;
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
 let contracts=[],live=false,error=null,marginError=null,marketError=null,fixedMargins=new Map(),psrRates=new Map(),marketQuotes=new Map();
 const official=await getOfficialViopPayUnderlyings();
 try{marketQuotes=await fetchIsYatirimViopQuotes()}catch(err){marketError=err.message}
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
 // Merge every current official Borsa İstanbul pay-futures underlying even when
 // brokerage/margin pages omit a symbol. This prevents valid names such as ODAS
 // from disappearing from the terminal search.
 const universe=new Set([
  ...official.underlyings,
  ...fixedMargins.keys(),
  ...psrRates.keys(),
  ...Object.keys(VIOP_PSR_FALLBACK)
 ]);
 if(!contracts.length)contracts=generatedContractsForUnderlyings(universe,fixedMargins);
 else{
  const existing=new Set(contracts.map(c=>normalizeUnderlyingName(c.underlying)));
  const missing=[...universe].filter(symbol=>!existing.has(normalizeUnderlyingName(symbol)));
  if(missing.length)contracts.push(...generatedContractsForUnderlyings(new Set(missing),fixedMargins));
 }
 if(!contracts.length)contracts=VIOP_FALLBACK_CONTRACTS.map(x=>({...x,isActive:true,sortDate:x.expiryDate||"9999-12-31"}));

 // Reference prices are only needed for underlyings whose margin is PSR-based.
 // Fixed-margin and unknown-margin names hydrate their quote lazily when selected,
 // avoiding dozens of unnecessary Yahoo requests on every universe refresh.
 const priceNeeded=[...new Set(contracts.map(c=>normalizeUnderlyingName(c.underlying)))].filter(
  symbol=>!fixedMargins.has(symbol)&&(psrRates.has(symbol)||VIOP_PSR_FALLBACK[symbol]!=null)
 );
 const prices=await viopReferencePrices(priceNeeded);
 contracts=enrichViopMargins(contracts,psrRates,prices,fixedMargins).map(contract=>{
  const market=marketQuotes.get(contractMonthKeyFromContract(contract));
  if(!market)return contract;
  const size=Number(contract.contractSize)||contractSizeForUnderlying(contract.underlying);
  const psr=Number(contract.marginRate)||0;
  let initial=Number(contract.initialMargin)||0,marginSource=contract.marginSource;
  if(initial<=0&&psr>0){
   initial=market.price*size*psr/100;
   marginSource=`${psrRates.has(normalizeUnderlyingName(contract.underlying))?"Deniz PSR":"PSR"} + İş Yatırım VİOP fiyatı`;
  }
  return{
   ...contract,marketPrice:market.price,changePercent:market.changePercent,
   marketVolume:market.volumeLots,priceSource:market.source,
   referencePrice:market.price,initialMargin:initial||contract.initialMargin,
   maintenanceMargin:initial>0?initial*.75:contract.maintenanceMargin,
   marginSource:marginSource||contract.marginSource
  };
 });
 contracts.sort((a,b)=>String(a.underlying).localeCompare(String(b.underlying),"tr")||String(a.sortDate).localeCompare(String(b.sortDate)));
 viopContractCache={
  at:Date.now(),contracts,live:live||official.live||psrRates.size>0||fixedMargins.size>0,
  error:[error,marginError,marketError,official.error].filter(Boolean).join(" | "),
  psrCount:psrRates.size,fixedCount:fixedMargins.size,pricedCount:prices.size,marketPriceCount:marketQuotes.size,
  officialCount:official.underlyings.size,officialLive:official.live
 };
 return viopContractCache;
}
app.get("/api/viop/contracts",async(req,res)=>{
 const cache=await getViopContracts(req.query.refresh==="1");
 res.set("Cache-Control","public, max-age=300, s-maxage=300");
 res.json({
  contracts:cache.contracts,underlyings:viopUnderlyingRows(cache.contracts),
  live:cache.live,error:cache.error,
  sourceLabel:`Borsa İstanbul dayanak evreni (${cache.officialCount||0}) + İş Yatırım VİOP fiyatı (${cache.marketPriceCount||0}) + Alnus vade + Deniz PSR + Oyak yedek`,
  sourceUrl:BIST_VIOP_MARKET_MAKING_URL,contractSourceUrl:ALNUS_VIOP_URL,
  marginSourceUrl:OYAK_VIOP_MARGIN_URL,psrSourceUrl:DENIZ_VIOP_PSR_URL,asOf:new Date(cache.at).toISOString(),
  warning:"Pay VİOP başlangıç teminatı sabit tutar bulunamazsa güncel referans fiyat × kontrat büyüklüğü × PSR oranı ile hesaplanır. Sürdürme teminatı %75 olarak gösterilir; işlem öncesi kurum ekranı teyit edilmelidir."
 });
});
app.get("/api/viop/quote",async(req,res)=>{
 try{
  const underlying=normalizeUnderlyingName(req.query.underlying||"");
  const contractCode=String(req.query.contract||"").trim().toUpperCase();
  if(!underlying&&!contractCode)return res.status(400).json({error:"underlying veya contract gerekli"});

  const cache=await getViopContracts(req.query.refresh==="1");
  let contract=contractCode?cache.contracts.find(c=>String(c.code).toUpperCase()===contractCode):null;
  if(!contract&&underlying){
   contract=cache.contracts.filter(c=>normalizeUnderlyingName(c.underlying)===underlying)
    .sort((a,b)=>String(a.sortDate||"9999").localeCompare(String(b.sortDate||"9999")))
    .find(c=>c.isActive!==false);
  }

  // Highest priority for selected VİOP contract margin:
  // live Alnus exact contract row. If temporarily inaccessible, use a dated snapshot
  // fallback for known contracts rather than leaving margin fields blank.
  const fresh=await fetchFreshAlnusViopContract(contractCode||contract?.code);
  if(fresh){
   contract={...(contract||{}),...fresh,
    marginSource:fresh.marginSource||fresh.source||contract?.marginSource,
    initialMargin:Number(fresh.initialMargin)||Number(contract?.initialMargin)||0,
    maintenanceMargin:Number(fresh.maintenanceMargin)||Number(fresh.initialMargin)*.75||Number(contract?.maintenanceMargin)||0
   };
  }

  // Exact/current contract market price, if available.
  if(contract?.marketPrice){
   return res.json({
    underlying:contract.underlying,contract:contract.code,price:contract.marketPrice,
    referencePrice:contract.referencePrice||contract.marketPrice,
    initialMargin:Number(contract.initialMargin)||null,
    maintenanceMargin:Number(contract.maintenanceMargin)||null,
    spreadMargin:Number(contract.spreadMargin)||null,
    marginRate:Number(contract.marginRate)||null,
    marginSource:contract.marginSource||contract.source||null,
    source:contract.priceSource||"İş Yatırım VİOP piyasa tablosu",
    exactContract:true,exactMargin:!!fresh
   });
  }

  // Even without a futures market-price feed, exact Alnus initial margin is enough
  // to populate required collateral automatically.
  const ref=await fetchBistSpotReference(underlying||contract?.underlying);
  const size=Number(contract?.contractSize)||contractSizeForUnderlying(underlying||contract?.underlying);
  const psr=Number(contract?.marginRate)||VIOP_PSR_FALLBACK[underlying||contract?.underlying]||0;
  const initial=Number(contract?.initialMargin)||
    (ref&&psr>0?Number(ref.price)*size*psr/100:null);

  if(!initial&&!ref)return res.status(404).json({error:"VİOP teminat ve referans fiyatı bulunamadı"});

  res.json({
   underlying:underlying||contract?.underlying,contract:contract?.code||null,
   price:null,referencePrice:ref?.price??contract?.referencePrice??null,
   initialMargin:initial||null,
   maintenanceMargin:initial?initial*.75:(Number(contract?.maintenanceMargin)||null),
   spreadMargin:Number(contract?.spreadMargin)||null,
   marginRate:psr||null,
   marginSource:contract?.marginSource||contract?.source||(psr?"PSR fallback":"Manuel"),
   source:fresh
    ?(fresh.live?"Alnus VİOP güncel kontrat teminatı":fresh.source)
    :(ref?`${ref.source} spot referansı`:"VİOP teminat kaynağı"),
   exactContract:false,exactMargin:!!fresh
  });
 }catch(error){
  res.status(502).json({error:error.message||"VİOP fiyat/teminat verisi alınamadı"})
 }
});

app.get("/api/viop/search",async(req,res)=>{
 const q=String(req.query.q||"").trim().toUpperCase();
 if(!q)return res.json({items:[]});
 const cache=await getViopContracts(false);
 const items=viopUnderlyingRows(cache.contracts)
  .filter(x=>x.symbol.startsWith(q)||String(x.name||"").toLocaleUpperCase("tr-TR").includes(q))
  .slice(0,50);
 res.set("Cache-Control","public, max-age=60, s-maxage=60");
 res.json({query:q,count:items.length,items,live:cache.live,source:"Borsa İstanbul VİOP dayanak evreni + aracı kurum teminat kaynakları"});
});


const TRADEMASTER_FUTURES_SPECS_URL="https://trademaster.com.tr/yurtdisi/vadeli-islem-kontrat-ozellik-listesi";
const AMP_FUTURES_MARGIN_URL="https://www.ampfutures.com/trading-info/margins";
const GLOBAL_FUTURES_CATALOG=[
 {id:"GC",code:"GC",name:"Gold Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"GC=F",tradingViewSymbol:"COMEX:GC1!",multiplier:100,marginRate:9,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"MGC",code:"MGC",name:"Micro Gold Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"MGC=F",tradingViewSymbol:"COMEX:MGC1!",multiplier:10,marginRate:9,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"QO",code:"QO",name:"E-mini Gold Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"QO=F",priceProxySymbol:"GC=F",tradingViewSymbol:"COMEX:QO1!",multiplier:50,marginRate:9,quoteCurrency:"USD",marginCurrency:"USD"},
 {id:"1OZ",code:"1OZ",name:"1-Ounce Gold Futures",group:"Metals",exchange:"COMEX",yahooSymbol:"GC=F",priceProxySymbol:"GC=F",tradingViewSymbol:"COMEX:1OZ1!",multiplier:1,marginRate:9,quoteCurrency:"USD",marginCurrency:"USD"},
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

const GLOBAL_FUTURES_BROKER_MARGIN_SNAPSHOT={
 GC:{
  initial:27104,
  maintenance:24640,
  currency:"USD",
  asOf:"2026-08-10",
  source:"IBKR broker snapshot · GC Oct 2026 · 10.08.2026"
 }
};
function globalFutureBrokerMarginSnapshot(code){
 return GLOBAL_FUTURES_BROKER_MARGIN_SNAPSHOT[String(code||"").toUpperCase()]||null;
}
function globalFutureMarginPlausible(value,notional){
 const margin=Number(value),n=Number(notional);
 if(!Number.isFinite(margin)||margin<=0)return false;
 if(!Number.isFinite(n)||n<=0)return true;
 const ratio=margin/n;
 return ratio>=0.005&&ratio<=0.70;
}


function normalizedHeader(value=""){
 return decodeBasicHtml(value).toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c");
}
function parseTradeMasterFuturesRows(html){
 const map=new Map();
 for(const table of String(html||"").matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)){
  const rows=[...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(row=>[...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x=>decodeBasicHtml(x[1])));
  if(rows.length<2)continue;
  const headers=rows[0].map(normalizedHeader);
  const codeIx=headers.findIndex(x=>/kod|sembol|kontrat/.test(x));
  const initIx=headers.findIndex(x=>/baslangic.*teminat|initial.*margin/.test(x));
  const maintIx=headers.findIndex(x=>/surdurme.*teminat|maintenance.*margin/.test(x));
  const multIx=headers.findIndex(x=>/lot.*buyuk|kontrat.*buyuk|carpan|multiplier/.test(x));
  const curIx=headers.findIndex(x=>/para.*birimi|currency|teminat.*para/.test(x));
  for(const cells of rows.slice(1)){
   const text=cells.join(" ").toUpperCase();
   const item=GLOBAL_FUTURES_CATALOG.find(x=>{
    const code=String(cells[codeIx]||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    return code===x.code||new RegExp(`(^|[^A-Z0-9])${x.code}([^A-Z0-9]|$)`).test(text)||text.includes(x.name.toUpperCase());
   });
   if(!item)continue;
   const initial=initIx>=0?trNumber(cells[initIx]):null,maintenance=maintIx>=0?trNumber(cells[maintIx]):null,multiplier=multIx>=0?trNumber(cells[multIx]):null;
   const currency=curIx>=0?String(cells[curIx]||"").toUpperCase().match(/\b(USD|EUR|GBP|CHF|JPY|CAD|AUD|HKD|CNY)\b/)?.[1]:null;
   map.set(item.id,{initial,maintenance,multiplier,currency,source:"TradeMaster International kontrat özellik listesi",estimated:false});
  }
 }
 return map;
}

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
function globalFutureAliases(item){
 const code=String(item.code||"").toUpperCase();
 const group=String(item.group||"");
 const aliases=[];
 if(["GC","MGC","QO","1OZ"].includes(code))aliases.push("gold","gold futures","altın","altin","comex gold","precious metal");
 if(code==="GC")aliases.push("standard gold","100 oz gold","100 ounce gold");
 if(code==="MGC")aliases.push("micro gold","10 oz gold","10 ounce gold");
 if(code==="QO")aliases.push("e-mini gold","mini gold","50 oz gold","50 ounce gold");
 if(code==="1OZ")aliases.push("one ounce gold","1 ounce gold","1 oz gold");
 if(code==="HG")aliases.push("copper","bakır","bakir","copper futures");
 if(["SI","SIL"].includes(code))aliases.push("silver","gümüş","gumus");
 if(["CL","MCL"].includes(code))aliases.push("crude oil","oil","petrol","wti");
 if(code==="NG")aliases.push("natural gas","doğal gaz","dogal gaz");
 if(group==="Rates")aliases.push("bond","treasury","tahvil","faiz");
 if(group==="Equity Index")aliases.push("index","endeks");
 return aliases;
}
function foldGlobalFutureSearch(value){
 return String(value||"").toLocaleLowerCase("tr-TR")
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c");
}
function globalFutureSearchScore(item,query){
 const q=foldGlobalFutureSearch(query),code=foldGlobalFutureSearch(item.code),name=foldGlobalFutureSearch(item.name);
 const group=foldGlobalFutureSearch(item.group),aliases=globalFutureAliases(item).map(foldGlobalFutureSearch);
 if(code===q)return 0;
 if(code.startsWith(q))return 1;
 if(name.startsWith(q))return 2;
 if(name.includes(q))return 3;
 if(aliases.some(alias=>alias===q||alias.startsWith(q)))return 4;
 if(aliases.some(alias=>alias.includes(q)))return 5;
 if(group.includes(q))return 6;
 return 99;
}

async function getGlobalFutures(force=false){
 if(!force&&globalFuturesCache.contracts.length&&Date.now()-globalFuturesCache.at<10*60*1000)return globalFuturesCache;
 let tradeMasterSpecs=new Map(),ampMargins=new Map(),errors=[];
 try{tradeMasterSpecs=parseTradeMasterFuturesRows(await fetchPublicText(TRADEMASTER_FUTURES_SPECS_URL,30000))}catch(err){errors.push(`TradeMaster: ${err.message}`)}
 try{ampMargins=parseAmpMarginRows(await fetchPublicText(AMP_FUTURES_MARGIN_URL,30000))}catch(err){errors.push(`AMP: ${err.message}`)}
 const settled=await Promise.allSettled(GLOBAL_FUTURES_CATALOG.map(item=>fetchYahooChart(item.yahooSymbol||item.priceProxySymbol)));
 const contracts=GLOBAL_FUTURES_CATALOG.map((item,index)=>{
  const quote=settled[index].status==="fulfilled"?settled[index].value:null;
  const price=quote?.price??null,tm=tradeMasterSpecs.get(item.id),amp=ampMargins.get(item.id);
  const multiplier=tm?.multiplier||item.multiplier;
  const notional=price!=null?Math.abs(price*multiplier):null;
  const calculated=price!=null?Math.abs(price*multiplier*item.marginRate/100):null;
  const snapshot=globalFutureBrokerMarginSnapshot(item.code);

  const tmInitial=globalFutureMarginPlausible(tm?.initial,notional)?Number(tm.initial):null;
  const tmMaintenance=globalFutureMarginPlausible(tm?.maintenance,notional)?Number(tm.maintenance):null;
  const ampInitial=globalFutureMarginPlausible(amp?.initial,notional)?Number(amp.initial):null;
  const ampMaintenance=globalFutureMarginPlausible(amp?.maintenance,notional)?Number(amp.maintenance):null;

  const initial=Number(snapshot?.initial)||(tmInitial??ampInitial??calculated);
  const maintenance=Number(snapshot?.maintenance)||(tmMaintenance??ampMaintenance??(initial!=null?initial*.9:null));
  const marginSource=snapshot?.source||
    (tmInitial||tmMaintenance?tm.source:
      (ampInitial||ampMaintenance?amp.source:`Notional × %${item.marginRate} risk tahmini`));

  return{
   ...item,multiplier,aliases:globalFutureAliases(item),
   quoteCurrency:quote?.currency||item.quoteCurrency,
   marginCurrency:snapshot?.currency||tm?.currency||item.marginCurrency,
   price,changePercent:quote?.changePercent??null,delayed:true,
   initialMargin:initial,maintenanceMargin:maintenance,
   marginSource,
   marginEstimated:!snapshot&&!(tmInitial||tmMaintenance||ampInitial||ampMaintenance),
   marginSnapshotAsOf:snapshot?.asOf||null,
   priceTime:quote?.marketTime??null
  };
 });
 globalFuturesCache={at:Date.now(),contracts,live:contracts.some(x=>x.price!=null),error:errors.join(" · ")||null,tradeMasterCount:tradeMasterSpecs.size,ampCount:ampMargins.size};
 return globalFuturesCache;
}

function futuresQuotePlausible(price,reference){
 const p=Number(price),r=Number(reference);
 if(!Number.isFinite(p)||p<=0)return false;
 if(!Number.isFinite(r)||r<=0)return true;
 const ratio=p/r;
 // Protect against symbol/scale mismatches (e.g. GC around 4,000 accidentally becoming 37.xx).
 // Deliberately wide to allow genuine market moves while rejecting obvious wrong instruments.
 return ratio>=0.20&&ratio<=5.0;
}
async function fetchTradingViewFuturesQuote(item){
 const ticker=String(item?.tradingViewSymbol||"").trim();
 if(!ticker)return null;
 const columns=["close","currency","change","description"];
 const regions=["futures","america"];
 for(const region of regions){
  try{
   const row=await scanTradingViewColumns(ticker,columns,region);
   const price=Number(row.close);
   if(Number.isFinite(price)&&price>0){
    return{
     price,currency:row.currency||item.quoteCurrency||item.marginCurrency||"USD",
     changePercent:Number(row.change)||null,
     description:row.description||item.name,
     source:`TradingView ${ticker}`,
     marketTime:new Date().toISOString(),delayed:true
    };
   }
  }catch{}
 }
 return null;
}
async function fetchYahooFuturesQuote(item){
 const symbols=[item?.yahooSymbol,item?.priceProxySymbol].filter(Boolean);
 for(const symbol of [...new Set(symbols)]){
  try{
   const quote=await fetchYahooChart(symbol);
   if(Number.isFinite(Number(quote.price))&&Number(quote.price)>0){
    return{
     ...quote,price:Number(quote.price),
     source:`Yahoo Finance ${symbol}`,yahooSymbol:symbol,delayed:true
    };
   }
  }catch{}
 }
 return null;
}
async function getExactGlobalFutureQuote(item,referencePrice=0,force=false){
 const candidates=[];
 const tv=await fetchTradingViewFuturesQuote(item);
 if(tv)candidates.push(tv);
 const yahoo=await fetchYahooFuturesQuote(item);
 if(yahoo)candidates.push(yahoo);

 // Existing catalog quote is a final fallback, but it must pass the same sanity test.
 if(force||!candidates.length){
  try{
   const cache=await getGlobalFutures(force);
   const row=cache.contracts.find(x=>x.id===item.id||x.code===item.code);
   if(row&&Number.isFinite(Number(row.price))){
    candidates.push({
     price:Number(row.price),currency:row.quoteCurrency||row.marginCurrency,
     changePercent:row.changePercent,source:"Global Futures catalog",
     marketTime:row.priceTime||new Date().toISOString(),delayed:true
    });
   }
  }catch{}
 }

 const plausible=candidates.filter(q=>futuresQuotePlausible(q.price,referencePrice));
 if(!plausible.length)return{quote:null,candidates};

 // Prefer TradingView exact continuous contract, then Yahoo futures.
 plausible.sort((a,b)=>{
  const score=q=>String(q.source).startsWith("TradingView")?0:String(q.source).startsWith("Yahoo")?1:2;
  return score(a)-score(b);
 });
 return{quote:plausible[0],candidates};
}

app.get("/api/global-futures/contracts",async(req,res)=>{
 const cache=await getGlobalFutures(req.query.refresh==="1");
 res.set("Cache-Control","public, max-age=120, s-maxage=120");
 res.json({
  contracts:cache.contracts,live:cache.live,error:cache.error,
  sourceLabel:`Yahoo gecikmeli fiyat + broker teminat doğrulaması + ${cache.tradeMasterCount?`TradeMaster specs (${cache.tradeMasterCount}) + `:""}${cache.ampCount?"AMP margin sanity-check":"risk oranı tahmini"}`,
  sourceUrl:TRADEMASTER_FUTURES_SPECS_URL,fallbackSourceUrl:AMP_FUTURES_MARGIN_URL,asOf:new Date(cache.at).toISOString()
 });
});
app.get("/api/global-futures/quote",async(req,res)=>{
 try{
  const id=String(req.query.id||"").trim().toUpperCase();
  const code=String(req.query.code||"").trim().toUpperCase();
  const reference=Number(req.query.entry)||0;
  const item=GLOBAL_FUTURES_CATALOG.find(x=>
   String(x.id||"").toUpperCase()===id||
   String(x.code||"").toUpperCase()===code
  );
  if(!item)return res.status(404).json({error:"Yurtdışı futures kontratı bulunamadı"});

  const result=await getExactGlobalFutureQuote(item,reference,req.query.refresh==="1");
  if(!result.quote){
   return res.status(502).json({
    error:"Kontrat için güvenilir fiyat bulunamadı; mevcut fiyat korunuyor.",
    rejected:result.candidates.map(q=>({price:q.price,source:q.source}))
   });
  }

  const q=result.quote;
  res.set("Cache-Control","no-store");
  res.json({
   id:item.id,code:item.code,name:item.name,exchange:item.exchange,
   price:q.price,
   currency:q.currency||item.quoteCurrency||"USD",
   quoteCurrency:q.currency||item.quoteCurrency||"USD",
   marginCurrency:item.marginCurrency||((q.currency||item.quoteCurrency)==="USX"?"USD":(q.currency||item.quoteCurrency||"USD")),
   settlementCurrency:item.marginCurrency||((q.currency||item.quoteCurrency)==="USX"?"USD":(q.currency||item.quoteCurrency||"USD")),
   changePercent:q.changePercent??null,marketTime:q.marketTime||new Date().toISOString(),
   delayed:q.delayed!==false,source:q.source,
   yahooSymbol:item.yahooSymbol,tradingViewSymbol:item.tradingViewSymbol,
   multiplier:item.multiplier
  });
 }catch(error){
  res.status(502).json({error:error.message||"Yurtdışı futures fiyatı alınamadı"})
 }
});

app.get("/api/global-futures/search",async(req,res)=>{
 const q=String(req.query.q||"").trim();
 const cache=await getGlobalFutures(false);
 const items=cache.contracts
  .map(x=>({item:x,score:q?globalFutureSearchScore(x,q):0}))
  .filter(row=>row.score<99)
  .sort((a,b)=>a.score-b.score||String(a.item.code).localeCompare(String(b.item.code)))
  .slice(0,60)
  .map(({item:x})=>({
   ...x,symbol:x.code,yahooSymbol:x.yahooSymbol,type:`Yurtdışı Futures · ${x.group}`,
   exchange:x.exchange,aliases:x.aliases||globalFutureAliases(x),
   source:"Yahoo + TradeMaster/AMP + CME catalog",globalFutureId:x.id,futuresContract:x.code
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



const FREE_ASSISTANT_STOP_WORDS=new Set([
 "bir","bu","şu","icin","için","ile","ve","veya","mi","mı","mu","mü","ne","nedir","nasıl","nasil","hakkında","hakkinda","yorumla","analiz","yap","yapar","göster","goster","bana","sence","bugün","bugun","son","durum","hisse","senedi","piyasa","temel","teknik","değerleme","degerleme","ucuz","pahalı","pahali","fiyat","fiyatı","fiyati","kaç","kac","oran","oranı","orani","portföy","portfoy","risk","vadeli","futures","viop","başlangıç","baslangic","sürdürme","surdurme","teminat","trend","destek","direnç","direnc","rsi","sma","karşılaştır","karsilastir","vs","hangisi","daha","iyi"
]);
function assistantFold(value=""){
 return String(value).toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c");
}
function assistantFmt(value,digits=2){
 const n=Number(value);return Number.isFinite(n)?n.toLocaleString("tr-TR",{minimumFractionDigits:0,maximumFractionDigits:digits}):"-";
}
function assistantPct(value,digits=2){const n=Number(value);return Number.isFinite(n)?`${n>=0?"+":""}${assistantFmt(n,digits)}%`:"-"}
function assistantMoney(value,currency=""){const n=Number(value);return Number.isFinite(n)?`${assistantFmt(n,2)}${currency?` ${currency}`:""}`:"-"}
function firstFinite(...values){for(const value of values){const n=Number(value);if(Number.isFinite(n))return n}return null}
function normalizePercentValue(value){const n=Number(value);if(!Number.isFinite(n))return null;return Math.abs(n)<=1?n*100:n}
function sma(values,period){if(!Array.isArray(values)||values.length<period)return null;const slice=values.slice(-period);return slice.reduce((a,b)=>a+b,0)/period}
function rsi(values,period=14){
 if(!Array.isArray(values)||values.length<=period)return null;let gain=0,loss=0;
 for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d}
 if(loss===0)return 100;const rs=(gain/period)/(loss/period);return 100-(100/(1+rs));
}
async function fetchAssistantHistory(symbol,range="1y"){
 const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d&events=div%2Csplits`;
 const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},signal:AbortSignal.timeout(18000)});
 if(!response.ok)throw new Error(`Yahoo chart HTTP ${response.status}`);
 const json=await response.json(),result=json?.chart?.result?.[0];
 if(!result)throw new Error(json?.chart?.error?.description||"Geçmiş fiyat bulunamadı");
 const q=result.indicators?.quote?.[0]||{},closes=(q.close||[]).filter(Number.isFinite),highs=(q.high||[]).filter(Number.isFinite),lows=(q.low||[]).filter(Number.isFinite);
 return{closes,highs,lows,currency:result.meta?.currency||"",price:closes.at(-1)??result.meta?.regularMarketPrice??null};
}
function portfolioFreeAnalysis(context){
 const positions=Array.isArray(context?.positions)?context.positions:[];
 if(!positions.length)return"Aktif portföy verisi bulunmuyor. ‘Aktif portföyümü analizde kullan’ seçeneğini açık bırakın veya önce pozisyon ekleyin.";
 const rows=positions.map(p=>({
  ...p,size:Math.abs(Number(p.positionSize)||((Number(p.currentPrice)||Number(p.entry)||0)*(Number(p.quantity)||0))),
  pnl:Number(p.pnlAmount)||0,pct:Number(p.pnlPercent)||0
 }));
 const totalExposure=rows.reduce((s,p)=>s+p.size,0),totalPnl=rows.reduce((s,p)=>s+p.pnl,0);
 const sorted=[...rows].sort((a,b)=>b.size-a.size),winners=rows.filter(p=>p.pnl>0),losers=rows.filter(p=>p.pnl<0);
 const classMap={};rows.forEach(p=>classMap[p.assetClass]=(classMap[p.assetClass]||0)+p.size);
 const classes=Object.entries(classMap).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>`${k}: %${assistantFmt(totalExposure?v/totalExposure*100:0,1)}`).join(" · ");
 const top=sorted.slice(0,3).map(p=>`${p.symbol} %${assistantFmt(totalExposure?p.size/totalExposure*100:0,1)}`).join(" · ");
 const stopMissing=rows.filter(p=>!Number(p.stop)).map(p=>p.symbol);
 const concentration=sorted[0]&&totalExposure?sorted[0].size/totalExposure*100:0;
 return[
  "PORTFÖY ÖZETİ",
  `Aktif pozisyon: ${rows.length} · Brüt pozisyon büyüklüğü: ${assistantMoney(totalExposure,"TRY")} · Anlık net K/Z: ${assistantMoney(totalPnl,"TRY")}`,
  `Kazanan/Kaybeden: ${winners.length}/${losers.length} · En büyük ağırlıklar: ${top||"-"}`,
  `Ürün dağılımı: ${classes||"-"}`,
  concentration>35?`Risk uyarısı: En büyük pozisyonun ağırlığı %${assistantFmt(concentration,1)}; bu seviye belirgin konsantrasyon riski yaratır.`:"Konsantrasyon: En büyük pozisyon toplam brüt büyüklüğün %35’inin altında.",
  stopMissing.length?`Stop seviyesi girilmemiş pozisyonlar: ${stopMissing.slice(0,10).join(", ")}. Stop kullanmıyorsanız para bazlı maksimum zarar limiti tanımlayın.`:"Aktif pozisyonların tamamında stop seviyesi mevcut.",
  "Not: Farklı para birimleri kur çevrimi yapılmadan aynı toplamda gösterilmiş olabilir."
 ].join("\n\n");
}
function valuationComment(label,value){
 const n=Number(value);if(!Number.isFinite(n))return null;
 if(label==="F/K")return n<0?"şirket zarar ediyor":n<10?"düşük çarpan":n<=20?"genel olarak dengeli":n<=35?"büyüme primi taşıyor":"yüksek çarpan";
 if(label==="PD/DD")return n<1?"defter değerinin altında":n<=3?"genel olarak dengeli":n<=5?"primli":"yüksek primli";
 if(label==="FD/FAVÖK")return n<8?"düşük":n<=12?"dengeli":n<=15?"primli":"yüksek";
 if(label==="ROE")return n<8?"zayıf":n<15?"orta":n<25?"güçlü":"çok güçlü";
 if(label==="Borç/Özkaynak")return n<.5?"düşük borçluluk":n<=1.5?"orta borçluluk":"yüksek borçluluk";
 return null;
}
async function resolveAssistantAssets(question,context,maxAssets=2){
 const original=String(question||""),fold=assistantFold(original),positions=Array.isArray(context?.positions)?context.positions:[];
 const resolved=[];
 const add=asset=>{if(asset&&!resolved.some(x=>x.key===asset.key)&&resolved.length<maxAssets)resolved.push(asset)};
 for(const p of positions){if(fold.includes(assistantFold(p.symbol))||p.contract&&fold.includes(assistantFold(p.contract)))add({key:`position:${p.symbol}`,type:p.assetClass==="Yurtdışı Futures"?"global-future":String(p.assetClass).includes("VİOP")?"viop":"security",symbol:p.symbol,position:p,contract:p.contract});}
 const viopMatch=original.toUpperCase().match(/F_[A-Z0-9]+(?:\d{4}|\d{6})?/);if(viopMatch)add({key:`viop:${viopMatch[0]}`,type:"viop",symbol:viopMatch[0],contract:viopMatch[0]});
 for(const item of GLOBAL_FUTURES_CATALOG){const codeFold=assistantFold(item.code),nameFold=assistantFold(item.name);if(new RegExp(`(^|[^a-z0-9])${codeFold}([^a-z0-9]|$)`).test(fold)||fold.includes(nameFold))add({key:`gf:${item.id}`,type:"global-future",symbol:item.code,item});}
 const explicit=[...original.matchAll(/(?:\$|BIST:|NASDAQ:|NYSE:|AMEX:)?([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ0-9.-]{1,14})/g)].map(m=>m[1]);
 const words=original.split(/\s+/).map(x=>x.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü0-9.-]/g,"")).filter(Boolean);
 const candidates=[...new Set([...explicit,...words.filter(w=>w.length>=2&&w.length<=16&&!FREE_ASSISTANT_STOP_WORDS.has(assistantFold(w)))])].slice(0,7);
 for(const candidate of candidates){
  if(resolved.length>=maxAssets)break;
  try{
   const results=await searchYahooProducts(candidate);
   if(!results.length)continue;
   const upper=candidate.toUpperCase();
   const bistHint=/bist|yurtici|turkiye|viop/.test(fold);
   const chosen=results.find(x=>x.symbol===upper)||results.find(x=>x.symbol===`${upper}.IS`)||
    (bistHint?results.find(x=>x.symbol.endsWith(".IS")):null)||results.find(x=>assistantFold(x.name).includes(assistantFold(candidate)))||results[0];
   if(chosen)add({key:`sec:${chosen.symbol}`,type:"security",symbol:chosen.symbol,name:chosen.name,exchange:chosen.exchange});
  }catch{}
 }
 return resolved;
}
async function freeFundamentalSnapshot(asset){
 const symbol=asset.symbol,details=await fetchYahooDetails(symbol).catch(()=>({symbol}));
 const tv=await fetchTradingViewFundamentals(symbol,details.exchange||asset.exchange||"",false).catch(()=>({}));
 let sec={};if(!String(symbol).endsWith(".IS"))sec=await fetchSecFundamentals(symbol,tv.market_cap_basic??details.marketCap).catch(()=>({metrics:{}}));
 const sm=sec.metrics||{};
 return{
  symbol,name:details.name||tv.description||asset.name||symbol,currency:details.currency||tv.currency||"",
  price:firstFinite(details.price,tv.close),change:firstFinite(details.changePercent,tv.change),
  high52:firstFinite(details.fiftyTwoWeekHigh),low52:firstFinite(details.fiftyTwoWeekLow),
  pe:firstFinite(tv.price_earnings_ttm,details.trailingPE,sm.pe_ratio),pb:firstFinite(tv.price_book_fq,details.priceToBook,sm.price_to_book),
  evEbitda:firstFinite(tv.enterprise_value_ebitda_ttm,details.enterpriseToEbitda,sm.enterprise_value_over_ebitda),
  ps:firstFinite(tv.price_sales_current,sm.price_to_sales),dividend:normalizePercentValue(firstFinite(tv.dividends_yield_current,details.dividendYield)),
  roe:normalizePercentValue(firstFinite(tv.return_on_equity_fq,details.returnOnEquity,sm.return_on_equity)),
  roa:normalizePercentValue(firstFinite(tv.return_on_assets_fq,details.returnOnAssets,sm.return_on_assets)),
  debtEquity:firstFinite(tv.debt_to_equity_fq,details.debtToEquityComputed,sm.debt_to_equity),currentRatio:firstFinite(tv.current_ratio_fq,details.currentRatio,sm.current_ratio),
  netMargin:normalizePercentValue(firstFinite(tv.net_margin_ttm,details.netMargin,sm.net_profit_margin)),beta:firstFinite(tv.beta_1_year,details.beta),
  marketCap:firstFinite(tv.market_cap_basic,details.marketCap,sm.market_cap),source:[tv.ok?"TradingView":null,details.price!=null?"Yahoo":null,sec.ok?"SEC":null].filter(Boolean).join(" + ")||"Açık piyasa verileri"
 };
}
function fundamentalAnswer(snapshot){
 const rows=[
  ["F/K",snapshot.pe],["PD/DD",snapshot.pb],["FD/FAVÖK",snapshot.evEbitda],["F/S",snapshot.ps],
  ["ROE",snapshot.roe,true],["ROA",snapshot.roa,true],["Net Marj",snapshot.netMargin,true],["Borç/Özkaynak",snapshot.debtEquity],["Cari Oran",snapshot.currentRatio],["Beta",snapshot.beta]
 ].filter(([,v])=>Number.isFinite(Number(v)));
 const comments=rows.filter(([l])=>["F/K","PD/DD","FD/FAVÖK","ROE","Borç/Özkaynak"].includes(l)).map(([l,v])=>`${l} ${assistantFmt(v,2)} (${valuationComment(l,v)})`).join("; ");
 return[
  `${snapshot.symbol} · ${snapshot.name}`,
  `Fiyat: ${assistantMoney(snapshot.price,snapshot.currency)} · Günlük değişim: ${assistantPct(snapshot.change)} · 52H: ${assistantMoney(snapshot.high52,snapshot.currency)} / 52D: ${assistantMoney(snapshot.low52,snapshot.currency)}`,
  rows.map(([l,v,p])=>`${l}: ${assistantFmt(v,2)}${p?"%":""}`).join(" · ")||"Temel oranlar şu anda kaynaktan alınamadı.",
  comments?`Yorum: ${comments}.`:"",
  `Genel değerlendirme: Tek bir oranla ucuz/pahalı kararı verilmemeli. Çarpanları sektör medyanı, kâr büyümesi, nakit akışı ve bilanço kalitesiyle birlikte okuyun.`,
  `Kaynak: ${snapshot.source} · Gecikmeli/açık veriler.`
 ].filter(Boolean).join("\n\n");
}
async function technicalAnswer(asset){
 let symbol=asset.symbol,label=asset.symbol,proxyNote="";
 if(asset.type==="global-future"){symbol=asset.item?.yahooSymbol||asset.position?.yahooSymbol;label=asset.item?.name||asset.symbol}
 if(asset.type==="viop"){
  const raw=asset.contract||asset.symbol,underlying=String(raw).toUpperCase().replace(/^F_/,"").replace(/(?:0[1-9]|1[0-2])(?:20\d{2}|\d{2})$/,"");
  symbol=`${underlying}.IS`;label=`${raw} / ${underlying}`;proxyNote="VİOP ücretsiz geçmiş veri kısıtı nedeniyle teknik hesap dayanak spot üzerinden yapılmıştır.";
 }
 const hist=await fetchAssistantHistory(symbol),c=hist.closes,h=hist.highs,l=hist.lows,price=hist.price;
 const s20=sma(c,20),s50=sma(c,50),s200=sma(c,200),r=rsi(c,14),support=l.slice(-20).length?Math.min(...l.slice(-20)):null,resistance=h.slice(-20).length?Math.max(...h.slice(-20)):null;
 const ret20=c.length>21?(price/c.at(-21)-1)*100:null,ret60=c.length>61?(price/c.at(-61)-1)*100:null;
 const trend=price>s20&&s20>s50?"kısa/orta vadede yukarı":price<s20&&s20<s50?"kısa/orta vadede aşağı":"karışık/yatay";
 return[
  `${label} teknik görünüm`,
  `Son fiyat: ${assistantMoney(price,hist.currency)} · Trend: ${trend}`,
  `SMA20: ${assistantFmt(s20,4)} · SMA50: ${assistantFmt(s50,4)} · SMA200: ${assistantFmt(s200,4)} · RSI14: ${assistantFmt(r,1)}`,
  `20 günlük destek/direnç: ${assistantFmt(support,4)} / ${assistantFmt(resistance,4)} · 1 aylık momentum: ${assistantPct(ret20)} · 3 aylık momentum: ${assistantPct(ret60)}`,
  r!=null&&r>70?"RSI aşırı alım bölgesinde; momentum güçlü olsa da geri çekilme riski artmıştır.":r!=null&&r<30?"RSI aşırı satım bölgesinde; tepki ihtimali artmış olsa da düşen trend teyidi gerekir.":"RSI nötr bölgede; fiyat yapısı ve hacim teyidi daha önemlidir.",
  proxyNote,
  "Kaynak: Yahoo Finance gecikmeli günlük fiyat serisi."
 ].filter(Boolean).join("\n\n");
}
async function futuresMarginAnswer(asset){
 if(asset.type==="global-future"){
  const cache=await getGlobalFutures(false),item=cache.contracts.find(x=>x.id===asset.item?.id||x.code===asset.symbol)||asset.item;
  if(!item)return"Yurtdışı futures kontratı bulunamadı.";
  return[
   `${item.code} · ${item.name} (${item.exchange})`,
   `Gecikmeli fiyat: ${assistantMoney(item.price,item.quoteCurrency)} · Kontrat çarpanı: ${assistantFmt(item.multiplier,4)} · Yaklaşık kontrat büyüklüğü: ${assistantMoney(Number(item.price)*Number(item.multiplier),item.marginCurrency)}`,
   `Başlangıç teminatı: ${assistantMoney(item.initialMargin,item.marginCurrency)} · Sürdürme teminatı: ${assistantMoney(item.maintenanceMargin,item.marginCurrency)}`,
   `Teminat kaynağı: ${item.marginSource}. ${item.marginEstimated?"Bu tutar tahminidir; broker ekranı işlem öncesi teyit edilmelidir.":"Açık broker tablosu kullanılmıştır; yine de işlem öncesi teyit edin."}`
  ].join("\n\n");
 }
 const raw=asset.contract||asset.symbol,underlying=String(raw).toUpperCase().replace(/^F_/,"").replace(/(?:0[1-9]|1[0-2])(?:20\d{2}|\d{2})$/,"");
 const cache=await getViopContracts(false),rows=cache.contracts.filter(x=>String(x.underlying).toUpperCase()===underlying).sort((a,b)=>String(a.sortDate).localeCompare(String(b.sortDate))),item=rows.find(x=>x.isActive!==false)||rows[0];
 if(!item)return`${underlying} için VİOP teminat kaydı bulunamadı.`;
 return[
  `${item.code} · ${item.name}`,
  `Kontrat büyüklüğü: ${assistantFmt(item.contractSize,2)} · Referans fiyat: ${assistantMoney(item.referencePrice,"TRY")} · PSR: %${assistantFmt(item.marginRate,2)}`,
  `Başlangıç teminatı: ${assistantMoney(item.initialMargin,"TRY")} · Sürdürme teminatı: ${assistantMoney(item.maintenanceMargin,"TRY")}`,
  `Kaynak: ${item.marginSource||"Açık VİOP kaynakları"}. Teminatlar gün içinde değişebilir; kurum ekranı işlem öncesi teyit edilmelidir.`
 ].join("\n\n");
}
function knowledgeAnswer(question){
 const q=assistantFold(question),rules=[
  [["pd/dd","pd dd"],"PD/DD piyasa değerini özkaynaklara böler. 1 altı defter değerinin altında, 1–3 genel olarak dengeli, 3–5 primli, 5 üzeri yüksek kabul edilebilir. Bankalarda ROE ile birlikte okunmalıdır."],
  [["f/k","fiyat kazanc"],"F/K fiyatın hisse başına kâra oranıdır. Negatif değer zarar anlamına gelir. 10–20 genel bir denge bandı olabilir; büyüme, kâr kalitesi ve sektör medyanı mutlaka kontrol edilmelidir."],
  [["fd/favok","favok"],"FD/FAVÖK borcu da firma değerine dahil eder. 8 altı düşük, 8–12 dengeli, 12–15 primli, 15 üzeri yüksek olabilir. Bankalarda uygun bir oran değildir."],
  [["roe"],"ROE özkaynağın kâr üretme gücüdür. %8 altı zayıf, %8–15 orta, %15–25 güçlü, %25 üzeri çok güçlü olabilir; yüksek borç ROE’yi yapay biçimde yükseltebilir."],
  [["baslangic teminati","surdurme teminati","viop"],"Başlangıç teminatı pozisyonu açmak için gereken tutardır. Sürdürme teminatı hesabın altına düşmemesi gereken eşiktir. Gerçek piyasa riski teminat değil, kontratın toplam nominal büyüklüğüdür."],
  [["stop","risk yonetimi"],"Önce teknik geçersizlik seviyesi belirlenir, sonra stop mesafesine göre adet hesaplanır. Pozisyon başına para riski toplam portföyün küçük bir yüzdesiyle sınırlandırılmalı; korelasyonlu pozisyonlar tek risk kümesi gibi ele alınmalıdır."],
  [["sharpe"],"Sharpe oranı toplam oynaklık başına risksiz faiz üzerindeki getiriyi ölçer. 1 üzeri kabul edilebilir, 1,5 üzeri güçlü, 2 üzeri çok güçlü kabul edilir; dağılımın normal olmadığı dönemlerde tek başına yeterli değildir."],
  [["sortino"],"Sortino yalnızca aşağı yönlü oynaklığı cezalandırır. Sharpe’a göre yatırımcının zarar riskine daha yakın bir ölçüdür. Yüksek olması daha iyidir."],
  [["beta"],"Beta 1 ise piyasa ile benzer, 1 üzeri daha yüksek, 1 altı daha düşük sistematik oynaklık anlamına gelir. Negatif beta ters yönlü hareket eğilimini gösterir."]
 ];
 for(const [keys,answer] of rules)if(keys.some(k=>q.includes(k)))return answer;
 return null;
}
async function freeMarketAssistant(question,context,messages=[]){
 const q=assistantFold(question),portfolioIntent=/portfoy|pozisyonlarim|risk dagilimi|konsantrasyon/.test(q);
 if(portfolioIntent)return portfolioFreeAnalysis(context);
 const assets=await resolveAssistantAssets(question,context,/karsilastir| vs |hangisi/.test(` ${q} `)?2:1);
 if(assets.length===2){
  const snaps=await Promise.all(assets.map(a=>a.type==="security"?freeFundamentalSnapshot(a):null));
  if(snaps.every(Boolean)){
   const [a,b]=snaps;
   return[
    `${a.symbol} ve ${b.symbol} karşılaştırması`,
    `Fiyat/Günlük: ${a.symbol} ${assistantMoney(a.price,a.currency)} (${assistantPct(a.change)}) · ${b.symbol} ${assistantMoney(b.price,b.currency)} (${assistantPct(b.change)})`,
    `F/K: ${a.symbol} ${assistantFmt(a.pe,2)} · ${b.symbol} ${assistantFmt(b.pe,2)}`,
    `PD/DD: ${a.symbol} ${assistantFmt(a.pb,2)} · ${b.symbol} ${assistantFmt(b.pb,2)}`,
    `FD/FAVÖK: ${a.symbol} ${assistantFmt(a.evEbitda,2)} · ${b.symbol} ${assistantFmt(b.evEbitda,2)}`,
    `ROE: ${a.symbol} %${assistantFmt(a.roe,2)} · ${b.symbol} %${assistantFmt(b.roe,2)}`,
    "Daha düşük çarpan otomatik olarak daha iyi değildir; büyüme, kâr kalitesi, borçluluk ve sektör farkı birlikte değerlendirilmelidir."
   ].join("\n\n");
  }
 }
 const asset=assets[0];
 if(asset){
  if(/teminat|kaldirac|kontrat|margin/.test(q)&&(asset.type==="viop"||asset.type==="global-future"))return futuresMarginAnswer(asset);
  if(/teknik|trend|destek|direnc|rsi|sma|grafik|momentum/.test(q))return technicalAnswer(asset);
  if(asset.type==="global-future")return futuresMarginAnswer(asset);
  if(asset.type==="viop")return /temel|degerleme|fk|pd/.test(q)?fundamentalAnswer(await freeFundamentalSnapshot({symbol:`${String(asset.contract||asset.symbol).replace(/^F_/,"").replace(/(?:0[1-9]|1[0-2])(?:20\d{2}|\d{2})$/,"")}.IS`})):futuresMarginAnswer(asset);
  const snapshot=await freeFundamentalSnapshot(asset);
  if(/fiyat|son durum|kac|gunluk/.test(q)&&!/temel|degerleme|fk|pd|roe|teknik/.test(q))return`${snapshot.symbol} · ${snapshot.name}\n\nSon fiyat: ${assistantMoney(snapshot.price,snapshot.currency)} · Günlük değişim: ${assistantPct(snapshot.change)} · 52 haftalık aralık: ${assistantMoney(snapshot.low52,snapshot.currency)} – ${assistantMoney(snapshot.high52,snapshot.currency)}\n\nKaynak: ${snapshot.source} · Gecikmeli veri.`;
  if(/teknik|trend|destek|direnc|rsi|sma|momentum/.test(q))return technicalAnswer(asset);
  return fundamentalAnswer(snapshot);
 }
 const knowledge=knowledgeAnswer(question);if(knowledge)return knowledge;
 return[
  "Piyasa Asistanı Free tamamen ücretsiz ve site içinde çalışıyor; API anahtarı gerekmez.",
  "Şunları sorabilirsiniz:",
  "• KCHOL temel analiz yap",
  "• ORCL teknik görünüm ve destek/direnç",
  "• AAPL ile MSFT karşılaştır",
  "• GC futures başlangıç teminatı",
  "• KCHOL VİOP teminatı",
  "• Aktif portföyümü risk ve konsantrasyon açısından analiz et",
  "• F/K, PD/DD, Sharpe veya beta ne demek?",
  "Sembolü mümkünse açık yazın. Veriler gecikmeli olabilir ve kesin al/sat tavsiyesi üretilmez."
 ].join("\n");
}
app.get("/api/ai/status",(_req,res)=>res.json({provider:"free-local",model:"Piyasa Asistanı Free",fullyFree:true,requiresKey:false,dataDriven:true}));
app.post("/api/ai/chat",async(req,res)=>{
 const messages=Array.isArray(req.body?.messages)?req.body.messages.slice(-20):[],context=req.body?.context||null;
 const last=messages.filter(x=>x.role==="user").at(-1)?.content;
 if(!last)return res.status(400).json({error:"Soru gereklidir"});
 try{
  const answer=await freeMarketAssistant(last,context,messages);
  res.set("Cache-Control","no-store");
  return res.json({answer,provider:"free-local",providerLabel:"Piyasa Asistanı Free",fullyFree:true,fetchedAt:new Date().toISOString()});
 }catch(error){
  console.error("Free assistant error:",error);
  const fallback=knowledgeAnswer(last)||"Soru işlendi ancak piyasa veri kaynağına şu anda ulaşılamadı. Bir dakika sonra tekrar deneyin veya oran/portföy kavramı hakkında sorun.";
  return res.json({answer:fallback,provider:"free-local",providerLabel:"Piyasa Asistanı Free · Veri Yedeği",fullyFree:true,warning:error.message});
 }
});


const pmsLiveCache=new Map();
function pmsClamp(value,min=0,max=100){return Math.max(min,Math.min(max,Number(value)))}
function pmsAvgDefined(values){const rows=values.filter(Number.isFinite);return rows.length?rows.reduce((a,b)=>a+b,0)/rows.length:null}
function pmsScoreLower(value,good,bad){
 const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;
 if(n<=good)return 100;if(n>=bad)return 0;return pmsClamp((bad-n)/(bad-good)*100);
}
function pmsScoreHigher(value,bad,good){
 const n=Number(value);if(!Number.isFinite(n))return null;
 if(n<=bad)return 0;if(n>=good)return 100;return pmsClamp((n-bad)/(good-bad)*100);
}
async function pmsHistorySeries(symbol,range="1y"){
 const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d&events=div%2Csplits`;
 const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"},signal:AbortSignal.timeout(18000)});
 if(!response.ok)throw new Error(`Yahoo chart HTTP ${response.status}`);
 const json=await response.json(),result=json?.chart?.result?.[0];
 if(!result)throw new Error(json?.chart?.error?.description||"Geçmiş fiyat bulunamadı");
 const quote=result.indicators?.quote?.[0]||{},adjusted=result.indicators?.adjclose?.[0]?.adjclose||[],timestamps=result.timestamp||[],closes=quote.close||[],volumes=quote.volume||[];
 const rows=[];
 for(let i=0;i<timestamps.length;i++){
  const close=Number(closes[i]);if(!Number.isFinite(close)||close<=0)continue;
  const adjustedClose=Number(adjusted[i]);
  rows.push({date:new Date(Number(timestamps[i])*1000).toISOString().slice(0,10),close,adjustedClose:Number.isFinite(adjustedClose)&&adjustedClose>0?adjustedClose:close,volume:Number.isFinite(Number(volumes[i]))?Number(volumes[i]):null});
 }
 return{symbol,currency:result.meta?.currency||"",price:rows.at(-1)?.close??result.meta?.regularMarketPrice??null,rows};
}
async function pmsAssetSnapshot(symbol){
 const bundle=await fetchYahooModuleSet(symbol,["price","summaryDetail","defaultKeyStatistics","financialData","assetProfile"]).catch(()=>({}));
 const price=bundle?.price||{},summary=bundle?.summaryDetail||{},stats=bundle?.defaultKeyStatistics||{},fd=bundle?.financialData||{},profile=bundle?.assetProfile||{};
 const pct=v=>{const n=Number(raw(v));return Number.isFinite(n)?(Math.abs(n)<=1?n*100:n):null};
 return{
  symbol,name:price.longName||price.shortName||symbol,sector:profile.sector||null,industry:profile.industry||null,
  price:Number(raw(fd.currentPrice)??raw(price.regularMarketPrice))||null,
  averageVolume:Number(raw(summary.averageVolume)??raw(summary.averageVolume10days))||null,
  pe:Number(raw(summary.trailingPE)??raw(stats.trailingPE))||null,
  pb:Number(raw(stats.priceToBook))||null,evEbitda:Number(raw(stats.enterpriseToEbitda))||null,
  revenueGrowth:pct(fd.revenueGrowth),earningsGrowth:pct(fd.earningsGrowth),
  roe:pct(fd.returnOnEquity),operatingMargin:pct(fd.operatingMargins),
  debtToEquity:Number(raw(fd.debtToEquity))||null,currentRatio:Number(raw(fd.currentRatio))||null,
  freeCashflow:Number(raw(fd.freeCashflow))||null
 };
}
function pmsReturnMap(series){
 const map=new Map(),rows=series?.rows||[];
 for(let i=1;i<rows.length;i++){
  const a=Number(rows[i-1].adjustedClose??rows[i-1].close),b=Number(rows[i].adjustedClose??rows[i].close);
  if(a>0&&b>0)map.set(rows[i].date,b/a-1);
 }
 return map;
}
function pmsPairCov(mapA,mapB){
 const a=[],b=[];
 for(const [date,ra] of mapA){const rb=mapB.get(date);if(Number.isFinite(rb)){a.push(ra);b.push(rb)}}
 if(a.length<20)return null;
 const ma=average(a),mb=average(b);let sum=0;
 for(let i=0;i<a.length;i++)sum+=(a[i]-ma)*(b[i]-mb);
 return sum/(a.length-1);
}
function pmsFactorScores(snapshot,series){
 const rows=series?.rows||[],closes=rows.map(x=>x.close);
 const momentum=(period)=>closes.length>period&&closes.at(-period-1)>0?(closes.at(-1)/closes.at(-period-1)-1)*100:null;
 const m20=momentum(20),m50=momentum(50),m200=momentum(200);
 const value=pmsAvgDefined([
  pmsScoreLower(snapshot.pe,8,35),pmsScoreLower(snapshot.pb,1,6),pmsScoreLower(snapshot.evEbitda,6,20)
 ]);
 const growth=pmsAvgDefined([
  pmsScoreHigher(snapshot.revenueGrowth,-10,30),pmsScoreHigher(snapshot.earningsGrowth,-15,35)
 ]);
 const momentumScore=pmsAvgDefined([
  Number.isFinite(m20)?pmsClamp(50+m20*1.8):null,
  Number.isFinite(m50)?pmsClamp(50+m50*1.2):null,
  Number.isFinite(m200)?pmsClamp(50+m200*.7):null
 ]);
 const quality=pmsAvgDefined([
  pmsScoreHigher(snapshot.roe,5,30),pmsScoreHigher(snapshot.operatingMargin,3,25),
  Number.isFinite(snapshot.debtToEquity)?pmsClamp((200-snapshot.debtToEquity)/170*100):null,
  pmsScoreHigher(snapshot.currentRatio,.7,2.2),
  Number.isFinite(snapshot.freeCashflow)?(snapshot.freeCashflow>0?80:25):null
 ]);
 return{value,growth,momentum:momentumScore,quality,lowQuality:Number.isFinite(quality)?100-quality:null,momentum20:m20,momentum50:m50,momentum200:m200};
}
function pmsLiquidityScore(position,snapshot){
 const notional=Math.abs(Number(position.notional)||0),px=Number(snapshot.price)||0,vol=Number(snapshot.averageVolume)||0,mult=Math.max(1,Number(position.contractSize)||1);
 const adv=px*vol*mult;if(!notional||!adv)return{score:null,adv:null,days:null};
 const days=notional/(adv*.10);
 let score=15;
 if(days<=.1)score=100;else if(days<=.25)score=92;else if(days<=.5)score=82;else if(days<=1)score=68;else if(days<=2)score=52;else if(days<=5)score=32;
 return{score,adv,days};
}
function pmsHealthComment(overall,diversification,liquidity,risk){
 const rows=[["çeşitlendirme",diversification],["likidite",liquidity],["risk kontrolü",risk]].filter(([,v])=>Number.isFinite(v)).sort((a,b)=>a[1]-b[1]);
 const weak=rows[0],strong=rows.at(-1);
 const label=overall>=80?"güçlü":overall>=65?"iyi":overall>=50?"izlenmesi gereken":"zayıf";
 if(!rows.length)return"Canlı piyasa coverage yetersiz olduğu için sağlık yorumu üretilemedi.";
 return`Portföy sağlığı ${overall.toFixed(0)}/100 ile ${label} bölgede. En güçlü bileşen ${strong[0]} (${strong[1].toFixed(0)}/100), geliştirilmesi en çok gereken alan ${weak[0]} (${weak[1].toFixed(0)}/100). Skorlar portföy yapısını değerlendirir; beklenen getiriyi tahmin etmez.`;
}

async function pmsCachedHistory(symbol,range="10y"){
 const key=`pmsbench:${symbol}:${range}`,cached=pmsLiveCache.get(key);
 if(cached&&Date.now()-cached.at<30*60*1000)return cached.data;
 const data=await pmsHistorySeries(symbol,range);
 pmsLiveCache.set(key,{at:Date.now(),data});return data;
}
function pmsPolicyPeriodKey(date,frequency){
 const [y,m]=String(date).split("-").map(Number);
 if(frequency==="monthly")return`${y}-${String(m).padStart(2,"0")}`;
 if(frequency==="annual")return String(y);
 return`${y}-Q${Math.floor((m-1)/3)+1}`;
}
function pmsPolicyNormalizeWeights(input){
 const raw={
  bist:Math.max(0,Number(input?.bist)||0),sp500:Math.max(0,Number(input?.sp500)||0),
  gold:Math.max(0,Number(input?.gold)||0),bond:Math.max(0,Number(input?.bond)||0)
 };
 const total=raw.bist+raw.sp500+raw.gold+raw.bond;
 if(total<=0)return{bist:.25,sp500:.25,gold:.25,bond:.25};
 return Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,v/total]));
}
function pmsSeriesPriceMap(series,adjusted=false){
 return new Map((series?.rows||[]).map(row=>[row.date,Number(adjusted?(row.adjustedClose??row.close):row.close)]).filter(([,v])=>Number.isFinite(v)&&v>0));
}
function pmsCompositeIndexAtServer(history,date){
 if(!date||!history.length)return null;
 let lo=0,hi=history.length-1,best=null;
 while(lo<=hi){const mid=(lo+hi)>>1,row=history[mid];if(row.date<=date){best=row;lo=mid+1}else hi=mid-1}
 return best?.index??null;
}
async function pmsCompositeBenchmark(config={},modelStartDate=""){
 const weights=pmsPolicyNormalizeWeights(config?.weights),rebalance=["monthly","quarterly","annual"].includes(config?.rebalance)?config.rebalance:"quarterly";
 const [bist,sp500,gold,bond,usdtry]=await Promise.all([
  pmsCachedHistory("XU100.IS","10y"),
  pmsCachedHistory("SPY","10y"),
  pmsCachedHistory("GC=F","10y"),
  pmsCachedHistory("AGG","10y"),
  pmsCachedHistory("TRY=X","10y")
 ]);
 const maps={
  bist:pmsSeriesPriceMap(bist,false),
  sp500:pmsSeriesPriceMap(sp500,true),
  gold:pmsSeriesPriceMap(gold,false),
  bond:pmsSeriesPriceMap(bond,true),
  fx:pmsSeriesPriceMap(usdtry,false)
 };
 const dates=[...new Set([...maps.bist.keys(),...maps.sp500.keys(),...maps.gold.keys(),...maps.bond.keys(),...maps.fx.keys()])].sort();
 const last={bist:null,sp500:null,gold:null,bond:null,fx:null},previousLevel={bist:null,sp500:null,gold:null,bond:null};
 let sleeves=null,previousIndex=null,previousPeriod=null;
 const history=[];
 for(const date of dates){
  for(const key of ["bist","sp500","gold","bond","fx"]){const value=maps[key].get(date);if(Number.isFinite(value)&&value>0)last[key]=value}
  if(!last.bist||!last.sp500||!last.gold||!last.bond||!last.fx)continue;
  const levels={
   bist:last.bist,
   sp500:last.sp500*last.fx,
   gold:last.gold*last.fx,
   bond:last.bond*last.fx
  };
  if(!previousLevel.bist){
   previousLevel.bist=levels.bist;previousLevel.sp500=levels.sp500;previousLevel.gold=levels.gold;previousLevel.bond=levels.bond;
   sleeves={bist:100*weights.bist,sp500:100*weights.sp500,gold:100*weights.gold,bond:100*weights.bond};
   previousIndex=100;previousPeriod=pmsPolicyPeriodKey(date,rebalance);
   history.push({date,index:100,dailyReturn:0,components:{...levels}});
   continue;
  }
  const period=pmsPolicyPeriodKey(date,rebalance);
  if(period!==previousPeriod){
   const total=Object.values(sleeves).reduce((a,b)=>a+b,0);
   sleeves={bist:total*weights.bist,sp500:total*weights.sp500,gold:total*weights.gold,bond:total*weights.bond};
   previousPeriod=period;
  }
  const componentReturns={};
  for(const key of ["bist","sp500","gold","bond"]){
   componentReturns[key]=previousLevel[key]>0?levels[key]/previousLevel[key]-1:0;
   sleeves[key]*=1+componentReturns[key];previousLevel[key]=levels[key];
  }
  const index=Object.values(sleeves).reduce((a,b)=>a+b,0),dailyReturn=previousIndex>0?index/previousIndex-1:0;
  history.push({date,index,dailyReturn,components:{...levels},componentReturns});
  previousIndex=index;
 }
 if(!history.length)throw new Error("Composite benchmark geçmişi oluşturulamadı.");
 const valueDate=history.at(-1).date,indexLevel=history.at(-1).index;
 const ytdStart=`${valueDate.slice(0,4)}-01-01`,ytdBase=pmsCompositeIndexAtServer(history,ytdStart),ytd=ytdBase?indexLevel/ytdBase-1:null;
 const modelBase=modelStartDate?pmsCompositeIndexAtServer(history,String(modelStartDate).slice(0,10)):history[0].index;
 const sinceModelStart=modelBase?indexLevel/modelBase-1:null;
 return{
  source:"Yahoo Finance delayed · XU100.IS + SPY Adj Close + GC=F + AGG Adj Close + TRY=X",
  baseCurrency:"TRY",rebalance,weights,valueDate,indexLevel,ytd,sinceModelStart,history
 };
}

async function pmsMarketRegime(){
 const [spx,vix,hyg,ief]=await Promise.all([
  pmsHistorySeries("^GSPC","5y"),pmsHistorySeries("^VIX","5y"),pmsHistorySeries("HYG","5y"),pmsHistorySeries("IEF","5y")
 ]);
 const vixMap=new Map(vix.rows.map(x=>[x.date,x.close])),hygMap=new Map(hyg.rows.map(x=>[x.date,x.close])),iefMap=new Map(ief.rows.map(x=>[x.date,x.close]));
 const closes=spx.rows.map(x=>x.close),history=[],ratioWindow=[];
 for(let i=199;i<spx.rows.length;i++){
  const row=spx.rows[i],sma50=average(closes.slice(i-49,i+1)),sma200=average(closes.slice(i-199,i+1));
  const mom20=i>=20?(row.close/closes[i-20]-1)*100:null,v=vixMap.get(row.date);
  const h=hygMap.get(row.date),ie=iefMap.get(row.date),ratio=h&&ie?h/ie:null;
  if(Number.isFinite(ratio))ratioWindow.push(ratio);if(ratioWindow.length>50)ratioWindow.shift();
  const ratioSma=ratioWindow.length>=20?average(ratioWindow):null;
  let trend="Sideways";
  if(row.close>sma200&&sma50>sma200&&mom20>=0)trend="Bull";
  else if(row.close<sma200&&sma50<sma200&&mom20<=0)trend="Bear";
  const volatility=Number.isFinite(v)?(v>=25?"High Volatility":v<=18?"Low Volatility":"Normal Volatility"):"Unknown";
  let riskAppetite="Neutral";
  if(Number.isFinite(ratio)&&Number.isFinite(ratioSma)){
   if(ratio>ratioSma&&row.close>sma50)riskAppetite="Risk-On";
   else if(ratio<ratioSma&&row.close<sma50)riskAppetite="Risk-Off";
  }
  history.push({date:row.date,trend,volatility,riskAppetite,spx:row.close,sma50,sma200,momentum20:mom20,vix:v??null,riskRatio:ratio,riskRatioSma:ratioSma});
 }
 return{source:"Yahoo Finance gecikmeli: ^GSPC + ^VIX + HYG/IEF",current:history.at(-1)||null,history};
}
app.post("/api/pms/live-analytics",authRequired,async(req,res)=>{
 try{
  const positions=Array.isArray(req.body?.positions)?req.body.positions.slice(0,60):[];
  const exposureOf=p=>{
   const rows=[p?.exposureTRY,p?.notional].map(Number).filter(v=>Number.isFinite(v)&&v>0);
   return rows[0]||0;
  };
  const signedExposureOf=p=>{
   const rows=[p?.signedExposureTRY,p?.signedNotional].map(Number).filter(Number.isFinite);
   if(rows.length&&Math.abs(rows[0])>0)return rows[0];
   return exposureOf(p)*(Number(p?.directionSign)<0?-1:1);
  };
  const usable=positions.filter(p=>p?.symbol);
  const unique=[...new Set(usable.map(p=>String(p.symbol).trim().toUpperCase()).filter(Boolean))].slice(0,30);

  const snapshotEntries=await Promise.all(unique.map(async symbol=>{
   const cacheKey=`snapshot:${symbol}`,cached=pmsLiveCache.get(cacheKey);
   if(cached&&Date.now()-cached.at<5*60*1000)return[symbol,cached.data];
   const data=await pmsAssetSnapshot(symbol).catch(()=>({symbol}));
   pmsLiveCache.set(cacheKey,{at:Date.now(),data});return[symbol,data];
  }));
  const snapshots=new Map(snapshotEntries);

  const active=usable.filter(p=>p.status==="Aktif").slice(0,25);
  const activeSymbols=[...new Set(active.map(p=>String(p.symbol).toUpperCase()))];
  const historyEntries=await Promise.all(activeSymbols.map(async symbol=>{
   const cacheKey=`hist:${symbol}`,cached=pmsLiveCache.get(cacheKey);
   if(cached&&Date.now()-cached.at<5*60*1000)return[symbol,cached.data];
   const data=await pmsHistorySeries(symbol,"1y").catch(()=>null);
   if(data)pmsLiveCache.set(cacheKey,{at:Date.now(),data});return[symbol,data];
  }));
  const histories=new Map(historyEntries);

  const gross=active.reduce((s,p)=>s+Math.abs(exposureOf(p)),0);
  const assets=usable.map(p=>{
   const snap=snapshots.get(String(p.symbol).toUpperCase())||{symbol:p.symbol};
   const hist=histories.get(String(p.symbol).toUpperCase())||null;
   const factors=p.status==="Aktif"?pmsFactorScores(snap,hist):{};
   const liquidity=p.status==="Aktif"?pmsLiquidityScore({...p,notional:exposureOf(p)},snap):{};
   const sector=snap.sector||p.economicBucket||p.assetClass||"Diğer";
   return{
    ...p,exposureTRY:exposureOf(p),signedExposureTRY:signedExposureOf(p),
    sector,industry:snap.industry||null,price:snap.price||null,averageVolume:snap.averageVolume||null,
    liquidity,...factors
   };
  });

  const activeAssets=assets.filter(x=>x.status==="Aktif");
  const weights=activeAssets.map(x=>gross?Math.abs(Number(x.exposureTRY)||0)/gross:0);
  const signedWeights=activeAssets.map(x=>gross?(Number(x.signedExposureTRY)||0)/gross:0);
  const maps=activeAssets.map(x=>pmsReturnMap(histories.get(String(x.symbol).toUpperCase())));
  const n=activeAssets.length,covMatrix=Array.from({length:n},()=>Array(n).fill(0));
  let covarianceCoverage=0,totalPairs=0;
  for(let i=0;i<n;i++){
   for(let j=0;j<n;j++){
    totalPairs++;
    const cv=pmsPairCov(maps[i],maps[j]);
    if(Number.isFinite(cv)){covMatrix[i][j]=cv;covarianceCoverage++}
   }
  }

  let portfolioVar=0;
  for(let i=0;i<n;i++)for(let j=0;j<n;j++)portfolioVar+=signedWeights[i]*signedWeights[j]*covMatrix[i][j];

  // If pairwise covariance coverage is sparse, keep diagonal historical risk.
  if(!(portfolioVar>0)){
   portfolioVar=0;
   for(let i=0;i<n;i++){
    const v=Number(covMatrix[i][i])||0;
    if(v>0)portfolioVar+=signedWeights[i]*signedWeights[i]*v;
   }
  }
  portfolioVar=Math.max(0,portfolioVar);

  const riskRows=activeAssets.map((asset,i)=>{
   let marginal=0;for(let j=0;j<n;j++)marginal+=covMatrix[i][j]*signedWeights[j];
   const component=portfolioVar>0?signedWeights[i]*marginal/portfolioVar:null;
   const annVol=covMatrix[i][i]>0?Math.sqrt(covMatrix[i][i]*252)*100:null;
   return{
    label:asset.label,symbol:asset.symbol,
    weight:signedWeights[i],absoluteWeight:weights[i],
    exposureTRY:Number(asset.exposureTRY)||0,signedExposureTRY:Number(asset.signedExposureTRY)||0,
    annualVolatility:annVol,
    riskContributionPct:Number.isFinite(component)?component*100:null
   };
  });

  const meaningfulComponent=riskRows.some(x=>Number.isFinite(x.riskContributionPct)&&Math.abs(x.riskContributionPct)>.000001);
  if(!meaningfulComponent){
   const raw=riskRows.map((x,i)=>weights[i]*(Number(x.annualVolatility)||0)),den=raw.reduce((a,b)=>a+b,0);
   riskRows.forEach((x,i)=>x.riskContributionPct=den?raw[i]/den*100:null);
  }

  let portfolioVolatility=portfolioVar>0?Math.sqrt(portfolioVar*252)*100:null;
  if(!Number.isFinite(portfolioVolatility)){
   const diagonal=riskRows.reduce((s,x,i)=>{
    const annual=(Number(x.annualVolatility)||0)/100;
    return s+(signedWeights[i]*annual)**2;
   },0);
   portfolioVolatility=diagonal>0?Math.sqrt(diagonal)*100:null;
  }
  const riskCoverage=totalPairs?covarianceCoverage/totalPairs*100:0;

  const sectorMap={};
  activeAssets.forEach((x,i)=>{
   const sector=x.sector||"Diğer";
   sectorMap[sector]=(sectorMap[sector]||0)+weights[i];
  });
  const sectors=Object.entries(sectorMap).map(([sector,weight])=>({sector,weight})).sort((a,b)=>b.weight-a.weight);

  const hhi=weights.reduce((s,w)=>s+w*w,0),effN=hhi>0?1/hhi:0,maxW=Math.max(0,...weights);
  const positionDiv=activeAssets.length?50*pmsClamp(effN/8,0,1)+50*pmsClamp((1-maxW)/.85,0,1):0;
  const sectorWeights=sectors.map(x=>x.weight),sectorHhi=sectorWeights.reduce((s,w)=>s+w*w,0),effSector=sectorHhi>0?1/sectorHhi:0,maxSector=Math.max(0,...sectorWeights);
  const sectorDiv=sectors.length?50*pmsClamp(effSector/6,0,1)+50*pmsClamp((1-maxSector)/.70,0,1):positionDiv;
  const diversification=.7*positionDiv+.3*sectorDiv;

  let liqNum=0,liqDen=0,liqCoverageWeight=0;
  activeAssets.forEach((x,i)=>{
   if(Number.isFinite(x.liquidity?.score)){liqNum+=weights[i]*x.liquidity.score;liqDen+=weights[i];liqCoverageWeight+=weights[i]}
  });
  const liquidity=liqDen?liqNum/liqDen:45;
  const volScore=!Number.isFinite(portfolioVolatility)?55:portfolioVolatility<=10?100:portfolioVolatility<=15?85:portfolioVolatility<=20?70:portfolioVolatility<=30?50:portfolioVolatility<=40?30:15;
  const capital=Math.max(1,Number(req.body?.capital)||gross||1),leverage=gross/capital;
  const levScore=leverage<=1?100:leverage<=1.25?80:leverage<=1.5?60:leverage<=2?35:15;
  const concScore=maxW<=.15?100:maxW<=.20?85:maxW<=.30?65:maxW<=.40?45:20;
  const topRisk=Math.max(0,...riskRows.map(x=>Number(x.riskContributionPct)||0));
  const riskConcScore=topRisk<=20?100:topRisk<=30?80:topRisk<=40?60:topRisk<=55?35:15;
  const stopCoverage=activeAssets.length?activeAssets.filter(x=>x.hasStop).length/activeAssets.length:0;
  const stopScore=stopCoverage*100;
  const risk=.32*volScore+.20*levScore+.20*concScore+.18*riskConcScore+.10*stopScore;
  const coverage=(.45*(riskCoverage||0)+.30*(liqCoverageWeight*100)+.25*(activeAssets.length?100:0));
  const overall=.35*diversification+.25*liquidity+.40*risk;

  // Factor exposure: each factor gets its own coverage. Null factors are not zero.
  const factorKeys=["value","growth","momentum","quality","lowQuality"],factorExposure={},coverageByFactor={};
  for(const key of factorKeys){
   let num=0,den=0;
   activeAssets.forEach((x,i)=>{
    if(Number.isFinite(x[key])){num+=weights[i]*x[key];den+=weights[i]}
   });
   factorExposure[key]=den?num/den:null;
   coverageByFactor[key]=den*100;
  }
  const anyFactorCoverage=activeAssets.reduce((sum,x,i)=>{
   const any=factorKeys.some(key=>Number.isFinite(x[key]));
   return sum+(any?weights[i]:0);
  },0)*100;
  const fundamentalCoverage=Math.max(coverageByFactor.value||0,coverageByFactor.growth||0,coverageByFactor.quality||0);
  factorExposure.coverage=anyFactorCoverage;
  factorExposure.coverageByFactor=coverageByFactor;
  factorExposure.fundamentalCoverage=fundamentalCoverage;
  factorExposure.sectors=sectors;

  const [regime,compositeBenchmark]=await Promise.all([
   pmsMarketRegime(),
   pmsCompositeBenchmark(req.body?.benchmark||{},req.body?.modelStartDate||"")
  ]);
  res.set("Cache-Control","no-store");
  res.json({
   fetchedAt:new Date().toISOString(),
   source:"Yahoo Finance gecikmeli piyasa/fundamental verileri + Model Portföy kayıtları",
   assets,
   risk:{portfolioVolatility,coverage:riskCoverage,grossExposureTRY:gross,rows:riskRows},
   portfolioHealth:{overall,diversification,liquidity,risk,coverage,comment:pmsHealthComment(overall,diversification,liquidity,risk),effectivePositions:effN,maxWeight:maxW,stopCoverage,leverage},
   factorExposure,
   regime,
   compositeBenchmark
  });
 }catch(error){
  console.error("PMS live analytics error:",error);
  res.status(502).json({error:error.message||"PMS canlı analiz verisi alınamadı."});
 }
});


// ================================================================
// v8.4.5 — Learning Hub / Index constituent lookup
// On-demand + cached so broad indices do not slow initial page load.
// ================================================================
const indexConstituentCache=new Map();
const INDEX_CONSTITUENT_TTL=6*60*60*1000;

function decodeHtmlEntitiesBasic(value=""){
 return String(value)
  .replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
  .replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/\\u0026/g,"&").replace(/\\u003c/g,"<").replace(/\\u003e/g,">");
}
function normalizeIndexConstituentRows(rows=[]){
 const seen=new Set(),out=[];
 for(const row of rows){
  const symbol=String(row?.symbol||"").trim().toUpperCase();
  const ticker=String(row?.ticker||symbol.split(":").pop()||"").trim().toUpperCase();
  const name=decodeHtmlEntitiesBasic(String(row?.name||ticker||"").trim());
  if(!ticker||!name)continue;
  const key=symbol||ticker;
  if(seen.has(key))continue;
  seen.add(key);
  out.push({symbol:symbol||ticker,ticker,name});
 }
 return out;
}
function tradingViewMarketForCountry(country=""){
 const map={
  "ABD":"america","Kanada":"canada","Birleşik Krallık":"uk","Avustralya":"australia","Hindistan":"india",
  "Brezilya":"brazil","Almanya":"germany","Fransa":"france","İspanya":"spain","İtalya":"italy",
  "Hollanda":"netherlands","Güney Kore":"korea","Japonya":"japan","Türkiye":"turkey","İsrail":"israel",
  "Çin":"china","Hong Kong":"hongkong","Tayvan":"taiwan","Singapur":"singapore","Endonezya":"indonesia",
  "Malezya":"malaysia","Tayland":"thailand","Vietnam":"vietnam","Filipinler":"philippines","Pakistan":"pakistan",
  "Güney Afrika":"southafrica","Meksika":"mexico","Arjantin":"argentina","Şili":"chile","Kolombiya":"colombia",
  "Peru":"peru","Polonya":"poland","İsveç":"sweden","İsviçre":"switzerland","Norveç":"norway","Danimarka":"denmark",
  "Finlandiya":"finland","Belçika":"belgium","Portekiz":"portugal","Yunanistan":"greece","Avusturya":"austria",
  "İrlanda":"ireland","Yeni Zelanda":"newzealand","Suudi Arabistan":"ksa","Birleşik Arap Emirlikleri":"uae"
 };
 return map[String(country||"").trim()]||null;
}
async function fetchTradingViewIndexConstituents(indexCode,country=""){
 const payload={
  filter:[],
  options:{lang:"en"},
  symbols:{symbolset:[indexCode]},
  sort:{sortBy:"market_cap_basic",sortOrder:"desc"},
  range:[0,5000],
  columns:["name","description","exchange","type","market_cap_basic"]
 };
 const markets=["global",tradingViewMarketForCountry(country),"america"].filter((x,i,a)=>x&&a.indexOf(x)===i);
 const errors=[];
 for(const market of markets){
  try{
   const response=await fetch(`https://scanner.tradingview.com/${market}/scan`,{
    method:"POST",
    headers:{
     "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
     "Accept":"application/json,text/plain,*/*",
     "Content-Type":"application/json",
     "Origin":"https://www.tradingview.com",
     "Referer":"https://www.tradingview.com/"
    },
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(18000)
   });
   if(!response.ok){errors.push(`${market}: HTTP ${response.status}`);continue}
   const json=await response.json();
   const items=normalizeIndexConstituentRows((json?.data||[]).map(row=>({
    symbol:row?.s,
    ticker:row?.d?.[0]||String(row?.s||"").split(":").pop(),
    name:row?.d?.[1]||row?.d?.[0]||String(row?.s||"").split(":").pop()
   })));
   if(items.length)return{items,totalCount:Number(json?.totalCount)||items.length,source:`TradingView Index Screener (${market})`};
  }catch(error){errors.push(`${market}: ${error?.message||String(error)}`)}
 }
 throw new Error(errors.join(" | ")||"TradingView scanner bileşen döndürmedi.");
}
function parseBistIndexCsv(text,indexCode){
 const target=String(indexCode||"").replace(/^BIST:/i,"").trim().toUpperCase();
 const rows=[];
 for(const line of String(text||"").split(/\r?\n/)){
  if(!line.trim())continue;
  const cols=line.split(";").map(x=>x.trim().replace(/^"|"$/g,""));
  if(cols.length<4)continue;
  const stockRaw=cols[0],company=cols[1],code=String(cols[2]||"").toUpperCase();
  if(code!==target||!stockRaw||!company)continue;
  const ticker=stockRaw.replace(/\.E$/i,"").toUpperCase();
  rows.push({symbol:`BIST:${ticker}`,ticker,name:company});
 }
 return normalizeIndexConstituentRows(rows);
}
async function fetchBistOfficialIndexConstituents(indexCode){
 const response=await fetch("https://www.borsaistanbul.com/datum/hisse_endeks_ds.csv",{
  headers:{
   "User-Agent":"Mozilla/5.0 Chrome/124 Safari/537.36",
   "Accept":"text/csv,text/plain,*/*",
   "Referer":"https://www.borsaistanbul.com/"
  },
  signal:AbortSignal.timeout(18000)
 });
 if(!response.ok)throw new Error(`Borsa İstanbul HTTP ${response.status}`);
 const text=await response.text();
 const items=parseBistIndexCsv(text,indexCode);
 if(!items.length)throw new Error("Borsa İstanbul bileşen CSV'sinde endeks bulunamadı.");
 return{items,totalCount:items.length,source:"Borsa İstanbul resmi endeks bileşenleri"};
}
async function fetchPublicTradingViewComponentPreview(indexCode){
 const slug=String(indexCode||"").trim().replace(":","-");
 const response=await fetch(`https://www.tradingview.com/symbols/${encodeURIComponent(slug)}/components/`,{
  headers:{
   "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
   "Accept":"text/html,application/xhtml+xml",
   "Accept-Language":"en-US,en;q=0.9"
  },
  signal:AbortSignal.timeout(18000)
 });
 if(!response.ok)throw new Error(`TradingView components HTTP ${response.status}`);
 const html=await response.text();
 // Embedded TradingView pages commonly repeat ticker + description in JSON.
 const candidates=[];
 const patterns=[
  /"symbol"\s*:\s*"([A-Z0-9_.-]+:[A-Z0-9_.-]+)"[\s\S]{0,900}?"description"\s*:\s*"([^"]{2,180})"/g,
  /"pro_name"\s*:\s*"([A-Z0-9_.-]+:[A-Z0-9_.-]+)"[\s\S]{0,900}?"description"\s*:\s*"([^"]{2,180})"/g
 ];
 for(const pattern of patterns){
  let m;
  while((m=pattern.exec(html))!==null){
   candidates.push({symbol:m[1],ticker:m[1].split(":").pop(),name:m[2]});
   if(candidates.length>200)break;
  }
  if(candidates.length)break;
 }
 return{items:normalizeIndexConstituentRows(candidates),totalCount:candidates.length,source:"TradingView public components preview"};
}

app.get("/api/index-constituents",async(req,res)=>{
 const code=String(req.query.code||"").trim().toUpperCase();
 if(!/^[A-Z0-9_.-]+:[A-Z0-9_.!&-]+$/i.test(code))return res.status(400).json({error:"Geçerli TradingView endeks kodu gereklidir."});
 const cached=indexConstituentCache.get(code);
 if(cached&&Date.now()-cached.at<INDEX_CONSTITUENT_TTL){
  res.set("Cache-Control","public, max-age=1800, s-maxage=1800");
  return res.json(cached.payload);
 }
 let result=null,errors=[];
 // BIST: prefer official exchange constituent file because it is authoritative for local indices.
 if(code.startsWith("BIST:")){
  try{result=await fetchBistOfficialIndexConstituents(code)}catch(error){errors.push(error?.message||String(error))}
 }
 if(!result?.items?.length){
  try{result=await fetchTradingViewIndexConstituents(code,String(req.query.country||""))}catch(error){errors.push(error?.message||String(error))}
 }
 if(!result?.items?.length){
  try{
   const preview=await fetchPublicTradingViewComponentPreview(code);
   if(preview.items.length)result=preview;
  }catch(error){errors.push(error?.message||String(error))}
 }
 if(!result?.items?.length){
  return res.status(404).json({
   error:"Bu endeks için bileşen listesi veri kaynağından alınamadı.",
   code,
   details:errors.slice(0,3)
  });
 }
 const payload={
  code,
  index:String(req.query.index||""),
  country:String(req.query.country||""),
  source:result.source,
  items:result.items,
  totalCount:result.totalCount||result.items.length,
  fetchedAt:new Date().toISOString()
 };
 indexConstituentCache.set(code,{at:Date.now(),payload});
 res.set("Cache-Control","public, max-age=1800, s-maxage=1800");
 res.json(payload);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "portfolio-tracker", databaseConfigured: Boolean(DATABASE_URL), databaseReady });
});


const FX_RATE_SYMBOLS={
 USD:"TRY=X",EUR:"EURTRY=X",GBP:"GBPTRY=X",CHF:"CHFTRY=X",JPY:"JPYTRY=X",
 CAD:"CADTRY=X",AUD:"AUDTRY=X",HKD:"HKDTRY=X",CNY:"CNYTRY=X"
};
let fxRateCache={at:0,rates:null};
app.get("/api/fx/rates",async(req,res)=>{
 try{
  if(req.query.refresh!=="1"&&fxRateCache.rates&&Date.now()-fxRateCache.at<30*1000){
   return res.json({source:"Yahoo Finance delayed FX",fetchedAt:new Date(fxRateCache.at).toISOString(),rates:fxRateCache.rates});
  }
  const entries=Object.entries(FX_RATE_SYMBOLS);
  const settled=await Promise.allSettled(entries.map(([,symbol])=>fetchYahooChart(symbol)));
  const rates={TRY:{rate:1,symbol:"TRY",marketTime:new Date().toISOString(),delay:0}};
  settled.forEach((result,index)=>{
   const [currency,symbol]=entries[index];
   if(result.status==="fulfilled"&&Number.isFinite(Number(result.value?.price))&&Number(result.value.price)>0){
    rates[currency]={rate:Number(result.value.price),symbol,marketTime:result.value.marketTime,delay:result.value.delay};
   }
  });
  fxRateCache={at:Date.now(),rates};
  res.set("Cache-Control","public, max-age=20, s-maxage=20");
  res.json({source:"Yahoo Finance delayed FX",fetchedAt:new Date(fxRateCache.at).toISOString(),rates});
 }catch(error){res.status(502).json({error:error.message||"FX kurları alınamadı"})}
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

await initializeDatabase();

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
