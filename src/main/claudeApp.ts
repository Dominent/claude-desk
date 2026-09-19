import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Finds the real Claude desktop executable. An explicit path (CLAUDE_DESK_APP)
// wins, otherwise the platform's default install location.
export function findClaudeExecutable(platform = process.platform, env = process.env): string | undefined {
  const explicit = env.CLAUDE_DESK_APP;
  if (explicit && fs.existsSync(explicit)) return explicit;

  if (platform === 'darwin') {
    for (const app of ['/Applications/Claude.app', path.join(env.HOME ?? '', 'Applications', 'Claude.app')]) {
      const exe = path.join(app, 'Contents', 'MacOS', 'Claude');
      if (fs.existsSync(exe)) return exe;
    }
    return undefined;
  }

  if (platform === 'win32') {
    return findMsixExecutable(env) ?? findSquirrelExecutable(env);
  }

  return undefined;
}

// Current builds ship as an MSIX package under WindowsApps. That directory
// cannot be listed by a normal user, but a known full path is reachable, so
// ask where the package is: the claude:// handler the app registered, then
// the package manager, then the App Execution Alias if one exists.
function findMsixExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const fromHandler = registeredHandlerExe();
  if (fromHandler && fs.existsSync(fromHandler)) return fromHandler;
  try {
    const location = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-AppxPackage -Name Claude).InstallLocation'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const exe = path.join(location, 'app', 'Claude.exe');
    if (location && fs.existsSync(exe)) return exe;
  } catch {
    // no package manager answer
  }
  const alias = path.join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'Claude.exe');
  return fs.existsSync(alias) ? alias : undefined;
}

// The exe in HKCU\Software\Classes\claude\shell\open\command, when it is
// Claude's own (Claude Desk overwrites the key while it runs).
export function registeredHandlerExe(command?: string): string | undefined {
  if (command === undefined) {
    try {
      command = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\claude\\shell\\open\\command', '/ve'], {
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch {
      return undefined;
    }
  }
  const m = command.match(/"([^"]*\\Claude\.exe)"/i);
  return m?.[1];
}

// Older Squirrel layout: <LOCALAPPDATA>\AnthropicClaude\app-<version>\claude.exe.
// The claude.exe stub one level up relaunches the versioned one and exits,
// which would lose the pid, so pick the newest versioned directory directly.
function findSquirrelExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const root = path.join(env.LOCALAPPDATA ?? '', 'AnthropicClaude');
  if (!fs.existsSync(root)) return undefined;
  const versions = fs
    .readdirSync(root)
    .filter((d) => /^app-\d/.test(d))
    .sort(compareVersionDirs)
    .reverse();
  for (const v of versions) {
    const exe = path.join(root, v, 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

export function compareVersionDirs(a: string, b: string): number {
  const pa = a.slice(4).split('.').map(Number);
  const pb = b.slice(4).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
