// A project file that holds structured "board" data (Bitable-style base),
// rendered by the native BoardView instead of an HTML/iframe preview.
// Convention: a file named `board.json`, or any `*.board.json`. Kept as one
// shared predicate so the viewer routing and any file-list classification agree.
export function isBoardFileName(name: string): boolean {
  if (!name) return false;
  return name === 'board.json' || name.endsWith('/board.json') || name.endsWith('.board.json');
}
