// popup.js — 弹窗：按需打开页面面板、检测当前页面、打开设置
const PLATFORM_CN = { bilibili: 'B站', youtube: 'YouTube', baidu: '百度网盘' };

// 根据 URL 识别平台（与 manifest content_scripts 的 matches 保持一致）
function detectPlatform(url) {
  if (!url) return null;
  if (url.includes('bilibili.com') || url.includes('bilibili.tv') || url.includes('b23.tv') || url.includes('player.bilibili.com')) return 'bilibili';
  if (url.includes('youtube.com')) return 'youtube';
  if (url.includes('pan.baidu.com') || url.includes('yun.baidu.com')) return 'baidu';
  return null;
}

function setStatus(text, cls) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const btn = document.getElementById('openPanel');
  const tab = await getActiveTab();
  const platform = detectPlatform(tab && tab.url);
  if (!platform) {
    btn.disabled = true;
    btn.textContent = '📝 打开笔记面板';
    setStatus('当前页面不支持。\n请打开 B站 / YouTube / 百度网盘 的公开视频页。', 'no');
    return;
  }
  btn.disabled = false;
  btn.textContent = `📝 打开${PLATFORM_CN[platform] || ''}笔记面板`;
  // 向 content script 查询状态（面板可能尚未打开，仅作展示）
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { action: 'getContentStatus' });
    if (r && r.platform) {
      const title = r.meta && r.meta.title ? r.meta.title.slice(0, 24) : '当前视频';
      setStatus(`✅ 已适配：${PLATFORM_CN[r.platform] || r.platform}\n《${title}》\n字幕 ${r.subs} 条 · 配图 ${r.frames} 张${r.md ? ' · 已生成笔记' : ''}`, 'ok');
    } else {
      setStatus(`已检测到 ${PLATFORM_CN[platform]}，点击上方按钮打开面板即可使用。`, 'ok');
    }
  } catch (_) {
    setStatus(`已检测到 ${PLATFORM_CN[platform]}，点击上方按钮打开面板即可使用。`, 'ok');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refresh();

  // 打开面板：向当前页面 content script 发送 vnh-show 消息
  document.getElementById('openPanel').onclick = async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'vnh-show' });
      window.close(); // 关闭弹窗，让用户在页面面板上直接操作
    } catch (_) {
      setStatus('面板未就绪，请刷新视频页面后重试。', 'no');
    }
  };

  document.getElementById('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  document.getElementById('openGuide').onclick = () => {
    const help = `<!doctype html><meta charset=utf-8><title>使用说明</title>
<style>body{font:14px/1.8 sans-serif;padding:20px;max-width:640px;margin:auto}code{background:#f2f3f5;padding:2px 6px;border-radius:4px}h2{color:#3b82f6}</style>
<h2>快速上手</h2>
<ol>
<li>打开扩展设置（⚙️），填写 <b>大模型 API</b>（OpenAI 兼容：base_url / Key / 模型）。</li>
<li>如需同步到 Obsidian：安装社区插件 <code>Local REST API</code>，在设置中填写接口地址与密钥。</li>
<li>进入 B站 / YouTube / 百度网盘 的<b>公开视频</b>播放页。</li>
<li>点击浏览器工具栏的扩展图标 → 点 <b>「打开笔记面板」</b>，面板才会浮出（不会自动弹出）。</li>
<li>① 点击「提取字幕」抓取公开字幕（可手动编辑）。</li>
<li>② 点击「插入当前帧」或「自动按章节截帧」添加配图。</li>
<li>③ 点击「生成图文笔记」，稍候即可在预览框看到 Markdown。</li>
<li>可一键「同步 Obsidian」「复制全文」「导出 MD+图片压缩包」。</li>
</ol>
<p style="color:#86909c">所有数据本地运行，不上传任何服务器。详见仓库 docs/ 目录。</p>`;
    chrome.tabs.create({ url: 'data:text/html;charset=utf-8,' + encodeURIComponent(help) });
  };
});
