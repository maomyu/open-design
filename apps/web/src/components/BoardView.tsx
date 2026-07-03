// Native renderer for the structured `board.json` artifact (see
// runtime/board.ts). The agent writes/updates STRUCTURED DATA (Bitable-style
// base → tables → fields → rows); the host renders it here as read-only typed
// tables. This replaces per-step HTML generation: model output per step is a
// few rows of JSON (or a single `Edit` to one cell), so the right-side view
// updates fast. All interaction stays in the LEFT chat (AskUserQuestion) — this
// view never edits.
//
// Native React (NOT a sandboxed iframe), so it fetches project files through
// the app origin and renders inline — no iframe sandbox limits.

import { type CSSProperties, useEffect, useState } from 'react';

import { fetchProjectFileText, projectFileUrl } from '../providers/registry';
import {
  type Board,
  type BoardField,
  type BoardTable,
  cellToString,
  parseBoard,
} from '../runtime/board';
import type { ProjectFile } from '../types';
import styles from './BoardView.module.css';

// CSS-module class lookup as a guaranteed string (the module's types report
// `string | undefined` under strict indexed access; the classes always exist).
const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

// Map an agent-supplied select color name to a chip class key. Unknown values
// fall back to a neutral grey chip (or an inline hex if it looks like a color).
const COLOR_CLASS: Record<string, string> = {
  green: 'cGreen',
  amber: 'cAmber',
  yellow: 'cAmber',
  red: 'cRed',
  blue: 'cBlue',
  accent: 'cAccent',
  grey: 'cGrey',
  gray: 'cGrey',
};

function chipProps(color?: string): { className: string; style?: CSSProperties } {
  if (!color) return { className: `${c('chip')} ${c('cGrey')}` };
  const key = COLOR_CLASS[color.toLowerCase()];
  if (key) return { className: `${c('chip')} ${c(key)}` };
  if (/^#|^rgb|^hsl/.test(color)) {
    return { className: c('chip'), style: { background: color, borderColor: color, color: '#fff' } };
  }
  return { className: `${c('chip')} ${c('cGrey')}` };
}

function resolveAsset(projectId: string, value: string): string {
  if (/^https?:\/\//.test(value) || value.startsWith('data:')) return value;
  return projectFileUrl(projectId, value);
}

function Cell({
  projectId,
  field,
  value,
}: {
  projectId: string;
  field: BoardField;
  value: unknown;
}) {
  switch (field.type) {
    case 'longtext':
      return <div className={c('longtext')}>{cellToString(value)}</div>;
    case 'number':
      return <span className={c('num')}>{cellToString(value)}</span>;
    case 'checkbox':
      return <span className={c('check')}>{value ? '✓' : ''}</span>;
    case 'progress': {
      const n = Math.max(0, Math.min(100, Number(value) || 0));
      return (
        <span className={c('progressWrap')} title={`${n}%`}>
          <span className={c('progressBar')} style={{ width: `${n}%` }} />
        </span>
      );
    }
    case 'select': {
      const vals = Array.isArray(value) ? value.map(cellToString) : [cellToString(value)];
      return (
        <span className={c('chips')}>
          {vals
            .filter(Boolean)
            .map((v, i) => {
              const opt = field.options?.find((o) => o.value === v);
              const p = chipProps(opt?.color);
              return (
                <span key={i} className={p.className} style={p.style}>
                  {v}
                </span>
              );
            })}
        </span>
      );
    }
    case 'link': {
      // Accept a string URL, or an object {url,text}.
      let url = '';
      let label = '';
      if (typeof value === 'string') url = value;
      else if (value && typeof value === 'object') {
        const r = value as Record<string, unknown>;
        url = typeof r.url === 'string' ? r.url : '';
        label = typeof r.text === 'string' ? r.text : '';
      }
      if (!/^https?:\/\//.test(url)) return <span className={c('muted')}>{label || '—'}</span>;
      return (
        <a className={c('link')} href={url} target="_blank" rel="noopener noreferrer">
          {label || '查看原文'} ↗
        </a>
      );
    }
    case 'image': {
      const vals = Array.isArray(value) ? value.map(cellToString) : [cellToString(value)];
      const srcs = vals.filter(Boolean);
      if (!srcs.length) return <span className={c('muted')}>—</span>;
      return (
        <span className={c('thumbs')}>
          {srcs.map((s, i) => (
            <a key={i} href={resolveAsset(projectId, s)} target="_blank" rel="noopener noreferrer">
              <img className={c('thumb')} src={resolveAsset(projectId, s)} alt="" loading="lazy" />
            </a>
          ))}
        </span>
      );
    }
    case 'video': {
      const src = cellToString(Array.isArray(value) ? value[0] : value);
      if (!src) return <span className={c('muted')}>—</span>;
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <video className={c('video')} src={resolveAsset(projectId, src)} controls preload="metadata" />;
    }
    default:
      return <span>{cellToString(value)}</span>;
  }
}

function BoardTableView({ projectId, table }: { projectId: string; table: BoardTable }) {
  if (!table.fields.length) return null;
  return (
    <section className={c('card')}>
      {table.name ? <h3 className={c('tableName')}>{table.name}</h3> : null}
      {table.description ? <p className={c('tableDesc')}>{table.description}</p> : null}
      <div className={c('gridWrap')}>
        <table className={c('grid')}>
          <thead>
            <tr>
              {table.fields.map((f) => (
                <th key={f.key} className={f.type === 'number' ? c('thNum') : undefined}>
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 ? (
              <tr>
                <td className={c('empty')} colSpan={table.fields.length}>
                  暂无数据
                </td>
              </tr>
            ) : (
              table.rows.map((row, ri) => (
                <tr key={ri}>
                  {table.fields.map((f) => (
                    <td key={f.key}>
                      <Cell projectId={projectId} field={f} value={row[f.key]} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StepRail({ steps, step }: { steps: string[]; step?: number }) {
  const current = typeof step === 'number' ? step : 1;
  return (
    <nav className={c('steps')}>
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'active' : 'todo';
        return (
          <span key={i} className={c('stepItem')}>
            {i > 0 ? <span className={c('sep')} /> : null}
            <span className={`${c('dot')} ${c(`dot_${state}`)}`}>{state === 'done' ? '✓' : n}</span>
            <span className={`${c('stepLbl')} ${state === 'active' ? c('stepLblActive') : ''}`}>
              {label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

export function BoardView({ projectId, file }: { projectId: string; file: ProjectFile }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBoard(null);
    setRaw(null);
    void fetchProjectFileText(projectId, file.name).then((t) => {
      if (cancelled) return;
      const text = t ?? '';
      setRaw(text);
      setBoard(parseBoard(text));
    });
    return () => {
      cancelled = true;
    };
    // Re-fetch on mtime so an agent `Edit` to board.json live-updates the view.
  }, [projectId, file.name, file.mtime]);

  if (raw == null) {
    return (
      <div className={c('root')}>
        <div className={c('loading')}>加载中…</div>
      </div>
    );
  }
  if (!board) {
    // Not valid board JSON — show the raw text so nothing is lost.
    return (
      <div className={c('root')}>
        <pre className={c('rawFallback')}>{raw}</pre>
      </div>
    );
  }
  return (
    <div className={c('root')}>
      <div className={c('wrap')}>
        {board.title || board.subtitle ? (
          <header className={c('head')}>
            {board.title ? <h1 className={c('title')}>{board.title}</h1> : null}
            {board.subtitle ? <p className={c('subtitle')}>{board.subtitle}</p> : null}
          </header>
        ) : null}
        {board.steps && board.steps.length ? <StepRail steps={board.steps} step={board.step} /> : null}
        {board.tables.map((t, i) => (
          <BoardTableView key={i} projectId={projectId} table={t} />
        ))}
        {board.note ? <p className={c('note')}>{board.note}</p> : null}
      </div>
    </div>
  );
}
