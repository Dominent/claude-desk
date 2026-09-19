// Windows host. The guest's top-level window becomes a real child of the
// shell window through SetParent, so it moves, clips and minimizes with us.
import koffi from 'koffi';
import type { Rect } from '../geometry';
import type { GuestWindow, WindowHost } from './types';

const user32 = koffi.load('user32.dll');

// Handles are passed as integers: every Claude build for Windows is 64-bit.
const GetTopWindow = user32.func('uint64_t __stdcall GetTopWindow(uint64_t hwnd)');
const GetWindow = user32.func('uint64_t __stdcall GetWindow(uint64_t hwnd, uint32_t cmd)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uint64_t hwnd, _Out_ uint32_t *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uint64_t hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uint64_t hwnd, _Out_ char16_t *buf, int max)');
const SetParent = user32.func('uint64_t __stdcall SetParent(uint64_t child, uint64_t parent)');
const GetWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(uint64_t hwnd, int index)');
const SetWindowLongPtrW = user32.func('int64_t __stdcall SetWindowLongPtrW(uint64_t hwnd, int index, int64_t value)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uint64_t hwnd, uint64_t after, int x, int y, int w, int h, uint32_t flags)');
const MoveWindow = user32.func('bool __stdcall MoveWindow(uint64_t hwnd, int x, int y, int w, int h, bool repaint)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(uint64_t hwnd, int cmd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uint64_t hwnd)');
const SetFocus = user32.func('uint64_t __stdcall SetFocus(uint64_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(uint64_t hwnd)');
const GetParent = user32.func('uint64_t __stdcall GetParent(uint64_t hwnd)');
const GetFocus = user32.func('uint64_t __stdcall GetFocus()');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t attach, uint32_t to, bool flag)');
const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)');
// POINT is 8 bytes and travels in one register on every 64-bit Windows ABI.
const WindowFromPoint = user32.func('uint64_t __stdcall WindowFromPoint(uint64_t point)');
const GetCursorPosRaw = user32.func('bool __stdcall GetCursorPos(_Out_ int32_t *point)');

const GW_HWNDNEXT = 2;
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000n;
const WS_POPUP = 0x80000000n;
const WS_CAPTION = 0x00c00000n;
const WS_THICKFRAME = 0x00040000n;
const WS_SYSMENU = 0x00080000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const TOP_LEVEL_STYLES = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_RESTORE = 9;

const CHROMIUM_CLASS = 'Chrome_WidgetWin_1';
const VK_LBUTTON = 1;
const VK_RBUTTON = 2;
const CLICK_POLL_MS = 40;

function threadOf(hwnd: bigint): number {
  const pid: number[] = [0];
  return GetWindowThreadProcessId(hwnd, pid);
}

function cursorPoint(): bigint | undefined {
  const pt = [0, 0];
  if (!GetCursorPosRaw(pt)) return undefined;
  return (BigInt(pt[1] >>> 0) << 32n) | BigInt(pt[0] >>> 0);
}

export class WinHost implements WindowHost {
  private shell = 0n;
  private attached = new Set<bigint>();
  private clickWatch?: NodeJS.Timeout;
  private buttonWasDown = false;

  setShellHandle(handle: Buffer): void {
    this.shell = handle.readBigUInt64LE(0);
  }

  // A guest is a child window owned by another thread. Windows joins the input
  // queues when SetParent crosses threads, but nothing moves keyboard focus into
  // the child when it is clicked, because a child is never "activated". So the
  // mouse is watched: a button press over a guest sends focus to that guest.
  private watchClicks(): void {
    if (this.clickWatch) return;
    this.clickWatch = setInterval(() => {
      const down = (GetAsyncKeyState(VK_LBUTTON) | GetAsyncKeyState(VK_RBUTTON)) & 0x8000;
      const pressed = !!down && !this.buttonWasDown;
      this.buttonWasDown = !!down;
      if (!pressed || this.attached.size === 0) return;
      const pt = cursorPoint();
      if (pt === undefined) return;
      const guest = this.guestAt(WindowFromPoint(pt));
      if (guest && GetFocus() !== guest) SetFocus(guest);
    }, CLICK_POLL_MS);
  }

  // The attached guest that owns `hwnd`, which may be one of Chromium's inner windows.
  private guestAt(hwnd: bigint): bigint | undefined {
    for (let h = hwnd; h; h = GetParent(h)) {
      if (this.attached.has(h)) return h;
      if (h === this.shell) return undefined;
    }
    return undefined;
  }

  ready(): boolean {
    return true;
  }

  requestPermission(): void {}

  findWindow(pid: number): GuestWindow | undefined {
    for (let hwnd = GetTopWindow(0n); hwnd; hwnd = GetWindow(hwnd, GW_HWNDNEXT)) {
      if (!IsWindowVisible(hwnd)) continue;
      const out: number[] = [0];
      GetWindowThreadProcessId(hwnd, out);
      if (out[0] !== pid) continue;
      const buf = Buffer.alloc(128);
      const n = GetClassNameW(hwnd, buf, 64);
      if (koffi.decode(buf, 'char16_t', n) === CHROMIUM_CLASS) return hwnd;
    }
    return undefined;
  }

  // SetParent leaves WS_CHILD and WS_POPUP alone, so the styles are switched
  // first, as the API documentation asks, in both directions.
  attach(win: GuestWindow): void {
    const hwnd = win as bigint;
    const style = BigInt(GetWindowLongPtrW(hwnd, GWL_STYLE));
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~TOP_LEVEL_STYLES) | WS_CHILD);
    SetParent(hwnd, this.shell);
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    AttachThreadInput(threadOf(hwnd), threadOf(this.shell), true);
    this.attached.add(hwnd);
    this.watchClicks();
  }

  detach(win: GuestWindow): void {
    const hwnd = win as bigint;
    this.attached.delete(hwnd);
    AttachThreadInput(threadOf(hwnd), threadOf(this.shell), false);
    const style = BigInt(GetWindowLongPtrW(hwnd, GWL_STYLE));
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    SetParent(hwnd, 0n);
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    ShowWindow(hwnd, SW_RESTORE);
  }

  // Reparenting joins the two processes' input queues, and raise() parks the
  // keyboard in the guest. The tab bar asks for it back when clicked.
  focusShell(): void {
    SetFocus(this.shell);
  }

  // `rect` is already relative to the shell's client area and in physical pixels.
  layout(win: GuestWindow, rect: Rect): boolean {
    if (!IsWindow(win as bigint)) return false;
    return MoveWindow(win as bigint, rect.x, rect.y, rect.width, rect.height, true);
  }

  show(win: GuestWindow): void {
    ShowWindow(win as bigint, SW_SHOW);
  }

  hide(win: GuestWindow): void {
    ShowWindow(win as bigint, SW_HIDE);
  }

  raise(win: GuestWindow): void {
    const hwnd = win as bigint;
    ShowWindow(hwnd, SW_SHOW);
    SetForegroundWindow(this.shell);
    SetFocus(hwnd);
  }
}
