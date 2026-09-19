import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface Profile {
  id: string;
  name: string;
  dataDir: string;
}

export function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw new Error('profile name needs at least one letter or digit');
  return s;
}

// Each profile is a Claude user-data directory next to the app's own one, so a
// profile made by hand (or by the claude-profile script) is picked up as-is.
export function defaultDataDir(id: string, platform = process.platform, home = os.homedir()): string {
  if (platform === 'win32') {
    const p = path.win32;
    return p.join(process.env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), `Claude-${id}`);
  }
  const p = path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', `Claude-${id}`);
  return p.join(process.env.XDG_CONFIG_HOME ?? p.join(home, '.config'), `Claude-${id}`);
}

export class ProfileStore {
  private profiles: Profile[] = [];

  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) this.profiles = raw.filter(isProfile);
    } catch {
      this.profiles = [];
    }
  }

  list(): Profile[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  get(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  add(name: string, dataDir?: string): Profile {
    const id = slug(name);
    if (this.get(id)) throw new Error(`profile "${id}" already exists`);
    const profile = { id, name: name.trim(), dataDir: dataDir ?? defaultDataDir(id) };
    this.profiles.push(profile);
    this.save();
    return profile;
  }

  remove(id: string): void {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.profiles, null, 2) + '\n');
  }
}

function isProfile(p: unknown): p is Profile {
  return !!p && typeof p === 'object' && typeof (p as Profile).id === 'string' && typeof (p as Profile).dataDir === 'string';
}
