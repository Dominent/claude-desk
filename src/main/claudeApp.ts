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

// Current builds ship as an MSIX package under WindowsApps. The directory
// itself cannot be listed by a normal user, so try the known package name
// pattern, then fall back to the App Execution Alias that Windows creates.
function findMsixExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const apps = path.join(env.ProgramFiles ?? 'C:\\Program Files', 'WindowsApps');
  try {
    const dirs = fs.readdirSync(apps).filter((d) => /^Claude_.*__pzs8sxrjxfjjc$/.test(d));
    for (const d of dirs.sort().reverse()) {
      const exe = path.join(apps, d, 'app', 'Claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // listing WindowsApps is denied for normal users
  }
  const alias = path.join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'Claude.exe');
  return fs.existsSync(alias) ? alias : undefined;
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
