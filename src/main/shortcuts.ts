import { BrowserWindow, globalShortcut } from 'electron';

// Tab shortcuts: Ctrl+1..9 picks a tab, Ctrl+Tab / Ctrl+Shift+Tab cycle,
// Ctrl+Alt+Left / Right focus the left or right pane in split layout.
//
// While the user types in a guest, that guest is the foreground window and the
// shell never sees the keys, so the shortcuts have to be system level. They are
// registered only while the shell or one of its guests is in front, and
// released as soon as another app is, so nothing is taken from other apps.
export interface ShortcutActions {
  tab(index: number): void;
  next(): void;
  prev(): void;
  pane(side: 'left' | 'right'): void;
}

const OURS_POLL_MS = 150;
const WM_HOTKEY = 0x0312;

export class Shortcuts {
  private active = false;
  private timer?: NodeJS.Timeout;
  private win32?: Win32HotKeys;

  constructor(
    private win: BrowserWindow,
    private actions: ShortcutActions,
    private ours: () => boolean,
  ) {}

  start(): void {
    if (process.platform === 'win32') {
      this.win32 = new Win32HotKeys(this.win, this.actions);
    }
    this.timer = setInterval(() => this.sync(), OURS_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.release();
  }

  private sync(): void {
    const ours = this.ours();
    if (ours && !this.active) this.claim();
    else if (!ours && this.active) this.release();
  }

  private claim(): void {
    this.active = true;
    console.log('[desk] shortcuts on');
    if (this.win32) return this.win32.register();
    for (let i = 1; i <= 9; i++) globalShortcut.register(`Control+${i}`, () => this.actions.tab(i - 1));
    globalShortcut.register('Control+Tab', () => this.actions.next());
    globalShortcut.register('Control+Shift+Tab', () => this.actions.prev());
    globalShortcut.register('Control+Alt+Left', () => this.actions.pane('left'));
    globalShortcut.register('Control+Alt+Right', () => this.actions.pane('right'));
  }

  private release(): void {
    if (!this.active) return;
    this.active = false;
    console.log('[desk] shortcuts off');
    if (this.win32) return this.win32.unregister();
    globalShortcut.unregisterAll();
  }
}

// Windows: RegisterHotKey delivers WM_HOTKEY to the shell window, which
// Electron lets us hook. Ids 1..9 are tabs, then cycle and pane keys.
const MOD_ALT = 1;
const MOD_CONTROL = 2;
const MOD_SHIFT = 4;
const MOD_NOREPEAT = 0x4000;
const VK_TAB = 0x09;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const ID_NEXT = 10;
const ID_PREV = 11;
const ID_LEFT = 12;
const ID_RIGHT = 13;

class Win32HotKeys {
  private hwnd: bigint;
  private RegisterHotKey: (hwnd: bigint, id: number, mods: number, vk: number) => boolean;
  private UnregisterHotKey: (hwnd: bigint, id: number) => boolean;

  constructor(win: BrowserWindow, private actions: ShortcutActions) {
    const koffi = require('koffi') as typeof import('koffi');
    const user32 = koffi.load('user32.dll');
    this.RegisterHotKey = user32.func('bool __stdcall RegisterHotKey(uint64_t hwnd, int id, uint32_t mods, uint32_t vk)');
    this.UnregisterHotKey = user32.func('bool __stdcall UnregisterHotKey(uint64_t hwnd, int id)');
    this.hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    win.hookWindowMessage(WM_HOTKEY, (wParam) => this.fire(Buffer.isBuffer(wParam) ? wParam.readUInt32LE(0) : Number(wParam)));
  }

  register(): void {
    for (let i = 1; i <= 9; i++) this.RegisterHotKey(this.hwnd, i, MOD_CONTROL | MOD_NOREPEAT, 0x30 + i);
    this.RegisterHotKey(this.hwnd, ID_NEXT, MOD_CONTROL | MOD_NOREPEAT, VK_TAB);
    this.RegisterHotKey(this.hwnd, ID_PREV, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_TAB);
    this.RegisterHotKey(this.hwnd, ID_LEFT, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_LEFT);
    this.RegisterHotKey(this.hwnd, ID_RIGHT, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_RIGHT);
  }

  unregister(): void {
    for (let id = 1; id <= ID_RIGHT; id++) this.UnregisterHotKey(this.hwnd, id);
  }

  private fire(id: number): void {
    if (id >= 1 && id <= 9) this.actions.tab(id - 1);
    else if (id === ID_NEXT) this.actions.next();
    else if (id === ID_PREV) this.actions.prev();
    else if (id === ID_LEFT) this.actions.pane('left');
    else if (id === ID_RIGHT) this.actions.pane('right');
  }
}
