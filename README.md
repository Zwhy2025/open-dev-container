# Open Dev Container

Open Dev Container 让支持 Remote SSH 的 VS Code Compatible Editor，把正在运行的 Docker 容器作为开发工作区打开。目前已支持 Trae CN，理论上兼容所有支持 Remote SSH 的 VS Code Compatible Editor。常用功能为`Attach to Running Container`，连接过程本质上是将以下步骤自动化掉：

1. 选择一个正在运行的容器。
2. 在容器内准备 SSH 访问能力。
3. 在本机 SSH config 写入受管理的 Host 配置块。
4. 通过 `vscode-remote://ssh-remote+...` 打开容器内工作区。

GitHub 仓库：[https://github.com/Zwhy2025/open-dev-container ](https://github.com/Zwhy2025/open-dev-container)

## 主要能力

- Activity Bar 视图展示正在运行的容器和最近连接。
- 支持 Attach、Reconnect、Disconnect、Clean SSH Config 和 Refresh。
- 自动生成并复用专用 SSH key。
- 自动根据 Docker bind mount 推断容器内工作目录。
- 对 Docker、SSH、权限和配置写入失败提供明确诊断。
- `Disconnect Connection` 会同时删除 SSH config 配置块和最近连接记录。
- 最近连接读取时会过滤损坏数据，避免旧状态导致视图崩溃。

## 运行要求

- 支持 Remote SSH 的 VS Code 兼容编辑器。
- 主机上可用的 Docker CLI。
- 主机上可用的 `ssh` 和 `ssh-keygen`。
- 容器允许执行 `docker exec -u 0`。
- 如果容器里没有 `sshd`，需要 `apt-get`、`apk`、`dnf`、`yum`、`microdnf` 或 `pacman` 之一。

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

## 设置项

- `openDevContainer.dockerPath`：Docker CLI 路径，默认 `docker`。
- `openDevContainer.remoteUser`：容器内登录用户，默认 `root`。
- `openDevContainer.workspaceFolder`：容器内打开的路径；留空时按挂载推断。
- `openDevContainer.installSshd`：缺少时尝试安装 `openssh-server`，默认 `true`。
- `openDevContainer.openInNewWindow`：是否在新编辑器窗口打开，默认 `true`。
- `openDevContainer.sshConfigPath`：SSH 配置路径；留空表示 `~/.ssh/config`。

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
