const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const TIER_LIMITS = { Platinum: 6, Diamond: 8, Gold: 12, Silver: 20, Bronze: 30 };
const TIERS = ['Platinum', 'Diamond', 'Gold', 'Silver', 'Bronze'];
const ADMIN_KEY = process.env.ADMIN_KEY || '747admin';

const DATA_FILE = path.join(__dirname, 'data.json');

const seed = [
  { name: 'DIAMOND', accountId: 'U18e7b68e0a22722f4c14df2a09ad995c', company: 'VPG', tier: 'Diamond' },
  { name: 'PLATINUM', accountId: 'Ue3fff8ae76c8f1f32a21087b3ca95730', company: 'VPG', tier: 'Platinum' },
  { name: 'Support Gold V.10', accountId: 'U343bc9bfa2213789633895c99c1281ab', company: 'VPG', tier: 'Gold' },
  { name: 'NewGd v1', accountId: 'U254b6bb2f9a1f048fb7185a2367eec1f', company: 'VPG', tier: 'Gold' },
  { name: 'SILVER V.6', accountId: 'Uc9575d79b0768a815b5ecb56c654925d', company: 'VPG', tier: 'Silver' },
  { name: 'NewSv v1', accountId: 'U83ab5592e06648d14704a85d4b4c1db7', company: 'VPG', tier: 'Silver' },
  { name: 'Bronze', accountId: 'Uc59f042fb386b87d322cfc08779fb35b', company: 'VPG', tier: 'Bronze' },
  { name: 'NewBz v1', accountId: 'Udb53140fc95862176b4b998cb14afcc9', company: 'VPG', tier: 'Bronze' },
];

function loadConfig() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.accounts)) return data.accounts;
  } catch (e) {
    /* first run */
  }
  return seed.map((a) => ({ ...a }));
}

let configAccounts = loadConfig();

function saveConfig() {
  try {
    const body = { accounts: configAccounts.map((a) => ({ accountId: a.accountId, name: a.name, company: a.company, tier: a.tier })) };
    fs.writeFileSync(DATA_FILE, JSON.stringify(body, null, 2), 'utf8');
  } catch (e) {
    console.warn('cannot save data.json:', e.message);
  }
}

let KNOWN = new Set();

function rebuildKnown() {
  KNOWN = new Set([
    ...configAccounts.map((a) => a.name),
    ...configAccounts.map((a) => String(a.accountId || '').trim()).filter(Boolean),
  ]);
}

const accounts = configAccounts.map((a, i) => ({
  id: a.accountId || String(i + 1),
  accountId: a.accountId || '',
  name: a.name,
  company: a.company || 'Unassigned',
  tier: TIERS.includes(a.tier) ? a.tier : 'Silver',
  unread: 0,
  limit: TIER_LIMITS[a.tier] || 20,
  source: 'seed',
  updatedAt: Date.now(),
}));

rebuildKnown();

function snapshot() {
  return {
    updatedAt: Date.now(),
    accounts: accounts.map((a) => ({ ...a })),
  };
}

function broadcast() {
  io.emit('update', snapshot());
}

function applyPayload(payload) {
  const body = payload || {};
  const reqName = String(body.name || '').trim();
  const reqId = String(body.accountId || '').trim();
  const name = reqName;

  // รับเฉพาะบัญชีที่ admin ตั้งไว้ (match ด้วย accountId หรือชื่อ)
  if (!KNOWN.has(reqId) && !KNOWN.has(name)) return null;

  let acc = accounts.find((a) => a.accountId === reqId) ||
            accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!acc) return null;

  if (body.company && String(body.company).trim()) {
    acc.company = String(body.company).trim();
  }
  if (body.tier && TIERS.includes(String(body.tier).trim())) {
    const tier = String(body.tier).trim();
    acc.tier = tier;
    acc.limit = body.limit || TIER_LIMITS[tier] || 20;
  }

  const unread = parseInt(body.unread, 10);
  if (Number.isFinite(unread) && unread >= 0) {
    acc.unread = unread;
  }
  const limit = parseInt(body.limit, 10);
  if (Number.isFinite(limit) && limit >= 1) {
    acc.limit = limit;
  }

  acc.source = body.source || 'bridge';
  acc.updatedAt = Date.now();
  return acc;
}

app.post('/api/update-count', (req, res) => {
  const acc = applyPayload(req.body);
  if (!acc) {
    return res.status(400).json({ ok: false, error: 'unknown account' });
  }
  broadcast();
  res.json({ ok: true, account: { name: acc.name, unread: acc.unread } });
});

app.get('/api/state', (req, res) => {
  res.json(snapshot());
});

// config สำหรับ extension: map accountId -> { name, company, tier }
app.get('/api/config', (req, res) => {
  res.json({
    bridgeUrl: `${req.protocol}://${req.get('host')}`,
    accounts: configAccounts.map((a) => ({ accountId: a.accountId, name: a.name, company: a.company, tier: a.tier })),
  });
});

/* ---------- admin ---------- */
function requireAdmin(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '');
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'admin key ไม่ถูกต้อง' });
  }
  next();
}

app.post('/api/admin/auth', (req, res) => {
  const key = String((req.body && req.body.key) || '');
  res.json({ ok: key === ADMIN_KEY });
});

app.get('/api/admin/list', requireAdmin, (req, res) => {
  res.json({ accounts: snapshot().accounts });
});

app.post('/api/admin/add', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const accountId = String((req.body && req.body.accountId) || '').trim();
  let tier = String((req.body && req.body.tier) || 'Silver').trim();
  const company = String((req.body && req.body.company) || 'VPG').trim() || 'VPG';

  if (!name) return res.status(400).json({ ok: false, error: 'ต้องใส่ชื่อไลน์' });
  if (!accountId) return res.status(400).json({ ok: false, error: 'ต้องใส่ accountId (จาก URL chat.line.biz/U...)' });
  if (!TIERS.includes(tier)) tier = 'Silver';
  if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ ok: false, error: 'ชื่อนี้มีอยู่แล้ว' });
  }
  if (accounts.some((a) => a.accountId === accountId)) {
    return res.status(400).json({ ok: false, error: 'accountId นี้มีอยู่แล้ว' });
  }

  const acc = {
    id: accountId,
    accountId,
    name,
    company,
    tier,
    unread: 0,
    limit: TIER_LIMITS[tier] || 20,
    source: 'seed',
    updatedAt: Date.now(),
  };
  accounts.push(acc);
  configAccounts.push({ accountId, name, company, tier });
  rebuildKnown();
  saveConfig();
  broadcast();
  res.json({ ok: true, account: { name, tier } });
});

app.delete('/api/admin/remove/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name).trim();
  const idx = accounts.findIndex((a) => a.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return res.status(404).json({ ok: false, error: 'ไม่พบบัญชี' });
  accounts.splice(idx, 1);
  configAccounts = configAccounts.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
  rebuildKnown();
  saveConfig();
  broadcast();
  res.json({ ok: true });
});

let sim = null;
app.post('/api/sim/toggle', (req, res) => {
  if (sim) {
    clearInterval(sim);
    sim = null;
    return res.json({ running: false });
  }
  if (!accounts.length) return res.json({ running: false });
  sim = setInterval(() => {
    const acc = accounts[Math.floor(Math.random() * accounts.length)];
    const delta = Math.random() < 0.5 ? 1 : -1;
    acc.unread = Math.max(0, acc.unread + delta);
    if (Math.random() < 0.08) acc.unread = Math.min(40, acc.unread + 2);
    acc.updatedAt = Date.now();
    broadcast();
  }, 1800);
  res.json({ running: true });
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'frontend')));

io.on('connection', (socket) => {
  socket.emit('init', snapshot());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MONITOR 747 online -> http://localhost:${PORT}`);
});