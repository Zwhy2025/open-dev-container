import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { CONTAINER_RUNTIMES, findRuntimeByCli } from './containerRuntimes';

export type RuntimeState = { cli: string; availableIds: string[]; detecting: boolean; hostLabel: string };
export type PanelAction = 'start' | 'stop' | 'restart' | 'remove' | 'shell' | 'attach' | 'reconnect' | 'disconnect' | 'clean';
export type PanelNode = {
  id: string;
  label: string;
  description: string;
  tooltip: string;
  icon: string;
  expandable: boolean;
  actions: PanelAction[];
  children?: PanelNode[];
  status?: { state: string; label: string };
};
export interface PanelSource<T> {
  runtime(): RuntimeState;
  children(item?: T): Promise<T[]>;
  describe(item: T): Omit<PanelNode, 'id'>;
  action(action: PanelAction, item?: T): Promise<void>;
  switchRuntime(id: string): Promise<void>;
  refreshRuntimes(): Promise<void>;
  reportError(error: unknown): Promise<void>;
}

export class ContainerPanelProvider<T> implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private revision = 0;
  private busy = false;
  private loading = false;
  private items = new Map<string, T>();
  private counter = 0;

  constructor(private readonly extensionUri: vscode.Uri, private readonly source: PanelSource<T>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')] };
    const listener = view.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); });
    view.onDidDispose(() => {
      listener.dispose();
      if (this.view === view) { this.view = undefined; this.revision++; this.items.clear(); }
    });
    view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(); });
    const nonce = randomBytes(18).toString('base64');
    const resource = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', file));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${resource('containerPanel.css')}">
      </head><body>
      <header><strong>Containers</strong><span id="host" class="host-badge" title="Host the container CLI runs on"></span><div class="tools">
      <select id="runtime" aria-label="Container runtime" disabled><option>Loading…</option></select>
      <button id="refresh" class="icon-button" title="Refresh containers" aria-label="Refresh containers"></button>
      <button id="more" class="icon-button" title="More actions" aria-label="More actions" aria-expanded="false" aria-controls="menu"></button>
      </div></header>
      <div id="menu" hidden><button id="clean">Clean SSH Config</button></div>
      <div id="context-menu" role="menu" hidden></div>
      <p id="status" role="status" aria-live="polite"></p>
      <main id="groups" aria-label="Container groups"></main>
      <script nonce="${nonce}" src="${resource('containerPanel.js')}"></script></body></html>`;
  }

  private post(message: unknown): void { void this.view?.webview.postMessage(message); }

  private status(): void {
    const runtime = this.source.runtime();
    this.post({ type: 'status', runtime: { ...runtime, activeId: findRuntimeByCli(runtime.cli)?.id || 'custom',
      runtimes: CONTAINER_RUNTIMES.map(({ id, label }) => ({ id, label })) }, busy: this.busy, loading: this.loading });
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    const revision = ++this.revision;
    if (this.busy || this.source.runtime().detecting) { this.status(); return; }
    this.loading = true;
    this.status();
    const items = new Map<string, T>();
    const describe = (item: T): PanelNode => {
      const id = `${revision}:${++this.counter}`;
      items.set(id, item);
      return { ...this.source.describe(item), id };
    };
    try {
      const roots = await this.source.children();
      const groups = await Promise.all(roots.map(async (root) => ({ ...describe(root),
        children: (await this.source.children(root)).map(describe) })));
      if (revision !== this.revision) return;
      this.items = items;
      this.post({ type: 'groups', groups });
    } catch (error: unknown) {
      if (revision === this.revision) this.post({ type: 'error', message: 'Unable to load containers. Try refreshing.' });
      await this.source.reportError(error);
    } finally {
      if (revision === this.revision) { this.loading = false; this.status(); }
    }
  }

  async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const { type, id, action } = message as { type?: unknown; id?: unknown; action?: unknown };
    if (type === 'ready') { await this.refresh(); return; }
    if (this.busy || this.loading || this.source.runtime().detecting) return;
    if (type === 'expand' && typeof id === 'string') {
      const item = this.items.get(id);
      if (!item || !this.source.describe(item).expandable) return;
      const revision = this.revision;
      try {
        const children = await this.source.children(item);
        if (revision !== this.revision) return;
        this.post({ type: 'children', id, children: children.map((child) => {
          const childId = `${revision}:${++this.counter}`;
          this.items.set(childId, child);
          return { ...this.source.describe(child), id: childId };
        }) });
      } catch (error: unknown) { await this.source.reportError(error); }
      return;
    }
    let run: (() => Promise<void>) | undefined;
    if (type === 'switch' && typeof id === 'string' && this.source.runtime().availableIds.includes(id)) {
      run = () => this.source.switchRuntime(id);
    } else if (type === 'refresh') {
      run = () => this.source.refreshRuntimes();
    } else if (type === 'cleanAll') {
      run = () => this.source.action('clean');
    } else if (type === 'action' && typeof id === 'string' && typeof action === 'string') {
      const item = this.items.get(id);
      if (item && this.source.describe(item).actions.includes(action as PanelAction)) {
        run = () => this.source.action(action as PanelAction, item);
      }
    }
    if (!run) return;
    this.busy = true;
    this.status();
    try { await run(); } catch (error: unknown) { await this.source.reportError(error); }
    finally { this.busy = false; await this.refresh(); }
  }
}
