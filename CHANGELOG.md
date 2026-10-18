# Changelog

记录 Open Dev Container 的用户可见改动。版本号沿用仓库中的 Git 标签。

## [0.0.5] - 2026-10-18

### 新增

- 支持 Remote SSH 远程窗口：容器命令会通过 `ssh <远程主机别名>` 转发到远端执行，因此在 SSH 窗口中列出和操作的是远程主机上的容器，而不是本机的容器。
- 新增 `openDevContainer.remoteHost` 设置，可显式指定远程 SSH 主机别名；留空时从当前远程工作区自动推导。
- 远程主机只接受密码登录时会提示输入一次，密码保存在扩展的本地存储中（0600），通过 `SSH_ASKPASS` 提供给 ssh，不进入命令行。
- SSH 配置改为写入独立文件 `~/.ssh/config.d/open-dev-container.conf`，仅在主配置中追加一行 `Include`，不再把托管块直接写进 `~/.ssh/config`；已有块会自动迁移。

### 改进

- 容器面板标题栏显示容器命令的执行位置（`Local` 或 `Remote · <别名>`）。
- 转发时对命令参数逐一加引号，避免远端 shell 二次解析 `{{json .}}` 之类的特殊字符。
- 远程执行失败时仍按容器引擎错误特征归类（CLI 缺失、守护进程不可达、权限不足）。

### 修复

- 修复在容器窗口内打开面板时把容器自身的 SSH 别名当成执行目标、进而在容器内部查找容器并报 `No container runtimes detected` 的问题：现在会从托管 SSH 块的 `ProxyCommand` 回溯到真正运行容器的主机。
- 修复 `ProxyCommand` 的引号拼接错误：`env 'SSH_ASKPASS=...' SSH_ASKPASS_REQUIRE=force DISPLAY=:0` 前缀曾被整体包裹成一个参数，ssh 把它当成可执行文件名，导致 Remote SSH 在 100 多毫秒内静默失败。

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

[0.0.5]: https://github.com/Zwhy2025/open-dev-container/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/Zwhy2025/open-dev-container/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Zwhy2025/open-dev-container/releases/tag/v0.0.3
[0.0.2]: https://github.com/Zwhy2025/open-dev-container/releases/tag/v0.0.2
[0.0.1]: https://github.com/Zwhy2025/open-dev-container/releases/tag/v0.0.1
