(() => {
  const vscode = acquireVsCodeApi();
  const runtime = document.getElementById('runtime');
  const groups = document.getElementById('groups');
  const status = document.getElementById('status');
  const host = document.getElementById('host');
  const more = document.getElementById('more');
  const menu = document.getElementById('menu');
  const contextMenu = document.getElementById('context-menu');
  const saved = vscode.getState() || {};
  const collapsed = new Set(saved.collapsed || []);
  const details = new Map();
  let locked = true;
  const paths = {
    refresh: 'M13 6a5 5 0 1 0 .3 4M13 2v4H9',
    more: 'M3 8h.01M8 8h.01M13 8h.01',
    start: 'm4 2 9 6-9 6V2',
    stop: 'M3 3h10v10H3z',
    paused: 'M5 3v10M11 3v10',
    attach: 'M2 3h8v4M2 3v10h8v-2M7 8h7m-3-3 3 3-3 3',
    reconnect: 'M3 5a5 5 0 1 1-1 5M3 2v4h4',
    disconnect: 'm4 4 8 8m0-8-8 8',
    clean: 'M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v5m2-5v5',
    expand: 'm6 4 4 4-4 4',
    container: 'm8 1 6 3v8l-6 3-6-3V4l6-3m-6 3 6 3 6-3M8 7v8',
    history: 'M3 5a5 5 0 1 1-1 5M3 2v4h4M8 5v3l2 1',
    info: 'M8 7v4M8 4h.01M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1'
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[name] || paths.info); svg.append(path); return svg;
  }
  function el(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function send(message) { if (!locked) vscode.postMessage(message); }
  function button(name, label, run) {
    const node = el('button', 'icon-button'); node.title = label; node.setAttribute('aria-label', label);
    node.append(icon(name)); node.addEventListener('click', run); return node;
  }
  const labels = { attach: 'Attach to container', shell: 'Attach shell', start: 'Start container', stop: 'Stop container', restart: 'Restart container', remove: 'Remove container', reconnect: 'Reconnect', disconnect: 'Disconnect connection', clean: 'Clean SSH config' };
  const menuGroups = [['attach', 'shell'], ['start', 'stop', 'restart'], ['remove']];
  function row(item) {
    if (!item.actions.length && !item.expandable && ['info', 'circle-slash', 'error', 'clock'].includes(item.icon)) {
      const node = el('div', 'message'); node.append(el('strong', '', item.label), el('small', '', item.description)); return node;
    }
    const wrapper = el('div'); const node = el('div', 'row'); node.title = item.tooltip;
    if (item.actions.length) {
      node.tabIndex = 0;
      node.setAttribute('aria-label', `${item.label}${item.status ? `: ${item.status.label}` : ''}`);
      node.addEventListener('contextmenu', (event) => { event.preventDefault(); openContextMenu(item, event.clientX, event.clientY); });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); const rect = node.getBoundingClientRect(); openContextMenu(item, rect.left + 20, rect.bottom);
        }
      });
    }
    wrapper.append(node);
    if (item.expandable) {
      const children = el('div', 'children'); children.hidden = true;
      const expand = button('expand', `Show details for ${item.label}`, () => {
        children.hidden = !children.hidden; expand.setAttribute('aria-expanded', String(!children.hidden));
        if (!children.hidden && !details.get(item.id).loaded) {
          children.replaceChildren(el('div', 'message', 'Loading details…'));
          send({ type: 'expand', id: item.id });
        }
      });
      expand.classList.add('expand'); expand.setAttribute('aria-expanded', 'false');
      node.append(expand); wrapper.append(children); details.set(item.id, { children, loaded: false });
    }
    const stateIcon = item.status ? (item.status.state === 'running' ? 'start' : item.status.state === 'paused' ? 'paused' : ['exited', 'created'].includes(item.status.state) ? 'stop' : 'info') : undefined;
    const rowIcon = icon(stateIcon || (item.icon === 'server-process' ? 'container' : item.icon === 'history' ? 'history' : 'info'));
    if (item.status) rowIcon.classList.add('state-icon', `state-${item.status.state}`);
    node.append(rowIcon);
    const name = el('span', 'name', item.label);
    node.append(name);
    if (item.status) {
      const badge = el('span', `state-badge state-${item.status.state}`, item.status.label);
      badge.title = item.tooltip; node.append(badge);
    }
    node.append(el('span', 'description', item.description));
    return wrapper;
  }
  function renderGroups(items) {
    closeContextMenu(); details.clear(); groups.replaceChildren();
    for (const item of items) {
      const group = el('details', 'group'); group.open = !collapsed.has(item.label);
      const summary = el('summary'); summary.append(icon(item.icon === 'history' ? 'history' : 'container'), el('span', '', item.label));
      summary.append(el('span', 'count', String(item.children.filter((child) => child.status || child.actions.length).length)));
      group.append(summary); for (const child of item.children) group.append(row(child));
      group.addEventListener('toggle', () => {
        if (!group.isConnected) return;
        if (group.open) collapsed.delete(item.label); else collapsed.add(item.label);
        vscode.setState({ collapsed: [...collapsed] });
      });
      groups.append(group);
    }
  }
  function closeContextMenu() { contextMenu.hidden = true; }
  function openContextMenu(item, x, y) {
    if (locked || !item.actions.length) return;
    closeMenu(); contextMenu.replaceChildren();
    item.actions.forEach((action, index) => {
      if (index > 0 && menuGroups.some((group) => group.includes(action) && !group.includes(item.actions[index - 1]))) {
        const separator = el('div', 'menu-separator'); separator.setAttribute('role', 'separator'); contextMenu.append(separator);
      }
      const entry = el('button', '', labels[action]); entry.setAttribute('role', 'menuitem');
      entry.addEventListener('click', () => { closeContextMenu(); send({ type: 'action', action, id: item.id }); });
      contextMenu.append(entry);
    });
    contextMenu.hidden = false;
    contextMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - contextMenu.offsetWidth - 4)) + 'px';
    contextMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - contextMenu.offsetHeight - 4)) + 'px';
    contextMenu.firstElementChild.focus();
  }
  document.addEventListener('click', (event) => { if (!contextMenu.contains(event.target)) closeContextMenu(); });
  contextMenu.addEventListener('keydown', (event) => {
    const buttons = [...contextMenu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
    }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !contextMenu.hidden) { closeContextMenu(); runtime.focus(); } });
  document.getElementById('refresh').append(icon('refresh'));
  document.getElementById('refresh').addEventListener('click', () => send({ type: 'refresh' }));
  more.append(icon('more'));
  function closeMenu() { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
  more.addEventListener('click', () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) document.getElementById('clean').focus(); });
  document.addEventListener('click', (event) => { if (!menu.contains(event.target) && !more.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.hidden) { closeMenu(); more.focus(); } });
  document.getElementById('clean').addEventListener('click', () => { closeMenu(); send({ type: 'cleanAll' }); });
  runtime.addEventListener('change', () => send({ type: 'switch', id: runtime.value }));
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'groups') renderGroups(data.groups);
    if (data.type === 'children') {
      const entry = details.get(data.id); if (entry) { entry.loaded = true; entry.children.replaceChildren(...data.children.map(row)); }
    }
    if (data.type === 'error') { groups.replaceChildren(el('div', 'message', data.message)); }
    if (data.type === 'status') {
      const state = data.runtime;
      locked = data.busy || data.loading || state.detecting;
      if (locked) closeContextMenu();
      runtime.replaceChildren();
      if (state.activeId === 'custom') runtime.add(new Option(state.cli, 'custom'));
      for (const item of state.runtimes) {
        const available = state.availableIds.includes(item.id);
        const option = new Option(item.label, item.id); option.disabled = !available;
        option.title = available ? item.label : `${item.label} not detected`; runtime.add(option);
      }
      runtime.value = state.activeId; runtime.title = state.cli;
      if (host && state.hostLabel) { host.textContent = state.hostLabel; host.hidden = false; }
      runtime.disabled = locked || !state.availableIds.length;
      document.querySelectorAll('button').forEach((node) => { node.disabled = locked; });
      groups.setAttribute('aria-busy', String(locked));
      status.textContent = state.detecting ? 'Detecting runtimes…' : data.busy ? 'Working…' : data.loading ? 'Loading containers…' : !state.availableIds.length ? 'No container runtimes detected.' : '';
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
