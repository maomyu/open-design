// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseBoard } from '../../src/runtime/board';
import { isBoardFileName } from '../../src/runtime/board-file';

const SAMPLE = JSON.stringify({
  title: '公众号发布',
  step: 1,
  steps: ['选题', '写稿', '发草稿'],
  tables: [
    {
      name: '选题候选',
      fields: [
        { key: 'title', name: '标题', type: 'text' },
        { key: 'hot', name: '热度', type: 'select', options: [{ value: '高', color: 'green' }] },
        { key: 'link', name: '原文', type: 'link' },
      ],
      rows: [{ title: '示例选题标题', hot: '高', link: 'https://example.com/a' }],
    },
  ],
});

// BoardView pulls its content through the registry; mock the two helpers it uses.
vi.mock('../../src/providers/registry', () => ({
  fetchProjectFileText: vi.fn(async () => SAMPLE),
  projectFileUrl: (projectId: string, name: string) => `/api/projects/${projectId}/raw/${name}`,
}));

import { BoardView } from '../../src/components/BoardView';

afterEach(() => cleanup());

describe('board-file predicate', () => {
  it('recognizes board.json and *.board.json, not other json', () => {
    expect(isBoardFileName('board.json')).toBe(true);
    expect(isBoardFileName('sub/board.json')).toBe(true);
    expect(isBoardFileName('wechat.board.json')).toBe(true);
    expect(isBoardFileName('data.json')).toBe(false);
    expect(isBoardFileName('1-选题.html')).toBe(false);
  });
});

describe('parseBoard', () => {
  it('parses a well-formed board', () => {
    const b = parseBoard(SAMPLE)!;
    expect(b).not.toBeNull();
    expect(b.title).toBe('公众号发布');
    expect(b.steps).toEqual(['选题', '写稿', '发草稿']);
    expect(b.tables).toHaveLength(1);
    expect(b.tables[0]!.fields).toHaveLength(3);
    expect(b.tables[0]!.rows).toHaveLength(1);
  });

  it('falls back unknown field types to text and drops malformed bits', () => {
    const b = parseBoard(
      JSON.stringify({
        tables: [
          { fields: [{ key: 'a', name: 'A', type: 'bogus' }, { type: 'number' }], rows: [{ a: 1 }, 'junk'] },
        ],
      }),
    )!;
    expect(b.tables[0]!.fields).toHaveLength(1); // keyless+nameless field dropped
    expect(b.tables[0]!.fields[0]!.type).toBe('text'); // bogus -> text
    expect(b.tables[0]!.rows).toHaveLength(1); // 'junk' dropped
  });

  it('returns null for non-JSON or non-board JSON', () => {
    expect(parseBoard('not json')).toBeNull();
    expect(parseBoard('{"foo":1}')).toBeNull(); // no tables/bases array
    expect(parseBoard('[]')).toBeNull();
  });

  // Real-world agent output uses Bitable terminology: `bases` instead of
  // `tables`, fields keyed only by `name` (no `key`), and select options using
  // `name` instead of `value`. The lenient parser must accept all of these.
  it('accepts the `bases` alias, name-only fields, and name-keyed options', () => {
    const b = parseBoard(
      JSON.stringify({
        title: '公众号发布',
        steps: ['选题', '写稿'],
        bases: [
          {
            name: '选题候选',
            fields: [
              { name: '标题', type: 'text' },
              { name: '热度', type: 'select', options: [{ name: '高', color: 'green' }] },
            ],
            rows: [{ 标题: '示例', 热度: '高' }],
          },
        ],
      }),
    );
    expect(b).not.toBeNull();
    expect(b!.tables).toHaveLength(1);
    const t = b!.tables[0]!;
    expect(t.name).toBe('选题候选');
    // name became the key, so the row cell resolves.
    expect(t.fields[0]!.key).toBe('标题');
    expect(t.rows[0]!['标题']).toBe('示例');
    // option value came from `name`, so the colored chip can resolve.
    expect(t.fields[1]!.options).toEqual([{ value: '高', color: 'green' }]);
  });

  it('flattens a base that wraps tables (bases:[{tables:[...]}])', () => {
    const b = parseBoard(
      JSON.stringify({
        bases: [{ name: 'base', tables: [{ name: 'T1', fields: [{ name: 'a', type: 'text' }], rows: [] }] }],
      }),
    );
    expect(b!.tables).toHaveLength(1);
    expect(b!.tables[0]!.name).toBe('T1');
  });
});

describe('BoardView render', () => {
  it('renders the table, a colored select chip, and an external link', async () => {
    render(
      <BoardView
        projectId="proj-1"
        file={{ name: 'board.json', path: 'board.json', kind: 'code', mime: 'application/json', size: 1, mtime: 1 } as never}
      />,
    );
    // Header + step rail + table name + header cell + row cell.
    expect(await screen.findByText('公众号发布')).toBeTruthy();
    expect(screen.getByText('选题候选')).toBeTruthy();
    expect(screen.getByText('标题')).toBeTruthy();
    expect(screen.getByText('示例选题标题')).toBeTruthy();
    expect(screen.getByText('高')).toBeTruthy(); // select chip value
    const link = screen.getByText(/查看原文/).closest('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.getAttribute('target')).toBe('_blank');
  });
});
