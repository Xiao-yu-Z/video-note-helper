// =============================================================
// content/adapters/youtube.js — YouTube 适配器（优化版）
// 修复要点：
//   1. 字幕下载经后台 proxyFetch 代发，彻底规避 CORS / 第三方源问题；
//   2. 多重策略获取 ytInitialPlayerResponse（全局变量 → 内联脚本解析）；
//   3. 同时兼容 XML(ttml) 与 json3 两种字幕格式解析。
// 仅抓取公开可见字幕，不破解任何付费/会员限制。
// =============================================================
(function () {
  'use strict';

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (r && r.error) return reject(new Error(r.error));
        resolve(r);
      });
    });
  }
  async function proxy(url) {
    const r = await send({ action: 'proxyFetch', payload: { url, method: 'GET' } });
    return r; // {status, text}
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // 多重策略获取播放器响应对象
  function getPlayerResponse() {
    try { if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse; } catch (_) {}
    const scripts = document.querySelectorAll('script');
    for (const sc of scripts) {
      const t = sc.textContent || '';
      const idx = t.indexOf('ytInitialPlayerResponse');
      if (idx === -1) continue;
      // 从 "ytInitialPlayerResponse" = {...} 起，平衡花括号解析
      const start = t.indexOf('{', idx);
      if (start === -1) continue;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < t.length; i++) {
        const ch = t[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch (_) { break; } } }
      }
    }
    return null;
  }

  function getVideoEl() {
    return document.querySelector('#movie_player video, #ytd-player video, video') || null;
  }

  function getMeta() {
    const pr = getPlayerResponse();
    const title = (document.querySelector('h1.title, h1.ytd-watch-metadata, #title h1, .title') || {}).textContent
      || (pr && pr.videoDetails && pr.videoDetails.title) || document.title || '未命名视频';
    const dur = pr && pr.videoDetails && pr.videoDetails.lengthSeconds;
    const vid = (pr && pr.videoDetails && pr.videoDetails.videoId) || (location.href.match(/[?&]v=([\w-]+)/) || [])[1] || '';
    return { title: title.trim(), url: 'https://www.youtube.com/watch?v=' + vid, duration: dur ? fmt(dur) : '' };
  }

  function pickTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    const official = tracks.filter((t) => t.kind !== 'asr');
    const byLang = official.find((t) => (t.languageCode || '').toLowerCase().startsWith(lang))
      || official.find((t) => (t.name && t.name.simpleText || '').toLowerCase().includes(lang));
    const asr = tracks.find((t) => t.kind === 'asr' && (t.languageCode || '').toLowerCase().startsWith(lang))
      || tracks.find((t) => t.kind === 'asr');
    return byLang || asr || official[0] || tracks[0];
  }

  async function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const nodes = doc.getElementsByTagName('text');
    const list = [];
    for (const n of nodes) {
      const start = parseFloat(n.getAttribute('start') || '0');
      const content = (n.textContent || '').replace(/\n/g, ' ').trim();
      if (content) list.push({ time: fmt(start), text: content });
    }
    return list;
  }
  async function parseJson3(text) {
    const j = JSON.parse(text);
    const events = j.events || [];
    const list = [];
    for (const e of events) {
      if (!e.segs) continue;
      const content = e.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
      if (content) list.push({ time: fmt((e.tStart || 0) / 1000), text: content });
    }
    return list;
  }

  async function extractSubtitles() {
    const pr = getPlayerResponse();
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer
      && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!tracks || !tracks.length) throw new Error('该视频暂无公开字幕。可在 YouTube 播放器开启字幕后重试。');

    const track = pickTrack(tracks);
    let url = track.baseUrl;
    if (url.indexOf('fmt=') === -1) url += (url.indexOf('?') === -1 ? '?' : '&') + 'fmt=json3';
    const res = await proxy(url);
    if (!res || res.status !== 200) throw new Error('字幕下载失败（HTTP ' + (res && res.status) + '）。');
    const text = res.text || '';
    let list = [];
    try { list = await parseJson3(text); } catch (_) { try { list = await parseXml(text); } catch (_) {} }
    if (!list.length) {
      // 回退：尝试 XML 格式
      const res2 = await proxy(track.baseUrl + (track.baseUrl.indexOf('?') === -1 ? '?' : '&') + 'fmt=ttml');
      if (res2 && res2.status === 200) list = await parseXml(res2.text || '');
    }
    if (!list.length) throw new Error('字幕内容为空。');
    const out = [];
    for (const it of list) { if (out.length && out[out.length - 1].text === it.text) continue; out.push(it); }
    return out;
  }

  window.VNH_ADAPTER = { platform: 'youtube', getMeta, getVideoEl, extractSubtitles };
})();
