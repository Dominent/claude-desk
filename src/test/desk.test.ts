import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { childRect, guestRect, paneRects, sameRect } from '../main/geometry';
import { defaultDataDir, ProfileStore, slug } from '../main/profiles';
import { compareVersionDirs } from '../main/claudeApp';

test('guest rect sits below the tab bar', () => {
  assert.deepEqual(guestRect({ x: 100, y: 50, width: 800, height: 600 }, 40), { x: 100, y: 90, width: 800, height: 560 });
});

test('child rect is relative and scaled', () => {
  assert.deepEqual(childRect({ x: 100, y: 50, width: 800, height: 600 }, 1.5, 40), { x: 0, y: 60, width: 1200, height: 840 });
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

test('data directories sit next to the app default', () => {
  assert.equal(defaultDataDir('work', 'darwin', '/Users/x'), '/Users/x/Library/Application Support/Claude-work');
  assert.match(defaultDataDir('work', 'win32', 'C:\\Users\\x'), /Claude-work$/);
});

test('profile store round-trips and rejects duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const file = path.join(dir, 'profiles.json');
  const store = new ProfileStore(file);
  const p = store.add('Work', path.join(dir, 'data'));
  assert.equal(p.id, 'work');
  assert.throws(() => store.add('work'));
  const again = new ProfileStore(file);
  assert.deepEqual(again.list(), [p]);
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
