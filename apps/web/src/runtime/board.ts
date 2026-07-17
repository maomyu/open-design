// Structured "board" data model — a multidimensional-table style base the agent
// writes as `board.json` instead of generating presentation HTML each step.
// The agent only inserts/updates DATA (tables → fields → rows); the host owns
// rendering (see components/BoardView.tsx). This keeps per-step model output
// tiny (a few rows of JSON, or a single `Edit` to one cell) so the right-side
// visualization updates fast.
//
// parseBoard() is intentionally LENIENT: agent-authored JSON is imperfect, so
// unknown field types fall back to text, missing arrays become empty, and a
// malformed file returns null (the caller shows a friendly fallback) rather
// than throwing.

export type BoardFieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'select'
  | 'link'
  | 'image'
  | 'video'
  | 'checkbox'
  | 'progress'
  | 'date';

export interface BoardFieldOption {
  value: string;
  /** Optional CSS color or token-ish hint for select chips (e.g. green/amber/#c96442). */
  color?: string;
}

export interface BoardField {
  key: string;
  name: string;
  type: BoardFieldType;
  /** Coloring for `select` chips, keyed by cell value. */
  options?: BoardFieldOption[];
}

export interface BoardTable {
  name?: string;
  description?: string;
  fields: BoardField[];
  rows: Array<Record<string, unknown>>;
}

export interface Board {
  title?: string;
  subtitle?: string;
  /** 1-based index of the current step (drives the step rail highlight). */
  step?: number;
  /** Step rail labels, e.g. ["选题","写稿","配图","排版","发草稿"]. */
  steps?: string[];
  tables: BoardTable[];
  /** Optional one-line note shown under the board. */
  note?: string;
}

const FIELD_TYPES = new Set<BoardFieldType>([
  'text',
  'longtext',
  'number',
  'select',
  'link',
  'image',
  'video',
  'checkbox',
  'progress',
  'date',
]);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function parseOptions(v: unknown): BoardFieldOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BoardFieldOption[] = [];
  for (const o of v) {
    if (typeof o === 'string') {
      if (o) out.push({ value: o });
    } else if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      // Accept value / name / label as the option's value (agents vary).
      const value =
        typeof r.value === 'string'
          ? r.value
          : typeof r.name === 'string'
            ? r.name
            : typeof r.label === 'string'
              ? r.label
              : '';
      if (value) out.push({ value, ...(typeof r.color === 'string' ? { color: r.color } : {}) });
    }
  }
  return out.length ? out : undefined;
}

function parseField(v: unknown): BoardField | null {
  const f = asRecord(v);
  const key = typeof f.key === 'string' ? f.key : typeof f.name === 'string' ? f.name : '';
  if (!key) return null;
  const name = typeof f.name === 'string' ? f.name : key;
  const type =
    typeof f.type === 'string' && FIELD_TYPES.has(f.type as BoardFieldType)
      ? (f.type as BoardFieldType)
      : 'text';
  const options = parseOptions(f.options);
  return { key, name, type, ...(options ? { options } : {}) };
}

function parseTable(v: unknown): BoardTable {
  const t = asRecord(v);
  // Accept fields / columns and rows / records (agents vary on naming).
  const rawFields = Array.isArray(t.fields) ? t.fields : Array.isArray(t.columns) ? t.columns : [];
  const fields = rawFields.map(parseField).filter((f): f is BoardField => f !== null);
  const rawRows = Array.isArray(t.rows) ? t.rows : Array.isArray(t.records) ? t.records : [];
  const rows = rawRows.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
  );
  return {
    ...(typeof t.name === 'string' ? { name: t.name } : {}),
    ...(typeof t.description === 'string' ? { description: t.description } : {}),
    fields,
    rows,
  };
}

/** Collect the list of tables from a board object, tolerating the common
 * Bitable-terminology variants an agent may emit:
 *   - `tables: [...]`            (canonical)
 *   - `bases:  [...]`            (each entry treated as a table)
 *   - `bases:  [{ tables: [...] }]` (a base wrapping tables → flattened)
 */
function collectRawTables(d: Record<string, unknown>): unknown[] {
  const top = Array.isArray(d.tables) ? d.tables : Array.isArray(d.bases) ? d.bases : [];
  const out: unknown[] = [];
  for (const item of top) {
    const r = asRecord(item);
    const nested = Array.isArray(r.tables) ? r.tables : Array.isArray(r.bases) ? r.bases : null;
    const hasFields = Array.isArray(r.fields) || Array.isArray(r.columns);
    if (nested && !hasFields) out.push(...nested);
    else out.push(item);
  }
  return out;
}

/** Parse a `board.json` string into a Board, leniently. Returns null if the
 * text is not valid JSON or not an object with a `tables`/`bases` array. */
export function parseBoard(raw: string): Board | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.tables) && !Array.isArray(d.bases)) return null;
  return {
    ...(typeof d.title === 'string' ? { title: d.title } : {}),
    ...(typeof d.subtitle === 'string' ? { subtitle: d.subtitle } : {}),
    ...(typeof d.step === 'number' ? { step: d.step } : {}),
    ...(Array.isArray(d.steps)
      ? { steps: d.steps.filter((s): s is string => typeof s === 'string') }
      : {}),
    ...(typeof d.note === 'string' ? { note: d.note } : {}),
    tables: collectRawTables(d).map(parseTable),
  };
}

/** Render a cell value to a display string (for text-ish field types). */
export function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(cellToString).filter(Boolean).join('、');
  return '';
}
