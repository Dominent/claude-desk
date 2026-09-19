import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findClaudeExecutable } from './claudeApp';
import { DeepLinks, forwardUrlWindows } from './deeplink';
import { childRect, guestRect, paneRects, TAB_BAR_HEIGHT, type Rect } from './geometry';
import { Guest, type GuestInfo } from './guest';
import { createHost, type WindowHost } from './host';
import { ProfileStore, type Profile } from './profiles';

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
      // On macOS our window just came in front of the pinned guests; put them back on top.
      if (process.platform === 'darwin') setTimeout(() => this.raisePanes(), 30);
    });
    win.on('close', () => this.shutdown());

    setInterval(() => {
      if (process.platform === 'darwin' && !this.win.isMinimized()) this.placePanes(true);
    }, PIN_INTERVAL_MS);
    setInterval(() => {
      if (!this.host.ready()) this.broadcast();
    }, PERMISSION_POLL_MS);
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
    guest.setVisible(true);
    if (guest.state === 'stopped' || guest.state === 'error') guest.start();
    this.placePanes(true);
    this.raisePanes();
    this.remember();
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
    return new Guest(profile, this.host, this.exe ?? '', () => {
      // A guest that just got its window needs placing; others only need the UI refreshed.
      const g = this.guests.get(profile.id);
      if (g && this.panes.includes(profile.id) && g.state === 'running') {
        this.placePanes(true);
        if (profile.id === this.active) g.raise();
      }
      this.broadcast();
    });
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
    const content = this.win.getContentBounds();
    if (process.platform === 'win32') {
      const scale = screen.getDisplayMatching(content).scaleFactor;
      return paneRects(childRect(content, scale, TAB_BAR_HEIGHT), panes);
    }
    return paneRects(guestRect(content, TAB_BAR_HEIGHT), panes);
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

function createShell(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Claude Desk',
    backgroundColor: '#1f1f22',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  const desk = new Desk(win);

  ipcMain.handle('desk:state', () => desk.state());
  ipcMain.handle('desk:add', (_e, name: string) => desk.add(String(name)));
  ipcMain.handle('desk:activate', (_e, id: string) => desk.activate(String(id)));
  ipcMain.handle('desk:stop', (_e, id: string) => desk.stop(String(id)));
  ipcMain.handle('desk:remove', (_e, id: string) => desk.remove(String(id)));
  ipcMain.handle('desk:layout', (_e, layout: Layout) => desk.setLayout(layout === 'split' ? 'split' : 'tabs'));
  ipcMain.handle('desk:permission', () => desk.requestPermission());

  deepLinks = new DeepLinks((url) => desk.deliverUrl(url));
  deepLinks.install();

  win.loadFile(path.join(app.getAppPath(), 'static', 'index.html')).then(() => {
    app.focus({ steal: true });
    desk.reopen();
  });
}

let deepLinks: DeepLinks | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(createShell);
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => deepLinks?.uninstall());
}
