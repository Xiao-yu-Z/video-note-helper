// =============================================================
// content/adapters/baidu.js — 百度网盘 适配器（优化版）
// 修复要点：
//   1. 新增「实时字幕捕获」：用 MutationObserver 监听播放器字幕渲染节点，
//      边播放边记录（时间 + 文本），点击「提取字幕」时直接导出已捕获内容；
//   2. 兜底：无捕获内容时再尝试 video.textTracks 与字幕 DOM 快照；
//   3. 给出明确操作指引（需开启 AI 字幕并播放）。
// 仅抓取页面公开可见字幕，不破解任何付费/会员限制、不下载视频源文件。
// =============================================================
(function () {
  'use strict';

  function fmt(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // 查找播放器 video：优先主文档，其次同源 iframe（百度播放器常内嵌 iframe）
  function getVideoEl() {
    let v = document.querySelector('.video-container video, .play-video video, #video video, video') || null;
    if (!v) {
      try {
        document.querySelectorAll('iframe').forEach((f) => {
          if (v) return;
          try { if (f.contentDocument) v = f.contentDocument.querySelector('video') || null; } catch (_) {}
        });
      } catch (_) {}
    }
    return v;
  }
  function getMeta() {
    const v = getVideoEl();
    const title = (document.querySelector('.file-name, .title, #filename, .video-name') || {}).textContent
      || (v && v.title) || document.title || '未命名视频';
    return { title: title.trim(), url: location.href, duration: v && v.duration ? fmt(v.duration) : '' };
  }

  /* ---------------- 实时字幕捕获（轮询 + 观察器双保险） ---------------- */
  const buffer = [];          // 已捕获的 {time, text}
  const seen = new Set();     // 去重
  let observing = false;
  let polling = false;
  let observer = null;
  let pollTimer = null;

  function looksLikeSubtitle(text) {
    if (!text || text.length < 2 || text.length > 300) return false;
    const cjk = /[一-鿿]/.test(text);
    const alnum = /[A-Za-z0-9]{2,}/.test(text);
    return cjk || (text.length >= 6 && alnum);
  }

  function record(text) {
    const t = text.trim();
    if (!looksLikeSubtitle(t)) return;
    const v = getVideoEl();
    const now = fmt(v ? v.currentTime : 0);
    // 流式字幕合并：AI 字幕会「短句 → 完整句」渐进更新，
    // 若当前文本是上一句的延伸（前缀相同），用更长版本替换上一句，避免碎片占位
    const last = buffer[buffer.length - 1];
    if (last && (t.startsWith(last.text) || last.text.startsWith(t))) {
      if (t.length > last.text.length) {
        seen.delete(last.text);
        buffer[buffer.length - 1] = { time: last.time, text: t }; // 保留首次出现的时间
        seen.add(t);
      }
      return;
    }
    if (seen.has(t)) return;
    seen.add(t);
    buffer.push({ time: now, text: t });
    if (buffer.length > 5000) stopObserve(); // 保护内存
  }

  // 在 document 与同源 iframe 中查找字幕候选根节点
  function findSubtitleRoots() {
    const sel = '[class*="subtitle" i], [class*="caption" i], [class*="cc" i], [class*="srt" i], [class*="字幕" i], [data-subtitle], .vjs-text-track-display';
    const roots = [];
    const collect = (doc) => {
      if (!doc) return;
      doc.querySelectorAll(sel).forEach((el) => {
        // 优先小容器（直接承载字幕文本，子节点少）
        if (el.children.length <= 8) roots.push(el);
      });
    };
    collect(document);
    try {
      document.querySelectorAll('iframe').forEach((f) => {
        try { if (f.contentDocument) collect(f.contentDocument); } catch (_) {}
      });
    } catch (_) {}
    return roots;
  }

  // 给候选文本打分，挑出最像「字幕」的那一句（排除播放器 UI 文字）
  function scoreText(t) {
    let s = 0;
    if (/[一-鿿]/.test(t)) s += 100;
    if (t.length >= 4 && t.length <= 140) s += 50;
    if (/[，。！？、；：,.!?]/.test(t)) s += 30;       // 句末标点 → 更像句子
    if (/倍速|音量|全屏|设置|播放|暂停|下一集|清晰度|弹幕|选集/.test(t)) s -= 200; // UI 噪声
    return s;
  }

  function readCurrentSubtitle() {
    const roots = findSubtitleRoots();
    const cands = [];
    for (const root of roots) {
      const t0 = ((root.innerText != null ? root.innerText : root.textContent) || '').trim();
      if (t0) cands.push(t0);
      root.querySelectorAll('[class*="text" i], [class*="content" i], [class*="subtitle" i], span').forEach((el) => {
        const tt = ((el.innerText != null ? el.innerText : el.textContent) || '').trim();
        if (tt) cands.push(tt);
      });
    }
    if (!cands.length) return '';
    cands.sort((a, b) => scoreText(b) - scoreText(a));
    return cands[0];
  }

  // 节流：timeupdate 约 4Hz（250ms），直接读 DOM 即可，无需更高频
  let lastRead = 0;
  let lastVideo = null;
  function onTimeUpdate() {
    const now = Date.now();
    if (now - lastRead < 300) return;
    lastRead = now;
    pollTick();
  }

  // video 元素可能随 SPA 切换重建，轮询时检测并重新绑定事件
  function bindVideoEvents() {
    const v = getVideoEl();
    if (!v || v === lastVideo) return;
    if (lastVideo) { try { lastVideo.removeEventListener('timeupdate', onTimeUpdate); } catch (_) {} }
    lastVideo = v;
    v.addEventListener('timeupdate', onTimeUpdate);
  }

  function pollTick() {
    bindVideoEvents();
    const v = getVideoEl();
    if (!v) return;
    const txt = readCurrentSubtitle();
    if (txt) record(txt);
  }

  function stopObserve() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (lastVideo) { try { lastVideo.removeEventListener('timeupdate', onTimeUpdate); } catch (_) {} lastVideo = null; }
    observing = false; polling = false;
  }

  function startObserve() {
    if (observing) return;
    observing = true;
    // timeupdate 驱动（跟随播放进度，字幕切换不漏句）+ 轮询兜底（timeupdate 不触发时仍能捕获）
    if (!polling) {
      polling = true;
      pollTimer = setInterval(pollTick, 800);
      pollTick();
    }
    // 观察器：字幕节点一变动就即时读取
    const roots = findSubtitleRoots();
    if (!roots.length) { setTimeout(() => { if (observing) startObserve(); }, 1500); return; }
    observer = new MutationObserver(() => pollTick());
    for (const root of roots) {
      try { observer.observe(root, { subtree: true, childList: true, characterData: true }); } catch (_) {}
    }
  }

  // 页面就绪后自动开始捕获
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserve);
  else startObserve();

  /* ---------------- 兜底方法 ---------------- */
  async function fromTextTracks(video) {
    const tracks = video.textTracks;
    if (!tracks || tracks.length === 0) return null;
    let best = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.mode === 'disabled') t.mode = 'hidden';
      if (t.cues && t.cues.length) best = t;
    }
    if (!best) return null;
    const list = [];
    for (let i = 0; i < best.cues.length; i++) {
      const c = best.cues[i];
      const text = (c.text || '').replace(/\n/g, ' ').trim();
      if (text) list.push({ time: fmt(c.startTime), text });
    }
    return list.length ? list : null;
  }
  async function fromDom() {
    const sel = '.subtitle-text, .subtitle-item, [data-subtitle], .caption-text, .subtitle-wrap__text, .player-subtitle, .subtitle-container, [class*="subtitle" i], [class*="caption" i]';
    const collect = (doc) => {
      const nodes = doc.querySelectorAll(sel);
      const list = [];
      nodes.forEach((n) => {
        const time = n.getAttribute('data-time') || n.getAttribute('data-start') || '';
        // innerText 会保留换行：若播放器把历史字幕都渲染在容器内，按行拆成多条
        let lines = (n.innerText != null ? n.innerText : n.textContent || '')
          .split('\n').map((s) => s.trim()).filter(Boolean);
        // 单行且很长（可能是多句拼一起）→ 按句末标点拆
        if (lines.length === 1 && lines[0].length > 40) {
          lines = lines[0].split(/(?<=[。！？；])/).map((s) => s.trim()).filter(Boolean);
        }
        for (const line of lines) {
          if (looksLikeSubtitle(line)) list.push({ time: time ? fmt(time) : '', text: line });
        }
      });
      return list;
    };
    let list = collect(document);
    try {
      document.querySelectorAll('iframe').forEach((f) => {
        try { if (f.contentDocument) list = list.concat(collect(f.contentDocument)); } catch (_) {}
      });
    } catch (_) {}
    return list.length ? list : null;
  }

  async function extractSubtitles() {
    const video = getVideoEl();
    if (!video) throw new Error('未找到播放器 video 元素，请确认已进入视频播放页。');

    // 立即补抓当前屏幕上显示的字幕（timeupdate/轮询可能刚好错过）
    pollTick();
    // 缓冲为空时，AI 字幕是流式生成的，稍等片刻再补抓一次
    if (!buffer.length) {
      await new Promise((r) => setTimeout(r, 600));
      pollTick();
    }

    // 优先使用实时捕获缓冲
    if (buffer.length) {
      const out = [];
      const dup = new Set();
      for (const it of buffer) {
        if (dup.has(it.text)) continue;
        dup.add(it.text);
        out.push(it);
      }
      return out;
    }
    // 兜底：textTracks
    let list = await fromTextTracks(video).catch(() => null);
    if (!list) list = await fromDom().catch(() => null);
    if (list && list.length) {
      const out = []; const dup = new Set();
      for (const it of list) { if (dup.has(it.text)) continue; dup.add(it.text); out.push(it); }
      return out;
    }
    throw new Error(
      '未能捕获字幕。百度网盘需手动开启字幕后再提取：\n' +
      '① 在播放器底部工具栏点「字幕 / CC」图标；\n' +
      '② 开启「AI 字幕」（或选择已上传的字幕文件）；\n' +
      '③ 让视频播放一段时间，等字幕出现；\n' +
      '④ 再点本面板的「提取字幕」。\n' +
      '（若仍为空，可能是该视频无字幕或字幕在跨域 iframe 中无法读取。）'
    );
  }

  window.VNH_ADAPTER = { platform: 'baidu', getMeta, getVideoEl, extractSubtitles };
})();
