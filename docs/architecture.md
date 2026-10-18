# 架构说明

## 背景

Open Dev Container 面向支持 Remote SSH 的 VS Code 兼容编辑器。当前实现不直接实现完整远端 authority，而是把正在运行的 Docker / Podman 容器伪装成一个 SSH 主机，再交给编辑器已有的 Remote SSH 链路打开工作区。

这个方案的第一阶段目标是稳定、可维护、容易诊断：

- 容器运行时（Docker 或 Podman）负责容器发现和 `exec`。
- 扩展负责在容器内准备最小 SSH 入口。
- Remote SSH 负责最终打开工作区。

Docker 与 Podman 走同一条链路：运行时差异集中在 `containerRuntimes.ts` 的注册表里（CLI 名、守护进程不可达和权限不足的报错特征），命令构造与输出解析完全共用。Podman 的 `ps --format '{{json .}}'` 输出字段与 Docker 不同（`Id`、`Names` 数组、`Status` 为空），由 `parseDockerContainerList` 统一归一化。

## 为什么暂不做完整 Dev Containers

完整 Dev Containers 能力通常分两层：

- 容器生命周期：解析 `.devcontainer/devcontainer.json`、构建镜像、启动 Compose、执行生命周期命令。
- 编辑器远端连接：在容器内安装并启动编辑器 server，再把本地窗口连接进去。

第二层依赖更深的编辑器远端 API、server 分发和版本匹配策略。当前仓库先交付稳定的 Remote SSH 桥接方案，再逐步补 Dev Containers 相关能力。

## 两个执行位置

扩展可能运行在两种窗口里，容器命令的执行位置因此不同：

- 本地窗口：容器 CLI 就在本机，直接 `execFile`。
- Remote SSH 窗口：容器 CLI 在远端主机上，本地 `ssh <target> "<cli> <args>"` 转发过去执行。

所有容器命令（列表、检查、生命周期、sshd 准备、运行时探测）都收敛到 `containerExec.ts` 的 `execContainerCli()`，`sshTarget` 只在这一处生效，避免出现「部分命令走远端、部分走本地」。

有一个容易搞错的细节：**当窗口是通过本扩展打开的容器窗口时，工作区 authority 是容器自己的别名**，不能直接当执行目标，否则会去容器内部找容器。`resolveActiveSshTarget()` 会从托管块的 `ProxyCommand` 回溯到运行容器的主机，因此面板里看到的是宿主机的容器列表。

## 当前链路

1. 解析当前窗口的执行位置（`resolveActiveSshTarget()`）：本地 = 空；Remote SSH = 主机别名；容器窗口 = 回溯出的宿主机。
2. 用容器运行时列出容器；远端场景下这条命令经 `ssh <target>` 执行。
3. 在扩展全局存储中生成专用 SSH key。
4. 在目标容器里准备 `sshd`；必要且允许时安装 `openssh-server`。
5. 把公钥写入容器用户的 `authorized_keys`。
6. 在 `~/.ssh/config.d/open-dev-container.conf` 写入受管理的 Host 配置块，并确保 `~/.ssh/config` 顶部有一行 `Include`。
7. 通过 `vscode-remote://ssh-remote+<host>/<workspace>` 打开容器内工作区。

## 托管 SSH 配置块

托管块写在独立文件里，用户自己的 `~/.ssh/config` 只多一行 `Include`；旧版本直接写在主配置里的块会在激活时自动迁移过去。用户显式设置 `openDevContainer.sshConfigPath` 时，则完全按该路径写入，不做迁移。

本地容器（`ProxyCommand` 直接调用容器 CLI）：

```sshconfig
# >>> open-dev-container odc-<name>-<id6>
Host odc-<name>-<id6>
  HostName 127.0.0.1
  User root
  IdentityFile <extension-global-storage>/open_dev_container_ed25519
  ProxyCommand 'docker' 'exec' '-i' '-u' '0' '<container-id>' '/usr/sbin/sshd' '-i' '-f' '/tmp/open-dev-container/sshd_config'
# <<< open-dev-container odc-<name>-<id6>
```

远程主机上的容器（先 ssh 到主机，再在主机上 exec 进容器）：

```sshconfig
  ProxyCommand env 'SSH_ASKPASS=<storage>/ssh-auth/askpass-<hash>.sh' SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh <host> "'podman' 'exec' '-i' '-u' '0' '<container-id>' '/usr/sbin/sshd' '-i' '-f' '/tmp/open-dev-container/sshd_config'"
```

三条必须遵守的约定：

- `ProxyCommand` 交给 shell 执行，所以 `buildProxyCommand()` 返回的是**按 shell 词拼接好的字符串**，不是 ssh_config 值。调用方直接拼进 `ProxyCommand ` 即可，**不能再整体加引号**——否则 `env 'SSH_ASKPASS=...' ...` 会被当成一个可执行文件名。
- 托管块用 `StrictHostKeyChecking no`，因为容器重建后 sshd host key 会变；而命令行 ssh 到真实主机用 `accept-new`。两者策略不同是故意的。
- 反向解析由 `parseManagedHostTarget()` 负责，与写入格式共享同一份约定，`test/remoteHost.test.js` 里有 round-trip 断言。

Host alias 使用 `odc-<name>-<id6>`，这样 Remote SSH 状态栏不会显示过长的扩展名前缀，同时仍保留容器名和短 ID 用于区分连接。

生成的 `sshd_config` 使用一个 `ForceCommand` 保活包装，避免非 tty 的 Remote SSH 会话过早退出。

## 代码结构

代码按职责分层，新增能力应放进已有模块而不是继续平铺：

- `src/extension.ts`：VS Code API、命令注册、树视图、面板装配和主流程编排。
- 容器领域
  - `containerRuntimes.ts`：Docker / Podman 运行时注册表与 CLI 解析（纯函数）。
  - `containerExec.ts`：容器命令的唯一执行入口，含本地/远端分支、密码重试和运行时探测。
  - `dockerClient.ts`：容器列表、检查与生命周期操作，构造参数为 `DockerClientOptions`。
  - `containerProvisioner.ts`：容器内 sshd 准备脚本生成与错误解析。
  - `containerState.ts`：容器状态判断与右键菜单动作。
  - `containerPanel.ts`：Webview 容器面板。
  - `recentConnections.ts`：最近连接的读取、保存、去重、删除和损坏数据过滤。
- SSH 领域
  - `sshConfig.ts`：托管块写入、替换、清理和配置布局迁移。
  - `sshAuth.ts`：SSH 密码存储与 `SSH_ASKPASS` 脚本生成，密码不进入命令行。
  - `sshTarget.ts`：从窗口 authority 解析目标，并从托管块回溯宿主机（纯函数，不依赖 vscode）。
  - `remoteHost.ts`：把上述解析接到 vscode 的 `env.remoteName` 与工作区 authority 上。
- 基础设施
  - `shell.ts`：`shellQuote` / `splitShellWords`，所有拼命令行的地方共用。
  - `commandRunner.ts`：进程执行与命令错误归一化。
  - `errors.ts`、`fileSystem.ts`、`types.ts`、`utils.ts`：错误类型、文件操作、共享类型和纯工具函数。

依赖方向是 `extension → 领域模块 → 基础设施`。`sshTarget.ts` 与 `containerRuntimes.ts` 不 import vscode，因此 Docker 输出解析、SSH 配置处理、目标解析和 recent 存储都可以用 Node 单元测试直接覆盖，不需要启动扩展宿主。

## 当前边界

当前版本暂不负责：

- 解析 `.devcontainer/devcontainer.json`
- `docker-compose` 启动
- `@devcontainers/cli` 集成
- 生命周期命令执行
- 原生 `dev-container` resolver

## 测试策略

仓库使用 Node 内置测试框架，测试入口是：

```bash
npm test
```

当前测试覆盖：

- Docker / Podman 的 `ps` 和 `inspect` 输出解析。
- 运行时探测、切换优先级和 CLI 解析。
- 容器状态判断、生命周期命令与面板动作。
- SSH config 标记块 upsert、单个删除、全部删除，以及独立文件布局迁移和 `Include` 检测。
- SSH config value 转义与 shell 词拼接/切分（含 round-trip）。
- 窗口 authority 解析、Remote SSH 目标推导、容器块到宿主机的回溯。
- SSH 密码文件与 askpass 脚本的生成和清理。
- bind mount 工作目录推断、Host alias 与 remote user 校验。
- 最近连接过滤、排序、去重和删除。
- 容器 sshd 准备脚本关键分支。

改动后至少执行 `npm test`。涉及真实容器、Remote SSH 和编辑器窗口打开的改动，还需要在扩展宿主里手动验证 Attach、Reconnect、Disconnect 和 Clean SSH Config，以及容器窗口里面板是否列出宿主机容器。

## VSIX 版本管理

`infra.sh pack` 会读取 `package.json` 的 `name` 和 `version`，输出：

```text
dist/open-dev-container-<version>.vsix
```

也就是说 VSIX 版本由 `package.json.version` 管理。发布新包前先 bump 版本号，再执行：

```bash
npm run pack
```

这样每次产物都会带版本号，例如：

```text
dist/open-dev-container-0.0.1.vsix
dist/open-dev-container-0.0.2.vsix
dist/open-dev-container-0.1.0.vsix
```
