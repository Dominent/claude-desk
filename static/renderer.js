// Tab bar for Switchboard. The guest window covers #content while it runs, so
// the notice underneath only shows before the window arrives or on problems.
const tabList = document.getElementById('tab-list');
const notice = document.getElementById('notice');
const addButton = document.getElementById('add');
const addForm = document.getElementById('add-form');
const addName = document.getElementById('add-name');
const layoutTabs = document.getElementById('layout-tabs');
const layoutSplit = document.getElementById('layout-split');
const content = document.getElementById('content');

document.body.classList.add(navigator.platform.startsWith('Mac') ? 'mac' : 'win');

const AVATAR_COLORS = ['#5a6cff', '#2fa66a', '#e0a23a', '#e0503f', '#9b59d0', '#1f9bb5', '#d4588f', '#7a8a2e'];
function avatarColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const MARK = '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 4v16" stroke="currentColor" stroke-width="1.8"/><path d="M6 9h3M15 9h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

let state = { guests: [], panes: [], active: undefined, layout: 'tabs', permission: true, claudeFound: true };

let pendingRender = false;

function render() {
  // The first click of a double-click activates the tab and pushes new state;
  // rebuilding the bar now would throw the editor away. Redraw when it closes.
  if (tabList.querySelector('input.rename')) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  tabList.replaceChildren(
    ...state.guests.map((g) => {
      const tab = document.createElement('button');
      const shown = state.panes.indexOf(g.id);
      tab.className = 'tab' + (g.id === state.active ? ' active' : '') + (shown >= 0 ? ' shown' : '');
      tab.setAttribute('role', 'tab');
      tab.title = g.error ? g.error : `${g.name} · ${g.state}`;
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.style.setProperty('--avatar', avatarColor(g.id));
      avatar.textContent = (g.name.trim()[0] || '?').toUpperCase();
      const dot = document.createElement('span');
      dot.className = 'dot ' + g.state;
      avatar.append(dot);
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = g.name;
      const parts = [avatar, label];
      if (state.layout === 'split' && shown >= 0) {
        const slot = document.createElement('span');
        slot.className = 'slot';
        slot.textContent = shown === 0 ? 'L' : 'R';
        parts.push(slot);
      }
      const close = document.createElement('button');
      close.className = 'close';
      close.setAttribute('aria-label', 'Close');
      close.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      close.title = g.state === 'stopped' ? 'Remove profile' : 'Stop this instance';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        if (g.state === 'stopped' || g.state === 'error') {
          if (confirm(`Remove the "${g.name}" tab? The sign-in data on disk is kept.`)) window.desk.remove(g.id);
        } else {
          window.desk.stop(g.id);
        }
      });
      tab.append(...parts, close);
      tab.dataset.id = g.id;
      tab.addEventListener('click', () => window.desk.activate(g.id));
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        startRename(tab, label, g);
      });
      return tab;
    }),
  );
  layoutTabs.classList.toggle('on', state.layout !== 'split');
  layoutSplit.classList.toggle('on', state.layout === 'split');
  content.classList.toggle('half', state.layout === 'split' && state.panes.length === 1);
  renderNotice();
}

// The first click of a double-click activates the tab and rebuilds the bar,
// so the double-click is caught on the bar itself and resolved by id.
tabList.addEventListener('dblclick', (e) => {
  const tab = e.target.closest('.tab');
  const g = tab && state.guests.find((x) => x.id === tab.dataset.id);
  if (g) startRename(tab, tab.querySelector('.name'), g);
});

// Rename a tab in place. Enter saves, Escape puts the label back.
function startRename(tab, label, g) {
  if (!label || tab.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = g.name;
  input.maxLength = 32;
  label.replaceWith(input);
  window.desk.focusShell().then(() => {
    input.focus();
    input.select();
  });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(label);
    if (save && name && name !== g.name) {
      try {
        await window.desk.rename(g.id, name);
      } catch (err) {
        console.warn(err);
      }
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renderNotice() {
  const active = state.guests.find((g) => g.id === state.active);
  notice.replaceChildren();
  const h = document.createElement('h1');
  const p = document.createElement('p');

  if (!state.claudeFound) {
    h.textContent = 'Claude desktop app not found';
    p.textContent = 'Install it from claude.ai/download, or set CLAUDE_DESK_APP to its executable.';
  } else if (!state.permission) {
    h.textContent = 'Accessibility access needed';
    p.textContent = 'macOS only lets Claude Desk place another app\'s window in this frame once it has Accessibility access. Grant it in System Settings, Privacy & Security, Accessibility.';
    const b = document.createElement('button');
    b.textContent = 'Open the prompt';
    b.addEventListener('click', () => window.desk.requestPermission());
    notice.append(h, p, b);
    return;
  } else if (state.guests.length === 0) {
    h.textContent = 'Add your first profile';
    p.innerHTML = 'Press <kbd>+</kbd> in the bar. Each profile is a separate Claude sign-in, shown here as a tab.';
  } else if (state.layout === 'split' && state.panes.length === 1 && active && active.state === 'running') {
    h.textContent = 'Pick a second tab';
    p.textContent = 'It opens in this half. Clicking a third tab replaces the one that is not focused.';
  } else if (!active) {
    h.textContent = 'Pick a tab';
    p.innerHTML = 'Each tab is a full Claude desktop app with its own account. <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> switches, <kbd>Ctrl</kbd>+<kbd>Tab</kbd> cycles.';
  } else if (active.state === 'starting') {
    h.textContent = `Starting ${active.name}…`;
    p.textContent = 'The Claude window appears here in a moment.';
  } else if (active.state === 'error') {
    h.textContent = `${active.name} did not open`;
    p.textContent = (active.error || '') + '. Restarting quits that Claude and starts a fresh one on the same profile.';
    const b = document.createElement('button');
    b.textContent = 'Restart it';
    b.addEventListener('click', () => window.desk.restart(active.id));
    notice.append(h, p, b);
    return;
  } else if (active.state === 'stopped') {
    h.textContent = `${active.name} is stopped`;
    const b = document.createElement('button');
    b.textContent = 'Start';
    b.addEventListener('click', () => window.desk.activate(active.id));
    notice.append(h, p, b);
    return;
  } else {
    return;
  }
  notice.append(h, p);
}

document.getElementById('settings').addEventListener('click', () => window.desk.openSettings());
layoutTabs.addEventListener('click', () => window.desk.setLayout('tabs'));
layoutSplit.addEventListener('click', () => window.desk.setLayout('split'));

// An embedded guest holds the keyboard; clicking our bar takes it back.
document.getElementById('bar').addEventListener('pointerdown', () => window.desk.focusShell());

addButton.addEventListener('click', async () => {
  addForm.hidden = false;
  addName.value = '';
  await window.desk.focusShell();
  addName.focus();
});
addName.addEventListener('blur', () => (addForm.hidden = true));
addName.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') addForm.hidden = true;
});
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = addName.value.trim();
  if (!name) return;
  try {
    await window.desk.add(name);
    addForm.hidden = true;
  } catch (err) {
    addName.setCustomValidity(String(err.message || err).replace(/^.*Error: /, ''));
    addName.reportValidity();
    addName.setCustomValidity('');
  }
});

window.desk.onState((s) => {
  state = s;
  render();
});
window.desk.state().then((s) => {
  state = s;
  render();
});
