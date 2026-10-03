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

// 响应解析与 options 页共用同一实现，避免两处逻辑漂移
import { parseMaybeStream, textFromParsed } from './shared/llm-parse.js';
import { splitSubtitleChunks, assignFramesToChunks, timeToSec } from './shared/chunk.js';

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
  // 网络健壮性
  requestTimeout: 240,   // 大模型请求超时（秒）
  retryTimes: 2,        // 失败自动重试次数
  obsidianTimeout: 20,  // Obsidian 单次请求超时（秒）
  ensureDirs: false,    // 写文件前预建目录（Local REST API 一般会自动建，默认关闭以提速）
  subtitleMaxChars: 24000, // 送入模型的字幕字符上限（超出截断，避免超时）
  // 长视频分段生成：字幕过长时切成多段分别调用模型，避免超出上下文导致「零输出」
  chunkMode: true,
  chunkChars: 6000,     // 每段字幕字符预算
  maxChunks: 10,        // 段数上限（超出则自动放大每段预算）
};

/* ------------------------- 工具函数 ------------------------- */

// 读取合并后的设置
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// 向发起请求的标签页推送进度（用于「正在重试…」等实时提示）
async function notifyStatus(text, tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'vnh-status', text });
  } catch (_) { /* 面板未打开则忽略 */ }
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

/* ---------------------- 健壮网络层 ---------------------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 统一超时 fetch：把AbortError 转成可读的超时错误
async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const err = new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
      err.code = 'ETIMEDOUT';
      throw err;
    }
    // Failed to fetch 在扩展里通常意味着 DNS/证书/连接被拒
    if (e instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(e.message)) {
      const err = new Error(`无法连接到目标地址（网络不可达或被拒绝）：${url}`);
      err.code = 'ENET';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 带指数退避的重试封装。retryable 决定哪些错误值得重试。
async function withRetry(fn, retries = 2, onRetry) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      const code = (e && e.code) || '';
      const status = e && e.status;
      // 4xx（除429）属于配置/请求问题，重试无意义；ERETRY 是我们主动要求换个参数再试
      const retryable = code === 'ETIMEDOUT' || code === 'ENET' || code === 'ERETRY'
        || status === 429 || status === 408 || status >= 500;
      if (!retryable || i === retries) break;
      // ERETRY 是主动换参数，立即重跑即可，无需退避等待
      const wait = code === 'ERETRY' ? 0 : Math.min(8000, 800 * Math.pow(2, i)); // 0.8s → 1.6s → 3.2s
      if (wait > 0) {
        if (onRetry) onRetry(i + 1, retries, wait, e);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// 调用大模型（OpenAI chat/completions 兼容）
// opts.rebuild(maxChars) 可选：在「零输出」时用于重建更精简的提示词
async function callLLM(settings, userPrompt, systemPrompt, tabId, opts) {
  if (!settings.apiBase || !settings.apiKey) {
    throw new Error('尚未配置大模型 API：请打开扩展设置填写 base_url、API Key 与模型名称。');
  }
  const base = settings.apiBase.replace(/\/+$/, '');
  // 容错：用户可能填了完整端点 /chat/completions
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const timeoutMs = Math.max(30, Number(settings.requestTimeout) || 240) * 1000;
  const retries = Math.max(0, Number(settings.retryTimes) || 0);
  let maxTokens = Number(settings.maxTokens) || 2000;
  //推理模型（deepseek-r1 / o1 / qwen-thinking 等）的思考过程会消耗 max_tokens，
  // 预算过小会导致「只有 reasoning、没有正文」。这里留出一次自动加码的机会。
  let reasoningRetryUsed = false;
  // 部分模型（o1 / gpt-5 系列）只认max_completion_tokens，不认 max_tokens / temperature
  let useCompletionTokens = false;
  let omitTemperature = false;
  // 「零输出」（completion_tokens=0）多为输入过长超出上下文，留一次自动精简重试的机会
  let shrinkUsed = false;
  let curUser = userPrompt;
  let curSystem = systemPrompt;
  let curCap = Number(settings.subtitleMaxChars) || 24000;
  // 记录每次「零输出」的输入规模，最终失败时用来判断到底是不是"提示词过长"
  const zeroLog = [];
  // 保存最近一次原始响应，失败时附在错误里，避免继续靠猜
  let lastRaw = '';

  const buildBody = () => {
    const b = {
      model: settings.model,
      max_tokens: maxTokens,
      stream: false, // 明确关闭流式；部分网关忽略此字段，parseMaybeStream 仍会兜底
      messages: [
        { role: 'system', content: curSystem },
        { role: 'user', content: curUser },
      ],
    };
    if (useCompletionTokens) {
      b.max_completion_tokens = maxTokens;
      delete b.max_tokens;
    }
    if (!omitTemperature) b.temperature = Number(settings.temperature) || 0.4;
    return b;
  };

  const segLabel = (opts && opts.label) ? opts.label : '';
  const jobStart = (opts && opts.jobStart) || 0;
  const runAttempts = () => withRetry(async () => {
    // 心跳：既让内容脚本的看门狗知道后台仍在工作（长视频分段可能耗时很久），
    // 也通过 chrome.* 调用保活 MV3 Service Worker，避免被浏览器回收。
    // 同时给出总耗时，让用户在长等待中能判断"确实在推进"。
    const hbStart = Date.now();
    const heartbeat = setInterval(() => {
      const wait = Math.round((Date.now() - hbStart) / 1000);
      const total = jobStart ? `，总耗时 ${Math.round((Date.now() - jobStart) / 1000)}s` : '';
      notifyStatus(`${segLabel}模型生成中…（本段已等待 ${wait}s${total}）`, tabId);
    }, 20000);
    try {
      return await runOnce();
    } finally {
      clearInterval(heartbeat);
    }
  }, retries, (i, max, wait, e) => {
    // ERETRY 是我们主动换参数重试，提示语不应说"异常"
    if (e && e.code === 'ERETRY') return;
    notifyStatus(`模型响应异常，${wait / 1000}s 后进行第 ${i}/${max} 次重试…`, tabId);
  });

  const runOnce = async () => {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(buildBody()),
      }, timeoutMs);
    } catch (e) {
      throw new Error(cnError(e, 'API'));
    }

    // 统一先读 text，再容错解析：避免 res.json() 遇到 SSE 直接炸掉
    let text = '';
    try { text = await res.text(); } catch (_) {}
    lastRaw = text || '';

    if (!res.ok) {
      let detail = '';
      try {
        const j = parseMaybeStream(text);
        detail = j?.error?.message || j?.message || '';
      } catch (_) { detail = text.slice(0, 300); }
      const err = new Error(`【API】HTTP ${res.status}：${detail || text.slice(0, 300)}`);
      err.status = res.status;
      // 参数不兼容时自动换写法再试一次：
      //  · max_tokens 不支持 → 改用 max_completion_tokens
      //  · temperature 不支持 → 去掉（o1 / gpt-5 系列只支持默认值）
      if (!reasoningRetryUsed && /max_tokens|max_completion_tokens|temperature/i.test(detail)
        && /not supported|unsupported|not allowed|invalid|unknown|unrecognized|must be/i.test(detail)) {
        reasoningRetryUsed = true;
        if (/max_tokens|max_completion_tokens/i.test(detail)) useCompletionTokens = true;
        if (/temperature/i.test(detail)) omitTemperature = true;
        if (!useCompletionTokens && !omitTemperature) useCompletionTokens = true;
        await notifyStatus('模型参数不兼容，正在自动调整请求参数重试…', tabId);
        const err2 = new Error(detail);
        err2.code = 'ERETRY';
        throw err2;
      }
      throw err;
    }

    let data;
    try {
      data = parseMaybeStream(text);
    } catch (e) {
      // 「只有思考过程、没有正文」→ 提高 token 预算自动重试一次
      if (!reasoningRetryUsed && e.reason === 'REASONING_ONLY') {
        reasoningRetryUsed = true;
        maxTokens = Math.min(32000, maxTokens * 2);
        await notifyStatus(`模型思考过程较长，正在提高 Token 预算重试（${maxTokens}）…`, tabId);
        const err = new Error(e.message);
        err.code = 'ERETRY';
        throw err;
      }
      // 「零输出」（completion_tokens=0）→ 先精简提示词，再放宽 Token 预算，各试一次
      if (e.reason === 'ZERO_OUTPUT') {
        zeroLog.push({ prompt: Number(e.usage?.prompt_tokens) || 0, cap: curCap, maxTokens });

        if (!shrinkUsed && typeof opts?.rebuild === 'function') {
          shrinkUsed = true;
          const smaller = Math.max(2000, Math.floor(curCap / 2));
          const r = opts.rebuild(smaller);
          if (r && r.user) {
            curUser = r.user;
            curSystem = r.system;
            curCap = smaller;
            await notifyStatus(`模型未产出内容（输入约 ${e.usage?.prompt_tokens || '?'} tokens），正在精简提示词后重试…`, tabId);
            const err2 = new Error(e.message);
            err2.code = 'ERETRY';
            throw err2;
          }
        }
        if (!reasoningRetryUsed) {
          reasoningRetryUsed = true;
          maxTokens = Math.min(32000, maxTokens * 2);
          await notifyStatus(`仍无输出，正在放宽 Token 预算重试（${maxTokens}）…`, tabId);
          const err2 = new Error(e.message);
          err2.code = 'ERETRY';
          throw err2;
        }

        // 所有恢复手段都用尽 → 给出决定性结论，别让用户继续猜
        const lines = zeroLog.map((z, i) =>
          `  第${i + 1}次：输入≈${z.prompt || '?'} tokens（字幕上限 ${z.cap} 字，max_tokens=${z.maxTokens}）`);
        const shrunk = zeroLog.length >= 2
          && zeroLog[0].prompt > 0
          && zeroLog[zeroLog.length - 1].prompt > 0
          && zeroLog[zeroLog.length - 1].prompt < zeroLog[0].prompt;
        e.message += '\n\n—— 本次自动排查记录 ——\n' + lines.join('\n') + '\n';
        if (shrunk) {
          e.message +=
            '结论：**已把输入从约 ' + zeroLog[0].prompt + ' 精简到约 ' + zeroLog[zeroLog.length - 1].prompt + ' tokens，仍然零输出**，' +
            '说明问题不在"提示词过长"，而在模型侧。请依次确认：\n' +
            '  ① 模型名是否真实存在（很多中转站的别名并非官方模型名，建议先用官方名测试）；\n' +
            '  ② 账户余额 / 配额是否充足、该模型是否已开通；\n' +
            '  ③ 换一个已知可用的模型（或换成官方 API）再试一次——若换模型即恢复正常，即为原模型/中转的问题。';
        }
        e.message += '\n原始响应开头：' + (lastRaw || '').slice(0, 300).replace(/\s+/g, ' ');
        throw e;
      }
      throw e;
    }

    const md = textFromParsed(data);
    if (!md || !md.trim()) {
      throw new Error('【API】响应格式异常：未找到可用的文本内容（choices[0].message.content 为空）。');
    }
    return md;
  };

  try {
    return await runAttempts();
  } catch (e) {
    // 把原始响应附到错误上，便于一键导出诊断信息
    if (!e.raw && lastRaw) e.raw = lastRaw.slice(0, 4000);
    throw e;
  }
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
// 统一获取 Obsidian 请求的公共参数
function obsCtx(settings) {
  const base = (settings.obsidianBase || 'http://127.0.0.1:27123').replace(/\/+$/, '');
  return {
    base,
    timeout: Math.max(3, Number(settings.obsidianTimeout) || 20) * 1000,
    headers: { Authorization: `Bearer ${settings.obsidianKey || ''}` },
  };
}

// 连通性探测：区分「连不上」与「密钥错」
async function obsidianPing(settings) {
  const { base, timeout, headers } = obsCtx(settings);
  try {
    const res = await fetchWithTimeout(`${base}/`, { headers, method: 'GET' }, timeout);
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('Obsidian 密钥错误：Local REST API 返回 ' + res.status + '，请重新复制授权密钥。'), { status: res.status });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`Obsidian 接口返回 HTTP ${res.status}（请确认 Local REST API 插件已启用）。`), { status: res.status });
    }
    return true;
  } catch (e) {
    if (e.status) throw e;
    if (e.code === 'ETIMEDOUT') {
      throw new Error(`连接 Obsidian 超时（${Math.round(timeout / 1000)}s 无响应）：请确认 Obsidian 已启动，且地址端口正确（当前 ${base}）。`);
    }
    throw new Error(`无法连接 Obsidian 本地服务 ${base}：请确认 ①Obsidian 已启动 ②已安装并启用「Local REST API」插件 ③地址/端口正确（默认 http://127.0.0.1:27123）。原始错误：${e.message || e}`);
  }
}

async function obsidianVaultName(settings) {
  const { base, headers } = obsCtx(settings);
  try {
    const res = await fetchWithTimeout(`${base}/`, { headers, method: 'GET' }, obsCtx(settings).timeout);
    if (!res.ok) return '';
    const text = await res.text();
    const j = parseMaybeStream(text);
    return j.vault || '';
  } catch (_) { return ''; }
}

async function obsidianPutFile(settings, path, bytes, contentType) {
  const { base, timeout } = obsCtx(settings);
  const safe = path.split('/').map((s) => encodeURIComponent(s)).join('/');
  const headers = {
    ...obsCtx(settings).headers,
    'Content-Type': contentType,
    'Overwrite-If-Exists': settings.syncOverwrite ? 'true' : 'false',
    'Create-If-DoesNotExist': 'true',
  };
  const retries = Math.max(0, Number(settings.retryTimes) || 0);
  try {
    return await withRetry(async () => {
      let res;
      try {
        res = await fetchWithTimeout(`${base}/vault/${safe}`, {
          method: 'PUT',
          headers,
          body: bytes,
        }, timeout);
      } catch (e) {
        // 连接被拒 / 服务未运行：给出可操作的明确提示（不重试，因为重试无意义）
        const err = new Error(`【Obsidian】无法连接本地服务 ${base}：请确认 Obsidian 已启动、已启用「Local REST API」插件，且地址端口正确（默认 http://127.0.0.1:27123）。原始错误：${e.message || e}`);
        err.code = 'ENET'; // 仅网络类可重试
        throw err;
      }
      if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch (_) {}
        if (res.status === 404) throw new Error('Obsidian 目录不存在：请先在库中创建对应目录（' + path + '）。');
        if (res.status === 401) throw new Error('Obsidian 密钥错误（401）：请在设置中填写正确的授权密钥。');
        const err = new Error(`Obsidian 同步失败 HTTP ${res.status}：${detail.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return true;
    }, retries);
  } catch (e) {
    // 404 目录不存在时：自动建目录后重试一次
    if (/目录不存在/.test(e.message || '')) {
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir) {
        await ensureDir(settings, dir);
        return obsidianPutFile(settings, path, bytes, contentType);
      }
    }
    throw e;
  }
}

// 预先创建 Obsidian 目录（逐层创建，兼容 Local REST API 不能一次建多级目录的情况）
async function ensureDir(settings, dirPath) {
  const { base, timeout } = obsCtx(settings);
  const parts = dirPath.split('/').filter(Boolean);
  const headers = {
    ...obsCtx(settings).headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Create-If-DoesNotExist': 'true',
  };
  let ok = true;
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).map((s) => encodeURIComponent(s)).join('/') + '/';
    try {
      const res = await fetchWithTimeout(`${base}/vault/${sub}`, { method: 'PUT', headers, body: '' }, timeout);
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
async function syncToObsidian(settings, payload, tabId) {
  const { markdown, frames = [], title, platform } = payload || {};
  // 预检：地址与密钥
  if (!settings.obsidianBase) {
    throw new Error('尚未配置 Obsidian 地址：请在扩展设置填写 Local REST API 地址（默认 http://127.0.0.1:27123）。');
  }
  if (!settings.obsidianKey) {
    throw new Error('尚未配置 Obsidian 授权密钥：请打开 Obsidian → 设置 → Local REST API，复制 Authorization 密钥并粘贴到扩展设置对应栏。');
  }
  // 连通性预检：把「连不上」和「密钥错」区分开，避免后续每张图都失败一次
  await obsidianPing(settings);

  // 文件名规则（先算出来，用它作为笔记独立子目录名）
  const date = new Date().toISOString().slice(0, 10);
  let fileName;
  if (settings.fileNameRule === 'title_date') fileName = `${title}_${date}`;
  else if (settings.fileNameRule === 'date_title') fileName = `${date}_${title}`;
  else fileName = `${title}`;
  fileName = fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名视频';

  // 目录规则：每篇笔记一个独立子目录，图片放在该目录的 attachments 下，避免多视频互相覆盖
  const noteRoot = settings.noteDir.replace(/^\/+|\/+$/g, '');
  const attachSubdir = settings.attachDir.replace(/^\/+|\/+$/g, '').split('/').pop() || 'attachments';
  const platformDir = settings.byPlatform ? platform : '';
  const noteDir = [noteRoot, platformDir, fileName].filter(Boolean).join('/');
  let attachDir = [noteDir, attachSubdir].filter(Boolean).join('/');

  // 确保目录存在（默认关闭：Local REST API 的 Create-If-DoesNotExist 会自动建，
  // 预建只是多几次往返，慢且无必要；仅在用户显式开启或后续写入报 404 时才建）
  if (settings.ensureDirs) {
    await ensureDir(settings, noteDir);
    const attachDirOk = await ensureDir(settings, attachDir);
    if (!attachDirOk) attachDir = noteDir;
  }

  // 上传图片附件：并发上传（分批，避免一次开太多连接）
  const map = {};
  const ext = settings.imageFormat === 'image/png' ? 'png' : 'jpg';
  const jobs = frames.map((f, i) => ({ i: i + 1, dataUrl: f.dataUrl }));
  const BATCH = 3;
  for (let b = 0; b < jobs.length; b += BATCH) {
    // 推送进度：既让用户看到分批上传，也让内容脚本的看门狗知道后台仍在工作
    await notifyStatus(`正在同步到 Obsidian：上传配图 ${Math.min(b + BATCH, jobs.length)}/${jobs.length}…`, tabId);
    const slice = jobs.slice(b, b + BATCH);
    await Promise.all(slice.map(async ({ i: idx, dataUrl }) => {
      const name = `frame_${idx}.${ext}`;
      const bytes = dataUrlToBytes(dataUrl);
      const imgFullPath = `${attachDir}/${name}`;
      await obsidianPutFile(settings, imgFullPath, bytes, settings.imageFormat);
      // 多别名映射：无论 LLM 写成 frame_N / frame_N.png / frame_N.jpg 都能命中
      // Obsidian 默认按相对当前 md 文件解析图片，因此写入相对 noteDir 的路径
      const real = getRelativePath(noteDir, imgFullPath);
      map[`frame_${idx}`] = real;
      map[`frame_${idx}.png`] = real;
      map[`frame_${idx}.jpg`] = real;
    }));
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
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const handle = async () => {
    switch (msg.action) {
      case 'getSettings':
        return await getSettings();

      case 'generateNote': {
        const s = await getSettings();
        // 长视频判定：字幕总长超过「每段预算 ×1.2」时分段生成，
        // 否则单次生成（段落少时上下文更连贯，质量更好）
        const subChars = (msg.payload.subtitles || [])
          .reduce((n, x) => n + ((x && x.text) || '').length + 12, 0);
        const chunkChars = Number(s.chunkChars) || 6000;
        const useChunked = s.chunkMode !== false && subChars > chunkChars * 1.2;

        let markdown;
        try {
          if (useChunked) {
            markdown = await callLLMChunked(s, msg.payload, tabId);
          } else {
            const system = buildSystemPrompt(s, msg.payload);
            const user = buildUserPrompt(s, msg.payload);
            await notifyStatus('正在调用大模型生成笔记…', tabId);
            markdown = await callLLM(s, user, system, tabId, {
              // 「零输出」时用它重建更精简的提示词（缩小字幕预算）再试
              rebuild: (maxChars) => {
                const s2 = { ...s, subtitleMaxChars: maxChars };
                return { system: buildSystemPrompt(s2, msg.payload), user: buildUserPrompt(s2, msg.payload) };
              },
            });
          }
        } catch (e) {
          // 保存失败详情（含原始响应）供「复制诊断信息」一键导出，便于排查
          try {
            await chrome.storage.local.set({
              lastFailure: {
                at: new Date().toISOString(),
                message: e.message,
                raw: e.raw || '',
              },
            });
          } catch (_) {}
          return { error: e.message, raw: e.raw || '' };
        }
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
            }, tabId);
          } catch (e) { sync = { error: cnError(e, 'Obsidian') }; }
        }
        return { markdown, sync, recordId: record.id };
      }

      case 'syncObsidian': {
        const s = await getSettings();
        try {
          const r = await syncToObsidian(s, msg.payload, tabId);
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
        // Service Worker 没有 DOM 的 URL.createObjectURL，改用 base64 data URL。
        // 注意：Chrome 对 data URL 下载有大小限制（约 2MB），大图易失败；
        // 因此这里返回 base64，由 content脚本转成 Blob 后用 objectURL 下载。
        const safe = (msg.payload.title || 'video-note').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
        return { ok: true, base64: bytesToBase64(zip), filename: `video-note-${safe}.zip` };
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
          const res = await fetchWithTimeout(url, { method, headers, body }, 25000);
          const text = await res.text();
          return { status: res.status, text };
        } catch (e) {
          if (e.code === 'ETIMEDOUT') return { status: 0, error: `【代理请求】访问超时：${url}` };
          return { status: 0, error: `【代理请求】无法访问 ${url}：${(e && e.message) || e}` };
        }
      }

      case 'getHistory':
        return { history: await getHistory() };

      case 'deleteHistory':
        await chrome.storage.local.set({ history: [] });
        return { ok: true };

      case 'getDiagnostics': {
        // 汇总排查所需的全部信息（不含密钥），便于用户一键复制反馈
        const s = await getSettings();
        let lastFailure = null;
        try { lastFailure = (await chrome.storage.local.get('lastFailure')).lastFailure || null; } catch (_) {}
        const maskKey = (k) => (!k ? '（未填）' : k.slice(0, 6) + '…' + k.slice(-4) + `（长度${k.length}）`);
        const lines = [
          '=== Video Note Helper 诊断信息 ===',
          `时间：${new Date().toISOString()}`,
          `扩展版本：${chrome.runtime.getManifest().version}`,
          '',
          '[大模型配置]',
          `base_url      ：${s.apiBase || '（未填）'}`,
          `model         ：${s.model || '（未填）'}`,
          `api_key       ：${maskKey(s.apiKey)}`,
          `max_tokens    ：${s.maxTokens}`,
          `temperature   ：${s.temperature}`,
          `请求超时(秒)  ：${s.requestTimeout}`,
          `重试次数      ：${s.retryTimes}`,
          `字幕字符上限  ：${s.subtitleMaxChars}`,
          '',
          '[Obsidian 配置]',
          `接口地址      ：${s.obsidianBase || '（未填）'}`,
          `授权密钥      ：${maskKey(s.obsidianKey)}`,
          `库名          ：${s.obsidianVault || '（未填）'}`,
          `笔记目录      ：${s.noteDir}`,
          '',
          '[最近一次失败]',
          lastFailure ? `时间：${lastFailure.at}` : '（无记录）',
          lastFailure ? `错误：\n${lastFailure.message}` : '',
          lastFailure && lastFailure.raw ? `\n原始响应开头：\n${lastFailure.raw.slice(0, 1500)}` : '',
        ];
        return { text: lines.filter((x) => x !== '').join('\n') };
      }

      default:
        return { error: '未知操作：' + msg.action };
    }
  };

  handle().then((r) => sendResponse(r)).catch((e) => {
    const m = (e && e.message) ? e.message : String(e);
    sendResponse({ error: /^【/.test(m) ? m : cnError(e, '后台') });
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

// seg: 可选，长视频分段时的段信息 { index, total, isLast }
function buildSystemPrompt(settings, payload, seg) {
  if (settings.notePromptTemplate && settings.notePromptTemplate.trim()) {
    return settings.notePromptTemplate.trim();
  }
  const lines = [
    '你是一名专业的知识笔记整理助手。请基于给定的视频标题、来源平台与字幕内容，',
    '生成一篇结构清晰、排版美观、适合放入 Obsidian 的图文 Markdown 笔记。',
    '要求：',
    '1. 不要输出 YAML 元信息头与一级标题（# 标题），系统会自动添加。',
    '2. 用二级/三级标题（## / ###）合理划分章节，每章先给一句话要点，再用列表展开关键内容，语言精炼。',
    '3. 在合适的章节插入配图引用，格式为 ![配图说明](frame_N.png)，N 必须使用下方给定的编号；',
    '   图片要与相邻知识点强相关，不要堆砌。',
    '4. 对字幕中的关键概念可适当展开解释，保持原创整理而非照搬字幕。',
    '5. 可用表格对比要点；可用 Obsidian Callout 语法（如 > [!tip] / > [!note] / > [!abstract]）突出重点。',
  ];
  if (seg && seg.total > 1) {
    // 分段模式：约束本段只负责自己的时间范围，避免重复或越界
    lines.push(
      `6. 【重要】这是长视频的第 ${seg.index}/${seg.total} 段字幕，按时间顺序切分。`,
      '   你只需整理**本段字幕**所覆盖的内容，不要复述其它段落的内容，也不要写整篇的总体介绍。',
      '   章节标题请贴合本段实际内容，不要使用「第一部分」这类占位标题。',
      seg.isLast
        ? '7. 本段是最后一段：请在末尾用 > [!summary] Callout 给出全片 3 条要点回顾（Key Takeaways）。'
        : '7. 本段不是最后一段：**不要**输出总结 / Key Takeaways / 结语，直接以最后一个小节结束即可。'
    );
  } else {
    lines.push('6. 末尾用 > [!summary] Callout 给出 3 条要点回顾（Key Takeaways）。');
  }
  lines.push('仅输出 Markdown 正文，不要使用代码块包裹。');
  return lines.join('\n');
}

function buildUserPrompt(settings, payload) {
  const sub = (payload.subtitles || []).map((x) => `[${x.time}] ${x.text}`).join('\n');
  // 分段模式下 frames 携带显式全局编号（index），必须原样使用，
  // 否则笔记里引用的 frame_N 会与真实附件编号错位。
  const frameLines = (payload.frames || []).map((f, i) =>
    `frame_${f.index || (i + 1)}.png —— 对应播放时间点 ${f.time}`).join('\n');
  // 超长字幕会显著拖慢模型甚至触发超时：超限时保留首尾（结论通常在尾部）
  const limit = Math.max(2000, Number(settings.subtitleMaxChars) || 24000);
  let subText = sub;
  let truncated = false;
  if (sub.length > limit) {
    const headLen = Math.floor(limit * 0.65);
    subText = sub.slice(0, headLen) + `\n\n…（中间内容因长度限制已省略 ${sub.length - limit} 字）…\n\n` + sub.slice(sub.length - (limit - headLen));
    truncated = true;
  }
  return [
    `视频标题：${payload.title}`,
    `来源平台：${payload.platform}`,
    `原链接：${payload.url}`,
    `总时长：${payload.duration || '未知'}`,
    `期望配图数量：${settings.imageDensity || 5}`,
    truncated ? `注意：字幕原文过长已被截断，请基于可见内容整理，不要臆造缺失段落。` : '',
    '',
    '截图与时间点对应关系（请在相关章节用 ![配图说明](frame_N.png) 引用）：',
    frameLines || '（无截图）',
    '',
    '字幕全文：',
    subText || '（无字幕）',
  ].join('\n');
}

/* -------- 长视频：分段生成 -------- */
// 把字幕切段，逐段调用模型后合并。每个请求都很小，不会超上下文。
async function callLLMChunked(settings, payload, tabId) {
  const subs = payload.subtitles || [];
  const chunkChars = Number(settings.chunkChars) || 6000;
  const maxChunks = Number(settings.maxChunks) || 10;
  const chunks = splitSubtitleChunks(subs, chunkChars, maxChunks);
  if (!chunks.length) throw new Error('没有可用于生成的字幕内容。');
  const framesByChunk = assignFramesToChunks(payload.frames || [], chunks);

  const density = Math.max(1, Number(settings.imageDensity) || 5);
  const perChunkImages = Math.max(1, Math.round(density / chunks.length));

  const parts = [];
  const failed = [];
  const jobStart = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    const seg = { index: i + 1, total: chunks.length, isLast: i === chunks.length - 1 };
    const segPayload = {
      ...payload,
      subtitles: chunks[i].items,
      frames: framesByChunk[i],
    };
    const segSettings = { ...settings, imageDensity: perChunkImages };
    const build = (cap) => ({
      system: buildSystemPrompt(segSettings, segPayload, seg),
      user: buildUserPrompt({ ...segSettings, subtitleMaxChars: cap }, segPayload),
    });
    const { system, user } = build(Number(settings.subtitleMaxChars) || 24000);

    await notifyStatus(
      `长视频已自动分段（共 ${chunks.length} 段）· 已完成 ${i}/${chunks.length} 段，正在生成第 ${i + 1}/${chunks.length} 段…`,
      tabId
    );
    // 单段仍保留「输入过长自动精简」的恢复能力；label/jobStart 用于心跳提示
    try {
      const md = await callLLM(segSettings, user, system, tabId, {
        rebuild: build,
        label: `第 ${i + 1}/${chunks.length} 段 `,
        jobStart,
      });
      if (md && md.trim()) parts.push(md.trim());
      else failed.push({ seg, chunk: chunks[i] });
    } catch (e) {
      // 单段失败不应让整篇白干：记下来继续，最后在文中显式标注缺口
      const err = new Error(`第 ${i + 1}/${chunks.length} 段生成失败：${e.message}`);
      err.code = e.code;
      err.reason = e.reason;
      err.raw = e.raw;
      err.segInfo = { index: i + 1, total: chunks.length, startSec: chunks[i].startSec, endSec: chunks[i].endSec };
      // 首段就失败 → 视为整体失败（大概率是配置问题，继续下去没意义）
      if (!parts.length) throw err;
      failed.push({ seg, chunk: chunks[i], error: e });
      await notifyStatus(`第 ${i + 1}/${chunks.length} 段失败，已跳过并继续后续段落…`, tabId);
    }
  }

  if (!parts.length) throw new Error('所有分段均生成失败，请检查模型配置。');

  let out = parts.join('\n\n');
  const spent = Math.round((Date.now() - jobStart) / 1000);
  if (failed.length) {
    const ranges = failed.map((f) => fmtRange(f.chunk)).join('、');
    out +=
      `\n\n> [!warning] 生成不完整\n` +
      `> 有 ${failed.length}/${chunks.length} 段未能生成（对应时间 ${ranges}），内容可能缺失。\n` +
      `> 可单独重试该时间段，或改用上下文更大的模型。`;
    await notifyStatus(`完成，但有 ${failed.length}/${chunks.length} 段失败（已标注在笔记中，总耗时 ${spent}s）。`, tabId);
  } else {
    await notifyStatus(`全部 ${chunks.length} 段生成完成（总耗时 ${spent}s）。`, tabId);
  }
  return out;
}

// 把秒区间格式化为 "HH:MM:SS–HH:MM:SS"
function fmtRange(chunk) {
  const f = (s) => {
    if (s === null || s === undefined) return '?';
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${ss}`;
  };
  return `${f(chunk.startSec)}–${f(chunk.endSec)}`;
}

console.log('[Video Note Helper] background service worker loaded.');
