import { app } from 'electron';
import { execFileSync, spawn } from 'node:child_process';

export const SCHEME = 'claude';

// The sign-in flow ends with a claude:// URL. With several Claude instances
// running the OS delivers it to whichever it likes, so while Claude Desk runs
// it owns the scheme and passes each URL to the instance the user is using.
// On macOS the app notices it is not the handler and switches to an in-process
// auth session, which needs no routing at all. The previous handler comes
// back on quit.
//
// Every Claude instance registers itself as the handler when it starts, so a
// single claim is undone by the next tab; the claim is renewed on a timer.
const RECLAIM_MS = 1500;

export class DeepLinks {
  private previousMac?: string;
  private previousWinCommand?: string;
  private timer?: NodeJS.Timeout;

  constructor(private onUrl: (url: string) => void) {}

  // Take the scheme back if a guest grabbed it.
  reclaim(): void {
    if (process.platform === 'darwin') {
      const { MacHost } = require('./host/mac') as typeof import('./host/mac');
      if (new MacHost().defaultUrlHandler(SCHEME) !== bundleId()) app.setAsDefaultProtocolClient(SCHEME);
    } else if (process.platform === 'win32') {
      if (!app.isDefaultProtocolClient(SCHEME)) app.setAsDefaultProtocolClient(SCHEME);
    }
  }

  install(): void {
    if (process.platform === 'darwin') {
      const { MacHost } = require('./host/mac') as typeof import('./host/mac');
      const host = new MacHost();
      this.previousMac = host.defaultUrlHandler(SCHEME);
      app.on('open-url', (e, url) => {
        e.preventDefault();
        this.onUrl(url);
      });
      app.setAsDefaultProtocolClient(SCHEME);
      this.timer = setInterval(() => this.reclaim(), RECLAIM_MS);
      return;
    }
    if (process.platform === 'win32') {
      this.previousWinCommand = readWinCommand();
      app.setAsDefaultProtocolClient(SCHEME);
      this.timer = setInterval(() => this.reclaim(), RECLAIM_MS);
      // A second Claude Desk started by the OS to open a URL hands it to us and exits.
      app.on('second-instance', (_e, argv) => {
        const url = argv.find((a) => a.startsWith(`${SCHEME}://`));
        if (url) this.onUrl(url);
      });
      const url = process.argv.find((a) => a.startsWith(`${SCHEME}://`));
      if (url) app.whenReady().then(() => this.onUrl(url));
    }
  }

  uninstall(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (process.platform === 'darwin') {
      const { MacHost } = require('./host/mac') as typeof import('./host/mac');
      const host = new MacHost();
      if (this.previousMac && this.previousMac !== bundleId()) host.setDefaultUrlHandler(SCHEME, this.previousMac);
      else app.removeAsDefaultProtocolClient(SCHEME);
      return;
    }
    if (process.platform === 'win32') {
      app.removeAsDefaultProtocolClient(SCHEME);
      if (this.previousWinCommand) writeWinCommand(this.previousWinCommand);
    }
  }
}

// Windows: hand the URL to the instance on that data directory. The app's
// single-instance lock is keyed on the directory, so the new process just
// forwards its arguments to the running one and exits.
export function forwardUrlWindows(exe: string, dataDir: string, url: string): void {
  spawn(exe, [`--user-data-dir=${dataDir}`, url], { detached: true, stdio: 'ignore' }).unref();
}

function bundleId(): string {
  return process.platform === 'darwin' ? (require('electron').app.name === 'Electron' ? 'com.github.Electron' : 'local.claude-desk') : '';
}

const WIN_KEY = `HKCU\\Software\\Classes\\${SCHEME}\\shell\\open\\command`;

function readWinCommand(): string | undefined {
  try {
    const out = execFileSync('reg', ['query', WIN_KEY, '/ve'], { encoding: 'utf8' });
    const m = out.match(/REG_SZ\s+(.*)$/m);
    return m?.[1].trim();
  } catch {
    return undefined;
  }
}

function writeWinCommand(command: string): void {
  try {
    execFileSync('reg', ['add', WIN_KEY, '/ve', '/d', command, '/f'], { stdio: 'ignore' });
  } catch {
    // leave the registry as the app rewrites it on its next start
  }
}
