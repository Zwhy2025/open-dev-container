import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { classifyHostCommandError, execFileAsync } from './commandRunner';
import { CONTAINER_SSHD_CONFIG, prepareContainerSshd } from './containerProvisioner';
import { DockerClient } from './dockerClient';
import { OpenDevContainerError, formatDiagnostic, formatErrorDetail } from './errors';
import { chmodQuiet, exists } from './fileSystem';
import { RecentConnectionStore } from './recentConnections';
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
  constructor(public readonly container: DockerContainer) {
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

  let treeProvider: ContainerTreeProvider | undefined;
  const service = new OpenDevContainerService(context, outputChannel, () => treeProvider?.refresh());
  treeProvider = new ContainerTreeProvider(service);

  context.subscriptions.push(vscode.window.registerTreeDataProvider(TREE_VIEW_ID, treeProvider));
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
      treeProvider.refresh();
    })
  );
}

export function deactivate() {}

class ContainerTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly service: OpenDevContainerService) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return [new GroupTreeItem('Running Containers', 'running'), new GroupTreeItem('Recent Connections', 'recent')];
    }

    if (element instanceof GroupTreeItem) {
      if (element.section === 'running') {
        return this.getRunningContainerItems();
      }
      return this.getRecentConnectionItems();
    }

    if (element instanceof ContainerTreeItem) {
      return this.getContainerDetailItems(element.container);
    }

    return [];
  }

  private async getRunningContainerItems(): Promise<TreeNode[]> {
    try {
      const containers = await this.service.listRunningContainers();
      if (containers.length === 0) {
        return [new MessageTreeItem('No running containers', 'Start a Docker container to attach to it.', 'circle-slash')];
      }
      return containers.map((container) => new ContainerTreeItem(container));
    } catch (error: unknown) {
      return [this.service.createErrorTreeItem(error, 'Unable to load running containers')];
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

  private async getContainerDetailItems(container: DockerContainer): Promise<TreeNode[]> {
    try {
      const inspect = await this.service.inspectContainer(container.ID);
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly refreshTree: () => void
  ) {
    this.recentStore = new RecentConnectionStore(context.globalState);
  }

  async attachRunningContainer(target?: ContainerTreeItem): Promise<void> {
    const settings = this.getCurrentSettings();
    const container = target?.container || (await this.pickRunningContainer(settings.dockerPath));
    if (!container) {
      return;
    }

    await this.attachContainer(container, settings);
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
        this.log(`attach start container=${container.ID} image=${container.Image}`);

        progress.report({ message: 'Inspecting container' });
        const inspect = await new DockerClient(settings.dockerPath).inspectContainer(container.ID);
        const localWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const workspaceFolder = settings.workspaceFolder || resolveWorkspaceFolder(inspect, localWorkspace);
        const workingDir = inspect.Config?.WorkingDir || '/';
        const mounts = inspect.Mounts || [];

        progress.report({ message: 'Preparing SSH key' });
        const keyPath = await this.ensureSshKey();
        const publicKey = (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();

        progress.report({ message: 'Preparing sshd inside container' });
        const sshdPath = await prepareContainerSshd(settings.dockerPath, container.ID, settings.remoteUser, publicKey, settings.installSshd);

        const hostAlias = createHostAlias(container);
        progress.report({ message: 'Updating SSH config' });
        await upsertSshConfig(settings.sshConfigPath, hostAlias, {
          dockerPath: settings.dockerPath,
          containerId: container.ID,
          identityFile: keyPath,
          remoteUser: settings.remoteUser,
          sshdPath,
          containerSshdConfig: CONTAINER_SSHD_CONFIG
        });

        progress.report({ message: 'Opening Remote SSH window' });
        await this.openRemoteFolder(hostAlias, workspaceFolder, settings.openInNewWindow);

        await this.recentStore.save({
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
        });

        this.outputChannel.appendLine(
          `[${new Date().toISOString()}] attached ${normalizeContainerName(container.Names)} -> ${hostAlias} (${workspaceFolder})`
        );
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
      dockerPath: config.get<string>('dockerPath') || 'podman',
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
