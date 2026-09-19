// Pure geometry for placing a guest window inside the shell's content area.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TAB_BAR_HEIGHT = 40;

// Where the active guest goes, in the shell's coordinate space (points).
// `content` is the shell's content bounds in screen coordinates.
export function guestRect(content: Rect, tabBar = TAB_BAR_HEIGHT): Rect {
  return {
    x: content.x,
    y: content.y + tabBar,
    width: Math.max(1, content.width),
    height: Math.max(1, content.height - tabBar),
  };
}

// Equal columns of the guest area for side-by-side panes.
export function paneRects(area: Rect, panes: number): Rect[] {
  const n = Math.max(1, panes);
  const rects: Rect[] = [];
  let x = area.x;
  for (let i = 0; i < n; i++) {
    const right = area.x + Math.round(((i + 1) * area.width) / n);
    rects.push({ x, y: area.y, width: Math.max(1, right - x), height: area.height });
    x = right;
  }
  return rects;
}

export function sameRect(a: Rect | undefined, b: Rect): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
