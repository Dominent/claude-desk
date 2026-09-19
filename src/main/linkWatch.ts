import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

// Sign-in callbacks on Windows.
//
// Signing in with Google opens the system browser, which returns to Claude
// through a claude:// link. Current Claude builds are MSIX packages that
// declare that scheme in their manifest, and for a scheme a package declares
// Windows ignores HKCU\Software\Classes\claude, and its link picker will not
// offer another app either. So the link always starts Claude on its default
// profile, which drops the callback because it did not start that sign-in.
//
// What can be done is to notice that launch: the short-lived Claude.exe that
// Windows starts for the link carries the URL on its command line. Switchboard
// watches for it and hands the same URL to the tab that is signing in. The
// default profile ignores its copy; nothing is registered and nothing needs
// setting up.

/**
 * The claude:// URL a Claude process was started to open, when Windows started
 * it for a link: a default-profile instance with the URL as an argument. Our own
 * forwards carry --user-data-dir and are ignored, or they would loop.
 */
export function linkActivationUrl(commandLine: string): string | undefined {
  if (/--user-data-dir[=\s]/i.test(commandLine)) return undefined;
  const m = commandLine.match(/"(claude:\/\/[^"]*)"|(?:^|\s)(claude:\/\/\S+)/i);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** A filter that is true the first time a URL is seen within `windowMs`, false for repeats. */
export function firstSighting(windowMs: number, now: () => number = Date.now): (url: string) => boolean {
  const seen = new Map<string, number>();
  return (url) => {
    const t = now();
    for (const [u, at] of seen) if (t - at >= windowMs) seen.delete(u);
    if (seen.has(url)) return false;
    seen.set(url, t);
    return true;
  };
}

// WMI's process-creation event, polled four times a second: no admin rights
// needed, and the link process lives for about a second. Filtered to Claude
// processes whose command line holds a link, so nothing else is reported.
const WQL =
  "SELECT * FROM __InstanceCreationEvent WITHIN 0.25 WHERE TargetInstance ISA 'Win32_Process' " +
  "AND TargetInstance.Name = 'claude.exe' AND TargetInstance.CommandLine LIKE '%claude://%'";

// The watcher exits by itself once Switchboard is gone, so a crash never
// leaves it running.
function watcherScript(parentPid: number): string {
  return [
    `Register-CimIndicationEvent -Query "${WQL}" -SourceIdentifier sbLinks | Out-Null`,
    'while ($true) {',
    '  $e = Wait-Event -SourceIdentifier sbLinks -Timeout 2',
    '  if ($e) {',
    '    [Console]::Out.WriteLine($e.SourceEventArgs.NewEvent.TargetInstance.CommandLine)',
    '    [Console]::Out.Flush()',
    '    Remove-Event -EventIdentifier $e.EventIdentifier',
    '  }',
    `  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }`,
    '}',
  ].join('\n');
}

const RESTART_MS = 5000;
const REPEAT_WINDOW_MS = 3000;

export class LinkWatcher {
  private child?: ChildProcess;
  private stopped = false;
  private isNew = firstSighting(REPEAT_WINDOW_MS);

  constructor(private onUrl: (url: string) => void) {}

  start(): void {
    if (process.platform !== 'win32' || this.child) return;
    this.stopped = false;
    const encoded = Buffer.from(watcherScript(process.pid), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      const url = linkActivationUrl(line.trim());
      if (url && this.isNew(url)) this.onUrl(url);
    });
    child.on('exit', () => {
      this.child = undefined;
      if (this.stopped) return;
      console.warn('[desk] sign-in link watcher stopped; restarting');
      setTimeout(() => this.start(), RESTART_MS);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = undefined;
  }
}
