require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const CONFIG = require("./config");
const { Readable } = require("node:stream");

const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(cookieParser());
app.use(express.static("public", { etag: false, lastModified: false,
  setHeaders: (res) => res.set("Cache-Control", "no-store") }));
app.use("/avatars", express.static(path.join(__dirname, "data", "avatars")));

const DATA = path.join(__dirname, "data");
const AVDIR = path.join(DATA, "avatars");
const USERS = path.join(DATA, "users");
fs.mkdirSync(AVDIR, { recursive: true });
fs.mkdirSync(USERS, { recursive: true });

const RANKS = CONFIG.ranks || { free: { name: "Free", daily: 15, days: 0, unlimited: false } };
const rankOf = (p) => (p.rank && p.rank !== "free" && p.rankExpire && Date.now() < p.rankExpire && RANKS[p.rank]) ? p.rank : "free";

const secretFile = path.join(DATA, "secret.txt");
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  try { JWT_SECRET = fs.readFileSync(secretFile, "utf8").trim(); } catch {}
  if (!JWT_SECRET) { JWT_SECRET = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(secretFile, JWT_SECRET); }
}

const safeName = (s) => (String(s).toLowerCase().replace(/[^a-z0-9ก-๙_.-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)) || "user";
const readUser  = (file) => JSON.parse(fs.readFileSync(path.join(USERS, file), "utf8").replace(/^module\.exports\s*=\s*/, ""));
const writeUser = (file, data) => fs.writeFileSync(path.join(USERS, file), "module.exports = " + JSON.stringify(data, null, 2));
function allUsers() {
  return fs.readdirSync(USERS).filter(f => f.endsWith(".js")).map(f => {
    try { return { file: f, data: readUser(f) }; } catch { return null; }
  }).filter(Boolean);
}
function findUser(pred) { return allUsers().find(u => pred(u.data.profile)) || null; }
function freeFile(base) {
  let file = base + ".js", i = 2;
  while (fs.existsSync(path.join(USERS, file))) file = `${base}-${i++}.js`;
  return file;
}
const pub = (p) => ({ id: p.id, username: p.username, email: p.email || "", avatar: p.avatar || "", avatarUrl: p.avatarUrl || "", theme: p.theme || null, rank: rankOf(p), rankName: RANKS[rankOf(p)].name, rankExpire: p.rankExpire || null });
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const SUPA_URL = (CONFIG.supaUrl || process.env.SUPA_URL || process.env.supaUrl || "").replace(/\/+$/, "");
const SUPA_KEY = CONFIG.supaKey || process.env.SUPA_KEY || process.env.supaKey || "";
const SH = { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY, "Content-Type": "application/json" };

function setToken(res, profile) {
  const token = jwt.sign({ id: profile.id }, JWT_SECRET, { expiresIn: "30d" });
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 864e5 });
}
app.use((req, res, next) => {
  req.userRec = null;
  try {
    const { id } = jwt.verify(req.cookies.token || "", JWT_SECRET);
    req.userRec = findUser(p => p.id === id);
  } catch {}
  next();
});
const auth = (req, res, next) => { if (!req.userRec) return res.status(401).json({ error: "auth" }); next(); };

app.get("/__check", (req, res) => {
  const PUB = path.join(__dirname, "public");
  let idx = "", js = "";
  try { idx = fs.readFileSync(path.join(PUB, "index.html"), "utf8"); } catch (e) { idx = "ERR:" + e.message; }
  try { js = fs.readFileSync(path.join(PUB, "app.js"), "utf8"); } catch (e) { js = "ERR:" + e.message; }
  res.json({
    cwd: __dirname,
    files_in_public: fs.existsSync(PUB) ? fs.readdirSync(PUB) : "missing!",
    index_html: { has_input: idx.includes('id="input"'), has_plusBtn: idx.includes("plusBtn"), has_stopBtn: idx.includes("stopBtn"), has_stabAcc: idx.includes("stabAcc"), size_kb: Math.round(idx.length/1024*10)/10 },
    app_js: { last_line: js.trim().split("\n").pop(), size_kb: Math.round(js.length/1024*10)/10 },
  });
});

/* ═══ 🌐 WEB SEARCH ═══ */
async function webSearch(query) {
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    const html = await r.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 6) {
      let title = m[2].replace(/<[^>]*>/g, "").trim();
      let url = m[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (title) results.push({ title, url });
    }
    const snippets = [];
    for (const res2 of results.slice(0, 3)) {
      try {
        const pr = await fetch(res2.url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
        const ptext = (await pr.text()).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 1500);
        if (ptext.length > 100) snippets.push(`[จาก: ${res2.title}]\n${ptext}`);
      } catch {}
    }
    return { results, snippets };
  } catch (e) { return { results: [], snippets: [], err: e.message }; }
}

app.post("/api/register", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const username = (req.body?.username || "").trim();
  const password = req.body?.password || "";
  const confirm = req.body?.confirm || "";
  if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email" });
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (password !== confirm) return res.status(400).json({ error: "Passwords do not match" });
  if (findUser(p => p.username.toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: "Username already taken" });
  if (findUser(p => (p.email || "").toLowerCase() === email)) return res.status(400).json({ error: "Email already registered" });
  const file = freeFile(safeName(username));
  const profile = { id: crypto.randomUUID(), username, email, pass: await bcrypt.hash(password, 10), avatar: "", avatarUrl: "", theme: null, rank: "free", rankExpire: null, createdAt: Date.now() };
  writeUser(file, { profile, chats: [] });
  setToken(res, profile);
  res.json({ user: pub(profile) });
});

app.post("/api/login", async (req, res) => {
  const id = (req.body?.username || "").trim().toLowerCase();
  const rec = findUser(p => p.username.toLowerCase() === id || (p.email || "").toLowerCase() === id);
  if (!rec || !rec.data.profile.pass || !(await bcrypt.compare(req.body?.password || "", rec.data.profile.pass)))
    return res.status(400).json({ error: "Wrong username/email or password" });
  setToken(res, rec.data.profile);
  res.json({ user: pub(rec.data.profile) });
});

app.post("/api/logout", (req, res) => { res.clearCookie("token"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json({ user: pub(req.userRec.data.profile) }));

app.post("/api/me", auth, (req, res) => {
  const rec = req.userRec, p = rec.data.profile;
  const nu = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (nu && nu !== p.username) {
    if (nu.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
    if (findUser(x => x.username.toLowerCase() === nu.toLowerCase() && x.data.profile.id !== p.id))
      return res.status(400).json({ error: "Username already taken" });
    p.username = nu;
    const nf = freeFile(safeName(nu));
    if (nf !== rec.file) { writeUser(nf, rec.data); try { fs.unlinkSync(path.join(USERS, rec.file)); } catch {}; rec.file = nf; }
  }
  if (req.body?.theme !== undefined) p.theme = req.body.theme;
  writeUser(rec.file, rec.data);
  res.json({ user: pub(p) });
});

app.post("/api/avatar", auth, (req, res) => {
  const image = req.body?.image || "";
  const m = image.match(/^data:image\/(png|jpe?g|webp);base64,/);
  if (!m || image.length > 1_500_000) return res.status(400).json({ error: "Invalid image" });
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const f = `${req.userRec.data.profile.id}.${ext}`;
  fs.writeFileSync(path.join(AVDIR, f), Buffer.from(image.split(",")[1], "base64"));
  req.userRec.data.profile.avatar = `/avatars/${f}?v=${Date.now()}`;
  writeUser(req.userRec.file, req.userRec.data);
  res.json({ user: pub(req.userRec.data.profile) });
});

app.get("/api/chats", auth, (req, res) => res.json(req.userRec.data.chats || []));
app.put("/api/chats", auth, (req, res) => {
  req.userRec.data.chats = Array.isArray(req.body) ? req.body : [];
  writeUser(req.userRec.file, req.userRec.data);
  res.json({ ok: true });
});

app.get("/api/usage", auth, (req, res) => {
  const rec = req.userRec, p = rec.data.profile;
  const rank = rankOf(p), limit = RANKS[rank].daily;
  const unlimited = !!RANKS[rank].unlimited;
  const today = new Date().toDateString();
  const used = (rec.data.usage && rec.data.usage.day === today) ? rec.data.usage.count : 0;
  const t = new Date(); t.setHours(24, 0, 0, 0);
  res.json({ used, limit: unlimited ? 0 : limit, unlimited, rank, rankName: RANKS[rank].name, expire: p.rankExpire || null, resetAt: t.getTime() });
});

/* ── License redeem: Supabase — เติมวันต่อยอด + RESET ── */
app.post("/api/redeem", auth, async (req, res) => {
  try {
    if (!SUPA_URL || !SUPA_KEY) return res.status(500).json({ error: "Supabase not configured in config.js" });
    const code = (req.body?.code || "").trim();
    if (!code) return res.status(400).json({ error: "Enter a license key" });
    const r = await fetch(`${SUPA_URL}/rest/v1/licenses?code=eq.${encodeURIComponent(code)}&select=*`, { headers: SH });
    const rows = await r.json();
    if (!r.ok || !rows.length) return res.status(400).json({ error: "Invalid license code" });
    const lic = rows[0];
    if (lic.used) return res.status(400).json({ error: "This license was already used" });
    const plan = lic.plan;
    console.log(`[REDEEM] plan="${plan}" by="${req.userRec.data.profile.username}"`);
    if (plan === "reset") {
      const pReset = req.userRec.data.profile;
      pReset.rank = "free"; pReset.rankExpire = null;
      await fetch(`${SUPA_URL}/rest/v1/licenses?code=eq.${encodeURIComponent(code)}`, {
        method: "PATCH", headers: { ...SH, Prefer: "return=minimal" },
        body: JSON.stringify({ used: true, used_by: pReset.username, used_at: Date.now() }),
      });
      writeUser(req.userRec.file, req.userRec.data);
      return res.json({ user: pub(pReset), reset: true });
    }
    if (!RANKS[plan] || plan === "free") return res.status(400).json({ error: "Bad license plan" });
    const p = req.userRec.data.profile;
    const addDays = RANKS[plan].days || 30;
    const sameRankActive = (p.rank === plan && p.rankExpire && Date.now() < p.rankExpire);
    if (sameRankActive) p.rankExpire = p.rankExpire + addDays * 864e5;
    else { p.rank = plan; p.rankExpire = Date.now() + addDays * 864e5; }
    await fetch(`${SUPA_URL}/rest/v1/licenses?code=eq.${encodeURIComponent(code)}`, {
      method: "PATCH", headers: { ...SH, Prefer: "return=minimal" },
      body: JSON.stringify({ used: true, used_by: p.username, used_at: Date.now() }),
    });
    writeUser(req.userRec.file, req.userRec.data);
    const daysLeft = Math.max(0, Math.ceil((p.rankExpire - Date.now()) / 864e5));
    res.json({ user: pub(p), addedDays: addDays, daysLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/config", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ aiName: CONFIG.aiName, company: CONFIG.company, tagline: CONFIG.tagline, welcome: CONFIG.welcome, rules: CONFIG.rules,
    identity: CONFIG.identity || {},
    discordInvite: CONFIG.discordInvite || "" });
});

/* ═══ ⭐ ระบบโมเดลหลายผู้ให้บริการ: Groq / Gemini / Cerebras / Mistral / OpenRouter / Pollinations ═══ */
let modelsCache = { t: 0, models: [] };   /* models = [{ m, k, base, vision }] */
const blacklist = {};
const BLACKLIST_MS = 15 * 60 * 1000;
let lastGoodNormal = "", lastGoodVision = "", lastGoodSmart = "";
const EMERGENCY = [
  { m: "deepseek/deepseek-chat-v3.1:free", k: "", base: "https://openrouter.ai/api/v1/chat/completions" },
  { m: "z-ai/glm-4.5-air:free", k: "", base: "https://openrouter.ai/api/v1/chat/completions" },
  { m: "openai", k: "", base: "https://text.pollinations.ai/openai" },
];

let pCache = { t: 0, ids: [], visionIds: [] };
async function pollinationsModels() {
  if (pCache.ids.length && Date.now() - pCache.t < 5 * 60 * 1000) return pCache;
  try {
    const r = await fetch("https://text.pollinations.ai/models");
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.models || data.data || []);
    const ids = [], visionIds = [];
    for (const m of list) {
      const id = typeof m === "string" ? m : (m.name || m.id || m.model);
      if (!id || /embed|whisper|tts|audio|rerank|image|flux/i.test(id)) continue;
      ids.push(id);
      const vision = Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : /openai|gemini/i.test(id);
      if (vision) visionIds.push(id);
    }
    pCache = { t: Date.now(), ids, visionIds };
    console.log(`[AI] Pollinations: ${ids.length} (vision ${visionIds.length})`);
  } catch (e) { console.error("[AI] Pollinations list failed:", e.message); }
  return pCache;
}

/* แยก key ตามผู้ให้บริการ */
function splitKeys() {
  const raw = (CONFIG.apiKey || process.env.AI_API_KEY || "").split(",").map(s => s.trim()).filter(Boolean);
  const out = { groq: [], gemini: [], openrouter: [], anthropic: [], mistral: [], cerebras: [] };
  for (const k of raw) {
    if (k.startsWith("gsk_")) out.groq.push(k);
    else if (k.startsWith("AIza")) out.gemini.push(k);
    else if (k.startsWith("sk-or-")) out.openrouter.push(k);
    else if (k.startsWith("sk-ant-")) out.anthropic.push(k);
    else if (k.startsWith("csk-")) out.cerebras.push(k);
    else if (k.length > 40) out.mistral.push(k);
  }
  return out;
}

/* รวมโมเดลจากทุกผู้ให้บริการ */
async function allModels() {
  if (modelsCache.models.length && Date.now() - modelsCache.t < 10 * 60 * 1000) return modelsCache.models;
  const keys = splitKeys();
  let models = [];

  /* Groq */
  for (const k of keys.groq) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: "Bearer " + k } });
      const d = await r.json();
      let count = 0;
      for (const m of (d.data || [])) {
        if (/whisper|tts|guard|embed/i.test(m.id)) continue;
        models.push({ m: m.id, k, base: "https://api.groq.com/openai/v1/chat/completions", vision: /scout|maverick|vision/i.test(m.id) });
        count++;
      }
      console.log(`[AI] Groq: ${count} models`);
    } catch (e) { console.error("[AI] Groq list failed:", e.message); }
  }

  /* Gemini */
  for (const k of keys.gemini) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + k);
      const d = await r.json();
      let count = 0;
      for (const m of (d.models || [])) {
        if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
        const id = m.name.replace("models/", "");
        if (/embedding|aqa|imagen|veo|tts|live/i.test(id)) continue;
        models.push({ m: id, k, base: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", vision: /gemini|flash|pro/i.test(id) });
        count++;
      }
      console.log(`[AI] Gemini: ${count} models`);
    } catch (e) { console.error("[AI] Gemini list failed:", e.message); }
  }

  /* Cerebras */
  for (const k of keys.cerebras) {
    try {
      const r = await fetch("https://api.cerebras.ai/v1/models", { headers: { Authorization: "Bearer " + k } });
      const d = await r.json();
      let count = 0;
      for (const m of (d.data || [])) {
        models.push({ m: m.id, k, base: "https://api.cerebras.ai/v1/chat/completions", vision: false });
        count++;
      }
      console.log(`[AI] Cerebras: ${count} models`);
    } catch (e) { console.error("[AI] Cerebras failed:", e.message); }
  }

  /* Mistral */
  for (const k of keys.mistral) {
    try {
      const r = await fetch("https://api.mistral.ai/v1/models", { headers: { Authorization: "Bearer " + k } });
      const d = await r.json();
      let count = 0;
      for (const m of (d.data || [])) {
        if (/embed|moderation/i.test(m.id)) continue;
        models.push({ m: m.id, k, base: "https://api.mistral.ai/v1/chat/completions", vision: /vision/i.test(m.id) });
        count++;
      }
      console.log(`[AI] Mistral: ${count} models`);
    } catch (e) { console.error("[AI] Mistral failed:", e.message); }
  }

  /* OpenRouter (free) */
  for (const k of keys.openrouter) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      const data = await r.json();
      const free = (data.data || []).filter(m => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0
        && (m.architecture?.output_modalities || ["text"]).includes("text"));
      const allow = new RegExp((CONFIG.allowedModels || []).join("|"), "i");
      let picked = free.filter(m => allow.test(m.id));
      if (!picked.length) picked = free;
      let count = 0;
      for (const m of picked) {
        models.push({ m: m.id, k, base: "https://openrouter.ai/api/v1/chat/completions", vision: (m.architecture?.input_modalities || []).includes("image") });
        count++;
      }
      console.log(`[AI] OpenRouter free: ${count} models`);
    } catch (e) { console.error("[AI] OpenRouter failed:", e.message); }
  }

  /* Pollinations (โหมดไม่มี key ก็มี) */
  try {
    const polli = await pollinationsModels();
    for (const id of (polli.ids || [])) {
      models.push({ m: id, k: "", base: "https://text.pollinations.ai/openai", vision: (polli.visionIds || []).includes(id) });
    }
  } catch {}

  /* เอาซ้ำออก */
  const seen = new Set();
  models = models.filter(x => !seen.has(x.m + x.base) && seen.add(x.m + x.base));

  modelsCache = { t: Date.now(), models };
  console.log(`[AI] TOTAL models: ${models.length}`);
  return models;
}

const alive = (x) => !(blacklist[x.m + x.base] && blacklist[x.m + x.base] > Date.now());
const ban = (x) => { blacklist[x.m + x.base] = Date.now() + BLACKLIST_MS; };

function detectBase(model, key) {
  if (CONFIG.apiBase) return CONFIG.apiBase;
  if (!key) return "https://text.pollinations.ai/openai";
  if (key.startsWith("sk-or-"))  return "https://openrouter.ai/api/v1/chat/completions";
  if (key.startsWith("gsk_"))    return "https://api.groq.com/openai/v1/chat/completions";
  if (key.startsWith("AIza"))    return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  if (key.startsWith("csk-"))    return "https://api.cerebras.ai/v1/chat/completions";
  if (key.startsWith("sk-ant-")) return "https://api.anthropic.com/v1/chat/completions";
  if (String(model).includes("/")) return "https://openrouter.ai/api/v1/chat/completions";
  return "https://text.pollinations.ai/openai";
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function tryModel(cand, messages, maxTokens, budgetMs) {
  const headers = { "Content-Type": "application/json" };
  if (cand.k) headers.Authorization = "Bearer " + cand.k;
  let r;
  try {
    r = await fetch(cand.base, { method: "POST", headers, body: JSON.stringify({ model: cand.m, messages, stream: true, max_tokens: maxTokens }) });
  } catch (e) { return { status: 502, err: e.message }; }
  if (!r.ok) return { status: r.status, err: (await r.text()).slice(0, 200) };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let first = "";
  try {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const { done, value } = await withTimeout(reader.read(), 4000);
      if (done) break;
      first += dec.decode(value, { stream: true });
      if (/"(content|reasoning|reasoning_content)"\s*:\s*"[^"]+/s.test(first)) return { body: r.body, reader, firstStr: first };
    }
  } catch {}
  try { await reader.cancel(); } catch {}
  return { status: 502, err: "empty or stalled (over budget)" };
}
function classify(text) {
  const t = text || "";
  if (/```|function\s|class\s|def\s|const\s|import\s|console\.|print\(|npm\s|pip\s|error|bug|debug|โค้ด|code|สคริปต์|โปรแกรม|แก้บั๊ก|เขียนเว็บ|react|python|javascript/i.test(t)) return "code";
  if (/\d+\s*[\+\-\*\/\^%]\s*\d+|solve|equation|โจทย์|คำนวณ|เปอร์เซ็นต์|สมการ/i.test(t)) return "math";
  return "chat";
}
function routePool(list, kind) {
  const pick = {
    code: (x) => /deepseek|coder|codestral|qwen/i.test(x.m),
    math: (x) => /r1|reason|think|pro/i.test(x.m),
    chat: (x) => /instant|8b|flash|fast|mini|small/i.test(x.m),
  }[kind];
  if (!pick || !list.length) return list;
  return [...list.filter(pick), ...list.filter(x => !pick(x))];
}

/* ⭐ ปั๊มสตรีมจากผู้ชนะไปหาผู้ใช้ */
async function pipeWinner(reader, firstStr, res) {
  try {
    res.write(typeof firstStr === "string" ? firstStr : "");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    res.end();
  } catch (e) {
    console.error("[AI] stream pipe error:", e.message);
    try { res.end(); } catch {}
  }
}

app.post("/api/chat", async (req, res) => {
  let lastErr = "no model available", lastStatus = 502;
  try {
    if (!req.userRec) return res.status(401).json({ error: "auth" });

    const rec = req.userRec, p = rec.data.profile;
    const rank = rankOf(p), limit = RANKS[rank].daily;
    const isUnlimited = !!RANKS[rank].unlimited;
    const today = new Date().toDateString();
    if (!rec.data.usage || rec.data.usage.day !== today) rec.data.usage = { day: today, count: 0 };
    if (!isUnlimited && rec.data.usage.count >= limit) {
      const t = new Date(); t.setHours(24, 0, 0, 0);
      return res.status(429).json({ error: `Daily limit reached (${limit}/${limit}) — resets at midnight`, resetAt: t.getTime() });
    }
    rec.data.usage.count++;
    writeUser(rec.file, rec.data);

    const { messages, thinking, webSearch: wantWeb } = req.body || {};
    const needVision = JSON.stringify(messages || []).includes("image_url");
    const maxTokens = Number(CONFIG.maxTokens) || 8000;

    const budget = thinking ? (Number(CONFIG.thinkingBudget) || 10000) : 7000;

    let searchBlock = "";
    if (wantWeb) {
      const lastUserQ = [...(messages || [])].reverse().find(m => m.role === "user");
      const q = typeof lastUserQ?.content === "string" ? lastUserQ.content : (lastUserQ?.content?.[0]?.text || "");
      console.log(`[WEB] searching: ${q.slice(0, 60)}`);
      const { results, snippets } = await webSearch(q);
      if (snippets.length) {
        searchBlock = "\n\n[ผลการค้นหาจากอินเทอร์เน็ต ณ วันนี้ — ใช้อ้างอิงและระบุแหล่งที่มา]\n" + snippets.join("\n\n");
        console.log(`[WEB] got ${results.length} results, ${snippets.length} pages read`);
      }
    }

    const lastUser = [...(messages || [])].reverse().find(m => m.role === "user");
    const lastText = typeof lastUser?.content === "string" ? lastUser.content : lastUser?.content?.[0]?.text || "";
    const kind = classify(lastText);

    /* ⭐ รวมโมเดลทุกผู้ให้บริการ (Groq/Gemini/Cerebras/Mistral/OpenRouter/Pollinations) */
    const allM = await allModels();
    let pool = allM.filter(alive);
    if (needVision) {
      const vp = pool.filter(x => x.vision);
      if (vp.length) pool = vp;
    }

    let tryList = [];
    if (thinking) {
      pool.filter(x => /r1|reason|think|pro/i.test(x.m)).forEach(x => tryList.push(x));
      pool.forEach(x => tryList.push(x));
    } else {
      if (lastGoodNormal) {
        const lg = pool.find(x => x.m === lastGoodNormal);
        if (lg) tryList.push(lg);
      }
      tryList.push(...routePool(pool, kind));
    }

    const seen = new Set();
    tryList = tryList.filter(x => !seen.has(x.m + x.base) && seen.add(x.m + x.base)).slice(0, 10);
    if (!tryList.length) tryList.push(EMERGENCY[2]);

    console.log(`[Router] ${kind}${needVision ? "+vision" : ""}${thinking ? "+think" : ""}${wantWeb ? "+web" : ""} [${rank}] RACE(3): ${tryList.slice(0, 3).map(x => x.m).join(" | ")}`);

    const msgsForAI = searchBlock ? JSON.parse(JSON.stringify(messages)) : messages;
    if (searchBlock) {
      const lastU = msgsForAI[msgsForAI.length - 1];
      if (lastU?.role === "user") {
        if (typeof lastU.content === "string") lastU.content += "\n\n" + searchBlock;
        else if (Array.isArray(lastU.content) && lastU.content[0]) lastU.content[0].text += "\n\n" + searchBlock;
      }
    }

    let winner = null, firstResult = null;
    await Promise.any(tryList.slice(0, 3).map(x =>
      tryModel(x, msgsForAI, maxTokens, budget).then(t => {
        if (t.body) {
          if (!firstResult) { firstResult = t; winner = x; }
          return;
        }
        throw new Error(t.err || "fail");
      })
    )).catch(() => {});

    if (firstResult) {
      console.log(`[AI] WIN → ${winner.m} (${winner.base.split("/")[2]})`);
      if (thinking) lastGoodSmart = winner.m;
      else if (needVision) lastGoodVision = winner.m;
      else lastGoodNormal = winner.m;
      try {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        pipeWinner(firstResult.reader, firstResult.firstStr, res);
      } catch (streamErr) {
        console.error("[AI] stream error:", streamErr.message);
      }
      return;
    }

    for (const x of tryList.slice(3)) {
      const t = await tryModel(x, msgsForAI, maxTokens, budget);
      if (t.body) {
        console.log(`[AI] OK → ${x.m}${x.k ? "" : " (free)"}`);
        if (thinking) lastGoodSmart = x.m; else if (needVision) lastGoodVision = x.m; else lastGoodNormal = x.m;
        try {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
          pipeWinner(t.reader, t.firstStr, res);
        } catch (streamErr) {
          console.error("[AI] stream error:", streamErr.message);
        }
        return;
      }
      lastStatus = t.status; lastErr = t.err;
      console.error(`[AI] ${x.m} → ${t.status}: ${String(t.err).slice(0, 100)} — blacklisted 15min`);
      ban(x);
      if (t.status === 401 && x.k) break;
    }
    if (!res.headersSent) res.status(lastStatus).json({ error: lastErr + `  [tried: ${tryList.slice(0, 3).map(x => x.m).join(", ")}...]` });
  } catch (e) {
    console.error("[CHAT] error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("──────────────────────────────────────");
  console.log(`Circuit by Bytelater → http://localhost:${PORT}`);
  console.log(`Ranks: ${Object.entries(RANKS).map(([k, v]) => `${v.name}=${v.unlimited ? "UNLIMITED" : v.daily + "/day"}(${v.days}d)`).join(", ")}`);
  console.log(`Supabase: ${SUPA_URL ? "connected" : "NOT configured"}`);
  console.log(`AI providers: ${(CONFIG.apiKey || process.env.AI_API_KEY || "").split(",").filter(k => k.trim()).length}`);
  console.log("──────────────────────────────────────");
});
