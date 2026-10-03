// =============================================================
// content/adapters/bilibili.js — B站 适配器（优化版）
// 修复要点：
//   1. 所有接口请求经后台 proxyFetch 代发，绕过 content script 的 CORS 限制；
//   2. x/player/wbi/v2 需要 WBI 签名，内置 MD5 + 混入密钥签名；
//   3. 多层兜底：签名请求失败 → 免签名 → 旧版 x/player/v2；
//   4. 自动附带 Referer / Cookie，降低 -412 风控。
// 仅抓取公开可见字幕，不破解任何付费/会员限制。
// =============================================================
(function () {
  'use strict';

  /* ---------------- 通信封装 ---------------- */
  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (r && r.error) return reject(new Error(r.error));
        resolve(r);
      });
    });
  }
  // 经后台代发（携带 Referer / Cookie 绕过 CORS 与风控）
  // 失败时抛出可读错误（区分超时 / 网络不通 / HTTP 状态码）
  async function proxy(url) {
    const headers = { Referer: 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent };
    try { headers['Cookie'] = document.cookie; } catch (_) {}
    const r = await send({ action: 'proxyFetch', payload: { url, method: 'GET', headers } });
    if (r && r.error) throw new Error(r.error);
    if (!r || r.status === 0) throw new Error('网络请求失败，无法访问 B站接口（可能被网络或风控拦截，可稍后重试）。');
    return r; // {status, text}
  }

    /* ---------------- 纯 JS MD5（blueimp/JavaScript-MD5，MIT 许可，零依赖） ----------------
     来源 https://github.com/blueimp/JavaScript-MD5 （Paul Johnston / Sebastian Tschan）。
     采用 16 位 safeAdd 拆分累加，规避 JS 解释器对 >2^31 有符号运算的舍入错误。
     此前自写版本因第 4 轮（md5ii）缺失 4 行且常量笔误导致所有哈希错误，
     已整体替换为经验证的权威实现。WBI 签名依赖正确的 MD5（仅 ASCII 入参）。 */
function safeAdd(x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff)
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16)
    return (msw << 16) | (lsw & 0xffff)
  }

  /**
   * Bitwise rotate a 32-bit number to the left.
   *
   * @param {number} num 32-bit number
   * @param {number} cnt Rotation count
   * @returns {number} Rotated number
   */
  function bitRotateLeft(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt))
  }

  /**
   * Basic operation the algorithm uses.
   *
   * @param {number} q q
   * @param {number} a a
   * @param {number} b b
   * @param {number} x x
   * @param {number} s s
   * @param {number} t t
   * @returns {number} Result
   */
  function md5cmn(q, a, b, x, s, t) {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b)
  }
  /**
   * Basic operation the algorithm uses.
   *
   * @param {number} a a
   * @param {number} b b
   * @param {number} c c
   * @param {number} d d
   * @param {number} x x
   * @param {number} s s
   * @param {number} t t
   * @returns {number} Result
   */
  function md5ff(a, b, c, d, x, s, t) {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t)
  }
  /**
   * Basic operation the algorithm uses.
   *
   * @param {number} a a
   * @param {number} b b
   * @param {number} c c
   * @param {number} d d
   * @param {number} x x
   * @param {number} s s
   * @param {number} t t
   * @returns {number} Result
   */
  function md5gg(a, b, c, d, x, s, t) {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t)
  }
  /**
   * Basic operation the algorithm uses.
   *
   * @param {number} a a
   * @param {number} b b
   * @param {number} c c
   * @param {number} d d
   * @param {number} x x
   * @param {number} s s
   * @param {number} t t
   * @returns {number} Result
   */
  function md5hh(a, b, c, d, x, s, t) {
    return md5cmn(b ^ c ^ d, a, b, x, s, t)
  }
  /**
   * Basic operation the algorithm uses.
   *
   * @param {number} a a
   * @param {number} b b
   * @param {number} c c
   * @param {number} d d
   * @param {number} x x
   * @param {number} s s
   * @param {number} t t
   * @returns {number} Result
   */
  function md5ii(a, b, c, d, x, s, t) {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t)
  }

  /**
   * Calculate the MD5 of an array of little-endian words, and a bit length.
   *
   * @param {Array} x Array of little-endian words
   * @param {number} len Bit length
   * @returns {Array<number>} MD5 Array
   */
  function binlMD5(x, len) {
    /* append padding */
    x[len >> 5] |= 0x80 << len % 32
    x[(((len + 64) >>> 9) << 4) + 14] = len

    var i
    var olda
    var oldb
    var oldc
    var oldd
    var a = 1732584193
    var b = -271733879
    var c = -1732584194
    var d = 271733878

    for (i = 0; i < x.length; i += 16) {
      olda = a
      oldb = b
      oldc = c
      oldd = d

      a = md5ff(a, b, c, d, x[i], 7, -680876936)
      d = md5ff(d, a, b, c, x[i + 1], 12, -389564586)
      c = md5ff(c, d, a, b, x[i + 2], 17, 606105819)
      b = md5ff(b, c, d, a, x[i + 3], 22, -1044525330)
      a = md5ff(a, b, c, d, x[i + 4], 7, -176418897)
      d = md5ff(d, a, b, c, x[i + 5], 12, 1200080426)
      c = md5ff(c, d, a, b, x[i + 6], 17, -1473231341)
      b = md5ff(b, c, d, a, x[i + 7], 22, -45705983)
      a = md5ff(a, b, c, d, x[i + 8], 7, 1770035416)
      d = md5ff(d, a, b, c, x[i + 9], 12, -1958414417)
      c = md5ff(c, d, a, b, x[i + 10], 17, -42063)
      b = md5ff(b, c, d, a, x[i + 11], 22, -1990404162)
      a = md5ff(a, b, c, d, x[i + 12], 7, 1804603682)
      d = md5ff(d, a, b, c, x[i + 13], 12, -40341101)
      c = md5ff(c, d, a, b, x[i + 14], 17, -1502002290)
      b = md5ff(b, c, d, a, x[i + 15], 22, 1236535329)

      a = md5gg(a, b, c, d, x[i + 1], 5, -165796510)
      d = md5gg(d, a, b, c, x[i + 6], 9, -1069501632)
      c = md5gg(c, d, a, b, x[i + 11], 14, 643717713)
      b = md5gg(b, c, d, a, x[i], 20, -373897302)
      a = md5gg(a, b, c, d, x[i + 5], 5, -701558691)
      d = md5gg(d, a, b, c, x[i + 10], 9, 38016083)
      c = md5gg(c, d, a, b, x[i + 15], 14, -660478335)
      b = md5gg(b, c, d, a, x[i + 4], 20, -405537848)
      a = md5gg(a, b, c, d, x[i + 9], 5, 568446438)
      d = md5gg(d, a, b, c, x[i + 14], 9, -1019803690)
      c = md5gg(c, d, a, b, x[i + 3], 14, -187363961)
      b = md5gg(b, c, d, a, x[i + 8], 20, 1163531501)
      a = md5gg(a, b, c, d, x[i + 13], 5, -1444681467)
      d = md5gg(d, a, b, c, x[i + 2], 9, -51403784)
      c = md5gg(c, d, a, b, x[i + 7], 14, 1735328473)
      b = md5gg(b, c, d, a, x[i + 12], 20, -1926607734)

      a = md5hh(a, b, c, d, x[i + 5], 4, -378558)
      d = md5hh(d, a, b, c, x[i + 8], 11, -2022574463)
      c = md5hh(c, d, a, b, x[i + 11], 16, 1839030562)
      b = md5hh(b, c, d, a, x[i + 14], 23, -35309556)
      a = md5hh(a, b, c, d, x[i + 1], 4, -1530992060)
      d = md5hh(d, a, b, c, x[i + 4], 11, 1272893353)
      c = md5hh(c, d, a, b, x[i + 7], 16, -155497632)
      b = md5hh(b, c, d, a, x[i + 10], 23, -1094730640)
      a = md5hh(a, b, c, d, x[i + 13], 4, 681279174)
      d = md5hh(d, a, b, c, x[i], 11, -358537222)
      c = md5hh(c, d, a, b, x[i + 3], 16, -722521979)
      b = md5hh(b, c, d, a, x[i + 6], 23, 76029189)
      a = md5hh(a, b, c, d, x[i + 9], 4, -640364487)
      d = md5hh(d, a, b, c, x[i + 12], 11, -421815835)
      c = md5hh(c, d, a, b, x[i + 15], 16, 530742520)
      b = md5hh(b, c, d, a, x[i + 2], 23, -995338651)

      a = md5ii(a, b, c, d, x[i], 6, -198630844)
      d = md5ii(d, a, b, c, x[i + 7], 10, 1126891415)
      c = md5ii(c, d, a, b, x[i + 14], 15, -1416354905)
      b = md5ii(b, c, d, a, x[i + 5], 21, -57434055)
      a = md5ii(a, b, c, d, x[i + 12], 6, 1700485571)
      d = md5ii(d, a, b, c, x[i + 3], 10, -1894986606)
      c = md5ii(c, d, a, b, x[i + 10], 15, -1051523)
      b = md5ii(b, c, d, a, x[i + 1], 21, -2054922799)
      a = md5ii(a, b, c, d, x[i + 8], 6, 1873313359)
      d = md5ii(d, a, b, c, x[i + 15], 10, -30611744)
      c = md5ii(c, d, a, b, x[i + 6], 15, -1560198380)
      b = md5ii(b, c, d, a, x[i + 13], 21, 1309151649)
      a = md5ii(a, b, c, d, x[i + 4], 6, -145523070)
      d = md5ii(d, a, b, c, x[i + 11], 10, -1120210379)
      c = md5ii(c, d, a, b, x[i + 2], 15, 718787259)
      b = md5ii(b, c, d, a, x[i + 9], 21, -343485551)

      a = safeAdd(a, olda)
      b = safeAdd(b, oldb)
      c = safeAdd(c, oldc)
      d = safeAdd(d, oldd)
    }
    return [a, b, c, d]
  }

  /**
   * Convert an array of little-endian words to a string
   *
   * @param {Array<number>} input MD5 Array
   * @returns {string} MD5 string
   */
  function binl2rstr(input) {
    var i
    var output = ''
    var length32 = input.length * 32
    for (i = 0; i < length32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> i % 32) & 0xff)
    }
    return output
  }

  /**
   * Convert a raw string to an array of little-endian words
   * Characters >255 have their high-byte silently ignored.
   *
   * @param {string} input Raw input string
   * @returns {Array<number>} Array of little-endian words
   */
  function rstr2binl(input) {
    var i
    var output = []
    output[(input.length >> 2) - 1] = undefined
    for (i = 0; i < output.length; i += 1) {
      output[i] = 0
    }
    var length8 = input.length * 8
    for (i = 0; i < length8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << i % 32
    }
    return output
  }

  /**
   * Calculate the MD5 of a raw string
   *
   * @param {string} s Input string
   * @returns {string} Raw MD5 string
   */
  function rstrMD5(s) {
    return binl2rstr(binlMD5(rstr2binl(s), s.length * 8))
  }

  /**
   * Calculates the HMAC-MD5 of a key and some data (raw strings)
   *
   * @param {string} key HMAC key
   * @param {string} data Raw input string
   * @returns {string} Raw MD5 string
   */
  function rstrHMACMD5(key, data) {
    var i
    var bkey = rstr2binl(key)
    var ipad = []
    var opad = []
    var hash
    ipad[15] = opad[15] = undefined
    if (bkey.length > 16) {
      bkey = binlMD5(bkey, key.length * 8)
    }
    for (i = 0; i < 16; i += 1) {
      ipad[i] = bkey[i] ^ 0x36363636
      opad[i] = bkey[i] ^ 0x5c5c5c5c
    }
    hash = binlMD5(ipad.concat(rstr2binl(data)), 512 + data.length * 8)
    return binl2rstr(binlMD5(opad.concat(hash), 512 + 128))
  }

  /**
   * Convert a raw string to a hex string
   *
   * @param {string} input Raw input string
   * @returns {string} Hex encoded string
   */
  function rstr2hex(input) {
    var hexTab = '0123456789abcdef'
    var output = ''
    var x
    var i
    for (i = 0; i < input.length; i += 1) {
      x = input.charCodeAt(i)
      output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f)
    }
    return output
  }

  /**
   * Encode a string as UTF-8
   *
   * @param {string} input Input string
   * @returns {string} UTF8 string
   */
  function str2rstrUTF8(input) {
    return unescape(encodeURIComponent(input))
  }

  /**
   * Encodes input string as raw MD5 string
   *
   * @param {string} s Input string
   * @returns {string} Raw MD5 string
   */
  function rawMD5(s) {
    return rstrMD5(str2rstrUTF8(s))
  }
  /**
   * Encodes input string as Hex encoded string
   *
   * @param {string} s Input string
   * @returns {string} Hex encoded string
   */
  function hexMD5(s) {
    return rstr2hex(rawMD5(s))
  }
  // 对外接口：传入字符串，返回 32 位小写十六进制 MD5（供 WBI 签名调用）
  function md5(s) { return hexMD5(s); }
/* ---------------- WBI 签名 ---------------- */
  const MIXIN_PERM = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let mixinKeyCache = null;
  async function getMixinKey() {
    if (mixinKeyCache) return mixinKeyCache;
    let r;
    try { r = await proxy('https://api.bilibili.com/x/web-interface/nav'); }
    catch (_) { return ''; } // 取不到签名密钥就走免签名兜底
    let orig = '';
    try {
      const j = JSON.parse(r.text || '{}');
      const img = j?.data?.wbi_img?.img_url || '';
      const sub = j?.data?.wbi_img?.sub_url || '';
      orig = (img.split('/').pop().split('.')[0] || '') + (sub.split('/').pop().split('.')[0] || '');
    } catch (_) {}
    if (!orig) return '';
    let s = '';
    for (const i of MIXIN_PERM) if (i < orig.length) s += orig[i];
    mixinKeyCache = s.slice(0, 32);
    return mixinKeyCache;
  }
  function toQuery(params) {
    return Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  }
  async function wbiSign(params) {
    const mk = await getMixinKey();
    if (!mk) return null;
    const p = { ...params, wts: Math.floor(Date.now() / 1000) };
    const q = toQuery(p);
    p.w_rid = md5(q + mk);
    return p;
  }

  /* ---------------- 业务函数 ---------------- */
  function fmt(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
  function getBvid() {
    const m = location.href.match(/BV[0-9A-Za-z]+/);
    if (m) return m[0];
    return new URLSearchParams(location.search).get('bvid') || null;
  }
  function getVideoEl() {
    return document.querySelector('.bpx-player-video video, #bilibili-player video, video') || null;
  }
  function getMeta() {
    const v = getVideoEl();
    const title = (document.querySelector('h1.video-title, .video-info-title, .v-title, #title h1') || {}).textContent || document.title || '未命名视频';
    return { title: title.trim(), url: location.href.split('?')[0], duration: v && v.duration ? fmt(v.duration) : '' };
  }

  async function getCid(bvid) {
    let r;
    try { r = await proxy(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`); }
    catch (e) { throw new Error(e.message || '获取视频信息失败。'); }
    if (!r || r.status !== 200) throw new Error(`获取视频 cid 失败（HTTP ${(r && r.status) || 0}），可能触发了 B站风控，请稍后重试或刷新页面。`);
    try {
      const j = JSON.parse(r.text);
      if (j.code === 0) return j.data.cid || (j.data.pages && j.data.pages[0] && j.data.pages[0].cid) || null;
      if (j.code === -403) throw new Error('B站拒绝了本次请求（风控 -403）：请在浏览器中先正常浏览几秒、确认已登录，再重试。');
    } catch (e) {
      if (/风控|拒绝/.test(e.message || '')) throw e;
    }
    return null;
  }

  async function fetchSubtitleList(bvid, cid) {
    // 1) WBI 签名请求
    try {
      const signed = await wbiSign({ bvid, cid });
      if (signed) {
        const r = await proxy(`https://api.bilibili.com/x/player/wbi/v2?${toQuery(signed)}`);
        if (r.status === 200) {
          try { const j = JSON.parse(r.text); if (j.code === 0) return j.data.subtitle.subtitles || []; } catch (_) {}
        }
      }
    } catch (_) { /* 进入下一层兜底 */ }
    // 2) 免签名兜底
    try {
      const r2 = await proxy(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`);
      if (r2.status === 200) {
        try { const j = JSON.parse(r2.text); if (j.code === 0) return j.data.subtitle.subtitles || []; } catch (_) {}
      }
    } catch (_) { /* 进入下一层兜底 */ }
    // 3) 旧版接口兜底
    try {
      const r3 = await proxy(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`);
      if (r3.status === 200) {
        try { const j = JSON.parse(r3.text); if (j.code === 0) return (j.data.subtitle && j.data.subtitle.subtitles) || []; } catch (_) {}
      }
    } catch (_) { /* 全部兜底失败 */ }
    return null;
  }

  function mergeSubs(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      if (out.length && out[out.length - 1].text === cur.text) continue;
      if (out.length) {
        const prev = out[out.length - 1];
        if (prev.text.length < 14 && prev.time === cur.time) { prev.text += cur.text; continue; }
      }
      out.push({ time: cur.time, text: cur.text });
    }
    const merged = [];
    for (const it of out) {
      if (merged.length && merged[merged.length - 1].text.length < 16 && it.text.length < 16) merged[merged.length - 1].text += '；' + it.text;
      else merged.push({ ...it });
    }
    return merged;
  }

  async function extractSubtitles() {
    const bvid = getBvid();
    if (!bvid) throw new Error('未能从链接识别 BV 号，请在视频播放页使用本功能。');
    const cid = await getCid(bvid);
    if (!cid) throw new Error('未能获取视频 cid，请确认视频已正常加载（部分视频需登录后查看，或触发了 B站风控，可刷新页面后重试）。');

    let subs = await fetchSubtitleList(bvid, cid);
    if (!subs || !subs.length) throw new Error('该视频暂无公开字幕（CC/AI）。可在 B站播放器开启字幕后重试；若确有字幕，多为 B站风控拦截，稍后重试即可。');

    // 排序：官方 CC 优先（ai_type!=1），其次 AI 自动字幕
    subs = subs.slice().sort((a, b) => (a.ai_type === 1 ? 1 : 0) - (b.ai_type === 1 ? 1 : 0));
    const pick = subs[0];

    let url = pick.subtitle_url;
    if (url.startsWith('//')) url = 'https:' + url;
    const raw = await proxy(url);
    if (raw.status !== 200) throw new Error('字幕文件下载失败 HTTP ' + raw.status);
    let arr;
    try { arr = JSON.parse(raw.text); } catch (_) { throw new Error('字幕数据解析失败：返回内容不是合法 JSON。'); }
    // B站字幕文件格式为 {body: [...]}；少数旧版可能是纯数组，统一兼容处理。
    const body = arr && Array.isArray(arr.body) ? arr.body : Array.isArray(arr) ? arr : [];
    if (!body.length) throw new Error('字幕格式异常：未识别到字幕条目。');
    const list = body.map((x) => ({ time: fmt(x.from), text: (x.content || '').replace(/\n/g, ' ').trim() })).filter((x) => x.text);
    if (!list.length) throw new Error('字幕内容为空。');
    return mergeSubs(list);
  }

  window.VNH_ADAPTER = { platform: 'bilibili', getMeta, getVideoEl, extractSubtitles };
})();
