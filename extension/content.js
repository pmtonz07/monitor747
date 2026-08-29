// MONITOR 747 · LINE OA bridge
// ดึงรายชื่อบัญชี + backend URL จาก server (ตั้งในหน้า /admin หรือ popup ของ extension)
// แต่ละบัญชีระบุด้วย accountId ที่อยู่ใน URL: https://chat.line.biz/U.../<

const DEFAULT_BRIDGE = 'http://localhost:3000';

let BRIDGE_URL = DEFAULT_BRIDGE;
let ACCOUNTS = {}; // accountId -> { name, company, tier }
let lastTotal = null;
let lastValues = [];
let currentTotal = 0;
let scanTimer = null;
let pendingValue = null;

// selector ที่เข้ากันได้กับ badge ฝั่ง chat.line.biz ทุกรูปแบบที่พอจะเดาได้
const UNREAD_SELECTORS = [
  '[class*="badge" i]',
  '[class*="unread" i]',
  '[class*="count" i]',
  '[class*="counter" i]',
  '[class*="notif" i]',
  '[class*="alert" i]',
  '[class*="msg-num" i]',
];

try {
  chrome.storage.sync.get('m747Bridge', (res) => {
    if (res && res.m747Bridge) BRIDGE_URL = String(res.m747Bridge).replace(/\/$/, '');
    fetchConfig();
  });
} catch (e) {
  fetchConfig();
}

function fetchConfig() {
  fetch(`${BRIDGE_URL}/api/config`)
    .then((r) => r.json())
    .then((data) => {
      if (data && Array.isArray(data.accounts)) {
        ACCOUNTS = {};
        for (const a of data.accounts) {
          if (a.accountId) ACCOUNTS[a.accountId] = { name: a.name, company: a.company, tier: a.tier };
        }
        console.log('[MONITOR747] config loaded:', Object.keys(ACCOUNTS).length, 'accounts');
        scanNow();
      }
      setTimeout(fetchConfig, 60000); // refresh config ปกติ 60 วิ
    })
    .catch((err) => {
      console.warn('[MONITOR747] cannot reach backend', BRIDGE_URL, err.message, '- retry 10s');
      setTimeout(fetchConfig, 10000); // backend หลับ/ค้าง → ลองใหม่ไวๆ
    });
}

// refresh config ทุก 60 วิ (admin เพิ่ม/ลบไลน์ได้โดยไม่ต้อง reload extension)
fetchConfig();

function accountIdFromUrl() {
  const m = location.pathname.match(/^\/([A-Za-z0-9]+)\//);
  return m ? m[1] : null;
}

function currentAccount() {
  const id = accountIdFromUrl();
  if (id && ACCOUNTS[id]) {
    return { configured: true, name: ACCOUNTS[id].name, company: ACCOUNTS[id].company, tier: ACCOUNTS[id].tier };
  }
  return { configured: false };
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return true;
}

function parseColor(str) {
  const m = String(str).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

function isRed(p) {
  if (!p || p.a < 0.06) return false;
  return p.r >= 160 && (p.r - p.g) >= 60 && (p.r - p.b) >= 60;
}

// badge จริงของ LINE = ป้ายแดงเล็กๆ เท่านั้น จับเฉพาะ red เพื่อไม่เก็บตัวเลขสีอื่นมั่ว
function badgeish(el, style) {
  const r = el.getBoundingClientRect();
  if (!r.width || r.height > 22 || r.width > 110) return false; // badge ต้องเล็ก
  if (isRed(parseColor(style.backgroundColor))) return true;
  if (isRed(parseColor(style.color))) return true;
  return false;
}

function parseValue(txt) {
  const m = (txt || '').trim().match(/^(\d{1,4})\s*\+?$/);
  return m ? parseInt(m[1], 10) : null;
}

function collectNumericCandidates() {
  const values = [];
  const seen = new Set();

  const consider = (el) => {
    if (el.children.length) return;
    const val = parseValue(el.textContent);
    if (val === null) return;
    const style = window.getComputedStyle(el);
    const fs = parseFloat(style.fontSize) || 0;
    if (fs < 9 || fs > 14) return;
    if (!isVisible(el)) return;
    if (!badgeish(el, style)) return;

    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (seen.has(p)) return;
      p = p.parentElement;
    }
    seen.add(el);
    values.push(val);
  };

  for (const selector of UNREAD_SELECTORS) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (e) {
      continue;
    }
    for (const el of nodes) consider(el);
  }

  if (values.length === 0) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const parent = node.parentElement;
      if (!parent || seen.has(parent)) continue;
      consider(parent);
    }
  }

  return values;
}

function sendUpdate() {
  const id = accountIdFromUrl();
  if (!id) return; // หน้าเพจยังไม่โหลด route ครบ (SPA) — เงียบๆ สแกนต่อไป
  const account = currentAccount();
  if (!account.configured || !account.name) {
    console.warn(
      '[MONITOR747] skip (no config for accountId ' + id + ')',
      '- add it via dashboard /admin'
    );
    fetchConfig(); // ดึง config ใหม่ทันที เผื่อเพิ่งเพิ่มทาง admin
    return;
  }
  const payload = {
    accountId: accountIdFromUrl(),
    name: account.name,
    company: account.company,
    tier: account.tier,
    unread: currentTotal,
    badges: lastValues,
    source: 'bridge',
  };

  fetch(`${BRIDGE_URL}/api/update-count`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.ok) {
        console.log('[MONITOR747] sent', payload.name, '->', payload.unread, '| badges:', payload.badges);
      } else {
        console.warn('[MONITOR747] backend rejects:', res.error);
      }
    })
    .catch((err) => {
      console.warn('[MONITOR747] cannot reach backend', BRIDGE_URL, err.message);
    });
}

function scanNow() {
  const values = collectNumericCandidates();
  currentTotal = values.reduce((s, v) => s + v, 0);
  lastValues = values;

  // ส่งเฉพาะเมื่อค่าคงที่ 2 จังหวะติดกัน (กันตัวเลขกระพริบตอน DOM กำลังเปลี่ยน)
  if (currentTotal === pendingValue) {
    if (lastTotal === null || currentTotal !== lastTotal) {
      sendUpdate();
    }
    lastTotal = currentTotal;
  }
  pendingValue = currentTotal;
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanNow, 450);
}

const observer = new MutationObserver((mutations) => {
  let meaningful = false;
  for (const m of mutations) {
    if (m.type === 'characterData' && m.target.nodeValue && /\d/.test(m.target.nodeValue)) {
      meaningful = true;
      break;
    }
    if (m.type === 'childList' && m.addedNodes.length) {
      meaningful = true;
      break;
    }
  }
  if (meaningful) scheduleScan();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

setInterval(() => {
  scanNow();
}, 20000);

console.log('[MONITOR747] bridge active on', location.href, '| backend:', BRIDGE_URL);