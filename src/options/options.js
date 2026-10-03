// options.js — 设置页逻辑：读取、保存、校验、测试连接
// 响应解析与后台共用同一模块，避免两处逻辑漂移
import { parseMaybeStream, textFromParsed } from '../shared/llm-parse.js';

const DEFAULTS = {
  apiBase: '', apiKey: '', model: 'gpt-4o-mini', temperature: 0.4, maxTokens: 2000,
  obsidianBase: 'http://127.0.0.1:27123', obsidianKey: '', obsidianVault: '', noteDir: 'VideoNotes',
  attachDir: 'VideoNotes/attachments', byPlatform: true, fileNameRule: 'title',
  syncOverwrite: true, autoSync: false, imageFormat: 'image/jpeg', imageQuality: 0.75,
  imageMaxWidth: 720, imageDensity: 5, yamlFields: 'platform, source, url, duration, created',
  tags: 'video-note, AI', notePromptTemplate: '',
  requestTimeout: 240, retryTimes: 2, obsidianTimeout: 20, ensureDirs: false, subtitleMaxChars: 24000,
  chunkMode: true, chunkChars: 6000, maxChunks: 10,
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
  const base = s.apiBase.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  // 与后台 callLLM 保持一致：部分模型只认 max_completion_tokens、不认 temperature。
  // 探针也要给足 token——推理模型的思考过程会先消耗预算，给太小必然得到空正文。
  const variants = [
    { name: '标准参数', body: { model: s.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 2048, temperature: 0.4, stream: false } },
    { name: '兼容模式（max_completion_tokens）', body: { model: s.model, messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 2048, stream: false } },
  ];
  let lastErr = '';

  for (const v of variants) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    m.textContent = `正在测试连接（${v.name}）…`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify(v.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 200);
        try { const j = parseMaybeStream(text); detail = j?.error?.message || detail; } catch (_) {}
        lastErr = `HTTP ${res.status}：${detail}`;
        continue; // 换下一种参数写法再试
      }
      let data;
      try {
        data = parseMaybeStream(text);
      } catch (e) {
        // 解析失败时给出具体原因（如「零输出」「只有思考过程」），而不是笼统的"格式异常"
        lastErr = e.message;
        continue;
      }
      if (Array.isArray(data?.choices)) {
        if (textFromParsed(data).trim() || data.choices[0]?.finish_reason) {
          m.textContent = `✅ 连接成功（${v.name}）`; m.className = 'ok'; return;
        }
        lastErr = '连接成功但模型未返回正文（推理模型可能用满了 Token 预算，建议调大「最大输出 Token」）';
        continue;
      }
      lastErr = '响应中没有 choices 字段';
    } catch (e) {
      clearTimeout(timer);
      lastErr = (e && e.name === 'AbortError') ? '请求超时（30s 无响应）' : (e.message || String(e));
    }
  }
  m.textContent = '⚠️ 连接失败：' + lastErr + '（已尝试标准参数与兼容模式，请检查 Base URL / Key / 模型名）';
  m.className = 'err';
}

/* -------- Obsidian 连通性测试 -------- */
async function testObsidian() {
  const m = $('msg'); m.textContent = '正在测试 Obsidian 连接…'; m.className = '';
  const s = collect();
  if (!s.obsidianBase) { m.textContent = '请先填写 Obsidian 接口地址'; m.className = 'err'; return; }
  const base = s.obsidianBase.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3, s.obsidianTimeout || 20) * 1000);
  try {
    const res = await fetch(`${base}/`, {
      headers: { Authorization: `Bearer ${s.obsidianKey || ''}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) { m.textContent = `⚠️ 密钥错误（${res.status}）：请重新复制 Local REST API 的授权密钥`; m.className = 'err'; return; }
    if (!res.ok) { m.textContent = `⚠️ 接口返回 HTTP ${res.status}：请确认 Local REST API 插件已启用`; m.className = 'err'; return; }
    let vault = '';
    try { vault = (JSON.parse(await res.text())).vault || ''; } catch (_) {}
    m.textContent = `✅ 连接成功${vault ? '（Vault：' + vault + '）' : ''}`; m.className = 'ok';
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? '连接超时，请确认 Obsidian 已启动' : (e.message || String(e));
    m.textContent = '⚠️ 无法连接：' + msg; m.className = 'err';
  }
}

function reset() {
  chrome.storage.local.set(DEFAULTS, () => { load(); const m = $('msg'); m.textContent = '已恢复默认'; m.className = 'ok'; setTimeout(() => { m.textContent = ''; m.className = ''; }, 2000); });
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').onclick = save;
  $('test').onclick = testConnection;
  const to = $('testObsidian');
  if (to) to.onclick = testObsidian;
  $('reset').onclick = reset;
});
