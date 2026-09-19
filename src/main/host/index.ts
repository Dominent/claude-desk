import type { WindowHost } from './types';

export type { GuestWindow, WindowHost } from './types';

export function createHost(): WindowHost {
  if (process.platform === 'darwin') {
    const { MacHost } = require('./mac') as typeof import('./mac');
    return new MacHost();
  }
  if (process.platform === 'win32') {
    const { WinHost } = require('./win') as typeof import('./win');
    return new WinHost();
  }
  throw new Error(`Switchboard supports macOS and Windows, not ${process.platform}`);
}
