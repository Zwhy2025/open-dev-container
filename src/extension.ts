import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { classifyHostCommandError, execFileAsync } from './commandRunner';
import { CONTAINER_SSHD_CONFIG, prepareContainerSshd } from './containerProvisioner';
import { detectAvailableRuntimes, findRuntimeByCli, resolveContainerCli, type ContainerRuntime } from './containerRuntimes';
import { getContainerActions, getContainerStatus, resolveContainerShell } from './containerState';
import { DockerClient } from './dockerClient';
import { OpenDevContainerError, formatDiagnostic, formatErrorDetail } from './errors';
import { chmodQuiet, exists } from './fileSystem';
import { RecentConnectionStore } from './recentConnections';
import { ContainerPanelProvider, type RuntimeState } from './containerPanel';
import { removeAllManagedBlocksFromFile, removeManagedHostBlockFromFile, upsertSshConfig } from './sshConfig';
import type { ConnectionSettings, DockerContainer, RecentConnection } from './types';
import {
  buildConnectionKey,
  createHostAlias,
  ensureSafeRemoteUser,
  expandHome,
  formatMountTooltip,
  formatTimestamp,
  normalizeContainerName,
  resolveWorkspaceFolder,
  summarizeMounts
} from './utils';

const OUTPUT_CHANNEL_NAME = 'Open Dev Container';
const TREE_VIEW_ID = 'openDevContainer.containersView';
const ACTIVE_RUNTIME_STATE_KEY = 'openDevContainer.activeRuntime';

type TreeNode = GroupTreeItem | ContainerTreeItem | ContainerDetailTreeItem | RecentConnectionTreeItem | MessageTreeItem;

class GroupTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly section: 'running' | 'recent'
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'open-dev-container-group';
    this.iconPath = new vscode.ThemeIcon(section === 'running' ? 'server-process' : 'history');
  }
}

class ContainerTreeItem extends vscode.TreeItem {
  constructor(public readonly container: DockerContainer, public readonly cli: string) {
    super(normalizeContainerName(container.Names), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `container:${container.ID}`;
    this.contextValue = 'open-dev-container-container';
    this.description = `${container.Image} · ${container.Status}`;
    this.tooltip = [
      `Container ID: ${container.ID}`,
      `Image: ${container.Image}`,
      `State: ${container.State}`,
      `Status: ${container.Status}`
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon('server-process');
    this.command = {
      command: 'open-dev-container.attachRunningContainer',
      title: 'Attach to Running Container',
      arguments: [this]
    };
  }
}

class ContainerDetailTreeItem extends vscode.TreeItem {
  constructor(label: string, value: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'open-dev-container-detail';
    this.description = value;
    this.tooltip = tooltip || value;
    this.iconPath = new vscode.ThemeIcon('symbol-key');
  }
}

class RecentConnectionTreeItem extends vscode.TreeItem {
  constructor(public readonly connection: RecentConnection, public readonly running: boolean) {
    super(connection.containerName, vscode.TreeItemCollapsibleState.None);
    this.id = `recent:${connection.connectionKey}`;
    this.contextValue = 'open-dev-container-recent';
    this.description = connection.workspaceFolder;
    this.tooltip = [
      `Container: ${connection.containerName}`,
      `Image: ${connection.image}`,
      `Host alias: ${connection.hostAlias}`,
      `Workspace: ${connection.workspaceFolder}`,
      `Remote user: ${connection.remoteUser}`,
      `SSH config: ${connection.sshConfigPath}`,
      `Container CLI: ${connection.dockerPath}`,
      `Working dir: ${connection.workingDir || '/'}`,
      `Mounts: ${connection.mountSummary || 'none'}`,
      `Last attached: ${formatTimestamp(connection.lastAttachedAt)}`,
      running ? 'Status: available for reconnect' : 'Status: stale'
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon(running ? 'history' : 'circle-slash');
    this.command = {
      command: 'open-dev-container.reconnectConnection',
      title: 'Reconnect',
      arguments: [this]
    };
  }
}

class MessageTreeItem extends vscode.TreeItem {
  constructor(label: string, detail: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'open-dev-container-message';
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = detail;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);
  const manifest = context.extension.packageJSON;
  const build = manifest.openDevContainerBuild;
  outputChannel.appendLine(`[${new Date().toISOString()}] activated version=${manifest.version} mode=${build?.mode || 'release'} build=${build?.id || 'unmarked'} baseVersion=${build?.baseVersion || manifest.version} path=${context.extensionPath}`);
  if (build?.mode === 'debug') outputChannel.show(true);

  let panel: ContainerPanelProvider<TreeNode> | undefined;
  const service = new OpenDevContainerService(context, outputChannel, () => { void panel?.refresh(); });
  const treeProvider = new ContainerTreeProvider(service);
  panel = new ContainerPanelProvider(context.extensionUri, {
    runtime: () => service.getRuntimeSelectorState(),
    children: (item) => treeProvider.getChildren(item),
    describe: (item) => ({
      label: typeof item.label === 'string' ? item.label : item.label?.label || '',
      description: typeof item.description === 'string' ? item.description : '',
      tooltip: typeof item.tooltip === 'string' ? item.tooltip : '',
      icon: item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : 'info',
      expandable: item.collapsibleState !== vscode.TreeItemCollapsibleState.None,
      status: item instanceof ContainerTreeItem ? getContainerStatus(item.container) : undefined,
      actions: item instanceof ContainerTreeItem ? getContainerActions(item.container) : item instanceof RecentConnectionTreeItem ? ['reconnect', 'disconnect', 'clean'] : []
    }),
    action: async (action, item) => {
      if (action === 'attach' && item instanceof ContainerTreeItem) await service.attachRunningContainer(item);
      if (action === 'shell' && item instanceof ContainerTreeItem) await service.attachShell(item);
      if ((action === 'start' || action === 'stop' || action === 'restart') && item instanceof ContainerTreeItem) {
        await service.changeContainerState(item, action);
      }
      if (action === 'remove' && item instanceof ContainerTreeItem) await service.removeContainer(item);
      if (action === 'reconnect' && item instanceof RecentConnectionTreeItem) await service.reconnectConnection(item);
      if (action === 'disconnect' && item instanceof RecentConnectionTreeItem) await service.disconnectConnection(item);
      if (action === 'clean' && (!item || item instanceof RecentConnectionTreeItem)) await service.cleanSshConfig(item);
    },
    switchRuntime: (id) => service.switchRuntime(id),
    refreshRuntimes: () => service.refreshAvailableRuntimes(),
    reportError: (error) => showCommandFailure(outputChannel, error)
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(TREE_VIEW_ID, panel));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('openDevContainer.dockerPath')) void panel?.refresh();
  }));
  void service.refreshAvailableRuntimes();
  context.subscriptions.push(
    registerSafeCommand(outputChannel, 'open-dev-container.attachRunningContainer', async (target?: ContainerTreeItem) => {
      await service.attachRunningContainer(target);
    })
  );
  context.subscriptions.push(
    registerSafeCommand(outputChannel, 'open-dev-container.reconnectConnection', async (target?: RecentConnectionTreeItem) => {
      await service.reconnectConnection(target);
    })
  );
  context.subscriptions.push(
    registerSafeCommand(outputChannel, 'open-dev-container.disconnectConnection', async (target?: RecentConnectionTreeItem) => {
      await service.disconnectConnection(target);
    })
  );
  context.subscriptions.push(
    registerSafeCommand(outputChannel, 'open-dev-container.cleanSshConfig', async (target?: RecentConnectionTreeItem) => {
      await service.cleanSshConfig(target);
    })
  );
  context.subscriptions.push(
    registerSafeCommand(outputChannel, 'open-dev-container.refreshContainers', async () => {
      await service.refreshAvailableRuntimes();
    })
  );
  context.subscriptions.push(
    registerSafeCommand(outputChannel, 'open-dev-container.switchRuntime', async () => {
      await service.switchRuntime();
    })
  );
}

export function deactivate() {}

class ContainerTreeProvider {
  constructor(private readonly service: OpenDevContainerService) {}

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return [
        new GroupTreeItem('Individual Containers', 'running'),
        new GroupTreeItem('Recent Connections', 'recent')
      ];
    }

    if (element instanceof GroupTreeItem) {
      if (element.section === 'running') {
        return this.getRunningContainerItems();
      }
      return this.getRecentConnectionItems();
    }

    if (element instanceof ContainerTreeItem) {
      return this.getContainerDetailItems(element);
    }

    return [];
  }

  private async getRunningContainerItems(): Promise<TreeNode[]> {
    try {
      const cli = this.service.getRuntimeSelectorState().cli;
      const containers = await new DockerClient(cli).listAllContainers();
      if (containers.length === 0) {
        return [new MessageTreeItem('No containers', `Create a ${this.service.getActiveRuntimeLabel()} container to get started.`, 'circle-slash')];
      }
      return containers.map((container) => new ContainerTreeItem(container, cli));
    } catch (error: unknown) {
      return [this.service.createErrorTreeItem(error, 'Unable to load containers')];
    }
  }

  private async getRecentConnectionItems(): Promise<TreeNode[]> {
    try {
      const [recentConnections, runningContainers] = await Promise.all([
        this.service.getRecentConnections(),
        this.service.listRunningContainers().catch(() => [] as DockerContainer[])
      ]);
      if (recentConnections.length === 0) {
        return [new MessageTreeItem('No recent connections', 'Attach to a container to save a recent connection.', 'clock')];
      }

      const runningIds = new Set(runningContainers.map((container) => container.ID));
      const runningNames = new Set(runningContainers.map((container) => normalizeContainerName(container.Names)));
      return recentConnections.map((connection) => {
        const running = runningIds.has(connection.containerId) || runningNames.has(connection.containerName);
        return new RecentConnectionTreeItem(connection, running);
      });
    } catch (error: unknown) {
      return [this.service.createErrorTreeItem(error, 'Unable to load recent connections')];
    }
  }

  private async getContainerDetailItems(item: ContainerTreeItem): Promise<TreeNode[]> {
    const container = item.container;
    try {
      const inspect = await new DockerClient(item.cli).inspectContainer(container.ID);
      const workingDir = inspect.Config?.WorkingDir || '/';
      const mounts = inspect.Mounts || [];
      return [
        new ContainerDetailTreeItem('Status', container.Status, `State: ${container.State}`),
        new ContainerDetailTreeItem('Image', container.Image),
        new ContainerDetailTreeItem('Working dir', workingDir),
        new ContainerDetailTreeItem('Mounts', summarizeMounts(mounts), formatMountTooltip(mounts))
      ];
    } catch (error: unknown) {
      return [this.service.createErrorTreeItem(error, `Unable to inspect ${normalizeContainerName(container.Names)}`)];
    }
  }
}

class OpenDevContainerService {
  private readonly recentStore: RecentConnectionStore;
  private availableRuntimes: ContainerRuntime[] = [];
  private detectingRuntimes = true;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly refreshTree: () => void
  ) {
    this.recentStore = new RecentConnectionStore(context.globalState);
  }

  async attachRunningContainer(target?: ContainerTreeItem): Promise<void> {
    const settings = { ...this.getCurrentSettings(), ...(target ? { dockerPath: target.cli } : {}) };
    const container = target?.container || (await this.pickRunningContainer(settings.dockerPath));
    if (!container) {
      return;
    }

    await this.attachContainer(container, settings);
  }

  async attachShell(target: ContainerTreeItem): Promise<void> {
    const client = new DockerClient(target.cli);
    const container = (await client.listAllContainers()).find((item) => item.ID === target.container.ID);
    if (!container || getContainerStatus(container).state !== 'running') {
      throw new OpenDevContainerError('CONTAINER_NOT_FOUND', 'The container is no longer running. Refresh the list.');
    }
    const terminal = vscode.window.createTerminal({
      name: `${normalizeContainerName(container.Names)} · shell`,
      shellPath: target.cli,
      shellArgs: ['exec', '-it', container.ID, resolveContainerShell(vscode.workspace.getConfiguration('openDevContainer').get<string>('containerShell') || '')]
    });
    terminal.show();
  }

  async changeContainerState(target: ContainerTreeItem, action: 'start' | 'stop' | 'restart'): Promise<void> {
    const client = new DockerClient(target.cli);
    const container = (await client.listAllContainers()).find((item) => item.ID === target.container.ID);
    if (!container) {
      throw new OpenDevContainerError('CONTAINER_NOT_FOUND', 'The container no longer exists. Refresh the list.');
    }
    if (!getContainerActions(container).includes(action)) {
      this.refreshTree();
      await vscode.window.showInformationMessage(`Container is ${getContainerStatus(container).label.toLowerCase()}; the list has been refreshed.`);
      return;
    }
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${normalizeContainerName(container.Names)}`,
        cancellable: false
      }, async () => {
        if (action === 'start') await client.startContainer(container.ID);
        else if (action === 'stop') await client.stopContainer(container.ID);
        else await client.restartContainer(container.ID);
        this.log(`${action} container=${container.ID} cli=${target.cli}`);
      });
    } finally {
      this.refreshTree();
    }
  }

  async removeContainer(target: ContainerTreeItem): Promise<void> {
    const container = (await new DockerClient(target.cli).listAllContainers()).find((item) => item.ID === target.container.ID);
    if (!container) {
      throw new OpenDevContainerError('CONTAINER_NOT_FOUND', 'The container no longer exists. Refresh the list.');
    }
    const name = normalizeContainerName(container.Names);
    const choice = await vscode.window.showWarningMessage(
      `Remove container ${name}? This cannot be undone.`,
      { modal: true },
      'Remove'
    );
    if (choice !== 'Remove') return;
    await new DockerClient(target.cli).removeContainer(container.ID);
    this.log(`remove container=${container.ID} cli=${target.cli}`);
    this.refreshTree();
  }

  async reconnectConnection(target?: RecentConnectionTreeItem): Promise<void> {
    const recent = target?.connection || (await this.recentStore.getMostRecent());
    if (!recent) {
      throw new OpenDevContainerError('NO_RECENT_CONNECTION', 'No recent connections found. Attach to a container first.');
    }

    const settings = this.getReconnectSettings(recent);
    const container = await this.resolveContainerForRecent(recent, settings.dockerPath);
    if (!container) {
      throw new OpenDevContainerError(
        'CONTAINER_NOT_FOUND',
        `The recent container ${recent.containerName} is not running.`,
        'Start the container again or use the attach command to pick a different running container.'
      );
    }

    await this.attachContainer(container, settings);
  }

  async disconnectConnection(target?: RecentConnectionTreeItem): Promise<void> {
    const recent = target?.connection || (await this.recentStore.getMostRecent());
    if (!recent) {
      throw new OpenDevContainerError('NO_RECENT_CONNECTION', 'No recent connections found to disconnect.');
    }

    const removedConfig = await removeManagedHostBlockFromFile(recent.sshConfigPath, recent.hostAlias);
    const removedRecent = await this.recentStore.remove(recent.connectionKey);
    this.log(`disconnect ${recent.containerName} (${recent.hostAlias}) configRemoved=${removedConfig} recentRemoved=${removedRecent}`);
    this.refreshTree();
    await vscode.window.showInformationMessage(
      removedConfig || removedRecent
        ? `Disconnected ${recent.containerName}.`
        : `No managed connection state was found for ${recent.containerName}.`
    );
  }

  async cleanSshConfig(target?: RecentConnectionTreeItem): Promise<void> {
    const settings = this.getCurrentSettings();
    const sshConfigPath = target?.connection.sshConfigPath || settings.sshConfigPath;

    if (target) {
      const removed = await removeManagedHostBlockFromFile(sshConfigPath, target.connection.hostAlias);
      this.log(`clean single block ${target.connection.containerName} removed=${removed}`);
      this.refreshTree();
      await vscode.window.showInformationMessage(
        removed
          ? `Removed managed SSH config block for ${target.connection.containerName}.`
          : `No managed SSH config block was found for ${target.connection.containerName}.`
      );
      return;
    }

    const result = await removeAllManagedBlocksFromFile(sshConfigPath);
    this.log(`clean all blocks path=${sshConfigPath} removed=${result.removed}`);
    this.refreshTree();
    await vscode.window.showInformationMessage(
      result.removed > 0
        ? `Removed ${result.removed} managed SSH config block${result.removed === 1 ? '' : 's'}.`
        : 'No managed SSH config blocks were found.'
    );
  }

  async listRunningContainers(): Promise<DockerContainer[]> {
    return this.createDockerClient().listRunningContainers();
  }

  async refreshAvailableRuntimes(): Promise<void> {
    this.detectingRuntimes = true;
    this.refreshTree();
    try {
      this.availableRuntimes = await detectAvailableRuntimes();
    } finally {
      this.detectingRuntimes = false;
      this.refreshTree();
    }
  }

  getRuntimeSelectorState(): RuntimeState {
    return {
      cli: this.getCurrentSettings().dockerPath,
      availableIds: this.availableRuntimes.map((runtime) => runtime.id),
      detecting: this.detectingRuntimes
    };
  }

  async switchRuntime(runtimeId?: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('openDevContainer');
    const explicitPath = (config.get<string>('dockerPath') || '').trim();
    if (explicitPath) {
      const clear = await vscode.window.showWarningMessage(
        `"openDevContainer.dockerPath" is set to "${explicitPath}", which overrides runtime switching.`,
        'Clear Setting and Switch'
      );
      if (!clear) {
        return;
      }
      await config.update('dockerPath', undefined, vscode.ConfigurationTarget.Global);
    }

    await this.refreshAvailableRuntimes();
    if (this.availableRuntimes.length === 0) {
      throw new OpenDevContainerError('DOCKER_CLI_MISSING', 'No supported container CLI (docker or podman) was found on this host.');
    }

    const currentCli = this.getCurrentSettings().dockerPath;
    const picked = runtimeId
      ? this.availableRuntimes.find((runtime) => runtime.id === runtimeId)
      : (await vscode.window.showQuickPick(
        this.availableRuntimes.map((runtime) => ({
          label: `${runtime.cli === currentCli ? '$(check)' : '$(blank)'} ${runtime.label}`,
          description: runtime.cli === currentCli ? 'Current' : undefined,
          runtime
        })),
        {
          title: 'Switch Container Runtime',
          placeHolder: `Using ${this.getActiveRuntimeLabel()} · Select a runtime to show its containers`
        }
      ))?.runtime;
    if (!picked) {
      return;
    }

    await this.context.globalState.update(ACTIVE_RUNTIME_STATE_KEY, picked.id);
    this.log(`switched container runtime to ${picked.id}`);
    this.refreshTree();
  }

  getActiveRuntimeLabel(): string {
    const cli = this.getCurrentSettings().dockerPath;
    return findRuntimeByCli(cli)?.label || cli;
  }

  async inspectContainer(containerId: string) {
    return this.createDockerClient().inspectContainer(containerId);
  }

  async getRecentConnections(): Promise<RecentConnection[]> {
    return this.recentStore.getAll();
  }

  createErrorTreeItem(error: unknown, label: string): MessageTreeItem {
    const diagnostic = formatDiagnostic(error);
    return new MessageTreeItem(label, diagnostic.message, 'error');
  }

  private async attachContainer(container: DockerContainer, settings: ConnectionSettings): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Preparing container ${normalizeContainerName(container.Names)}`,
        cancellable: false
      },
      async (progress) => {
        const attachStartedAt = Date.now();
        this.outputChannel.show(true);
        const build = this.context.extension.packageJSON.openDevContainerBuild;
        this.log(`attach start container=${container.ID} image=${container.Image} cli=${settings.dockerPath} build=${build?.id || 'unmarked'}`);
        this.log('attach note: the first attach may install openssh-server inside the container.');

        const runPhase = async <T>(name: string, message: string, action: () => Promise<T>): Promise<T> => {
          const phaseStartedAt = Date.now();
          progress.report({ message });
          this.log(`attach phase=start name=${name} message=${message}`);
          try {
            const result = await action();
            this.log(`attach phase=done name=${name} durationMs=${Date.now() - phaseStartedAt}`);
            return result;
          } catch (error: unknown) {
            this.log(`attach phase=failed name=${name} durationMs=${Date.now() - phaseStartedAt}`);
            throw error;
          }
        };

        const inspect = await runPhase('inspect', 'Inspecting container', () =>
          new DockerClient(settings.dockerPath).inspectContainer(container.ID)
        );
        const localWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const workspaceFolder = settings.workspaceFolder || resolveWorkspaceFolder(inspect, localWorkspace);
        const workingDir = inspect.Config?.WorkingDir || '/';
        const mounts = inspect.Mounts || [];

        const { keyPath, publicKey } = await runPhase('ssh-key', 'Preparing SSH key', async () => {
          const keyPath = await this.ensureSshKey();
          const publicKey = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();
          return { keyPath, publicKey };
        });

        const sshdMessage = settings.installSshd
          ? 'Preparing sshd (checking/installing openssh-server; first time may take a minute)'
          : 'Preparing sshd (checking only; installation disabled)';
        const sshdPath = await runPhase('sshd', sshdMessage, () =>
          prepareContainerSshd(
            settings.dockerPath,
            container.ID,
            settings.remoteUser,
            publicKey,
            settings.installSshd,
            (stream, chunk) => this.logCommandOutput(`sshd ${stream}`, chunk)
          )
        );

        const hostAlias = createHostAlias(container);
        await runPhase('ssh-config', 'Updating SSH config', () => upsertSshConfig(settings.sshConfigPath, hostAlias, {
          dockerPath: settings.dockerPath,
          containerId: container.ID,
          identityFile: keyPath,
          remoteUser: settings.remoteUser,
          sshdPath,
          containerSshdConfig: CONTAINER_SSHD_CONFIG
        }));

        await runPhase('remote-open', 'Opening Remote SSH window', () =>
          this.openRemoteFolder(hostAlias, workspaceFolder, settings.openInNewWindow)
        );

        await runPhase('recent-save', 'Saving recent connection', () => this.recentStore.save({
          connectionKey: buildConnectionKey({
            containerName: normalizeContainerName(container.Names),
            dockerPath: settings.dockerPath,
            remoteUser: settings.remoteUser,
            workspaceFolder,
            sshConfigPath: settings.sshConfigPath
          }),
          containerId: container.ID,
          containerName: normalizeContainerName(container.Names),
          image: container.Image,
          hostAlias,
          workspaceFolder,
          dockerPath: settings.dockerPath,
          remoteUser: settings.remoteUser,
          sshConfigPath: settings.sshConfigPath,
          lastAttachedAt: Date.now(),
          lastStatus: container.Status,
          workingDir,
          mountSummary: summarizeMounts(mounts)
        }));

        this.log(`attached ${normalizeContainerName(container.Names)} -> ${hostAlias} (${workspaceFolder}) durationMs=${Date.now() - attachStartedAt}`);
        this.refreshTree();
      }
    );
  }

  private async pickRunningContainer(dockerPath: string): Promise<DockerContainer | undefined> {
    const containers = await new DockerClient(dockerPath).listRunningContainers();
    if (containers.length === 0) {
      throw new OpenDevContainerError('NO_RUNNING_CONTAINERS', 'No running Docker containers found.');
    }

    const picked = await vscode.window.showQuickPick(
      containers.map((container) => ({
        label: normalizeContainerName(container.Names),
        description: `${container.Image} (${container.ID.slice(0, 12)})`,
        detail: container.Status,
        container
      })),
      { placeHolder: 'Select a running Docker container to attach to' }
    );

    return picked?.container;
  }

  private async resolveContainerForRecent(recent: RecentConnection, dockerPath: string): Promise<DockerContainer | undefined> {
    const containers = await new DockerClient(dockerPath).listRunningContainers();
    const byId = containers.find((container) => container.ID === recent.containerId);
    if (byId) {
      return byId;
    }

    const byName = containers.find((container) => normalizeContainerName(container.Names) === recent.containerName);
    if (byName) {
      return byName;
    }

    if (containers.length === 0) {
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      containers.map((container) => ({
        label: normalizeContainerName(container.Names),
        description: `${container.Image} (${container.ID.slice(0, 12)})`,
        detail: `${container.Status} · reconnect using the recent connection settings`,
        container
      })),
      {
        placeHolder: `Recent container ${recent.containerName} is not running. Select another running container to reuse the recent settings.`
      }
    );

    return picked?.container;
  }

  private getCurrentSettings(): ConnectionSettings {
    const config = vscode.workspace.getConfiguration('openDevContainer');
    return {
      dockerPath: resolveContainerCli(
        config.get<string>('dockerPath') || '',
        this.context.globalState.get<string>(ACTIVE_RUNTIME_STATE_KEY),
        this.availableRuntimes.map((runtime) => runtime.id)
      ),
      remoteUser: ensureSafeRemoteUser(config.get<string>('remoteUser') || 'root'),
      workspaceFolder: config.get<string>('workspaceFolder') || '',
      installSshd: config.get<boolean>('installSshd') ?? true,
      openInNewWindow: config.get<boolean>('openInNewWindow') ?? true,
      sshConfigPath: expandHome(config.get<string>('sshConfigPath') || '~/.ssh/config')
    };
  }

  private getReconnectSettings(recent: RecentConnection): ConnectionSettings {
    const current = this.getCurrentSettings();
    return {
      dockerPath: recent.dockerPath || current.dockerPath,
      remoteUser: ensureSafeRemoteUser(recent.remoteUser || current.remoteUser),
      workspaceFolder: recent.workspaceFolder || current.workspaceFolder,
      installSshd: current.installSshd,
      openInNewWindow: current.openInNewWindow,
      sshConfigPath: recent.sshConfigPath || current.sshConfigPath
    };
  }

  private async ensureSshKey(): Promise<string> {
    try {
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
    } catch (error: unknown) {
      throw new OpenDevContainerError('HOST_STORAGE_UNAVAILABLE', 'Cannot prepare extension global storage.', formatErrorDetail(error));
    }

    const keyPath = path.join(this.context.globalStorageUri.fsPath, 'open_dev_container_ed25519');
    if ((await exists(keyPath)) && (await exists(`${keyPath}.pub`))) {
      await chmodQuiet(keyPath, 0o600);
      return keyPath;
    }

    try {
      await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'open-dev-container']);
      await chmodQuiet(keyPath, 0o600);
      return keyPath;
    } catch (error: unknown) {
      throw classifyHostCommandError(error, 'ssh-keygen');
    }
  }

  private async openRemoteFolder(hostAlias: string, workspaceFolder: string, openInNewWindow: boolean): Promise<void> {
    try {
      const remoteUri = vscode.Uri.from({
        scheme: 'vscode-remote',
        authority: `ssh-remote+${hostAlias}`,
        path: workspaceFolder.startsWith('/') ? workspaceFolder : `/${workspaceFolder}`
      });

      await vscode.commands.executeCommand('vscode.openFolder', remoteUri, { forceNewWindow: openInNewWindow });
    } catch (error: unknown) {
      throw new OpenDevContainerError(
        'REMOTE_OPEN_FAILED',
        'Failed to open the Remote SSH window.',
        formatErrorDetail(error)
      );
    }
  }

  private createDockerClient(): DockerClient {
    return new DockerClient(this.getCurrentSettings().dockerPath);
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private logCommandOutput(prefix: string, chunk: string): void {
    for (const line of chunk.replace(/\r/g, '\n').split('\n').map((item) => item.trim()).filter(Boolean)) {
      this.log(`${prefix}: ${line}`);
    }
  }
}

function registerSafeCommand<T extends unknown[]>(
  outputChannel: vscode.OutputChannel,
  commandId: string,
  handler: (...args: T) => Promise<void>
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, (...args: T) => {
    void handler(...args).catch(async (error: unknown) => {
      await showCommandFailure(outputChannel, error);
    });
  });
}

async function showCommandFailure(outputChannel: vscode.OutputChannel, error: unknown): Promise<void> {
  const diagnostic = formatDiagnostic(error);
  outputChannel.appendLine(`[${new Date().toISOString()}] ERROR ${diagnostic.code}: ${diagnostic.message}`);
  if (diagnostic.detail) {
    outputChannel.appendLine(diagnostic.detail);
  }

  const choice = await vscode.window.showErrorMessage(`Open Dev Container: ${diagnostic.message}`, 'Show Output');
  if (choice === 'Show Output') {
    outputChannel.show(true);
  }
}
