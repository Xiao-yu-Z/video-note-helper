// =============================================================
// shared/chunk.js — 长视频字幕分段
//
// 为什么需要：字幕越长 prompt 越大，一旦超出模型上下文就会「零输出」。
// 单纯截断字幕会丢内容，且截断多少难以预判。
// 分段生成则是把 N 万字切成若干段、每段单独调用模型，最后合并 ——
// 每个请求都很小，永远不会超上下文，且信息保留完整。
//
// 这里只放纯函数（无 chrome / DOM 依赖），便于单测。
// =============================================================

// "HH:MM:SS" 或 "MM:SS" → 秒；无法解析返回 null
export function timeToSec(t) {
  const m = String(t == null ? '' : t).match(/^(\d+):(\d+)(?::(\d+))?/);
  if (!m) return null;
  return m[3] !== undefined
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    : Number(m[1]) * 60 + Number(m[2]);
}

function makeChunk(items) {
  const secs = items.map((i) => timeToSec(i.time)).filter((v) => v !== null && v !== undefined);
  return {
    items,
    startSec: secs.length ? Math.min(...secs) : null,
    endSec: secs.length ? Math.max(...secs) : null,
  };
}

/**
 * 按字符预算把字幕切成若干段，切分点只落在字幕条目边界（不切断单条）。
 * subtitles: [{ time, text }]
 * 返回 [{ items, startSec, endSec }]
 */
export function splitSubtitleChunks(subtitles, chunkChars, maxChunks = 10) {
  const list = (subtitles || []).filter((s) => s && (s.text || '').trim());
  if (!list.length) return [];

  const weigth = (s) => (s.text || '').length + 12; // +12 估算时间戳与换行开销
  const total = list.reduce((n, s) => n + weigth(s), 0);

  const doSplit = (size) => {
    const out = [];
    let cur = [];
    let len = 0;
    for (const s of list) {
      const w = weigth(s);
      if (cur.length && len + w > size) {
        out.push(makeChunk(cur));
        cur = [];
        len = 0;
      }
      cur.push(s);
      len += w;
    }
    if (cur.length) out.push(makeChunk(cur));
    return out;
  };

  // 段数上限保护：避免一次生成发几十个请求。
  // 注意：贪心切分按条目边界断开，每段都装不满 size，所以 ceil(total/maxChunks)
  // 往往仍会多出 1~2 段，必须迭代放大 size 直到真正满足上限。
  let size = Math.max(400, Number(chunkChars) || 6000);
  if (maxChunks > 0 && total / size > maxChunks) size = Math.ceil(total / maxChunks);
  let chunks = doSplit(size);
  for (let guard = 0; maxChunks > 0 && chunks.length > maxChunks && guard < 6; guard++) {
    size = Math.ceil(size * (chunks.length / maxChunks) * 1.02);
    chunks = doSplit(size);
  }
  return chunks;
}

/**
 * 把截图分配到各段（按时间落在哪一段），保证 LLM 引用的是**全局编号**。
 * frames: [{ time, dataUrl }]（原始顺序即 frame_1..frame_n）
 * 返回 [[{ index, time }], ...]，与 chunks 一一对应
 */
export function assignFramesToChunks(frames, chunks) {
  const buckets = (chunks || []).map(() => []);
  if (!buckets.length) return buckets;
  (frames || []).forEach((f, i) => {
    const t = timeToSec(f && f.time);
    let target = buckets.length - 1; // 无法定位时间的一律归到最后一段
    if (t !== null && t !== undefined) {
      for (let c = 0; c < chunks.length; c++) {
        const end = chunks[c].endSec;
        if (end === null || end === undefined || t <= end) { target = c; break; }
      }
    }
    buckets[target].push({ index: i + 1, time: (f && f.time) || '' });
  });
  return buckets;
}
