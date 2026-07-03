import { describe, expect, it } from 'vitest';

import { decideAutoOpenAfterWrite, pickNewlyCreatedPageFile } from '../../src/components/auto-open-file';

describe('decideAutoOpenAfterWrite', () => {
  it('returns shouldOpen=false when filePath is empty', () => {
    const result = decideAutoOpenAfterWrite('', [{ name: 'index.html' }]);
    expect(result).toEqual({ shouldOpen: false, fileName: null });
  });

  it('returns shouldOpen=true when filePath equals a project file path', () => {
    const result = decideAutoOpenAfterWrite('index.html', [
      { name: 'index.html', path: 'index.html' },
      { name: 'styles.css', path: 'styles.css' },
    ]);
    expect(result).toEqual({ shouldOpen: true, fileName: 'index.html' });
  });

  it('returns shouldOpen=false when filePath has slashes but matches no project path', () => {
    // Regression: this is the "rogue empty tab" case — the agent edited a
    // file outside the project (e.g. an upstream repo's source file) and
    // we must NOT open a placeholder tab for it. filePath has a slash, so
    // the basename fallback is intentionally skipped.
    const result = decideAutoOpenAfterWrite(
      '/home/bryan/projects/open-design/apps/daemon/src/project-watchers.ts',
      [
        { name: 'index.html', path: 'index.html' },
        { name: 'App.jsx', path: 'App.jsx' },
      ],
    );
    expect(result).toEqual({ shouldOpen: false, fileName: null });
  });

  it('falls back to basename match when filePath is just a basename', () => {
    const result = decideAutoOpenAfterWrite('App.jsx', [
      { name: 'index.html', path: 'index.html' },
      { name: 'App.jsx', path: 'App.jsx' },
      { name: 'styles.css', path: 'styles.css' },
      { name: 'README.md', path: 'README.md' },
    ]);
    expect(result).toEqual({ shouldOpen: true, fileName: 'App.jsx' });
  });

  it('matches an absolute filePath via path-suffix against a nested project file', () => {
    // Real-world case: the agent passes an absolute file_path; the project
    // file lives at "prototype/App.jsx". The decision must still resolve
    // unambiguously, returning the project-relative file name.
    const result = decideAutoOpenAfterWrite(
      '/home/bryan/projects/open-design/.od/projects/abc/prototype/App.jsx',
      [
        { name: 'index.html', path: 'index.html' },
        { name: 'prototype/App.jsx', path: 'prototype/App.jsx' },
      ],
    );
    expect(result).toEqual({ shouldOpen: true, fileName: 'prototype/App.jsx' });
  });

  it('declines when an absolute filePath could match multiple nested project files (ambiguous)', () => {
    // Two project files share the basename "App.jsx" but live in different
    // subdirs. The agent's filePath ends with "/App.jsx" only, with no
    // disambiguating subdirectory match — refuse rather than open the wrong file.
    const result = decideAutoOpenAfterWrite(
      '/some/external/path/App.jsx',
      [
        { name: 'src/App.jsx', path: 'src/App.jsx' },
        { name: 'lib/App.jsx', path: 'lib/App.jsx' },
      ],
    );
    expect(result).toEqual({ shouldOpen: false, fileName: null });
  });

  it('declines when filePath has a slash and no project path is a suffix match', () => {
    // Agent edited /upstream/repo/App.jsx; project also has prototype/App.jsx.
    // The previous (basename-only) implementation would have opened the
    // wrong file; the path-suffix check leaves zero matches and the
    // basename fallback is intentionally skipped because filePath has a slash.
    const result = decideAutoOpenAfterWrite('/upstream/repo/App.jsx', [
      { name: 'prototype/App.jsx', path: 'prototype/App.jsx' },
    ]);
    expect(result).toEqual({ shouldOpen: false, fileName: null });
  });

  it('still works when ProjectFile entries omit the optional path field', () => {
    // Defensive: ProjectFile.path is optional in the API contract. Fall
    // back to using `name` (which the daemon populates with the full
    // project-relative path) when path is missing.
    const result = decideAutoOpenAfterWrite('index.html', [
      { name: 'index.html' },
      { name: 'styles.css' },
    ]);
    expect(result).toEqual({ shouldOpen: true, fileName: 'index.html' });
  });

  it('declines a basename fallback when multiple project files share the basename', () => {
    const result = decideAutoOpenAfterWrite('App.jsx', [
      { name: 'src/App.jsx', path: 'src/App.jsx' },
      { name: 'lib/App.jsx', path: 'lib/App.jsx' },
    ]);
    expect(result).toEqual({ shouldOpen: false, fileName: null });
  });

  it('declines to auto-open a .jsx module loaded by a sibling HTML entry', () => {
    // icons.jsx is a module of a multi-file React prototype (loaded by
    // "Backups Panel.html" via <script type="text/babel" src>). It has no
    // standalone preview, so auto-opening it strands the user on a dead-end
    // tab. Issue #2744.
    const result = decideAutoOpenAfterWrite(
      'icons.jsx',
      [
        { name: 'icons.jsx', path: 'icons.jsx' },
        { name: 'Backups Panel.html', path: 'Backups Panel.html' },
      ],
      { moduleFileNames: new Set(['icons.jsx']) },
    );
    expect(result).toEqual({ shouldOpen: false, fileName: null });
  });

  it('still auto-opens the same file when no module set is supplied (back-compat)', () => {
    // Proves the suppression is driven solely by moduleFileNames: the legacy
    // two-arg call path is unchanged, so this test goes red if the guard ever
    // suppresses unconditionally.
    const result = decideAutoOpenAfterWrite('icons.jsx', [
      { name: 'icons.jsx', path: 'icons.jsx' },
    ]);
    expect(result).toEqual({ shouldOpen: true, fileName: 'icons.jsx' });
  });

  it('still auto-opens a standalone artifact even when other modules exist', () => {
    const result = decideAutoOpenAfterWrite(
      'landing.html',
      [
        { name: 'landing.html', path: 'landing.html' },
        { name: 'icons.jsx', path: 'icons.jsx' },
      ],
      { moduleFileNames: new Set(['icons.jsx']) },
    );
    expect(result).toEqual({ shouldOpen: true, fileName: 'landing.html' });
  });
});

describe('pickNewlyCreatedPageFile', () => {
  it('opens an HTML page that a Bash script created after the snapshot', () => {
    // The wechat render script writes 4-排版-article.html via Bash (no Write
    // tool_use). board.json already existed (kind code) in the snapshot.
    const prev = new Set(['board.json', '2-写稿-article.md']);
    const next = [
      { name: 'board.json', path: 'board.json', kind: 'code', mtime: 5 },
      { name: '2-写稿-article.md', path: '2-写稿-article.md', kind: 'document', mtime: 4 },
      { name: '4-排版-article.html', path: '4-排版-article.html', kind: 'html', mtime: 9 },
    ];
    expect(pickNewlyCreatedPageFile(prev, next)).toBe('4-排版-article.html');
  });

  it('returns null when no new page file appeared (only an existing file changed)', () => {
    // A re-render overwrites the html (mtime bumps) but it is NOT new, so we
    // must not re-open it — the viewer re-fetches an open file on mtime change.
    const prev = new Set(['board.json', '4-排版-article.html']);
    const next = [
      { name: 'board.json', path: 'board.json', kind: 'code', mtime: 7 },
      { name: '4-排版-article.html', path: '4-排版-article.html', kind: 'html', mtime: 20 },
    ];
    expect(pickNewlyCreatedPageFile(prev, next)).toBeNull();
  });

  it('ignores newly-created images (board thumbnails), never stealing focus from a page', () => {
    // During 配图, the script creates images under 3-配图/; those are board
    // assets, not pages. With no new page file, nothing auto-opens.
    const prev = new Set(['board.json', '4-排版-article.html']);
    const next = [
      { name: 'board.json', path: 'board.json', kind: 'code', mtime: 7 },
      { name: '4-排版-article.html', path: '4-排版-article.html', kind: 'html', mtime: 8 },
      { name: '3-配图/封面.jpg', path: '3-配图/封面.jpg', kind: 'image', mtime: 30 },
      { name: '3-配图/图1.jpg', path: '3-配图/图1.jpg', kind: 'image', mtime: 31 },
    ];
    expect(pickNewlyCreatedPageFile(prev, next)).toBeNull();
  });

  it('picks the most-recently-modified page when several new pages appear', () => {
    const prev = new Set<string>([]);
    const next = [
      { name: 'a.html', path: 'a.html', kind: 'html', mtime: 3 },
      { name: 'b.html', path: 'b.html', kind: 'html', mtime: 9 },
    ];
    expect(pickNewlyCreatedPageFile(prev, next)).toBe('b.html');
  });

  it('falls back to name when path is omitted', () => {
    const prev = new Set(['old.html']);
    const next = [{ name: 'new.html', kind: 'html', mtime: 2 }];
    expect(pickNewlyCreatedPageFile(prev, next)).toBe('new.html');
  });
});
