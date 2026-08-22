// options.js — 设置页逻辑：读取、保存、校验、测试连接
const DEFAULTS = {
  apiBase: '', apiKey: '', model: 'gpt-4o-mini', temperature: 0.4, maxTokens: 2000,
  obsidianBase: 'http://127.0.0.1:27123', obsidianKey: '', obsidianVault: '', noteDir: 'VideoNotes',
  attachDir: 'VideoNotes/attachments', byPlatform: true, fileNameRule: 'title',
  syncOverwrite: true, autoSync: false, imageFormat: 'image/jpeg', imageQuality: 0.75,
  imageMaxWidth: 720, imageDensity: 5, yamlFields: 'platform, source, url, duration, created',
  tags: 'video-note, AI', notePromptTemplate: '',
};

const $ = (id) => document.getElementById(id);
const fields = Object.keys(DEFAULTS);

function load() {
  chrome.storage.local.get(fields, (s) => {
    for (const k of fields) {
      const v = s[k] === undefined ? DEFAULTS[k] : s[k];
      const el = $(k);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    }
  });
}

function collect() {
  const obj = {};
  for (const k of fields) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') obj[k] = el.checked;
    else if (el.type === 'number') obj[k] = Number(el.value);
    else obj[k] = el.value;
  }
  return obj;
}

function save() {
  chrome.storage.local.set(collect(), () => {
    const m = $('msg'); m.textContent = '✅ 设置已保存'; m.className = 'ok';
    setTimeout(() => { m.textContent = ''; m.className = ''; }, 2500);
  });
}

async function testConnection() {
  const m = $('msg'); m.textContent = '正在测试连接…'; m.className = '';
  const s = collect();
  if (!s.apiBase || !s.apiKey) { m.textContent = '请先填写 API Base URL 与 Key'; m.className = 'err'; return; }
  try {
    const res = await fetch(`${s.apiBase.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.choices) { m.textContent = '✅ 连接成功'; m.className = 'ok'; }
    else { m.textContent = '⚠️ 连接异常：' + (data.error?.message || ('HTTP ' + res.status)); m.className = 'err'; }
  } catch (e) {
    m.textContent = '⚠️ 连接失败：' + e.message; m.className = 'err';
  }
}

function reset() {
  chrome.storage.local.set(DEFAULTS, () => { load(); const m = $('msg'); m.textContent = '已恢复默认'; m.className = 'ok'; setTimeout(() => { m.textContent = ''; m.className = ''; }, 2000); });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').onclick = save;
  $('test').onclick = testConnection;
  $('reset').onclick = reset;
});
