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
let sourceMode = 'bridge';

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

// --- debug: เรียกจาก console ว่า __m747dbg() ---
window.__m747dbg = () => {
  const out = { path: location.pathname };
  const leafs = document.querySelectorAll('*');
  const labels = [];
  for (const el of leafs) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (t === 'แชท' || t === 'Chat') labels.push(el);
  }
  out.menuLabels = labels.length;
  if (labels.length) {
    let row = labels[0];
    out.levelHits = [];
    for (let i = 0; i < 6 && row; i++) {
      row = row.parentElement;
      if (!row) continue;
      const hits = [];
      for (const c of row.querySelectorAll('*')) {
        if (c.children.length) continue;
        const v = parseValue(c.textContent);
        if (v === null) continue;
        hits.push({ v, cls: (c.className || '').toString().slice(0, 40), fs: window.getComputedStyle(c).fontSize, bg: window.getComputedStyle(c).backgroundColor, color: window.getComputedStyle(c).color });
      }
      if (hits.length) out.levelHits.push({ level: i + 1, hits });
    }
  }
  const allNum = [];
  for (const el of leafs) {
    if (el.children.length) continue;
    const v = parseValue(el.textContent);
    if (v === null) continue;
    if (!isVisible(el)) continue;
    const st = window.getComputedStyle(el);
    const b = badgeish(el, st) ? 1 : 0;
    allNum.push({ v, b, fs: st.fontSize, bg: st.backgroundColor, text: (el.textContent || '').trim().slice(0, 12) });
  }
  out.redDigits = allNum.filter((x) => x.b);
  out.sample = allNum.slice(0, 40);
  console.log('[MONITOR747-DEBUG]', JSON.stringify(out));
};

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

// ตรวจว่า node นี้เป็น "ตัวเลข badge" (ตัวเองแดง หรือ row มันมี class badge/unread/notif)
function isBadgeText(el) {
  const v = parseValue(el.textContent);
  if (v === null) return false;
  const st = window.getComputedStyle(el);
  if (!isVisible(el)) return false;
  if (badgeish(el, st)) return true;
  let p = el.parentElement;
  for (let i = 0; i < 3 && p; i++) {
    const cl = (p.className || '').toString().toLowerCase();
    if (/badge|unread|count|notif|alert/.test(cl)) return true;
    if (badgeish(p, window.getComputedStyle(p))) return true;
    p = p.parentElement;
  }
  return false;
}

// ตัวเลขจากเมนู "แชท" (ป้ายซ้ายมือ) — ไล่หา badge ใกล้ป้ายโครงสร้าง
// /nav/div[1]/a/div — badge อยู่ sibling ใกล้ๆ ในแถวเดียวกัน
function menuChatUnread() {
  const leafs = document.querySelectorAll('*');
  let label = null;
  for (const el of leafs) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (t === 'แชท' || t === 'Chat') { label = el; break; }
  }
  if (!label) return null;

  let parent = label.parentElement;
  for (let i = 0; i < 6 && parent; i++) {
    const kids = Array.from(parent.children);
    const labelIdx = kids.indexOf(label);
    const cands = [];
    for (const c of parent.querySelectorAll('*')) {
      if (c.children.length) continue;
      const v = parseValue(c.textContent);
      if (v === null) continue;
      if (!isVisible(c)) continue;
      const fs = parseFloat(window.getComputedStyle(c).fontSize) || 0;
      // ระดับแคบรอบป้าย → ตัวเลขที่เห็นถือเป็น badge ได้เลย (ไม่มีเลขอื่นปนในแถว)
      // ระดับไกลขึ้น → ต้องผ่าน badgeish/isBadgeText
      const pass = i <= 1 ? fs >= 8 && fs <= 18 : isBadgeText(c);
      if (pass) cands.push({ c, v });
    }
    if (cands.length) {
      if (labelIdx >= 0) {
        const ranked = cands.map(({ c, v }) => {
          const ci = parent.children.length
            ? Array.from(parent.children).findIndex((x) => x.contains(c) || x === c)
            : -1;
          return { v, d: ci < 0 ? 999 : Math.abs(ci - labelIdx) };
        });
        ranked.sort((a, b) => a.d - b.d);
        return ranked[0].v;
      }
      return cands[0].v;
    }
    if (/^\s*\d+\s*\+?\s*$/.test(parent.textContent)) {
      return parseValue(parent.textContent);
    }
    label = parent;
    parent = parent.parentElement;
  }
  return 0; // มีเมนู แต่ไม่เห็นตัวเลข = ไม่มีแชทค้าง
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
    source: sourceMode,
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

function scanNow(force) {
  const menuV = menuChatUnread();
  const values = collectNumericCandidates();
  if (menuV === null) {
    currentTotal = values.reduce((s, v) => s + v, 0);
    sourceMode = 'bridge';
  } else {
    currentTotal = menuV; // ใช้ตัวเลขจากเมนู "แชท" เป็นหลัก
    sourceMode = 'menu';
  }
  lastValues = values;

  // ส่งเฉพาะเมื่อค่าคงที่ 2 จังหวะติดกัน (กันตัวเลขกระพริบตอน DOM กำลังเปลี่ยน)
  if (currentTotal === pendingValue) {
    if (lastTotal === null || currentTotal !== lastTotal) {
      sendUpdate();
    } else if (force) {
      sendUpdate(); // heartbeat: ส่งซ้ำค่าคงที่ ให้ board สดเสมอ
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
  scanNow(true);
}, 20000);

// กลับมาเปิดแท็บเมื่อไหร่ → ส่งค่าทันที กัน board ค้าง
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scanNow(true);
});

console.log('[MONITOR747] bridge active on', location.href, '| backend:', BRIDGE_URL);