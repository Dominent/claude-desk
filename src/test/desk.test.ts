import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { guestRect, paneRects, sameRect } from '../main/geometry';
import { defaultDataDir, ProfileStore, slug } from '../main/profiles';
import { compareVersionDirs, registeredHandlerExe } from '../main/claudeApp';
import { escapeRegex } from '../main/guest';
import { firstSighting, linkActivationUrl } from '../main/linkWatch';

test('guest rect sits below the tab bar', () => {
  assert.deepEqual(guestRect({ x: 100, y: 50, width: 800, height: 600 }, 40), { x: 100, y: 90, width: 800, height: 560 });
});

test('rects never collapse to zero', () => {
  const r = guestRect({ x: 0, y: 0, width: 300, height: 20 }, 40);
  assert.ok(r.height >= 1);
  assert.ok(sameRect(r, r));
  assert.ok(!sameRect(undefined, r));
});

test('slug normalizes names', () => {
  assert.equal(slug('  Work Account! '), 'work-account');
  assert.throws(() => slug('!!!'));
});

test('data directories sit next to the app default, in the platform\'s own path style', () => {
  assert.equal(defaultDataDir('work', 'darwin', '/Users/x'), '/Users/x/Library/Application Support/Claude-work');
  assert.match(defaultDataDir('work', 'win32', 'C:\\Users\\x'), /\\Claude-work$/);
});

test('the registered handler yields the Claude exe but not the shell', () => {
  const claude = '(Default)    REG_SZ    "C:\\Program Files\\WindowsApps\\Claude_2.110.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe" "%1"';
  assert.equal(registeredHandlerExe(claude), 'C:\\Program Files\\WindowsApps\\Claude_2.110.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe');
  assert.equal(registeredHandlerExe('(Default)    REG_SZ    "C:\\Work\\claude-desk\\node_modules\\electron\\dist\\electron.exe" "%1"'), undefined);
});

test('profile store round-trips and rejects duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const file = path.join(dir, 'profiles.json');
  const store = new ProfileStore(file);
  const p = store.add('Work', path.join(dir, 'data'));
  assert.equal(p.id, 'work');
  assert.throws(() => store.add('work'));
  assert.equal(store.rename('work', ' Work laptop ').name, 'Work laptop');
  assert.equal(store.get('work')?.dataDir, path.join(dir, 'data'));
  assert.throws(() => store.rename('work', '  '));
  const again = new ProfileStore(file);
  assert.deepEqual(again.list(), [{ ...p, name: 'Work laptop' }]);
  again.remove('work');
  assert.deepEqual(new ProfileStore(file).list(), []);
});

test('newest Squirrel version directory wins', () => {
  const dirs = ['app-1.9.0', 'app-1.10.2', 'app-1.10.0'].sort(compareVersionDirs).reverse();
  assert.equal(dirs[0], 'app-1.10.2');
});

test('pane rects tile the area without gaps or overlap', () => {
  const [a, b] = paneRects({ x: 10, y: 20, width: 1001, height: 500 }, 2);
  assert.equal(a.x, 10);
  assert.equal(a.x + a.width, b.x);
  assert.equal(b.x + b.width, 1011);
  assert.equal(a.height, 500);
  assert.equal(paneRects({ x: 0, y: 0, width: 100, height: 10 }, 1)[0].width, 100);
});

test('a link activation is a default-profile Claude started with a claude:// URL', () => {
  const exe = String.raw`"C:\Program Files\WindowsApps\Claude_2.2553.1.0_x64__pzs8sxrjxfjjc\app\Claude.exe"`;
  assert.equal(linkActivationUrl(`${exe} "claude://claude.ai/login/callback?code=abc&state=xyz"`), 'claude://claude.ai/login/callback?code=abc&state=xyz');
  assert.equal(linkActivationUrl(`${exe} claude://claude.ai/x`), 'claude://claude.ai/x');
  // Our own forward to a profile must never be picked up again, or it loops.
  assert.equal(linkActivationUrl(`${exe} --user-data-dir=C:\\Users\\x\\Claude-work "claude://claude.ai/x"`), undefined);
  assert.equal(linkActivationUrl(`${exe} "--user-data-dir=C:\\Users\\x\\Claude-work" "claude://claude.ai/x"`), undefined);
  assert.equal(linkActivationUrl(`${exe} --type=renderer`), undefined);
});

test('the same link seen twice in quick succession is delivered once', () => {
  let now = 1000;
  const isNew = firstSighting(2000, () => now);
  assert.equal(isNew('claude://a'), true);
  now += 500;
  assert.equal(isNew('claude://a'), false);
  assert.equal(isNew('claude://b'), true);
  now += 2500;
  assert.equal(isNew('claude://a'), true);
});

test('a data directory is matched whole, not as a prefix', () => {
  const dir = 'C:\\Users\\x\\AppData\\Roaming\\Claude-test';
  const re = new RegExp(`--user-data-dir=${escapeRegex(dir)}("|\\s|$)`);
  assert.ok(re.test(`"C:\\Claude.exe" --user-data-dir=${dir}`));
  assert.ok(re.test(`"C:\\Claude.exe" "--user-data-dir=${dir}" --flag`));
  assert.ok(!re.test(`"C:\\Claude.exe" --user-data-dir=${dir}2`));
});
