# Pull Request 模板 / Pull Request Template

感谢你为 Video Note Helper 做出贡献！提交 PR 前请阅读以下清单，并填写相关信息。

## 变更类型
- [ ] 新增功能（feature）
- [ ] 问题修复（bug fix）
- [ ] 优化调整（refactor / docs / chore）
- [ ] 其他（请说明）

## 关联 Issue
- 关闭 #（填写关联的 Issue 编号，如 #12）

## 变更说明
清晰描述本次 PR 做了什么、为什么做。

## 影响范围
- [ ] 百度网盘适配器
- [ ] B站适配器
- [ ] YouTube 适配器
- [ ] 公共逻辑 / 面板
- [ ] 后台 / 同步 / 导出
- [ ] 设置页 / 弹窗
- [ ] 文档

## 自检清单
- [ ] 代码为纯原生 JS / HTML / CSS，无新增第三方依赖
- [ ] 遵循 Manifest V3 规范，未扩大权限范围
- [ ] 新增/修改的适配器实现了统一接口（`platform / getMeta / getVideoEl / extractSubtitles`）
- [ ] 关键逻辑已加中文注释
- [ ] 不实现任何下载、破解限速、绕过会员、提取视频源文件等违规功能
- [ ] 已在目标平台页面手动验证功能正常
- [ ] 文档（README / docs）已同步更新（如涉及用户可见变更）

## 补充说明
其他需要 Reviewer 注意的事项。
