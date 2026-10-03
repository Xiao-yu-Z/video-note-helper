// =============================================================
// shared/llm-parse.js — 大模型响应解析（background 与 options 共用）
//
// 为什么独立成模块：这段逻辑此前在 background.js 与 options.js 各存一份，
// 已出现行为漂移（一处修了另一处没修）。统一在此维护，两处 import 使用。
//
// 设计原则：**宁可给出可诊断的证据，也不要给"解析失败"这类无信息量的提示。**
// 对接不确定的第三方网关时，"解析不到预期结构"远比"解析报错"更难排查。
// =============================================================

// 从一条 SSE 分片对象中提取文本
function pickText(obj, paths) {
  for (const get of paths) {
    let v;
    try { v = get(); } catch (_) { continue; }
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') { if (v) return v; continue; }
    if (Array.isArray(v)) {
      // 多模态：content 可能是 [{type:'text',text:'...'}, ...]
      const s = v.map((x) => (typeof x === 'string' ? x : x?.text || x?.content || '')).join('');
      if (s) return s;
    }
  }
  return '';
}

// 解析 SSE 流：返回 { content, reasoning, usage, stats }
export function parseSSE(raw) {
  let content = '';
  let reasoning = '';
  let contentChunks = 0; // 有内容的有效分片
  let usageChunks = 0;   // 仅含用量统计的分片（choices 为空数组）
  let badChunks = 0;     // 解析失败的分片
  let firstBad = '';
  let sawError = null;
  let usage = null;
  const keys = new Set();
  let pending = '';

  const handleChunk = (payload) => {
    const j = JSON.parse(payload);
    if (j && j.error) {
      sawError = (typeof j.error === 'string' ? j.error : j.error.message)
        || JSON.stringify(j.error).slice(0, 200);
      return;
    }
    if (j && j.usage) usage = j.usage;
    if (j && typeof j === 'object') for (const k of Object.keys(j)) keys.add(k);

    // choices 为空数组 = 纯用量统计分片（stream_options.include_usage 的标准收尾），
    // 属正常现象，不计入"无文本字段"的诊断依据
    if (Array.isArray(j?.choices) && j.choices.length === 0) { usageChunks++; return; }

    // 注意：不能因缺少 choices[0] 就 return——
    // Ollama 原生格式（{message:{content}} / {response:"..."}）没有 choices 字段。
    const d = j?.choices?.[0] || {};
    const gotContent = pickText(j, [
      () => d.delta?.content,
      () => d.message?.content,
      () => d.text,
      () => d.delta?.text,
      () => j.message?.content,  // Ollama /api/chat
      () => j.response,          // Ollama /api/generate
    ]);
    const gotReasoning = pickText(j, [
      () => d.delta?.reasoning_content,
      () => d.delta?.reasoning,
      () => d.message?.reasoning_content,
      () => j.message?.thinking,
    ]);
    content += gotContent;
    reasoning += gotReasoning;
    if (gotContent || gotReasoning) contentChunks++;
  };

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      // 空行在 SSE 中是事件边界：若此时仍有未解析成功的分片，
      // 说明它已无法靠续行补救 —— 记为坏分片而不是直接丢弃，
      // 否则内容会"凭空消失"且诊断信息里看不到任何痕迹。
      if (pending) { badChunks++; if (!firstBad) firstBad = pending.slice(0, 120); pending = ''; }
      continue;
    }
    if (t.startsWith('data:')) {
      // 上一分片仍未解析成功 → 记为坏分片（绝不静默丢弃）
      if (pending) { badChunks++; if (!firstBad) firstBad = pending.slice(0, 120); pending = ''; }
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        handleChunk(payload);
      } catch (_) {
        pending = payload; // 分片可能被换行截断，等续行拼接
      }
    } else if (pending) {
      try {
        handleChunk(pending + t);
        pending = '';
      } catch (_) { pending += t; }
    }
  }
  if (pending) { badChunks++; if (!firstBad) firstBad = pending.slice(0, 120); }

  return {
    content, reasoning, usage, sawError,
    stats: { contentChunks, usageChunks, badChunks, firstBad, keys: [...keys] },
  };
}

/**
 * 容错解析大模型响应。
 * 兼容：标准 JSON → SSE 流式 → ```json 围栏 → 前后带杂讯。
 * 失败时抛出带reason 的错误，reason 取值见下，便于调用方做自动恢复。
 */
export function parseMaybeStream(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    const e = new Error('响应内容为空。');
    e.reason = 'EMPTY';
    throw e;
  }

  // 1) 直接 JSON
  try { return JSON.parse(raw); } catch (_) {}

  // 2) SSE 流式
  if (/^\s*(data:|event:|id:|\s*$)/m.test(raw) || raw.includes('\ndata:')) {
    const r = parseSSE(raw);

    if (r.content.trim()) return { choices: [{ message: { content: r.content } }] };

    if (r.reasoning.trim()) {
      // 只有思考过程、没有正文：几乎都是 max_tokens 被思考吃光
      const e = new Error(
        '模型只输出了思考过程、没有生成正文。\n' +
        '常见原因：推理模型（deepseek-r1 / o1 / qwen-thinking 等）的思考过程耗尽了 max_tokens 预算。\n' +
        '解决办法：① 在设置页把「最大输出 Token」调大（建议 4000 以上）；' +
        '② 或改用非推理模型；③ 或在「自定义系统提示词」中要求模型直接给出结论、不要长篇推理。'
      );
      e.reason = 'REASONING_ONLY';
      throw e;
    }

    if (r.sawError) {
      const e = new Error(`接口在流式响应中返回错误：${r.sawError}`);
      e.reason = 'UPSTREAM_ERROR';
      throw e;
    }

    // ---- 一个 token 都没生成 ----
    if (r.usage && Number(r.usage.completion_tokens) === 0) {
      const e = new Error(
        `模型没有生成任何内容（completion_tokens=0）。输入已被接口正常接收（prompt_tokens=${r.usage.prompt_tokens}），但模型未产出任何输出。\n` +
        '常见原因与对策：\n' +
        `① 提示词过长或超出该模型上下文（本次输入约 ${r.usage.prompt_tokens} tokens）→ 在设置页调低「字幕送入模型上限」后重试；\n` +
        '② 账户余额 / 配额不足，或该模型未开通 → 到服务商控制台确认；\n' +
        '③ 该模型不支持当前参数组合（如 temperature / max_tokens）→ 换个模型试试。'
      );
      e.reason = 'ZERO_OUTPUT';
      e.usage = r.usage;
      throw e;
    }

    // ---- 兜底诊断：把实际结构摆出来 ----
    const { contentChunks, usageChunks, badChunks, firstBad, keys } = r.stats;
    const total = contentChunks + usageChunks + badChunks;
    if (total > 0 || keys.length) {
      const detail = [
        `流式响应共 ${total} 个分片：有内容 ${contentChunks} 个 / 仅用量统计 ${usageChunks} 个 / 解析失败 ${badChunks} 个。`,
        badChunks ? `首个解析失败的分片开头：${firstBad}` : '',
        `实际出现的字段：${keys.slice(0, 12).join(', ') || '（无）'}`,
        r.usage ? `用量：prompt=${r.usage.prompt_tokens} completion=${r.usage.completion_tokens}` : '',
        `响应开头：${raw.slice(0, 200).replace(/\s+/g, ' ')}`,
      ].filter(Boolean).join('\n');
      const e = new Error(detail);
      e.reason = 'NO_TEXT_FIELD';
      throw e;
    }
  }

  // 3) ```json ... ``` 包裹
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) {}
  }

  // 4) 截取第一段平衡花括号再试
  const s = raw.indexOf('{');
  if (s !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(s, i + 1)); } catch (_) { break; } } }
    }
  }

  // 5) 都不是 → 抛出可诊断的错误
  const e = new Error('响应不是合法 JSON：' + raw.slice(0, 160).replace(/\s+/g, ' '));
  e.reason = 'NOT_JSON';
  throw e;
}

// 从已解析的响应对象中取出正文文本（兼容字符串与多模态数组）
export function textFromParsed(data) {
  const choice = data?.choices?.[0];
  const raw = choice?.message?.content ?? choice?.delta?.content ?? choice?.text;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).join('');
  return '';
}
