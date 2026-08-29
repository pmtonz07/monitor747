const input = document.getElementById('url');
const statusEl = document.getElementById('status');
const dashLink = document.getElementById('dash');
const saveBtn = document.getElementById('save');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

chrome.storage.sync.get('m747Bridge', (res) => {
  if (res && res.m747Bridge) {
    input.value = res.m747Bridge;
    dashLink.href = res.m747Bridge;
  }
});

input.addEventListener('input', () => {
  dashLink.href = input.value.trim().replace(/\/$/, '');
});

saveBtn.addEventListener('click', () => {
  const url = input.value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(url)) {
    setStatus('URL ต้องขึ้นต้นด้วย http:// หรือ https://', 'err');
    return;
  }
  fetch(url + '/api/state')
    .then((r) => r.json())
    .then((data) => {
      if (data && Array.isArray(data.accounts)) {
        chrome.storage.sync.set({ m747Bridge: url }, () => {
          setStatus('บันทึกแล้ว + ต่อได้ (' + data.accounts.length + ' บัญชี)', 'ok');
          dashLink.href = url;
        });
      } else {
        setStatus('ตอบกลับไม่ถูกต้อง', 'err');
      }
    })
    .catch(() => {
      setStatus('ต่อไม่ได้ - ตรวจ URL / backend รันไหม', 'err');
    });
});