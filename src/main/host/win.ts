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

export class WinHost implements WindowHost {
  private shell = 0n;
  // Physical pixels per point of the display the shell is on.
  scale = 1;

  setShellHandle(handle: Buffer): void {
    this.shell = handle.readBigUInt64LE(0);
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

  attach(win: GuestWindow): void {
    const hwnd = win as bigint;
    const style = BigInt(GetWindowLongPtrW(hwnd, GWL_STYLE));
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~TOP_LEVEL_STYLES) | WS_CHILD);
    SetParent(hwnd, this.shell);
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
  }

  detach(win: GuestWindow): void {
    const hwnd = win as bigint;
    SetParent(hwnd, 0n);
    const style = BigInt(GetWindowLongPtrW(hwnd, GWL_STYLE));
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_CHILD) | WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    ShowWindow(hwnd, SW_RESTORE);
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
