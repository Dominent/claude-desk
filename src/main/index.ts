import { app, BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findClaudeExecutable } from './claudeApp';
import { DeepLinks, forwardUrlWindows } from './deeplink';
import { guestRect, paneRects, TAB_BAR_HEIGHT, type Rect } from './geometry';
import { findGuestPid, Guest, type GuestInfo } from './guest';
import { createHost, type WindowHost } from './host';
import { ProfileStore, type Profile } from './profiles';
import { Shortcuts } from './shortcuts';

export type Layout = 'tabs' | 'split';

export interface DeskState {
  guests: GuestInfo[];
  // Guests on screen, left to right. One in tab layout, up to two in split layout.
  panes: string[];
  // The pane with keyboard focus.
  active?: string;
  layout: Layout;
  permission: boolean;
  claudeFound: boolean;
}

// Mac guests are re-pinned on a timer, because the user can drag a pinned
// window (it is a real, separate window) and we want it back in the frame.
const PIN_INTERVAL_MS = 1000;
const PERMISSION_POLL_MS = 2000;
const MAX_PANES = 2;

class Desk {
  private host: WindowHost;
  private store: ProfileStore;
  private guests = new Map<string, Guest>();
  private panes: string[] = [];
  private active?: string;
  private layout: Layout = 'tabs';
  // Most recently focused first; decides what Split shows in the other half.
  private recent: string[] = [];
  private exe = findClaudeExecutable();
  private layoutTimer?: NodeJS.Timeout;
  private stateFile = path.join(app.getPath('userData'), 'state.json');

  constructor(private win: BrowserWindow) {
    this.host = createHost();
    this.store = new ProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
    for (const p of this.store.list()) this.guests.set(p.id, this.makeGuest(p));

    if (process.platform === 'win32') {
      (this.host as unknown as { setShellHandle(b: Buffer): void }).setShellHandle(win.getNativeWindowHandle());
    }

    win.on('move', () => this.scheduleLayout());
    win.on('resize', () => this.scheduleLayout());
    win.on('minimize', () => this.eachPane((g) => g.setVisible(false)));
    win.on('restore', () => this.showPanes());
    win.on('show', () => this.showPanes());
    win.on('focus', () => {
      // On macOS our window just came in front of the pinned guests; put them
      // back on top. A guest whose window is still appearing needs a later pass.
      if (process.platform === 'darwin') for (const ms of [30, 400, 1500]) setTimeout(() => this.raisePanes(), ms);
    });
    win.on('close', () => this.shutdown());

    setInterval(() => {
      if (process.platform === 'darwin' && !this.win.isMinimized()) this.placePanes(true);
    }, PIN_INTERVAL_MS);
    setInterval(() => {
      if (!this.host.ready()) this.broadcast();
    }, PERMISSION_POLL_MS);

    new Shortcuts(
      win,
      {
        tab: (i) => {
          const id = [...this.guests.keys()][i];
          if (id) this.activate(id);
        },
        next: () => this.step(1),
        prev: () => this.step(-1),
        pane: (side) => {
          const id = this.panes[side === 'left' ? 0 : 1];
          if (id) this.activate(id);
        },
      },
      () => this.host.inFront([...this.guests.values()].map((g) => g.pid!).filter(Boolean)),
    ).start();
  }

  // Instances already running on known profiles are taken over right away,
  // hidden until their tab is picked, instead of lingering as loose windows.
  adoptRunning(): void {
    if (!this.host.ready() || !this.exe) return;
    for (const g of this.guests.values()) {
      if (g.state === 'stopped' && findGuestPid(g.profile.dataDir)) {
        g.setVisible(false);
        g.start();
      }
    }
  }

  private step(delta: number): void {
    const ids = [...this.guests.keys()];
    if (ids.length === 0) return;
    const i = this.active ? ids.indexOf(this.active) : -1;
    this.activate(ids[(i + delta + ids.length) % ids.length]);
  }

  state(): DeskState {
    return {
      guests: [...this.guests.values()].map((g) => g.info()),
      panes: [...this.panes],
      active: this.active,
      layout: this.layout,
      permission: this.host.ready(),
      claudeFound: !!this.exe,
    };
  }

  // Reopen where the user left off. CLAUDE_DESK_OPEN=<profile> overrides, for scripting.
  reopen(): void {
    const forced = process.env.CLAUDE_DESK_OPEN;
    if (forced) return this.activate(forced);
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<DeskState>;
      if (saved.layout === 'split') this.layout = 'split';
      for (const id of saved.panes ?? []) this.activate(id);
    } catch {
      // first run
    }
  }

  add(name: string): void {
    const profile = this.store.add(name);
    this.guests.set(profile.id, this.makeGuest(profile));
    this.activate(profile.id);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    if (layout === 'tabs' && this.panes.length > 1) {
      const keep = this.active ?? this.panes[0];
      for (const id of this.panes) if (id !== keep) this.guests.get(id)?.setVisible(false);
      this.panes = [keep];
    }
    if (layout === 'split' && this.panes.length < MAX_PANES) {
      // Fill the other half straight away with the tab used most recently.
      const other = [...this.recent, ...this.guests.keys()].find((id) => !this.panes.includes(id) && this.guests.has(id));
      const focused = this.active;
      if (other) {
        this.activate(other);
        if (focused) this.activate(focused);
        return;
      }
    }
    this.placePanes(true);
    this.raisePanes();
    this.remember();
    this.broadcast();
  }

  activate(id: string): void {
    const guest = this.guests.get(id);
    if (!guest) return;
    if (!this.host.ready()) {
      this.host.requestPermission();
      this.broadcast();
      return;
    }
    if (!this.exe) return this.broadcast();

    if (!this.panes.includes(id)) {
      if (this.layout === 'tabs') {
        for (const other of this.panes) this.guests.get(other)?.setVisible(false);
        this.panes = [id];
      } else if (this.panes.length < MAX_PANES) {
        this.panes.push(id);
      } else {
        // Replace the pane that is not focused.
        const slot = this.panes.findIndex((p) => p !== this.active);
        this.guests.get(this.panes[slot])?.setVisible(false);
        this.panes[slot] = id;
      }
    }
    this.active = id;
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, 20);
    guest.setVisible(true);
    if (guest.state === 'stopped' || guest.state === 'error') guest.start();
    this.placePanes(true);
    this.raisePanes();
    this.remember();
    this.broadcast();
  }

  rename(id: string, name: string): void {
    const profile = this.store.rename(id, name);
    this.guests.get(id)?.setName(profile.name);
    this.broadcast();
  }

  stop(id: string): void {
    this.guests.get(id)?.stop();
    this.panes = this.panes.filter((p) => p !== id);
    if (this.active === id) this.active = this.panes[0];
    this.placePanes(true);
    this.remember();
    this.broadcast();
  }

  remove(id: string): void {
    this.stop(id);
    this.guests.delete(id);
    this.store.remove(id);
    this.broadcast();
  }

  requestPermission(): void {
    this.host.requestPermission();
  }

  focusShell(): void {
    this.host.focusShell?.();
    this.win.webContents.focus();
  }

  // Read-only facts for the settings window.
  info() {
    return {
      version: app.getVersion(),
      platform: process.platform,
      claudeExe: this.exe ?? null,
      profilesFile: path.join(app.getPath('userData'), 'profiles.json'),
      profiles: this.store.list().map((p) => ({ ...p, state: this.guests.get(p.id)?.state ?? 'stopped' })),
    };
  }

  private settings?: BrowserWindow;

  openSettings(): void {
    if (this.settings && !this.settings.isDestroyed()) return this.settings.focus();
    const dark = nativeTheme.shouldUseDarkColors;
    this.settings = new BrowserWindow({
      width: 580,
      height: 700,
      minWidth: 440,
      minHeight: 400,
      parent: this.win,
      // The guests sit above the shell, so the settings window must float above them.
      alwaysOnTop: true,
      title: 'Switchboard Settings',
      backgroundColor: dark ? '#141418' : '#f4f4f7',
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    this.settings.setMenuBarVisibility(false);
    this.settings.loadFile(path.join(app.getAppPath(), 'static', 'settings.html'));
  }

  // A claude:// URL (the sign-in callback) goes to the focused instance.
  deliverUrl(url: string): void {
    const guest = this.active ? this.guests.get(this.active) : undefined;
    console.log(`[desk] ${url.split('?')[0]} -> ${guest?.profile.id ?? 'no active profile'}`);
    if (!guest?.pid) return;
    if (process.platform === 'darwin') {
      (this.host as unknown as { sendUrl(pid: number, url: string): boolean }).sendUrl(guest.pid, url);
      guest.raise();
    } else if (this.exe) {
      forwardUrlWindows(this.exe, guest.profile.dataDir, url);
    }
  }

  private makeGuest(profile: Profile): Guest {
    const taken = () => [...this.guests.values()].filter((g) => g.profile.id !== profile.id && g.pid).map((g) => g.pid!);
    return new Guest(
      profile,
      this.host,
      this.exe ?? '',
      () => {
      // A guest that just got its window needs placing; others only need the UI refreshed.
      const g = this.guests.get(profile.id);
      if (g && this.panes.includes(profile.id) && g.state === 'running') {
        this.placePanes(true);
        g.raise();
        // The app is still settling its first window; one more raise lands after it has.
        setTimeout(() => {
          if (this.panes.includes(profile.id)) this.raisePanes();
        }, 500);
      }
      this.broadcast();
      },
      taken,
    );
  }

  private eachPane(fn: (g: Guest, index: number) => void): void {
    this.panes.forEach((id, i) => {
      const g = this.guests.get(id);
      if (g) fn(g, i);
    });
  }

  private showPanes(): void {
    this.eachPane((g) => g.setVisible(true));
    this.placePanes(true);
    this.raisePanes();
  }

  private raisePanes(): void {
    // Focused pane last, so it ends up on top.
    this.eachPane((g) => {
      if (g.profile.id !== this.active) g.raise();
    });
    if (this.active) this.guests.get(this.active)?.raise();
  }

  private placePanes(force = false): void {
    const rects = this.rects(this.panes.length);
    this.eachPane((g, i) => g.layout(rects[i], force));
  }

  private rects(panes: number): Rect[] {
    const area = guestRect(this.win.getContentBounds(), TAB_BAR_HEIGHT);
    // Windows hosts want physical pixels; Electron knows each display's scale.
    const screenArea = process.platform === 'win32' ? screen.dipToScreenRect(this.win, area) : area;
    return paneRects(screenArea, panes);
  }

  private scheduleLayout(): void {
    if (this.layoutTimer) return;
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = undefined;
      this.placePanes();
    }, 16);
  }

  private remember(): void {
    fs.writeFileSync(this.stateFile, JSON.stringify({ layout: this.layout, panes: this.panes }));
  }

  private broadcast(): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('desk:state', this.state());
  }

  // Closing the shell leaves the instances running as ordinary windows; the
  // next launch adopts them again. Windows must un-parent them first.
  private shutdown(): void {
    for (const g of this.guests.values()) g.release();
  }
}

// Profiles used to live under the old app name; carry them over once.
function migrateUserData(): void {
  const here = app.getPath('userData');
  if (fs.existsSync(path.join(here, 'profiles.json'))) return;
  // 'claude-desk' was the old app name, 'switchboard' the package name used
  // before the app named itself; on a case-sensitive volume they differ.
  for (const name of ['claude-desk', 'switchboard']) {
    const old = path.join(path.dirname(here), name);
    if (old === here || !fs.existsSync(path.join(old, 'profiles.json'))) continue;
    fs.mkdirSync(here, { recursive: true });
    for (const f of ['profiles.json', 'state.json']) {
      if (fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(here, f));
    }
    return;
  }
}

function createShell(): void {
  migrateUserData();
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: dark ? '#141418' : '#f4f4f7',
    // The tab bar is the title bar, as in a browser.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 12 },
    titleBarOverlay: process.platform === 'win32' ? { color: dark ? '#141418' : '#f4f4f7', symbolColor: dark ? '#ececef' : '#1c1c21', height: TAB_BAR_HEIGHT } : undefined,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
  const desk = new Desk(win);

  ipcMain.handle('desk:state', () => desk.state());
  ipcMain.handle('desk:add', (_e, name: string) => desk.add(String(name)));
  ipcMain.handle('desk:activate', (_e, id: string) => desk.activate(String(id)));
  ipcMain.handle('desk:stop', (_e, id: string) => desk.stop(String(id)));
  ipcMain.handle('desk:remove', (_e, id: string) => desk.remove(String(id)));
  ipcMain.handle('desk:rename', (_e, id: string, name: string) => desk.rename(String(id), String(name)));
  ipcMain.handle('desk:layout', (_e, layout: Layout) => desk.setLayout(layout === 'split' ? 'split' : 'tabs'));
  ipcMain.handle('desk:permission', () => desk.requestPermission());
  ipcMain.handle('desk:focus-shell', () => desk.focusShell());
  ipcMain.handle('desk:settings', () => desk.openSettings());
  ipcMain.handle('desk:info', () => desk.info());

  deepLinks = new DeepLinks((url) => desk.deliverUrl(url));
  deepLinks.install();

  win.loadFile(path.join(app.getAppPath(), 'static', 'index.html')).then(() => {
    app.focus({ steal: true });
    desk.reopen();
    desk.adoptRunning();
    if (process.env.CLAUDE_DESK_SETTINGS) desk.openSettings();
  });
}

let deepLinks: DeepLinks | undefined;

const APP_NAME = 'Switchboard';
// Before anything reads it: the user data folder, the taskbar and the about
// panel all take the name from here. In development the Dock and the menu bar
// still show Electron's own bundle name; scripts/dev-mac-setup.sh fixes that.
app.setName(APP_NAME);
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(createShell);
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => deepLinks?.uninstall());
}
