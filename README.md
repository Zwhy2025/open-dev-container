# Open Dev Container

Open Dev Container 让支持 Remote SSH 的 VS Code Compatible Editor，把正在运行的 Docker / Podman 容器作为开发工作区打开。目前已支持 Trae CN，理论上兼容所有支持 Remote SSH 的 VS Code Compatible Editor。常用功能为`Attach to Running Container`，连接过程本质上是将以下步骤自动化掉：

1. 选择一个正在运行的容器。
2. 在容器内准备 SSH 访问能力。
3. 在本机 SSH config 的独立文件 `~/.ssh/config.d/open-dev-container.conf` 写入受管理的 Host 配置块，并在主配置中追加一行 `Include`。
4. 通过 `vscode-remote://ssh-remote+...` 打开容器内工作区。

GitHub 仓库：[https://github.com/Zwhy2025/open-dev-container ](https://github.com/Zwhy2025/open-dev-container)

## 主要能力

- Activity Bar 视图按状态展示全部容器和最近连接。
- 同时支持 Docker 与 Podman：自动探测可用的运行时，面板下拉框可切换并记住选择，两者的容器输出统一解析。
- 支持 Attach、Reconnect、Disconnect、Clean SSH Config 和 Refresh。
- 自动生成并复用专用 SSH key。
- 自动根据容器 bind mount 推断容器内工作目录。
- 对容器引擎（Docker / Podman）、SSH、权限和配置写入失败提供明确诊断。
- `Disconnect Connection` 会同时删除 SSH config 配置块和最近连接记录。
- 最近连接读取时会过滤损坏数据，避免旧状态导致视图崩溃。

## 运行要求

- 支持 Remote SSH 的 VS Code 兼容编辑器。
- 主机上可用的 Docker CLI 或 Podman CLI（二选一即可，默认优先 docker）。
- 主机上可用的 `ssh` 和 `ssh-keygen`。
- 容器允许执行 `docker exec -u 0`（Podman 为 `podman exec -u 0`）。
- 如果容器里没有 `sshd`，需要 `apt-get`、`apk`、`dnf`、`yum`、`microdnf` 或 `pacman` 之一。

## 通过 Remote SSH 使用远程主机的容器

当编辑器通过 Remote SSH 连接到远程主机时，容器命令会经由 `ssh <远程主机别名>` 在远端执行，因此面板里列出和操作的是**远程主机上的容器**，而不是本机的容器。面板标题栏会显示当前执行位置（`Local` 或 `Remote · <别名>`）。

远程主机需要满足：

- 安装 Docker CLI 或 Podman CLI，且当前用户有访问权限。
- 从本机可以 SSH 到该主机：有可用密钥时直接复用；如果该主机只接受密码，扩展会提示输入一次，密码保存在扩展的本地存储中（0600），通过 `SSH_ASKPASS` 交给 ssh，不会出现在命令行或进程列表里。

别名默认从当前远程工作区推导；无法推导时可在 `openDevContainer.remoteHost` 中显式填写。

## 使用方法

在命令面板执行：

```text
Open Dev Container: Attach to Running Container
```

也可以在侧边栏的 `Open Dev Container` 视图里直接操作：

- 从容器列表附加。
- 从最近连接中重连。
- 断开已保存连接。
- 清理一个或全部 SSH 配置块。
- 刷新容器列表。

如果出现失败，优先查看输出通道 `Open Dev Container`，错误弹窗里也会提供 `Show Output` 入口。

开发时可以使用 `test/containers-up.sh` 创建 Docker / Podman 测试容器，使用 `test/containers-down.sh` 清理这些测试容器；脚本只删除带有 `odc-` 前缀的测试容器，保留镜像。

## 调试打包

调试打包使用 `npm run pack:debug`（或 `bash infra.sh pack-debug`）：每次先编译，再生成带 UUID 的 VSIX。调试包名称含 `Debug`，使用独立的时间戳内部版本，并标记为预发布；源码的正式版本保持不变。激活和 Attach 日志会打印完整构建码，激活日志还包含实际加载路径。调试包沿用扩展 ID，会替换当前安装；安装后请重载窗口。切回较低版本的正式包时，需卸载调试包再安装正式包。`npm run pack` 仍用于正式打包，不会发布到市场。

## 设置项

- `openDevContainer.dockerPath`：显式指定容器 CLI 路径；默认留空，表示自动探测可用的容器运行时（docker/podman）。
- `openDevContainer.remoteUser`：容器内登录用户，默认 `root`。
- `openDevContainer.workspaceFolder`：容器内打开的路径；留空时按挂载推断。
- `openDevContainer.installSshd`：缺少时尝试安装 `openssh-server`，默认 `true`。
- `openDevContainer.openInNewWindow`：是否在新编辑器窗口打开，默认 `true`。
- `openDevContainer.sshConfigPath`：SSH 配置路径；留空表示写入 `~/.ssh/config.d/open-dev-container.conf`，并只在 `~/.ssh/config` 中追加一行 `Include`。

容器运行时默认自动探测主机 PATH 中的 docker/podman（优先 docker）。容器面板顶部将 `Containers` 标题、`Docker` / `Podman` 文字下拉框、刷新和「…」菜单放在同一行，下方按 `Individual Containers` 分层展示所有容器及其状态（Running、Stopped、Created 等）和最近连接。容器行不放容易误触的操作按钮，右键菜单按状态提供 `Attach to container`、`Attach shell`、`Start`、`Stop`、`Restart` 和 `Remove`，菜单用分隔线区分连接、生命周期和删除操作；`Attach shell` 默认使用容器内的 `bash`，也可通过 `openDevContainer.containerShell` 设置为 `/bin/bash`、`zsh` 等命令，删除前会要求确认。点击下拉框可直接切换运行时，未检测到的选项会置灰；选择会被记住。若显式设置了 `dockerPath`，则以该设置为准。清理 SSH 配置入口位于「…」菜单中，也可针对单条最近连接执行。

最近连接会保存在扩展全局存储中，编辑器重启后仍然可用。

## Nix / NixOS

This repo ships a flake that builds the extension as a nixpkgs-style VS Code
extension derivation (`share/vscode/extensions/Zwhy2025.open-dev-container`).

```nix
# flake.nix of your NixOS / home-manager config
inputs.open-dev-container.url = "github:int3hh/open-dev-container";

# home-manager (VS Code or VSCodium – set `package` accordingly)
programs.vscode = {
  enable = true;
  package = pkgs.vscodium;   # omit for VS Code
  profiles.default.extensions = [
    inputs.open-dev-container.packages.${pkgs.system}.default
    pkgs.vscode-extensions.jeanp413.open-remote-ssh   # Remote SSH for VSCodium
  ];
};

# or plain nixpkgs
environment.systemPackages = [
  (pkgs.vscode-with-extensions.override {
    vscode = pkgs.vscodium;  # omit for VS Code
    vscodeExtensions = [ inputs.open-dev-container.packages.${pkgs.system}.default ];
  })
];
```

VSCodium note: Microsoft's `ms-vscode-remote.remote-ssh` is not available for
VSCodium; use `jeanp413.open-remote-ssh` instead, which provides the same
`ssh-remote` authority this extension opens.

An overlay is also exported (`inputs.open-dev-container.overlays.default`)
which adds `pkgs.open-dev-container`. Build locally with `nix build`.
