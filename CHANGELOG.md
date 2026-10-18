# Changelog

记录 Open Dev Container 的用户可见改动。版本号沿用仓库中的 Git 标签。

## [0.0.4] - 2026-10-18

### 新增

- 新增 `pack:debug` 调试打包：UUID 构建码、唯一内部版本和预发布标记；启动及附加日志显示构建来源。正式打包也会先重新编译。

- 新增 Docker / Podman 运行时探测、切换和记忆当前选择的功能。
- 新增自定义容器面板：运行时下拉框、刷新、分层容器列表、状态标签和最近连接。
- 容器列表从只显示运行中容器扩展为显示全部容器，并识别 Running、Stopped、Created、Paused、Restarting 等状态。
- 新增容器生命周期操作：Start、Stop、Restart 和 Remove；删除前需要确认。
- 新增 `Attach shell`，可从右键菜单打开容器终端。
- 新增 `openDevContainer.containerShell` 设置，默认使用 `bash`，可配置为 `/bin/bash`、`zsh` 等容器内命令。
- 新增附加过程日志：阶段状态、每步耗时以及容器内 `apt-get` / `openssh-server` 安装输出会实时写入 `Open Dev Container` 输出面板。
- 合入来自 `int3hh` 的 [PR #2](https://github.com/Zwhy2025/open-dev-container/pull/2)：Podman 支持、Distrobox 兼容修复、root sshd 修复、VSCodium 兼容、Nix Flake 打包和权限修复。

### 改进

- 容器操作从行内按钮移到右键菜单，按连接、生命周期和删除分组，减少误触。
- Docker 和 Podman 的容器输出统一解析，兼容 Podman 的容器 ID、名称和状态格式。
- 改进容器 sshd 准备、权限处理和命令错误诊断。
- 扩充自动化测试，覆盖运行时切换、容器状态、生命周期命令、面板操作和竞态场景。

## [0.0.3] - 2026-05-24

### 改进

- 补充扩展描述和 README 文档。
- 明确支持 Trae CN 等 VS Code 兼容编辑器。
- 增加仓库地址链接，并更新扩展描述信息。

## [0.0.2] - 2026-05-24

### 改进

- 更新扩展版本号。
- 更新发布者信息为 `Zwhy2025`。

## [0.0.1] - 2026-05-23

### 新增

- 初始实现 Open Dev Container 扩展。
- 支持列出运行中的 Docker 容器并通过 Remote SSH 附加到容器。
- 支持容器内 sshd 准备、SSH 配置块管理、最近连接、重连、断开和清理。
- 提供 TypeScript 编译、测试、构建和 VSIX 打包流程。
- 建立 CI、架构文档和 Node 内置测试基础设施。

[0.0.4]: https://github.com/Zwhy2025/open-dev-container/compare/v0.0.3...HEAD
[0.0.3]: https://github.com/Zwhy2025/open-dev-container/releases/tag/v0.0.3
[0.0.2]: https://github.com/Zwhy2025/open-dev-container/releases/tag/v0.0.2
[0.0.1]: https://github.com/Zwhy2025/open-dev-container/releases/tag/v0.0.1
