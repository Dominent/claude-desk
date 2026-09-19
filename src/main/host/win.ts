// Windows host. The guest stays a top-level window but is OWNED by the shell
// (GWLP_HWNDPARENT): owned windows sit above their owner, follow it in the
// z-order, and hide when it minimizes. Its frame is stripped and it is placed
// over the shell's content area on every move and resize.
//
// Reparenting it as a WS_CHILD looked cleaner but does not work: Chromium
// only treats its widget as active when its own HWND is the active window,
// and a child of a foreign top-level never is, so it drops every key press.
import koffi from 'koffi';
import type { Rect } from '../geometry';
import type { GuestWindow, WindowHost } from './types';

const user32 = koffi.load('user32.dll');

// Handles are passed as integers: every Claude build for Windows is 64-bit.
const GetTopWindow = user32.func('uint64_t __stdcall GetTopWindow(uint64_t hwnd)');
const GetWindow = user32.func('uint64_t __stdcall GetWindow(uint64_t hwnd, uint32_t cmd)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uint64_t hwnd, _Out_ uint32_t *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uint64_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(uint64_t hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uint64_t hwnd, _Out_ char16_t *buf, int max)');
const GetWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(uint64_t hwnd, int index)');
const SetWindowLongPtrW = user32.func('int64_t __stdcall SetWindowLongPtrW(uint64_t hwnd, int index, int64_t value)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uint64_t hwnd, uint64_t after, int x, int y, int w, int h, uint32_t flags)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(uint64_t hwnd, int cmd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uint64_t hwnd)');
const GetForegroundWindow = user32.func('uint64_t __stdcall GetForegroundWindow()');

const GW_HWNDNEXT = 2;
const GW_OWNER = 4;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_POPUP = 0x80000000n;
const WS_CAPTION = 0x00c00000n;
const WS_THICKFRAME = 0x00040000n;
const WS_SYSMENU = 0x00080000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const FRAME_STYLES = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_EX_APPWINDOW = 0x00040000n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SW_HIDE = 0;
const SW_SHOWNA = 8;
const SW_RESTORE = 9;

const CHROMIUM_CLASS = 'Chrome_WidgetWin_1';

export class WinHost implements WindowHost {
  private shell = 0n;

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
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~FRAME_STYLES) | WS_POPUP);
    const ex = BigInt(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    // No taskbar button of its own; the shell's is the one that matters.
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW);
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, this.shell);
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  }

  detach(win: GuestWindow): void {
    const hwnd = win as bigint;
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, 0n);
    const style = BigInt(GetWindowLongPtrW(hwnd, GWL_STYLE));
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | FRAME_STYLES);
    const ex = BigInt(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW);
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    ShowWindow(hwnd, SW_RESTORE);
  }

  // `rect` is in physical screen pixels.
  layout(win: GuestWindow, rect: Rect): boolean {
    const hwnd = win as bigint;
    if (!IsWindow(hwnd)) return false;
    SetWindowPos(hwnd, 0n, rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE);
    // Only a window that is gone counts as lost; a hidden one could never be found again.
    return IsWindow(hwnd);
  }

  show(win: GuestWindow): void {
    ShowWindow(win as bigint, SW_SHOWNA);
  }

  hide(win: GuestWindow): void {
    ShowWindow(win as bigint, SW_HIDE);
  }

  inFront(): boolean {
    // koffi hands back a uint64 as a plain number when it fits, and the shell
    // handle is a BigInt: compare as BigInt or the test is always false.
    const fg = BigInt(GetForegroundWindow());
    return !!fg && (fg === this.shell || BigInt(GetWindow(fg, GW_OWNER)) === this.shell);
  }

  raise(win: GuestWindow): void {
    const hwnd = win as bigint;
    ShowWindow(hwnd, SW_SHOWNA);
    // Activating an owned window brings its owner along; Chromium then gets a
    // real WM_ACTIVATE and accepts keyboard input.
    SetForegroundWindow(hwnd);
  }
}
