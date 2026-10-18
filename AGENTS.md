# 仓库指南

## 项目结构与模块组织

本仓库是一个 VS Code 扩展，主入口在 `src/extension.ts`。支持 Docker 与 Podman 两种容器运行时，并可在 Remote SSH 窗口中把容器命令转发到远端主机执行。

源文件按职责分层，新增代码优先放进已有模块，不要继续平铺到 `src/` 根目录：

- `src/extension.ts`：激活、命令注册、树视图与面板装配。
- `src/containerRuntimes.ts`：Docker / Podman 运行时注册表，纯数据加纯函数。
- `src/containerExec.ts`：容器命令的唯一执行入口。本地直接执行；Remote SSH 窗口内经 `ssh <target>` 转发。运行时探测也在这里。
- `src/dockerClient.ts`：容器列表、检查与生命周期操作，构造参数使用 `DockerClientOptions`。
- `src/containerProvisioner.ts`：容器内 sshd 的准备脚本。
- `src/containerState.ts`：容器状态判断与右键菜单动作。
- `src/containerPanel.ts`：Webview 容器面板。
- `src/recentConnections.ts`：最近连接存储。
- `src/sshAuth.ts`：SSH 密码存储与 `SSH_ASKPASS`，密码不进入命令行。
- `src/sshConfig.ts`：托管 SSH 配置块的读写。写入 `~/.ssh/config.d/open-dev-container.conf`，只在主配置追加一行 `Include`。
- `src/sshTarget.ts`：从窗口 authority 解析 SSH 目标，并从托管块回溯宿主机。纯函数，不依赖 vscode。
- `src/remoteHost.ts`：`resolveActiveSshTarget()`，把上面两个接到 vscode 环境上。
- `src/shell.ts`：`shellQuote` / `splitShellWords`，所有拼命令行的地方统一用它。
- `src/commandRunner.ts`、`errors.ts`、`fileSystem.ts`、`types.ts`、`utils.ts`：基础设施。

`out/` 存放 TypeScript 编译产物，`docs/` 存放架构和产品说明，`resources/` 是静态资源，`infra.sh` 负责安装、编译和打包。把 `out/`、`dist/`、`node_modules/` 和 `*.vsix` 视为生成产物，不要手工编辑。

## 构建、测试与开发命令

在仓库根目录执行以下命令：

- 直接执行 `bash ./infra.sh` 会依次完成 `lib_update -> build -> pack`。
- `npm run lib_update` 或 `bash ./infra.sh lib_update`：执行 `npm ci` 安装依赖。
- `npm run compile`：编译 TypeScript 到 `out/`。
- `npm test`：先编译，再运行 Node 单元测试。
- `npm run watch`：开发时持续编译。
- `npm run build` 或 `bash ./infra.sh build`：先检查依赖，再编译。
- `npm run package`：执行版本化 VSIX 打包。
- `npm run pack` 或 `bash ./infra.sh pack`：生成 `dist/open-dev-container-<version>.vsix`。

仓库使用 Node 内置测试框架。改动后至少要跑一次 `npm test`，并在扩展宿主里手动验证核心流程。

VSIX 文件名由 `package.json` 的 `name` 和 `version` 生成。发布新包前先 bump `version`，再执行打包命令。

## SSH 约定

这几条是实际踩过坑的地方，改动 SSH 相关代码前先读：

- `buildProxyCommand()` 返回的是 **shell 词串**，不是 ssh_config 值。调用方直接写 `ProxyCommand ${buildProxyCommand(options)}`，**不要**再整体加引号。否则 `env 'SSH_ASKPASS=...' SSH_ASKPASS_REQUIRE=force ...` 会被 shell 当成一个可执行文件名，Remote SSH 会以退出码 0 静默失败。
- `parseManagedHostTarget()` 负责反向解析同一个格式。改动 `buildProxyCommand()` 的写入格式时必须同步改它；`test/remoteHost.test.js` 里的 round-trip 用例会拦住单侧改动。
- 在容器窗口内，工作区 authority 是**容器自己的别名**，不能直接当执行目标，否则会在容器内部找容器。`resolveActiveSshTarget()` 会从托管块的 `ProxyCommand` 回溯到运行容器的主机。
- 托管块用 `StrictHostKeyChecking no`（容器重建后 sshd key 会变），命令行 ssh 用 `accept-new`。两者策略不同是故意的。

## 代码风格与命名

- 使用 2 空格缩进、单引号和分号。
- 类型、类使用 `PascalCase`，函数和变量使用 `camelCase`，常量使用 `UPPER_SNAKE_CASE`。
- 命令 ID 使用 `open-dev-container.*` 前缀。
- 只在控制流不明显时加简短注释；注释解释“为什么”，不复述“做了什么”。

## 测试指南

当前使用 Node 内置测试框架。验证时优先检查：

1. `npm test` 是否通过。
2. 扩展是否能在 VS Code 兼容编辑器的扩展宿主中启动。
3. 容器列表、Attach、Reconnect、Disconnect 和清理 SSH 配置是否正常。
4. Docker 与 Podman 两种运行时都能列出容器，下拉框切换后会记住选择。
5. 远程场景：在容器窗口内打开面板，标题应显示 `Remote · <宿主机>` 并能列出该主机的容器，而不是 `No container runtimes detected`。

测试名称应直接描述行为，不要只写实现细节。

## 提交与 PR 指南

仓库历史使用 Conventional Commits，例如 `feat: 初始化Open Dev Container扩展，实现容器附加功能`。继续保持这种风格，标题要简短、动词式。

PR 里建议包含：

- 用户可见变化的简要说明
- 你执行过的验证步骤
- UI 改动的截图或录屏
- 关联 issue 或后续事项

## 安全与配置提示

扩展会写入 SSH 配置并调用容器 CLI（docker 或 podman），修改附加逻辑时要特别注意：

- 不要提交本机密钥、账号或机器专属路径
- 不要把用户现有 SSH 配置块覆盖掉；托管块只在 `~/.ssh/config.d/open-dev-container.conf` 内增删
- 密码只通过 0600 文件和 `SSH_ASKPASS` 传递，不要改成命令行参数
- 涉及权限、远程登录和配置写入的改动要重点回归
