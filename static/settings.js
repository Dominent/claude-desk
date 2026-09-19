const SHORTCUTS = [
  [['Ctrl', '1'], 'Switch to tab 1 (through Ctrl+9 for tab 9) and give it the keyboard'],
  [['Ctrl', 'Tab'], 'Next tab'],
  [['Ctrl', 'Shift', 'Tab'], 'Previous tab'],
  [['Ctrl', 'Alt', '←'], 'Focus the left pane in split layout'],
  [['Ctrl', 'Alt', '→'], 'Focus the right pane in split layout'],
];

function row(table, first, second) {
  const tr = document.createElement('tr');
  const a = document.createElement('td');
  const b = document.createElement('td');
  if (typeof first === 'string') a.textContent = first;
  else a.append(first);
  if (typeof second === 'string') b.textContent = second;
  else b.append(second);
  tr.append(a, b);
  table.append(tr);
}

function keys(list) {
  const frag = document.createDocumentFragment();
  list.forEach((k, i) => {
    if (i) frag.append(' + ');
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    frag.append(kbd);
  });
  return frag;
}

const shortcuts = document.getElementById('shortcuts');
for (const [combo, what] of SHORTCUTS) row(shortcuts, keys(combo), what);

window.desk.info().then((info) => {
  const profiles = document.getElementById('profiles');
  if (info.profiles.length === 0) row(profiles, 'No profiles yet', 'Press + in the main window.');
  for (const p of info.profiles) {
    const name = document.createDocumentFragment();
    const dot = document.createElement('span');
    dot.className = 'state ' + p.state;
    name.append(dot, p.name);
    row(profiles, name, p.dataDir);
  }
  const about = document.getElementById('about');
  row(about, 'Switchboard', `version ${info.version} on ${info.platform === 'darwin' ? 'macOS' : 'Windows'}`);
  row(about, 'Claude desktop app', info.claudeExe || 'not found (set CLAUDE_DESK_APP)');
  row(about, 'Profiles file', info.profilesFile);
  row(about, 'Source', 'github.com/Dominent/claude-desk');
});
