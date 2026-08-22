# 更新日志（Changelog）

本项目遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/) 规范：版本号格式为 `主版本.次版本.修订号`。

---

## [1.0.0] - 2026-08-22

### 新增功能
- 多平台适配：自动识别百度网盘、B站（bilibili.com）、YouTube（youtube.com），非支持平台隐藏面板。
- **面板按需打开**：打开视频页不再自动弹出操作面板；点击工具栏扩展图标 → 弹窗「打开笔记面板」才显示（幂等，可随时再次唤出）。
- 字幕提取：分平台抓取公开可见字幕，统一输出 `[{ time, text }]` 标准格式，面板内支持预览与手动编辑。
  - B站：优先官方 CC 字幕，其次 AI 自动字幕。
  - YouTube：优先官方上传字幕，其次自动生成字幕，默认取页面显示语言。
  - 百度网盘：优先读取播放器文本轨道 / 字幕渲染容器；实时捕获采用 `timeupdate` 事件驱动（跟随播放节奏，字幕切换不漏句）+ 800ms 轮询兜底，支持同源 iframe 内播放器与流式字幕渐进合并（消除 AI 字幕「短句→完整句」更新产生的碎片）；提取前自动补抓当前句并短暂重试；提取成功提示附「捕获至 X / 总时长 Y」进度，提示用户完整播放可补全。
- 关键帧截取：`<canvas>` 捕获播放器当前帧（纯前端本地），跨域时自动回退为可见标签页截图；支持手动与自动两种模式。
- 大模型接入：兼容 OpenAI `/v1/chat/completions` 标准接口；支持 `base_url / API Key / 模型 / temperature / 最大 token` 本地配置；完整中文错误处理与一键重试。
- 图文笔记生成：标准 Obsidian Markdown 输出，含 YAML 元数据、章节结构、配图引用；支持自定义提示词模板、YAML 字段、标签体系。
- Obsidian 同步：基于社区插件 `Local REST API` 本地接口通信，自动写入笔记与图片附件，返回 `obsidian://` 跳转链接；支持覆盖/新建选择。
- 基础交互：悬浮面板（提取字幕 / 生成 / 同步 / 复制 / 导出 MD+图片压缩包）、本地历史记录、SPA 路由切换自动刷新。

### 优化调整
- 严格遵循 Chrome Manifest V3，权限最小化（`storage / activeTab / scripting / downloads`），每个权限附用途注释。
- 纯原生 JavaScript / HTML / CSS 实现，零第三方依赖、无构建步骤、离线可用。
- 模块化架构：公共核心与分平台适配器分离，统一标准接口，便于扩展。

### 问题修复
- **字幕无法提取（核心修复）**：内容脚本直接 `fetch` 平台接口会因跨域（CORS）被拦截，导致三平台字幕均无法抓取。改为所有接口经**后台 Service Worker 代发（proxyFetch）**，彻底绕过 CORS。
- **B站 WBI 签名失败**：`x/player/wbi/v2` 需 WBI 签名，原自写 MD5 在第 4 轮（md5ii）存在常量错误，导致所有签名请求失败。已替换为经验证的 blueimp/JavaScript-MD5 实现，并保留「免签名 / 旧版 `x/player/v2`」两层兜底，提升不同视频的兼容性。
- **B站 cid 获取**：`x/web-interface/view` 代发时附带 `Referer` 与页面 `Cookie`，降低 `-412` 风控概率。
- **Obsidian 同步后提示「Vault not found」**：原因是在未探测到库名时使用了 `obsidian://open?path=...` 链接，Obsidian 无法据此定位 vault。已新增「库名（Vault）」设置项；优先使用用户填写的库名生成 `obsidian://open?vault=...&file=...`，未填写时仅显示同步成功路径、不再尝试打开，避免弹窗报错。
- **图片链接断链（图片已上传但笔记显示裂图）**：默认图片格式为 JPEG，上传文件名为 `frame_N.jpg`，而提示词让模型写 `frame_N.png`，旧替换映射 key 为 `frame_N.jpg`，导致 markdown 内的 `frame_N.png` 永远匹配不上、链接失效。已为每帧注册 `frame_N` / `frame_N.png` / `frame_N.jpg` 三个别名统一替换；ZIP 导出同步采用相同逻辑。
- **Obsidian 中提示「找不到 frame_N.png」**：markdown 内写入的是 vault 绝对路径（如 `VideoNotes/B站/attachments/frame_2.jpg`），但 Obsidian 默认按**相对当前 md 文件**解析图片链接，导致路径解析错误。已新增 `getRelativePath()` 计算图片相对笔记目录的相对路径（如 `./attachments/frame_2.jpg`），并新增 `ensureDir()` 在同步前自动创建附件目录（失败则降级把图片放到笔记同目录），确保图片真实存在且链接可解析。
- **导出 ZIP 报错 `URL.createObjectURL is not a function`**：Service Worker 无 DOM API，无法使用 `URL.createObjectURL`。已新增 `bytesToBase64()`，将 ZIP 字节流转为 base64 data URL 后调用 `chrome.downloads.download`。
- **点击历史记录报错 `$ is not defined`**：`$` 只在 `bindEvents()` 内部定义，`loadHistory()` 越级访问导致未定义。已改为 `panelEl.querySelector(...)`。
- **图片引用扩展名重复（如 `./frame_1.jpg.png`）**：多别名 `frame_N / frame_N.png / frame_N.jpg` 顺序替换时，`frame_1` 作为前缀先命中了 `frame_1.png`，导致结果变成 `./frame_1.jpg.png`。已改为**两阶段替换**：先把所有别名统一替换成临时占位符 `__VNH_IMG_N__`，再一次性替换为真实路径。`syncToObsidian` 与 `exportZip` 均已同步修改。
- **多视频图片互相覆盖**：原实现把所有图片放在 `VideoNotes/平台/` 或 `VideoNotes/平台/attachments/` 下，不同视频的 `frame_1.jpg` 会互相覆盖。已改为**每篇笔记独立子目录**：`VideoNotes/平台/笔记标题/笔记标题.md`，图片放在 `VideoNotes/平台/笔记标题/attachments/` 下，markdown 内引用 `./attachments/frame_N.jpg`。`ensureDir()` 同时改为逐层创建目录，兼容 Local REST API 无法一次创建多级目录的情况。
- **笔记结构美化**：新增 `buildFrontmatter()` 按设置字段与真实数据生成规范 YAML 元信息头，并自动拼接 `# 标题`；系统提示词改为只输出正文（不重复 YAML/标题），要求分章小标题、列表要点、表格对比、Obsidian Callout 突出重点，末尾以 `> [!summary]` 给出要点回顾。
- **百度网盘字幕提取失败**：原实现仅依赖 MutationObserver 读变动节点自身文本（字幕常被拆子节点而漏抓），且 `findSubtitleRoot` 只搜主文档、百度播放器常在同源 iframe 内导致根本找不到字幕节点。已重写为「轮询读当前字幕文本（每 800ms）+ 观察器触发」双保险，并同时遍历 `document` 与同源 `iframe.contentDocument`；新增 `scoreText()` 打分从候选文本中挑出真正的字幕（排除倍速/全屏等 UI 文字）；提取失败提示改为可操作步骤（开启字幕→开启 AI 字幕→播放→再提取）。
- **YouTube 字幕解析**：`ytInitialPlayerResponse` 改用平衡括号扫描提取，避免正则对超大内联 JSON 失效；字幕下载同样走后台代发。
- **百度网盘字幕**：新增对播放器实时字幕的 `MutationObserver` 捕获，并保留 `textTracks` / DOM 兜底路径。

---

## 版本规则说明
- **主版本号（Major）**：不兼容的接口或架构变更。
- **次版本号（Minor）**：向下兼容的新功能。
- **修订号（Patch）**：向下兼容的问题修复。

> 发布首个 Release 后，所有更新均在此文件按「新增功能 / 问题修复 / 优化调整」分类记录。
