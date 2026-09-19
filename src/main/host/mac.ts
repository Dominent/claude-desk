// macOS host. There is no supported way to put another process's window inside
// ours, so the guest window is pinned over the shell's content area with the
// Accessibility API, hidden when its tab is inactive and raised when active.
// Position and size need the Accessibility grant; hide/unhide/activate go
// through NSRunningApplication and need nothing.
import koffi from 'koffi';
import type { Rect } from '../geometry';
import type { GuestWindow, WindowHost } from './types';

const AX = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
const OBJC = koffi.load('/usr/lib/libobjc.A.dylib');
const LS = koffi.load('/System/Library/Frameworks/CoreServices.framework/CoreServices');
koffi.load('/System/Library/Frameworks/Foundation.framework/Foundation', { global: true });

const CFTypeRef = koffi.pointer('CFTypeRef', koffi.opaque());
const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' });

const AXIsProcessTrusted = AX.func('bool AXIsProcessTrusted()');
const AXUIElementCreateApplication = AX.func('CFTypeRef AXUIElementCreateApplication(int pid)');
const AXUIElementCopyAttributeValue = AX.func('int AXUIElementCopyAttributeValue(CFTypeRef element, CFTypeRef attr, _Out_ CFTypeRef *value)');
const AXUIElementSetAttributeValue = AX.func('int AXUIElementSetAttributeValue(CFTypeRef element, CFTypeRef attr, CFTypeRef value)');
const AXUIElementPerformAction = AX.func('int AXUIElementPerformAction(CFTypeRef element, CFTypeRef action)');
const AXValueCreatePoint = AX.func('AXValueCreate', 'CFTypeRef', ['int', koffi.pointer(CGPoint)]);
const AXValueCreateSize = AX.func('AXValueCreate', 'CFTypeRef', ['int', koffi.pointer(CGSize)]);
const AXValueGetPoint = AX.func('AXValueGetValue', 'bool', ['CFTypeRef', 'int', koffi.out(koffi.pointer(CGPoint))]);
const AXValueGetSize = AX.func('AXValueGetValue', 'bool', ['CFTypeRef', 'int', koffi.out(koffi.pointer(CGSize))]);

const CFStringCreateWithCString = CF.func('CFTypeRef CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)');
const CFStringGetCString = CF.func('bool CFStringGetCString(CFTypeRef str, _Out_ char *buf, long size, uint32_t encoding)');
const CFArrayGetCount = CF.func('long CFArrayGetCount(CFTypeRef array)');
const CFArrayGetValueAtIndex = CF.func('CFTypeRef CFArrayGetValueAtIndex(CFTypeRef array, long index)');
const CFRetain = CF.func('CFTypeRef CFRetain(CFTypeRef value)');
const CFRelease = CF.func('void CFRelease(CFTypeRef value)');

const objc_getClass = OBJC.func('void *objc_getClass(const char *name)');
const sel_registerName = OBJC.func('void *sel_registerName(const char *name)');
const msgSendPid = OBJC.func('objc_msgSend', 'void *', ['void *', 'void *', 'int']);
const msgSendOpts = OBJC.func('objc_msgSend', 'bool', ['void *', 'void *', 'uint64_t']);
const msgSend = OBJC.func('objc_msgSend', 'bool', ['void *', 'void *']);
const msgSendStr = OBJC.func('objc_msgSend', 'void *', ['void *', 'void *', 'const char *']);
const msgSendPtr = OBJC.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
const msgSendEvent = OBJC.func('objc_msgSend', 'void *', ['void *', 'void *', 'uint32_t', 'uint32_t', 'void *', 'int16_t', 'int32_t']);
const msgSendParam = OBJC.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'uint32_t']);
const msgSendSend = OBJC.func('objc_msgSend', 'void *', ['void *', 'void *', 'uint64_t', 'double', 'void *']);

const LSCopyDefaultHandlerForURLScheme = LS.func('CFTypeRef LSCopyDefaultHandlerForURLScheme(CFTypeRef scheme)');
const LSSetDefaultHandlerForURLScheme = LS.func('int LSSetDefaultHandlerForURLScheme(CFTypeRef scheme, CFTypeRef bundleId)');

const UTF8 = 0x08000100;
const kAXValueCGPointType = 1;
const kAXValueCGSizeType = 2;
const NSApplicationActivateAllWindows = 1;
const NSApplicationActivateIgnoringOtherApps = 2;

const attr = (name: string) => CFStringCreateWithCString(null, name, UTF8);
const kAXWindows = attr('AXWindows');
const kAXSubrole = attr('AXSubrole');
const kAXPosition = attr('AXPosition');
const kAXSize = attr('AXSize');
const kAXRaise = attr('AXRaise');

const NSRunningApplication = objc_getClass('NSRunningApplication');
const NSAppleEventDescriptor = objc_getClass('NSAppleEventDescriptor');
const NSString = objc_getClass('NSString');
const selDescriptorWithPid = sel_registerName('descriptorWithProcessIdentifier:');
const selAppleEvent = sel_registerName('appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID:');
const selStringWithUTF8 = sel_registerName('stringWithUTF8String:');
const selDescriptorWithString = sel_registerName('descriptorWithString:');
const selSetParam = sel_registerName('setParamDescriptor:forKeyword:');
const selSendEvent = sel_registerName('sendEventWithOptions:timeout:error:');

const fourcc = (code: string) => code.split('').reduce((n, c) => (n << 8) | c.charCodeAt(0), 0) >>> 0;
const kGURL = fourcc('GURL');
const kCoreEventClass = fourcc('aevt');
const kAEReopenApplication = fourcc('rapp');
const keyDirectObject = fourcc('----');
const kAutoGenerateReturnID = -1;
const kAnyTransactionID = 0;
const kAENoReply = 1;
const kAEDefaultTimeout = -1;
const selWithPid = sel_registerName('runningApplicationWithProcessIdentifier:');
const selActivate = sel_registerName('activateWithOptions:');
const selHide = sel_registerName('hide');
const selUnhide = sel_registerName('unhide');
const selIsActive = sel_registerName('isActive');

function cfString(ref: unknown): string {
  const buf = Buffer.alloc(256);
  return CFStringGetCString(ref, buf, buf.length, UTF8) ? koffi.decode(buf, 'char', -1) : '';
}

function runningApp(pid: number): unknown {
  return msgSendPid(NSRunningApplication, selWithPid, pid);
}

export class MacHost implements WindowHost {
  ready(): boolean {
    return AXIsProcessTrusted();
  }

  requestPermission(): void {
    // Electron wraps AXIsProcessTrustedWithOptions with the prompt flag.
    const { systemPreferences } = require('electron') as typeof import('electron');
    systemPreferences.isTrustedAccessibilityClient(true);
  }

  findWindow(pid: number): GuestWindow | undefined {
    const app = AXUIElementCreateApplication(pid);
    if (!app) return undefined;
    try {
      const out: unknown[] = [null];
      if (AXUIElementCopyAttributeValue(app, kAXWindows, out) !== 0 || !out[0]) return undefined;
      const windows = out[0];
      try {
        const count = Number(CFArrayGetCount(windows));
        for (let i = 0; i < count; i++) {
          const win = CFArrayGetValueAtIndex(windows, i);
          const sub: unknown[] = [null];
          if (AXUIElementCopyAttributeValue(win, kAXSubrole, sub) !== 0 || !sub[0]) continue;
          const subrole = cfString(sub[0]);
          CFRelease(sub[0]);
          if (subrole === 'AXStandardWindow') return CFRetain(win);
        }
        return undefined;
      } finally {
        CFRelease(windows);
      }
    } finally {
      CFRelease(app);
    }
  }

  attach(): void {}

  detach(win: GuestWindow): void {
    CFRelease(win);
  }

  layout(win: GuestWindow, rect: Rect): boolean {
    const pos = AXValueCreatePoint(kAXValueCGPointType, { x: rect.x, y: rect.y });
    const size = AXValueCreateSize(kAXValueCGSizeType, { width: rect.width, height: rect.height });
    try {
      // Size first: a window that is too big for its new position gets clamped by the OS.
      AXUIElementSetAttributeValue(win, kAXSize, size);
      const err = AXUIElementSetAttributeValue(win, kAXPosition, pos);
      AXUIElementSetAttributeValue(win, kAXSize, size);
      return err === 0;
    } finally {
      CFRelease(pos);
      CFRelease(size);
    }
  }

  // Where the window is now, or undefined once it is gone.
  frame(win: GuestWindow): Rect | undefined {
    const p: unknown[] = [null];
    const s: unknown[] = [null];
    if (AXUIElementCopyAttributeValue(win, kAXPosition, p) !== 0 || !p[0]) return undefined;
    if (AXUIElementCopyAttributeValue(win, kAXSize, s) !== 0 || !s[0]) {
      CFRelease(p[0]);
      return undefined;
    }
    try {
      const pt = { x: 0, y: 0 };
      const sz = { width: 0, height: 0 };
      if (!AXValueGetPoint(p[0], kAXValueCGPointType, pt) || !AXValueGetSize(s[0], kAXValueCGSizeType, sz)) return undefined;
      return { x: pt.x, y: pt.y, width: sz.width, height: sz.height };
    } finally {
      CFRelease(p[0]);
      CFRelease(s[0]);
    }
  }

  inFront(pids: number[]): boolean {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return true;
    return pids.some((pid) => {
      const app = runningApp(pid);
      return !!app && msgSend(app, selIsActive);
    });
  }

  // Deliver a URL to one specific process, the way Launch Services would to
  // the app it picks: a GURL Apple Event. This is how an instance gets its
  // sign-in callback when several copies of Claude are running.
  sendUrl(pid: number, url: string): boolean {
    const target = msgSendPid(NSAppleEventDescriptor, selDescriptorWithPid, pid);
    const event = msgSendEvent(NSAppleEventDescriptor, selAppleEvent, kGURL, kGURL, target, kAutoGenerateReturnID, kAnyTransactionID);
    if (!event) return false;
    const str = msgSendStr(NSString, selStringWithUTF8, url);
    msgSendParam(event, selSetParam, msgSendPtr(NSAppleEventDescriptor, selDescriptorWithString, str), keyDirectObject);
    return !!msgSendSend(event, selSendEvent, kAENoReply, kAEDefaultTimeout, null);
  }

  // What the Dock sends when its icon is clicked: an app whose last window
  // was closed makes a new one. Used for an adopted instance without a window.
  nudge(pid: number): boolean {
    const target = msgSendPid(NSAppleEventDescriptor, selDescriptorWithPid, pid);
    const event = msgSendEvent(NSAppleEventDescriptor, selAppleEvent, kCoreEventClass, kAEReopenApplication, target, kAutoGenerateReturnID, kAnyTransactionID);
    return !!event && !!msgSendSend(event, selSendEvent, kAENoReply, kAEDefaultTimeout, null);
  }

  defaultUrlHandler(scheme: string): string | undefined {
    const s = attr(scheme);
    const ref = LSCopyDefaultHandlerForURLScheme(s);
    CFRelease(s);
    if (!ref) return undefined;
    const id = cfString(ref);
    CFRelease(ref);
    return id || undefined;
  }

  setDefaultUrlHandler(scheme: string, bundleId: string): boolean {
    const s = attr(scheme);
    const b = attr(bundleId);
    const err = LSSetDefaultHandlerForURLScheme(s, b);
    CFRelease(s);
    CFRelease(b);
    return err === 0;
  }

  show(_win: GuestWindow, pid: number): void {
    const app = runningApp(pid);
    if (app) msgSend(app, selUnhide);
  }

  hide(_win: GuestWindow, pid: number): void {
    const app = runningApp(pid);
    if (app) msgSend(app, selHide);
  }

  raise(win: GuestWindow, pid: number): void {
    const app = runningApp(pid);
    if (app) {
      msgSend(app, selUnhide);
      msgSendOpts(app, selActivate, NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps);
    }
    AXUIElementPerformAction(win, kAXRaise);
  }
}
