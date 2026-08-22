# Video Note Helper · 视频图文笔记助手

> 自动识别 **百度网盘 / B站 / YouTube** 视频 → 提取公开字幕 → 截取关键帧配图 → 调用**你自有**的大模型生成结构化图文笔记 → 一键同步到本地 **Obsidian**。
>
> **纯前端、本地运行、零第三方依赖、无需构建工具。** 代码全部为原生 JavaScript / HTML / CSS，拿到文件即可加载使用。

---

## ✨ 功能特性

| 模块 | 说明 |
| --- | --- |
| **多平台适配** | 自动识别百度网盘、B站（bilibili.com）、YouTube（youtube.com）；非支持平台不显示面板 |
| **字幕提取** | 分平台抓取公开可见字幕，统一为 `[{ time, text }]`；面板内可预览与编辑 |
| **关键帧截取** | 通过 `<canvas>` 捕获播放器当前帧（纯前端本地，跨域时自动回退为可见标签页截图）；支持手动 / 自动两种模式 |
| **大模型接入** | 兼容 OpenAI 标准接口，配置永久本地保存；密钥、模型均由用户提供，插件不内置任何密钥或默认收费接口 |
| **图文笔记生成** | 输出标准 Obsidian Markdown，含 YAML 元数据、章节结构、配图引用；支持自定义提示词模板与标签 |
| **Obsidian 同步** | 基于社区插件 `Local REST API` 本地通信，自动写入笔记与图片附件，返回 `obsidian://` 跳转链接 |
| **基础交互** | 悬浮面板：提取字幕 / 生成笔记 / 同步 / 复制 / 导出压缩包；时间戳可点击跳转；本地历史记录 |

---

## 📦 目录结构

```
video-note-helper/
├── src/                     # 插件核心源码（加载扩展时选此文件夹）
│   ├── manifest.json        # Manifest V3 配置（权限最小化 + 注释）
│   ├── background.js        # 后台：LLM 调用 / ZIP 打包 / Obsidian 同步 / 消息路由
│   ├── content/
│   │   ├── common.js        # 公共悬浮面板、截帧、通信
│   │   └── adapters/
│   │       ├── baidu.js     # 百度网盘适配器
│   │       ├── bilibili.js  # B站适配器
│   │       └── youtube.js  # YouTube 适配器
│   ├── options/             # 设置页（大模型 / Obsidian / 配图 / 提示词）
│   ├── popup/               # 浏览器工具栏弹窗（状态 + 入口）
│   └── assets/              # 16/48/128 尺寸图标
├── docs/                    # 文档体系
│   ├── install-guide.md     # 安装教程
│   ├── config-guide.md      # 配置教程（大模型 + Obsidian）
│   ├── changelog.md         # 更新日志
│   └── faq.md               # 常见问题排查
├── .github/                 # Issue / PR 模板
├── .gitignore
├── LICENSE                  # MIT 协议
└── README.md
```

---

## 🚀 安装与使用方法

### 方式一：本地加载（开发者模式）

1. 下载本仓库并解压，记住 `src/` 文件夹路径。
2. 打开 Chrome / Edge 浏览器，进入 `chrome://extensions`（或 `edge://extensions`）。
3. 右上角开启 **开发者模式（Developer mode）**。
4. 点击 **加载已解压的扩展程序（Load unpacked）**，选择本仓库的 `src/` 目录。
5. 固定扩展图标到工具栏，点击图标可打开状态弹窗与设置页。

> 详细图文步骤见 [docs/install-guide.md](docs/install-guide.md)。

### 方式二：使用流程

1. 在扩展设置中填写 **大模型 API**（OpenAI 兼容：`base_url` / `API Key` / 模型名）。
2. 进入 B站 / YouTube / 百度网盘 的 **公开视频** 播放页，点击工具栏扩展图标 → **「打开笔记面板」**（面板不会自动弹出，按需打开）。
3. ① 点击 **提取字幕**（可手动编辑）→ ② 点击 **插入当前帧** 或 **自动按章节截帧** → ③ 点击 **生成图文笔记**。
4. 生成后：一键 **同步 Obsidian** / **复制全文** / **导出 MD+图片压缩包**。

> 大模型与 Obsidian 的详细配置见 [docs/config-guide.md](docs/config-guide.md)。

---

## ⚠️ 免责声明

1. 本项目**仅供个人学习研究使用，禁止商业用途**。
2. 仅提取页面**公开字幕**与**播放器实时画面**，不实现视频下载、破解限速、绕过会员、提取视频源文件，也不破解各平台付费/会员视频的播放与字幕限制。
3. 请遵守各平台服务协议与版权规定，尊重内容创作者权益。
4. **所有数据本地运行**，开发者不收集任何用户的字幕、截图、配置、密钥或生成内容。

---

## 🤝 贡献指南

欢迎提交 Issue 与 Pull Request！

- Bug 反馈请使用 `.github/ISSUE_TEMPLATE/bug_report.md` 模板，附上平台、链接（可脱敏）、复现步骤与控制台报错。
- 功能建议请使用 `feature_request.md` 模板。
- 提交 PR 前请阅读 `.github/PULL_REQUEST_TEMPLATE.md`，确保代码通过基础校验、并补充必要说明。
- 新增平台适配器时，请参照 `src/content/adapters/` 下现有文件实现统一接口（`platform / getMeta / getVideoEl / extractSubtitles`）。

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。请在分发与使用本软件时保留版权与许可声明。
