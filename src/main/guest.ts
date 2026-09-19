import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { Rect } from './geometry';
import { sameRect } from './geometry';
import type { GuestWindow, WindowHost } from './host';
import type { Profile } from './profiles';

export type GuestState = 'stopped' | 'starting' | 'running' | 'error';

export interface GuestInfo {
  id: string;
  name: string;
  state: GuestState;
  pid?: number;
  error?: string;
}

const WINDOW_POLL_MS = 250;
const WINDOW_WAIT_MS = 90_000;

// One running Claude desktop instance: its process, its main window, and where
// that window currently sits.
export class Guest {
  state: GuestState = 'stopped';
  pid?: number;
  error?: string;
  window?: GuestWindow;
  private lastRect?: Rect;
  private poll?: NodeJS.Timeout;
  private visible = false;

  constructor(
    readonly profile: Profile,
    private host: WindowHost,
    private exe: string,
    private onChange: () => void,
  ) {}

  setName(name: string): void {
    this.profile.name = name;
  }

  info(): GuestInfo {
    return { id: this.profile.id, name: this.profile.name, state: this.state, pid: this.pid, error: this.error };
  }

  start(): void {
    if (this.state === 'starting' || this.state === 'running') return;
    fs.mkdirSync(this.profile.dataDir, { recursive: true });
    this.error = undefined;
    this.window = undefined;
    this.lastRect = undefined;

    // An instance someone launched by hand on this profile is adopted, not duplicated:
    // the app takes no single-instance lock on macOS.
    const existing = findGuestPid(this.profile.dataDir);
    if (existing) {
      this.pid = existing;
    } else {
      const child = spawn(this.exe, [`--user-data-dir=${this.profile.dataDir}`], { detached: true, stdio: 'ignore' });
      child.unref();
      child.on('error', (err) => this.fail(err.message));
      child.on('exit', () => this.onExit(child.pid));
      this.pid = child.pid;
    }
    this.state = 'starting';
    this.onChange();
    this.waitForWindow();
  }

  stop(): void {
    this.clearPoll();
    if (this.window) {
      this.host.detach(this.window);
      this.window = undefined;
    }
    if (this.pid) killTree(this.pid);
    this.pid = undefined;
    this.state = 'stopped';
    this.onChange();
  }

  // Let go of the window without killing the app (shell shutdown on Windows
  // must un-parent first or the child dies with us).
  release(): void {
    this.clearPoll();
    if (this.window) {
      this.host.show(this.window, this.pid!);
      this.host.detach(this.window);
      this.window = undefined;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.window || !this.pid) return;
    if (visible) this.host.show(this.window, this.pid);
    else this.host.hide(this.window, this.pid);
  }

  layout(rect: Rect, force = false): void {
    if (!this.window || !this.visible) return;
    if (!force && sameRect(this.lastRect, rect)) return;
    this.lastRect = rect;
    if (!this.host.layout(this.window, rect)) this.loseWindow();
  }

  // The window went away under us (closed, or the app replaced it): go back to waiting for one.
  private loseWindow(): void {
    if (!this.window) return;
    this.host.detach(this.window);
    this.window = undefined;
    this.lastRect = undefined;
    if (this.pid) {
      this.state = 'starting';
      this.onChange();
      this.waitForWindow();
    }
  }

  raise(): void {
    if (this.window && this.pid) this.host.raise(this.window, this.pid);
  }

  private waitForWindow(): void {
    const started = Date.now();
    let attempts = 0;
    this.clearPoll();
    this.poll = setInterval(() => {
      if (!this.pid) return this.clearPoll();
      const win = this.host.findWindow(this.pid);
      if (!win && ++attempts % 8 === 0) {
        console.log(`[desk] ${this.profile.id}: no window yet on pid ${this.pid}`);
        // A running app whose window was closed needs the same nudge as a Dock click.
        this.host.nudge?.(this.pid);
      }
      if (win) {
        this.clearPoll();
        this.window = win;
        this.host.attach(win);
        this.state = 'running';
        this.setVisible(this.visible);
        this.onChange();
      } else if (Date.now() - started > WINDOW_WAIT_MS) {
        this.clearPoll();
        this.fail('the Claude window never appeared');
      }
    }, WINDOW_POLL_MS);
  }

  private onExit(pid: number | undefined): void {
    if (pid !== this.pid) return;
    this.clearPoll();
    // The app relaunches itself after an update; if the profile is still up
    // under a new pid, follow it instead of reporting a stop.
    const successor = findGuestPid(this.profile.dataDir);
    if (successor) {
      this.pid = successor;
      this.window = undefined;
      this.state = 'starting';
      this.onChange();
      this.waitForWindow();
      return;
    }
    this.window = undefined;
    this.pid = undefined;
    this.state = 'stopped';
    this.onChange();
  }

  private fail(message: string): void {
    this.clearPoll();
    this.state = 'error';
    this.error = message;
    this.onChange();
  }

  private clearPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }
}

// The pid of a Claude main process already running on this data directory.
export function findGuestPid(dataDir: string): number | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('pgrep', ['-f', `Contents/MacOS/Claude --user-data-dir=${dataDir}( |$)`], { encoding: 'utf8' });
      const pid = Number(out.split('\n')[0]);
      return pid > 0 ? pid : undefined;
    }
    if (process.platform === 'win32') {
      const script =
        `Get-CimInstance Win32_Process -Filter "Name='Claude.exe' OR Name='claude.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*--user-data-dir=${dataDir.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*--type=*' } | ` +
        `Select-Object -First 1 -ExpandProperty ProcessId`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      const pid = Number(out.trim());
      return pid > 0 ? pid : undefined;
    }
  } catch {
    // pgrep exits 1 when nothing matches
  }
  return undefined;
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}
