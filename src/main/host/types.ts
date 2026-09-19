import type { Rect } from '../geometry';

// A handle to a guest's top-level window, opaque to the caller.
export type GuestWindow = unknown;

// Platform-specific window hosting. Windows reparents the guest window into the
// shell; macOS cannot, so it pins the window over the shell's content area.
export interface WindowHost {
  // True when the platform will let us drive other apps' windows.
  ready(): boolean;
  // Ask the OS for that permission, where that is a thing (macOS Accessibility).
  requestPermission(): void;
  // The guest's main window, once the app has created it.
  findWindow(pid: number): GuestWindow | undefined;
  // Take the window into the shell (a no-op on macOS).
  attach(win: GuestWindow): void;
  // Give it back before the guest is closed or the shell exits.
  detach(win: GuestWindow): void;
  // Place the window over the content area. `rect` is in the shell's
  // coordinate space; each host converts as it needs. False means the
  // window no longer exists.
  layout(win: GuestWindow, rect: Rect): boolean;
  show(win: GuestWindow, pid: number): void;
  hide(win: GuestWindow, pid: number): void;
  // Bring it in front of the shell and give it keyboard focus.
  raise(win: GuestWindow, pid: number): void;
}
