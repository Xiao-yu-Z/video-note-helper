// =============================================================
// background.js — Video Note Helper 后台服务工作者 (Manifest V3)
// 职责：
//   1. 接收 content / popup 消息并路由
//   2. 调用用户自有大模型（OpenAI 兼容接口）生成图文笔记
//   3. 通过 Obsidian Local REST API 同步笔记与附件
//   4. 将笔记 + 截图打包为 ZIP 并下载导出
//   5. 本地历史记录读写
// 全程纯前端：所有请求从浏览器直接发出，无中转服务器。
// =============================================================

/* ------------------------- 配置默认值 ------------------------- */
const DEFAULTS = {
  // 大模型 API（OpenAI 兼容）
  apiBase: '',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  maxTokens: 2000,
  // Obsidian Local REST API
  obsidianBase: 'http://127.0.0.1:27123',
  obsidianKey: '',
  obsidianVault: '',
  noteDir: 'VideoNotes',
  attachDir: 'VideoNotes/attachments',
  byPlatform: true,
  fileNameRule: 'title', // title | title_date | date_title
  syncOverwrite: true,
  autoSync: false,
  // 配图
  imageFormat: 'image/jpeg',
  imageQuality: 0.75,
  imageMaxWidth: 720,
  // 笔记
  imageDensity: 5, // 期望配图数量
  notePromptTemplate: '',
  yamlFields: 'platform, source, url, duration, created',
  tags: 'video-note, AI',
};

/* ------------------------- 工具函数 ------------------------- */

// 读取合并后的设置
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// 安全的中文错误包装
function cnError(err, ctx) {
  const msg = (err && err.message) ? err.message : String(err);
  if (/401|key|unauthorized/i.test(msg)) return `【${ctx}】密钥错误（401）：请检查 API Key 是否正确。`;
  if (/403/i.test(msg)) return `【${ctx}】权限不足（403）：密钥或接口无调用权限。`;
  if (/429|quota|rate/i.test(msg)) return `【${ctx}】额度不足或被限流（429）：请检查账户余额或稍后重试。`;
  if (/timeout|abort/i.test(msg)) return `【${ctx}】请求超时：网络异常或模型响应过慢，请重试。`;
  if (/network|fetch|failed/i.test(msg)) {
    if (ctx === 'Obsidian') {
      return `【Obsidian】无法连接本地服务：请确认 ①Obsidian 已启动 ②已安装并启用「Local REST API」插件 ③地址/端口正确（默认 http://127.0.0.1:27123）。`;
    }
    return `【${ctx}】网络错误：无法连接接口，请检查 base_url 与网络。`;
  }
  return `【${ctx}】${msg}`;
}

// 调用大模型（OpenAI chat/completions 兼容）
async function callLLM(settings, userPrompt, systemPrompt) {
  if (!settings.apiBase || !settings.apiKey) {
    throw new Error('尚未配置大模型 API：请打开扩展设置填写 base_url、API Key 与模型名称。');
  }
  const base = settings.apiBase.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body = {
    model: settings.model,
    temperature: Number(settings.temperature) || 0.4,
    max_tokens: Number(settings.maxTokens) || 2000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(cnError(e, 'API'));
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) {}
    throw new Error(`【API】HTTP ${res.status}：${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const md = data?.choices?.[0]?.message?.content;
  if (!md) throw new Error('【API】响应格式异常：未找到 choices[0].message.content。');
  return md;
}

// dataURL -> Uint8Array
function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------------------- 极简 ZIP 打包（store 法） ---------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodeZip(files) {
  // files: [{ name, bytes: Uint8Array }]
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = (s) => new TextEncoder().encode(s);
  for (const f of files) {
    const nameBytes = enc(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);      // version needed
    dv.setUint16(6, 0, true);       // flags
    dv.setUint16(8, 0, true);       // method 0 = store
    dv.setUint16(10, 0, true);      // time
    dv.setUint16(12, 0, true);      // date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, f.bytes);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);      // version made by
    cv.setUint16(6, 20, true);      // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + f.bytes.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(end, p);
  return out;
}

// 将 Uint8Array 转为 base64（Service Worker 无 URL.createObjectURL，用于导出 ZIP）
function bytesToBase64(bytes) {
  const chunks = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

/* ---------------------- Obsidian Local REST API ---------------------- */
async function obsidianVaultName(settings) {
  const base = settings.obsidianBase.replace(/\/+$/, '');
  const res = await fetch(`${base}/`, {
    headers: { Authorization: `Bearer ${settings.obsidianKey}` },
  });
  if (!res.ok) throw new Error(`Obsidian 接口返回 HTTP ${res.status}（请确认 Local REST API 已开启且密钥正确）。`);
  try {
    const j = await res.json();
    return j.vault || '';
  } catch (_) { return ''; }
}

async function obsidianPutFile(settings, path, bytes, contentType) {
  const base = settings.obsidianBase.replace(/\/+$/, '');
  const safe = path.split('/').map((s) => encodeURIComponent(s)).join('/');
  const headers = {
    Authorization: `Bearer ${settings.obsidianKey}`,
    'Content-Type': contentType,
    'Overwrite-If-Exists': settings.syncOverwrite ? 'true' : 'false',
    'Create-If-DoesNotExist': 'true',
  };
  let res;
  try {
    res = await fetch(`${base}/vault/${safe}`, {
      method: 'PUT',
      headers,
      body: bytes,
    });
  } catch (e) {
    // 连接被拒 / 服务未运行：给出可操作的明确提示
    throw new Error(`【Obsidian】无法连接本地服务 ${base}：请确认 Obsidian 已启动、已启用「Local REST API」插件，且地址端口正确（默认 http://127.0.0.1:27123）。原始错误：${e.message || e}`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) {}
    if (res.status === 404) throw new Error('Obsidian 目录不存在：请先在库中创建对应目录（' + path + '）。');
    if (res.status === 401) throw new Error('Obsidian 密钥错误（401）：请在设置中填写正确的授权密钥。');
    throw new Error(`Obsidian 同步失败 HTTP ${res.status}：${detail.slice(0, 200)}`);
  }
  return true;
}

// 预先创建 Obsidian 目录（逐层创建，兼容 Local REST API 不能一次建多级目录的情况）
async function ensureDir(settings, dirPath) {
  const base = settings.obsidianBase.replace(/\/+$/, '');
  const parts = dirPath.split('/').filter(Boolean);
  const headers = {
    Authorization: `Bearer ${settings.obsidianKey}`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Create-If-DoesNotExist': 'true',
  };
  let ok = true;
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).map((s) => encodeURIComponent(s)).join('/') + '/';
    try {
      const res = await fetch(`${base}/vault/${sub}`, { method: 'PUT', headers, body: '' });
      ok = ok && (res.ok || res.status === 409 || res.status === 400);
    } catch (_) {
      ok = false;
      break;
    }
  }
  return ok;
}

// 计算 toPath 相对于 fromDir 的相对路径（用于 Obsidian 内部链接）
function getRelativePath(fromDir, toPath) {
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.length - i;
  const down = toParts.slice(i);
  const prefix = up === 0 ? './' : '../'.repeat(up);
  return prefix + down.join('/');
}

// 将笔记中的 frame_N.png 引用替换为 Obsidian 相对路径，并上传图片
async function syncToObsidian(settings, payload) {
  const { markdown, frames = [], title, platform } = payload || {};
  // 预检：地址与密钥
  if (!settings.obsidianBase) {
    throw new Error('尚未配置 Obsidian 地址：请在扩展设置填写 Local REST API 地址（默认 http://127.0.0.1:27123）。');
  }
  if (!settings.obsidianKey) {
    throw new Error('尚未配置 Obsidian 授权密钥：请打开 Obsidian → 设置 → Local REST API，复制 Authorization 密钥并粘贴到扩展设置对应栏。');
  }
  const vault = await obsidianVaultName(settings).catch(() => '');

  // 文件名规则（先算出来，用它作为笔记独立子目录名）
  const date = new Date().toISOString().slice(0, 10);
  let fileName;
  if (settings.fileNameRule === 'title_date') fileName = `${title}_${date}`;
  else if (settings.fileNameRule === 'date_title') fileName = `${date}_${title}`;
  else fileName = `${title}`;
  fileName = fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  // 目录规则：每篇笔记一个独立子目录，图片放在该目录的 attachments 下，避免多视频互相覆盖
  const noteRoot = settings.noteDir.replace(/^\/+|\/+$/g, '');
  const attachSubdir = settings.attachDir.replace(/^\/+|\/+$/g, '').split('/').pop() || 'attachments';
  const platformDir = settings.byPlatform ? platform : '';
  const noteDir = [noteRoot, platformDir, fileName].filter(Boolean).join('/');
  let attachDir = [noteDir, attachSubdir].filter(Boolean).join('/');

  // 确保目录存在；若附件目录创建失败，则降级为与笔记同目录，避免图片写丢
  await ensureDir(settings, noteDir);
  const attachDirOk = await ensureDir(settings, attachDir);
  if (!attachDirOk) attachDir = noteDir;

  // 上传图片附件
  const map = {};
  for (let i = 0; i < frames.length; i++) {
    const idx = i + 1;
    const ext = settings.imageFormat === 'image/png' ? 'png' : 'jpg';
    const name = `frame_${idx}.${ext}`;
    const bytes = dataUrlToBytes(frames[i].dataUrl);
    const imgFullPath = `${attachDir}/${name}`;
    await obsidianPutFile(settings, imgFullPath, bytes, settings.imageFormat);
    // 多别名映射：无论 LLM 写成 frame_N / frame_N.png / frame_N.jpg 都能命中
    // Obsidian 默认按相对当前 md 文件解析图片，因此写入相对 noteDir 的路径
    const real = getRelativePath(noteDir, imgFullPath);
    map[`frame_${idx}`] = real;
    map[`frame_${idx}.png`] = real;
    map[`frame_${idx}.jpg`] = real;
  }

  // 替换笔记中的图片引用为 Obsidian 相对路径（忽略扩展名差异）
  // 用两阶段替换避免别名前缀重叠：frame_1.png 中的 frame_1 被先替换会导致 frame_1.jpg.png
  let finalMd = markdown;
  for (let i = 0; i < frames.length; i++) {
    const idx = i + 1;
    const placeholder = `__VNH_IMG_${idx}__`;
    finalMd = finalMd
      .split(`frame_${idx}.png`).join(placeholder)
      .split(`frame_${idx}.jpg`).join(placeholder)
      .split(`frame_${idx}`).join(placeholder);
  }
  for (let i = 0; i < frames.length; i++) {
    const idx = i + 1;
    const placeholder = `__VNH_IMG_${idx}__`;
    const real = map[`frame_${idx}`];
    finalMd = finalMd.split(placeholder).join(real);
  }

  const notePath = `${noteDir}/${fileName}.md`;
  await obsidianPutFile(settings, notePath, new TextEncoder().encode(finalMd), 'text/plain; charset=utf-8');

  // 优先使用用户填写的库名；未填写时尝试从接口探测
  let vaultName = (settings.obsidianVault || '').trim();
  if (!vaultName) vaultName = await obsidianVaultName(settings).catch(() => '');
  const link = vaultName
    ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(notePath)}`
    : '';
  return { notePath, link };
}

/* ---------------------- 历史记录 ---------------------- */
async function saveHistory(record) {
  const list = (await chrome.storage.local.get('history')).history || [];
  list.unshift(record);
  await chrome.storage.local.set({ history: list.slice(0, 50) });
}
async function getHistory() {
  return (await chrome.storage.local.get('history')).history || [];
}

/* ---------------------- 消息路由 ---------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handle = async () => {
    switch (msg.action) {
      case 'getSettings':
        return await getSettings();

      case 'generateNote': {
        const s = await getSettings();
        const system = buildSystemPrompt(s, msg.payload);
        const user = buildUserPrompt(s, msg.payload);
        let markdown;
        try { markdown = await callLLM(s, user, system); } catch (e) { return { error: e.message }; }
        // 自动拼接规范元信息头 + 标题，保证每份笔记结构统一、美观
        const fm = buildFrontmatter(s, msg.payload);
        markdown = `${fm}\n\n# ${msg.payload.title}\n\n${markdown.trim()}\n`;
        const record = {
          id: Date.now(),
          platform: msg.payload.platform,
          title: msg.payload.title,
          url: msg.payload.url,
          created: new Date().toISOString(),
          markdown,
          frameCount: (msg.payload.frames || []).length,
        };
        await saveHistory(record);
        // 若开启自动同步
        let sync = null;
        if (s.autoSync) {
          try {
            sync = await syncToObsidian(s, {
              markdown,
              frames: msg.payload.frames || [],
              title: msg.payload.title,
              platform: msg.payload.platform,
            });
          } catch (e) { sync = { error: cnError(e, 'Obsidian') }; }
        }
        return { markdown, sync, recordId: record.id };
      }

      case 'syncObsidian': {
        const s = await getSettings();
        try {
          const r = await syncToObsidian(s, msg.payload);
          return r;
        } catch (e) {
          return { error: cnError(e, 'Obsidian') };
        }
      }

      case 'exportZip': {
        const s = await getSettings();
        const ext = s.imageFormat === 'image/png' ? 'png' : 'jpg';
        // 与同步一致：用别名映射替换 markdown 中的图片引用
        // 两阶段替换，避免 frame_1 / frame_1.png / frame_1.jpg 前缀重叠导致扩展名重复
        const count = (msg.payload.frames || []).length;
        let md = msg.payload.markdown;
        for (let i = 0; i < count; i++) {
          const idx = i + 1;
          const placeholder = `__VNH_IMG_${idx}__`;
          md = md
            .split(`frame_${idx}.png`).join(placeholder)
            .split(`frame_${idx}.jpg`).join(placeholder)
            .split(`frame_${idx}`).join(placeholder);
        }
        for (let i = 0; i < count; i++) {
          const idx = i + 1;
          md = md.split(`__VNH_IMG_${idx}__`).join(`frame_${idx}.${ext}`);
        }

        const files = [{ name: 'note.md', bytes: new TextEncoder().encode(md) }];
        for (let i = 0; i < (msg.payload.frames || []).length; i++) {
          const name = `frame_${i + 1}.${ext}`;
          files.push({ name, bytes: dataUrlToBytes(msg.payload.frames[i].dataUrl) });
        }
        const zip = encodeZip(files);
        // Service Worker 没有 DOM 的 URL.createObjectURL，改用 base64 data URL
        const url = `data:application/zip;base64,${bytesToBase64(zip)}`;
        const safe = (msg.payload.title || 'video-note').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
        await chrome.downloads.download({ url, filename: `video-note-${safe}.zip`, saveAs: true });
        return { ok: true };
      }

      case 'saveHistory':
        await saveHistory(msg.payload);
        return { ok: true };

      case 'captureTab': {
        // 当 video 元素跨域导致 canvas 被污染时的兜底方案：
        // 截取当前可见标签页（播放器画面）作为实时帧，不读取视频源文件。
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
        return { dataUrl };
      }

      case 'proxyFetch': {
        // 后台代发跨域请求（绕过 content script 的 CORS 限制）。
        // 仅用于抓取页面公开字幕，不读取视频源文件。
        const { url, method = 'GET', headers = {}, body } = msg.payload || {};
        try {
          const res = await fetch(url, { method, headers, body });
          const text = await res.text();
          return { status: res.status, text };
        } catch (e) {
          return { status: 0, error: `【代理请求】无法访问 ${url}：${(e && e.message) || e}` };
        }
      }

      case 'getHistory':
        return { history: await getHistory() };

      case 'deleteHistory':
        await chrome.storage.local.set({ history: [] });
        return { ok: true };

      default:
        return { error: '未知操作：' + msg.action };
    }
  };

  handle().then((r) => sendResponse(r)).catch((e) => {
    const msg = (e && e.message) ? e.message : String(e);
    sendResponse({ error: /^【/.test(msg) ? msg : cnError(e, '后台') });
  });
  return true; // 保持异步通道
});

/* ---------------------- 提示词构造 ---------------------- */
// 根据设置中的 yamlFields 与真实数据，生成规范的 YAML 元信息头
function buildFrontmatter(settings, payload) {
  const fields = (settings.yamlFields || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const tags = (settings.tags || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const known = {
    platform: payload.platform,
    source: payload.url,
    url: payload.url,
    title: payload.title,
    duration: payload.duration || '未知',
    created: new Date().toISOString(),
  };
  const lines = ['---'];
  for (const f of fields) {
    if (f === 'tags') {
      if (tags.length) lines.push(`tags: [${tags.map((t) => `"${t}"`).join(', ')}]`);
      continue;
    }
    let v = known[f];
    if (v === undefined) v = '';
    if (typeof v === 'string' && /[:#\-\[\]]/.test(v)) v = `"${v.replace(/"/g, '\\"')}"`;
    lines.push(`${f}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function buildSystemPrompt(settings, payload) {
  if (settings.notePromptTemplate && settings.notePromptTemplate.trim()) {
    return settings.notePromptTemplate.trim();
  }
  return [
    '你是一名专业的知识笔记整理助手。请基于给定的视频标题、来源平台与字幕内容，',
    '生成一篇结构清晰、排版美观、适合放入 Obsidian 的图文 Markdown 笔记。',
    '要求：',
    '1. 不要输出 YAML 元信息头与一级标题（# 标题），系统会自动添加。',
    '2. 用二级/三级标题（## / ###）合理划分章节，每章先给一句话要点，再用列表展开关键内容，语言精炼。',
    '3. 在合适的章节插入配图引用，格式为 ![配图说明](frame_N.png)，N 从 1 开始与提供的截图顺序对应；',
    '   全篇配图控制在 3-6 张，图片要与相邻知识点强相关，不要堆砌。',
    '4. 对字幕中的关键概念可适当展开解释，保持原创整理而非照搬字幕。',
    '5. 可用表格对比要点；可用 Obsidian Callout 语法（如 > [!tip] / > [!note] / > [!abstract]）突出重点。',
    '6. 末尾用 > [!summary] Callout 给出 3 条要点回顾（Key Takeaways）。',
    '仅输出 Markdown 正文，不要使用代码块包裹。',
  ].join('\n');
}

function buildUserPrompt(settings, payload) {
  const sub = (payload.subtitles || []).map((x) => `[${x.time}] ${x.text}`).join('\n');
  const frameLines = (payload.frames || []).map((f, i) =>
    `frame_${i + 1}.png —— 对应播放时间点 ${f.time}`).join('\n');
  return [
    `视频标题：${payload.title}`,
    `来源平台：${payload.platform}`,
    `原链接：${payload.url}`,
    `总时长：${payload.duration || '未知'}`,
    `期望配图数量：${settings.imageDensity || 5}`,
    '',
    '截图与时间点对应关系（请在相关章节用 ![配图说明](frame_N.png) 引用）：',
    frameLines || '（无截图）',
    '',
    '字幕全文：',
    sub || '（无字幕）',
  ].join('\n');
}

console.log('[Video Note Helper] background service worker loaded.');
