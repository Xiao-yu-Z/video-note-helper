// =============================================================
// content/common.js — 公共悬浮面板与核心交互逻辑
// 注入到百度网盘 / B站 / YouTube 播放页。
// 适配器在 window.VNH_ADAPTER 上注册标准接口；本文件负责 UI、截帧、消息通信。
// 纯原生 JS，无第三方依赖。
// =============================================================
(function () {
  'use strict';

  // 适配器接口：window.VNH_ADAPTER = {
  //   platform: 'bilibili' | 'youtube' | 'baidu',
  //   getMeta(): {title,url,duration},
  //   getVideoEl(): HTMLVideoElement | null,
  //   extractSubtitles(): Promise<[{time,text}]>
  // }

  const state = {
    adapter: null,
    meta: { title: '', url: '', duration: '' },
    subtitles: [],   // [{time,text}]
    frames: [],      // [{time,dataUrl}]
    markdown: '',
    lastSync: null,
    settings: null,  // 缓存设置，避免截帧时反复通信
  };

  let panelEl = null;
  let lastUrl = location.href;

  /* ----------------- 通信封装 ----------------- */
  // MV3 的 Service Worker 空闲会被回收，长任务期间消息通道可能被关闭，
  // 导致 send() 永远不resolve（表现为"连接超时/无响应"）。
  //
  // 关键设计：超时衡量的是**沉默时长**，而不是总耗时。
  // 长视频分段生成会连续调用模型多次（可能十几分钟），后台每完成一段都会
  // 推送 vnh-status 进度；只要进度在推进就重置看门狗，绝不误判超时。
  // 只有后台真的挂了（长时间无任何消息）才触发超时。
  const SEND_TIMEOUT = {
    syncObsidian: 120000,
    exportZip: 60000,
    proxyFetch: 40000,
    default: 15000,
  };

  // 当前挂起的看门狗，由 vnh-status 进度推送重置
  let activeWatchdog = null;

  function sendOnce(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let lastReset = Date.now();
      const arm = () => {
        clearTimeout(timer);
        lastReset = Date.now();
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          activeWatchdog = null;
          const idle = Math.round((Date.now() - lastReset) / 1000);
          reject(new Error(
            `后台无响应（已 ${idle}s 未收到任何进度）：扩展后台可能已被浏览器回收。\n` +
            '请点击扩展图标刷新页面后重试；若视频很长，可在设置页调小「每段字幕字符数」以减少单次生成耗时。'
          ));
        }, timeoutMs);
      };
      arm();
      activeWatchdog = { arm };
      chrome.runtime.sendMessage(msg, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeWatchdog = null;
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(`扩展通信中断：${err.message}`));
        if (res && res.error) return reject(new Error(res.error));
        resolve(res);
      });
    });
  }

  // 收到后台进度推送时调用：证明后台还活着，重置看门狗
  function feedWatchdog() {
    if (activeWatchdog) { try { activeWatchdog.arm(); } catch (_) {} }
  }

  // 「生成笔记」的沉默上限要大于单次模型请求的超时，否则会把正常的长请求误判为卡死。
  function generateSilenceTimeout() {
    const perReq = (Number(state.settings && state.settings.requestTimeout) || 240) * 1000;
    return Math.max(120000, perReq + 60000);
  }

  async function send(msg) {
    const timeoutMs = msg && msg.action === 'generateNote'
      ? generateSilenceTimeout()
      : (SEND_TIMEOUT[msg && msg.action] || SEND_TIMEOUT.default);
    let lastErr;
    // 通道类错误重试一次（Service Worker 被回收后可自动恢复）
    for (let i = 0; i < 2; i++) {
      try {
        return await sendOnce(msg, timeoutMs);
      } catch (e) {
        lastErr = e;
        const m = e.message || '';
        const recoverable = /扩展通信中断|message port closed|Receiving end does not exist|Extension context invalidated/i.test(m);
        if (!recoverable || i === 1) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr;
  }

  /* ----------------- 注入样式 ----------------- */
  function injectStyle() {
    if (document.getElementById('vnh-style')) return;
    const css = `
#vnh-panel{position:fixed;right:16px;bottom:16px;width:340px;max-height:78vh;z-index:2147483647;
  background:#fff;color:#1f2329;border:1px solid #e5e6eb;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);
  font:13px/1.5 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;overflow:hidden}
#vnh-panel *{box-sizing:border-box}
#vnh-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#3b82f6;color:#fff;cursor:move}
#vnh-head .t{font-weight:600}
#vnh-head .x{cursor:pointer;opacity:.85;font-size:16px;line-height:1;padding:2px 6px}
#vnh-body{padding:10px 12px;overflow:auto}
#vnh-tabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
#vnh-tabs button{flex:1;min-width:64px;padding:6px 4px;border:1px solid #e5e6eb;background:#f5f7fa;border-radius:8px;cursor:pointer;font-size:12px}
#vnh-tabs button.on{background:#3b82f6;border-color:#3b82f6;color:#fff}
.vnh-sect{margin-bottom:10px}
.vnh-sect h4{margin:0 0 6px;font-size:12px;color:#4e5969}
#vnh-sub{width:100%;height:120px;resize:vertical;border:1px solid #e5e6eb;border-radius:8px;padding:6px;font-family:inherit;font-size:12px}
#vnh-md{width:100%;height:200px;resize:vertical;border:1px solid #e5e6eb;border-radius:8px;padding:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre;overflow:auto}
.vnh-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.vnh-row button,.vnh-act button{flex:1;min-width:70px;padding:7px 6px;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer;font-size:12px}
.vnh-act button.sec{background:#f2f3f5;color:#1f2329}
.vnh-act{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
#vnh-thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
#vnh-thumbs img{width:84px;height:48px;object-fit:cover;border:1px solid #e5e6eb;border-radius:6px}
#vnh-thumbs .cap{position:relative}
#vnh-status{font-size:12px;color:#86909c;min-height:16px;margin-top:6px;word-break:break-word}
#vnh-panel button:disabled{opacity:.5;cursor:not-allowed}
#vnh-hist{font-size:12px}
#vnh-hist .it{border:1px solid #e5e6eb;border-radius:8px;padding:6px 8px;margin-bottom:6px;cursor:pointer}
#vnh-hist .it:hover{background:#f5f7fa}
#vnh-disabled{padding:14px;color:#86909c;text-align:center}
.vnh-err{color:#f53f3f}
`;
    const style = document.createElement('style');
    style.id = 'vnh-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ----------------- 构建面板 ----------------- */
  function buildPanel() {
    // 幂等：已构建则直接显示（用户从扩展图标再次打开时复用）
    if (panelEl) {
      panelEl.style.display = '';
      return;
    }
    injectStyle();
    panelEl = document.createElement('div');
    panelEl.id = 'vnh-panel';
    panelEl.innerHTML = `
      <div id="vnh-head"><span class="t">📝 视频图文笔记助手</span><span class="x" title="收起">×</span></div>
      <div id="vnh-body">
        <div id="vnh-tabs">
          <button data-tab="main" class="on">笔记</button>
          <button data-tab="history">历史</button>
        </div>
        <div id="vnh-main">
          <div class="vnh-sect">
            <h4>① 字幕（可编辑后生成）</h4>
            <textarea id="vnh-sub" placeholder="点击「提取字幕」自动抓取，可手动修正…"></textarea>
            <div class="vnh-row"><button id="vnh-extract">提取字幕</button></div>
          </div>
          <div class="vnh-sect">
            <h4>② 关键帧配图</h4>
            <div class="vnh-row">
              <button id="vnh-cap-manual">插入当前帧</button>
              <button id="vnh-cap-auto">自动按章节截帧</button>
            </div>
            <div id="vnh-thumbs"></div>
          </div>
          <div class="vnh-sect">
            <h4>③ 生成与同步</h4>
            <div class="vnh-act">
              <button id="vnh-gen">生成图文笔记</button>
              <button id="vnh-sync" class="sec">同步 Obsidian</button>
            </div>
            <div class="vnh-act" style="margin-top:6px">
              <button id="vnh-copy" class="sec">复制全文</button>
              <button id="vnh-export" class="sec">导出 MD+图片</button>
            </div>
            <div class="vnh-act" style="margin-top:6px">
              <button id="vnh-diag" class="sec">复制诊断信息（报错时用）</button>
            </div>
          </div>
          <div class="vnh-sect">
            <h4>预览（Markdown）</h4>
            <textarea id="vnh-md" readonly placeholder="生成的笔记将显示在此…"></textarea>
          </div>
          <div id="vnh-status"></div>
        </div>
        <div id="vnh-history" style="display:none"><div id="vnh-hist"></div></div>
      </div>`;
    document.body.appendChild(panelEl);
    bindEvents();
    refreshMeta();
  }

  /* ----------------- 事件绑定 ----------------- */
  function bindEvents() {
    const $ = (s) => panelEl.querySelector(s);
    $('.x').onclick = () => panelEl.remove();
    panelEl.querySelectorAll('#vnh-tabs button').forEach((b) => {
      b.onclick = () => {
        panelEl.querySelectorAll('#vnh-tabs button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        const t = b.dataset.tab;
        $('#vnh-main').style.display = t === 'main' ? '' : 'none';
        $('#vnh-history').style.display = t === 'history' ? '' : 'none';
        if (t === 'history') loadHistory();
      };
    });
    // 拖动
    makeDraggable($('#vnh-head'), panelEl);

    $('#vnh-extract').onclick = onExtract;
    $('#vnh-cap-manual').onclick = () => captureAndPush('manual');
    $('#vnh-cap-auto').onclick = () => captureAndPush('auto');
    $('#vnh-gen').onclick = onGenerate;
    $('#vnh-sync').onclick = onSync;
    $('#vnh-copy').onclick = onCopy;
    $('#vnh-export').onclick = onExport;
    $('#vnh-diag').onclick = onDiagnostics;
  }

  function setStatus(text, isErr) {
    if (!panelEl) return;
    const el = panelEl.querySelector('#vnh-status');
    el.textContent = text || '';
    el.className = isErr ? 'vnh-err' : '';
  }

  // 防重复提交：生成/同步/导出期间禁用所有按钮，
  // 否则连点两下会并发发起多个大模型请求，叠加后极易超时。
  const BUSY_IDS = ['vnh-extract', 'vnh-cap-manual', 'vnh-cap-auto', 'vnh-gen', 'vnh-sync', 'vnh-copy', 'vnh-export', 'vnh-diag'];
  function setBusy(busy) {
    if (!panelEl) return;
    for (const id of BUSY_IDS) {
      const el = panelEl.querySelector('#' + id);
      if (el) el.disabled = !!busy;
    }
  }

  function makeDraggable(handle, box) {
    let sx, sy, ox, oy, dragging = false;
    handle.onmousedown = (e) => {
      if (e.target.classList.contains('x')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
      document.onmousemove = (ev) => {
        if (!dragging) return;
        box.style.left = (ox + ev.clientX - sx) + 'px';
        box.style.top = (oy + ev.clientY - sy) + 'px';
        box.style.right = 'auto'; box.style.bottom = 'auto';
      };
      document.onmouseup = () => { dragging = false; document.onmousemove = null; };
    };
  }

  /* ----------------- 元数据 ----------------- */
  async function refreshMeta() {
    if (!state.adapter) return;
    try {
      const m = state.adapter.getMeta();
      state.meta = { title: m.title || document.title || '未命名视频', url: m.url || location.href, duration: m.duration || '' };
    } catch (_) {}
  }

  /* ----------------- 字幕提取 ----------------- */
  async function onExtract() {
    if (!state.adapter) return setStatus('未识别到适配平台。', true);
    setStatus('正在提取字幕…');
    try {
      const subs = await state.adapter.extractSubtitles();
      if (!subs || !subs.length) return setStatus('未找到公开字幕，请在播放页确认已开启字幕（CC）。', true);
      state.subtitles = subs;
      panelEl.querySelector('#vnh-sub').value = subs.map((x) => `[${x.time}] ${x.text}`).join('\n');
      // 流式字幕（百度网盘 AI 字幕等）：附上捕获进度，提示继续播放可补全
      const v = getVideo();
      if (v && isFinite(v.duration) && v.duration > 0) {
        setStatus(
          `已提取 ${subs.length} 条字幕（捕获至 ${fmtTime(v.currentTime || 0)} / ${fmtTime(v.duration)}）。` +
          '若为 AI 实时字幕，需完整播放一遍才能捕获全部，可继续播放后重新提取补全。'
        );
      } else {
        setStatus(`已提取 ${subs.length} 条字幕，可编辑后生成。`);
      }
    } catch (e) {
      setStatus(e.message || '字幕提取失败。', true);
    }
  }

  /* ----------------- 截帧 ----------------- */
  function getVideo() {
    if (!state.adapter) return null;
    return state.adapter.getVideoEl();
  }

  // 压缩 canvas 到 dataURL（按设置的最大宽度与质量）
  async function toDataURL(settings, canvas) {
    const w = Math.min(canvas.width, settings.imageMaxWidth || 720);
    const ratio = w / canvas.width;
    const out = document.createElement('canvas');
    out.width = w; out.height = Math.round(canvas.height * ratio);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL(settings.imageFormat || 'image/jpeg', Number(settings.imageQuality) || 0.75);
  }

  async function captureFrame(video) {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 360;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    const settings = state.settings || (await send({ action: 'getSettings' }).catch(() => null));
    try {
      return await toDataURL(settings || {}, c);
    } catch (e) {
      // 跨域 video 污染 canvas：改用可见标签页截图作为实时帧
      const r = await send({ action: 'captureTab' });
      return r.dataUrl;
    }
  }

  // 定位到指定时间并截帧。
  // 关键修复：原实现无限等待 'seeked' 事件——当 video.duration 为 Infinity（YouTube 等
  // MSE 流媒体）或seek 被忽略时，该事件可能永不触发，导致界面永久卡住。
  // 现在加超时兜底：超时后直接截当前画面。
  async function seekAndCapture(video, time, timeoutMs = 4000) {
    const safe = Number(time);
    if (!isFinite(safe) || safe < 0) return null;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const onSeeked = async () => {
        try { finish(await captureFrame(video)); }
        catch (e) { finish(null); }
      };
      const timer = setTimeout(() => {
        // 兜底：不等 seek，直接截当前画面
        captureFrame(video).then(finish).catch(() => finish(null));
      }, timeoutMs);
      video.addEventListener('seeked', onSeeked, { once: true });
      try {
        video.currentTime = safe;
      } catch (_) {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function renderThumbs() {
    const box = panelEl.querySelector('#vnh-thumbs');
    box.innerHTML = '';
    state.frames.forEach((f, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'cap';
      const img = document.createElement('img');
      img.src = f.dataUrl; img.title = f.time;
      const del = document.createElement('span');
      del.textContent = '×'; del.style.cssText = 'position:absolute;top:0;right:0;background:#f53f3f;color:#fff;border-radius:50%;width:16px;height:16px;line-height:16px;text-align:center;cursor:pointer;font-size:12px';
      del.onclick = () => { state.frames.splice(i, 1); renderThumbs(); };
      wrap.appendChild(img); wrap.appendChild(del);
      box.appendChild(wrap);
    });
  }

  async function captureAndPush(mode) {
    const video = getVideo();
    if (!video) return setStatus('未找到播放器 video 元素。', true);
    setStatus('正在截取画面…');
    try {
      const settings = state.settings || (await send({ action: 'getSettings' }).catch(() => ({})));
      state.settings = settings;
      if (mode === 'manual') {
        const url = await captureFrame(video);
        state.frames.push({ time: fmtTime(video.currentTime), dataUrl: url });
      } else {
        // 自动：按总时长分段截取 3-6 张
        const n = Math.min(6, Math.max(3, Math.round(Number(settings.imageDensity)) || 4));
        // 流媒体（YouTube 等 MSE）video.duration 常为 Infinity/NaN，此时按比例分段无意义。
        // 策略：先尝试读取已知时长；不可用时改为「播放中连续采样」。
        let dur = Number(video.duration);
        const known = isFinite(dur) && dur > 0;
        state.frames = [];
        if (known) {
          for (let i = 0; i < n; i++) {
            const t = (dur * (i + 0.5)) / n;
            setStatus(`正在截取画面…（${i + 1}/${n}）`);
            const url = await seekAndCapture(video, t);
            if (url) state.frames.push({ time: fmtTime(t), dataUrl: url });
          }
          // 截帧会改动播放进度，回到开头
          try { video.currentTime = 0; } catch (_) {}
        } else {
          // 未知时长：让视频播放，按固定间隔连续采样当前画面
          setStatus(`视频时长未知（流媒体常见），将连续采样 ${n} 帧，请保持视频播放…`);
          try { if (video.paused) await video.play(); } catch (_) {}
          const stepMs = 1500;
          for (let i = 0; i < n; i++) {
            const t = video.currentTime || 0;
            const url = await captureFrame(video);
            if (url) state.frames.push({ time: fmtTime(t), dataUrl: url });
            if (i < n - 1) await new Promise((r) => setTimeout(r, stepMs));
          }
        }
      }
      renderThumbs();
      setStatus(`已截取 ${state.frames.length} 张配图。`);
    } catch (e) {
      setStatus(e.message || '截帧失败。', true);
    }
  }

  /* ----------------- 生成笔记 ----------------- */
  async function onGenerate() {
    if (!state.adapter) return setStatus('未识别到适配平台。', true);
    const subText = panelEl.querySelector('#vnh-sub').value.trim();
    if (!subText) return setStatus('请先提取或粘贴字幕。', true);
    let settings;
    try {
      settings = state.settings || await send({ action: 'getSettings' });
    } catch (e) {
      return setStatus('读取扩展设置失败：' + (e.message || '请点击扩展图标刷新页面后重试'), true);
    }
    state.settings = settings;
    if (!settings.apiBase || !settings.apiKey) {
      return setStatus('尚未配置大模型 API，请点击扩展图标打开设置页填写。', true);
    }
    setStatus('正在调用大模型生成笔记…');
    setBusy(true);
    try {
      const subs = subText.split('\n').map((line) => {
        const m = line.match(/^\[([\d:]+)\]\s*(.*)$/);
        return m ? { time: m[1], text: m[2] } : { time: '', text: line };
      }).filter((x) => x.text);
      const payload = {
        platform: state.adapter.platform,
        title: state.meta.title,
        url: state.meta.url,
        duration: state.meta.duration,
        subtitles: subs,
        frames: state.frames,
      };
      const res = await send({ action: 'generateNote', payload });
      state.markdown = res.markdown;
      panelEl.querySelector('#vnh-md').value = res.markdown;
      if (res.sync && res.sync.link) {
        state.lastSync = res.sync;
        setStatus('笔记已生成并自动同步到 Obsidian：' + res.sync.notePath);
      } else if (res.sync && res.sync.error) {
        setStatus('笔记已生成；自动同步失败：' + res.sync.error, true);
      } else {
        setStatus('笔记已生成。可手动同步或导出。');
      }
    } catch (e) {
      setStatus(e.message || '生成失败。', true);
    } finally {
      setBusy(false);
    }
  }

  /* ----------------- 同步 Obsidian ----------------- */
  async function onSync() {
    if (!state.markdown) return setStatus('请先生成笔记。', true);
    setStatus('正在同步到 Obsidian…');
    setBusy(true);
    try {
      const r = await send({
        action: 'syncObsidian',
        payload: { markdown: state.markdown, frames: state.frames, title: state.meta.title, platform: state.adapter.platform },
      });
      if (r.error) return setStatus(r.error, true);
      state.lastSync = r;
      setStatus('已同步：' + r.notePath);
      if (r.link) window.open(r.link, '_blank');
    } catch (e) {
      setStatus(e.message || '同步失败。', true);
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!state.markdown) return setStatus('请先生成笔记。', true);
    try {
      await navigator.clipboard.writeText(state.markdown);
      setStatus('已复制到剪贴板。');
    } catch (_) { setStatus('复制失败，请手动选择文本复制。', true); }
  }

  // 一键导出诊断信息：把配置、最近错误与原始响应汇总复制到剪贴板
  async function onDiagnostics() {
    try {
      const r = await send({ action: 'getDiagnostics' });
      if (!r || !r.text) return setStatus('未能生成诊断信息。', true);
      await navigator.clipboard.writeText(r.text);
      setStatus('诊断信息已复制到剪贴板，可直接粘贴反馈（不含完整密钥）。');
    } catch (e) {
      setStatus('复制诊断信息失败：' + (e.message || '请重试'), true);
    }
  }

  async function onExport() {
    if (!state.markdown) return setStatus('请先生成笔记。', true);
    setStatus('正在打包导出…');
    setBusy(true);
    try {
      const r = await send({ action: 'exportZip', payload: { markdown: state.markdown, frames: state.frames, title: state.meta.title } });
      if (!r || !r.base64) throw new Error('打包失败：后台未返回数据。');
      // base64 → Blob → objectURL：绕开 Chrome 对 data: URL 下载的约 2MB 限制
      const bin = atob(r.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename || 'video-note.zip';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
      setStatus('导出完成，请在下载目录查看 ZIP。');
    } catch (e) { setStatus(e.message || '导出失败。', true); }
    finally { setBusy(false); }
  }

  /* ----------------- 历史记录 ----------------- */
  async function loadHistory() {
    const box = panelEl.querySelector('#vnh-hist');
    box.innerHTML = '加载中…';
    try {
      const res = await send({ action: 'getHistory' });
      const list = res.history || [];
      if (!list.length) { box.innerHTML = '<div style="color:#86909c">暂无历史记录。</div>'; return; }
      box.innerHTML = '';
      list.forEach((it) => {
        const d = document.createElement('div');
        d.className = 'it';
        d.innerHTML = `<b>${escapeHtml(it.title)}</b><br><span style="color:#86909c">${it.platform} · ${it.created.slice(0, 10)} · ${it.frameCount} 图</span>`;
        d.onclick = () => {
          state.markdown = it.markdown;
          panelEl.querySelector('#vnh-md').value = it.markdown;
          panelEl.querySelector('#vnh-sub').value = '';
          panelEl.querySelectorAll('#vnh-tabs button').forEach((x) => x.classList.remove('on'));
          panelEl.querySelector('#vnh-tabs button[data-tab="main"]').classList.add('on');
          panelEl.querySelector('#vnh-main').style.display = '';
          panelEl.querySelector('#vnh-history').style.display = 'none';
          setStatus('已载入历史笔记，可重新同步/导出。');
        };
        box.appendChild(d);
      });
    } catch (e) { box.innerHTML = '<div class="vnh-err">' + (e.message || '加载失败') + '</div>'; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ----------------- 适配器注册与初始化 ----------------- */
  // 注入后不自动弹出面板：只完成适配器注册与元数据刷新，
  // 面板由用户点击扩展图标（popup 发送 vnh-show 消息）时按需构建。
  function init() {
    const adapter = window.VNH_ADAPTER;
    if (!adapter) {
      // 适配器尚未就绪，稍后重试
      setTimeout(init, 300);
      return;
    }
    state.adapter = adapter;
    refreshMeta();
  }

  // 供 popup 查询当前页面状态 / 请求显示面板
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.action === 'getContentStatus') {
      sendResponse({
        platform: state.adapter ? state.adapter.platform : null,
        meta: state.meta,
        frames: state.frames.length,
        subs: state.subtitles.length,
        md: !!state.markdown,
      });
    } else if (msg.action === 'vnh-show') {
      // 用户从扩展图标点开：构建/显示面板并刷新一次元数据
      buildPanel();
      if (state.adapter) refreshMeta();
      sendResponse({ ok: true, platform: state.adapter ? state.adapter.platform : null });
    } else if (msg.action === 'vnh-status') {
      // 后台推送的实时进度（如分组生成进度、重试提示）
      // 它同时是"后台仍在工作"的心跳证据 → 重置看门狗，避免长任务被误判超时
      feedWatchdog();
      if (panelEl && msg.text) setStatus(msg.text);
    }
    return true;
  });

  // SPA 路由切换：YouTube/Bilibili 使用 history pushState，URL 变化需刷新元数据
  function watchRoute() {
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (state.adapter) {
          state.subtitles = []; state.frames = []; state.markdown = '';
          if (panelEl) {
            panelEl.querySelector('#vnh-sub').value = '';
            panelEl.querySelector('#vnh-md').value = '';
            panelEl.querySelector('#vnh-thumbs').innerHTML = '';
            setStatus('检测到页面切换，已重置字幕与配图，请重新提取。');
          }
          refreshMeta();
        }
      }
    };
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function () { _ps.apply(this, arguments); check(); };
    history.replaceState = function () { _rs.apply(this, arguments); check(); };
    window.addEventListener('popstate', check);
    setInterval(check, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init(); watchRoute(); });
  else { init(); watchRoute(); }
})();
