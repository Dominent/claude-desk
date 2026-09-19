// Tab bar for Claude Desk. The guest window covers #content while it runs, so
// the notice underneath only shows before the window arrives or on problems.
const tabList = document.getElementById('tab-list');
const notice = document.getElementById('notice');
const addButton = document.getElementById('add');
const addForm = document.getElementById('add-form');
const addName = document.getElementById('add-name');
const splitButton = document.getElementById('split');
const content = document.getElementById('content');

let state = { guests: [], panes: [], active: undefined, layout: 'tabs', permission: true, claudeFound: true };

function render() {
  tabList.replaceChildren(
    ...state.guests.map((g) => {
      const tab = document.createElement('button');
      const shown = state.panes.indexOf(g.id);
      tab.className = 'tab' + (g.id === state.active ? ' active' : '');
      tab.title = g.error ? g.error : g.state;
      const dot = document.createElement('span');
      dot.className = 'dot ' + g.state;
      const label = document.createElement('span');
      label.textContent = g.name;
      if (state.layout === 'split' && shown >= 0) {
        const slot = document.createElement('span');
        slot.className = 'slot';
        slot.textContent = shown === 0 ? 'L' : 'R';
        label.append(' ', slot);
      }
      const close = document.createElement('button');
      close.className = 'close';
      close.textContent = '×';
      close.title = g.state === 'stopped' ? 'Remove profile' : 'Stop this instance';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        if (g.state === 'stopped' || g.state === 'error') {
          if (confirm(`Remove the "${g.name}" tab? The sign-in data on disk is kept.`)) window.desk.remove(g.id);
        } else {
          window.desk.stop(g.id);
        }
      });
      tab.append(dot, label, close);
      tab.addEventListener('click', () => window.desk.activate(g.id));
      return tab;
    }),
  );
  splitButton.classList.toggle('on', state.layout === 'split');
  content.classList.toggle('half', state.layout === 'split' && state.panes.length === 1);
  renderNotice();
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
    h.textContent = 'No profiles yet';
    p.textContent = 'Press + to add one. Each profile is a separate Claude sign-in.';
  } else if (state.layout === 'split' && state.panes.length === 1 && active && active.state === 'running') {
    h.textContent = 'Pick a second tab';
    p.textContent = 'It opens in this half. Clicking a third tab replaces the one that is not focused.';
  } else if (!active) {
    h.textContent = 'Pick a tab';
    p.textContent = 'Each tab is a full Claude desktop app with its own account.';
  } else if (active.state === 'starting') {
    h.textContent = `Starting ${active.name}…`;
    p.textContent = 'The Claude window appears here in a moment.';
  } else if (active.state === 'error') {
    h.textContent = `${active.name} failed to start`;
    p.textContent = active.error || '';
    const b = document.createElement('button');
    b.textContent = 'Try again';
    b.addEventListener('click', () => window.desk.activate(active.id));
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

splitButton.addEventListener('click', () => window.desk.setLayout(state.layout === 'split' ? 'tabs' : 'split'));

// An embedded guest holds the keyboard; clicking our bar takes it back.
document.getElementById('tabs').addEventListener('pointerdown', () => window.desk.focusShell());

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
