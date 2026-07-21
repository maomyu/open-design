// 飞书数据中心 · 应用内镜像页(App 为主 → 推飞书)。
//
// schema(10 表结构)静态来自 contracts DATACENTER_TABLES;左侧按前台/后台列表,
// 右侧对选中表做记录 CRUD。owner=user 的 5 张表(监控/素材/风格/Prompt/系统配置)
// 全增删改 + 同步飞书 + 同步态标记;owner=engine 的 5 张第一期只读展示(引擎产出,
// 第二期接回填)。中文文案不进 i18n(客户定制惯例)。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DATACENTER_TABLES,
  type DatacenterField,
  type DatacenterRecord,
  type DatacenterTable,
} from '@open-design/contracts';
import {
  createDatacenterRecord,
  deleteDatacenterRecord,
  fetchDatacenterRecords,
  syncDatacenterTable,
  updateDatacenterRecord,
} from '../../providers/datacenter';
import styles from './DataCenterView.module.css';

/** 第一期表单只做这些类型;link/user/attachment/auto_number/formula 跳过(第二期)。 */
const EDITABLE_TYPES = new Set(['text', 'number', 'single_select', 'multi_select', 'checkbox', 'datetime']);
const LONG_TEXT = /内容|正文|脚本|简介|结论|意见|理由|问题|结构|文案|备注|规则|痛点|钩子|矛盾|机会|JSON|数据|承接|表达|常用/;

function isEditable(f: DatacenterField): boolean {
  return !f.readonly && EDITABLE_TYPES.has(f.type);
}

/** 记录字段值 → 展示字符串。 */
function displayValue(f: DatacenterField, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (f.type === 'checkbox') return v ? '是' : '否';
  if (f.type === 'multi_select') return Array.isArray(v) ? v.join('、') : String(v);
  if (f.type === 'datetime') {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 1e11) return new Date(n).toLocaleString('zh-CN');
    return String(v);
  }
  return String(v);
}

/** 记录字段值 → 表单输入初值(multi_select 数组拼成顿号串,checkbox 保持布尔)。 */
function toFormValue(f: DatacenterField, v: unknown): string | boolean {
  if (f.type === 'checkbox') return v === true;
  if (f.type === 'multi_select') return Array.isArray(v) ? v.join('、') : v ? String(v) : '';
  if (v === undefined || v === null) return '';
  if (f.type === 'datetime') {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 1e11) return new Date(n).toLocaleString('zh-CN');
  }
  return String(v);
}

type FormState = Record<string, string | boolean>;

function initialForm(table: DatacenterTable, record?: DatacenterRecord): FormState {
  const form: FormState = {};
  for (const f of table.fields) {
    if (!isEditable(f)) continue;
    form[f.name] = record ? toFormValue(f, record.fields[f.name]) : f.type === 'checkbox' ? false : '';
  }
  return form;
}

/** 表单 → 提交的 fields(字符串直接给 daemon,由 daemon 按 schema 收敛类型)。 */
function formToFields(table: DatacenterTable, form: FormState): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const f of table.fields) {
    if (!isEditable(f)) continue;
    const raw = form[f.name];
    if (f.type === 'checkbox') fields[f.name] = raw === true;
    else fields[f.name] = typeof raw === 'string' ? raw : '';
  }
  return fields;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: DatacenterField;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}): JSX.Element {
  if (field.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 6 }}
      />
    );
  }
  const strVal = typeof value === 'string' ? value : '';
  if (field.type === 'number') {
    return (
      <input
        className={styles.input}
        type="number"
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.type === 'text' && LONG_TEXT.test(field.name)) {
    return <textarea className={styles.textarea} value={strVal} onChange={(e) => onChange(e.target.value)} />;
  }
  const listId = field.options && field.options.length ? `dc-opts-${field.name}` : undefined;
  return (
    <>
      <input
        className={styles.input}
        type="text"
        value={strVal}
        list={listId}
        placeholder={field.type === 'multi_select' ? '多个用「、」或逗号分隔' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {listId ? (
        <datalist id={listId}>
          {field.options!.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

export function DataCenterView(): JSX.Element {
  const [activeKey, setActiveKey] = useState<string>(DATACENTER_TABLES[0]?.key ?? 'monitor');
  const [records, setRecords] = useState<DatacenterRecord[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ id: string | 'new'; form: FormState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const table = useMemo(() => DATACENTER_TABLES.find((t) => t.key === activeKey)!, [activeKey]);
  const front = DATACENTER_TABLES.filter((t) => t.stage === 'front');
  const back = DATACENTER_TABLES.filter((t) => t.stage === 'back');

  const load = useCallback(async (key: string) => {
    setLoading(true);
    const recs = await fetchDatacenterRecords(key);
    setRecords(recs);
    setCounts((c) => ({ ...c, [key]: recs.length }));
    setLoading(false);
  }, []);

  useEffect(() => {
    setEditing(null);
    setNote(null);
    void load(activeKey);
  }, [activeKey, load]);

  // 进页面就并行拉全表计数,左侧列表一开就显真实条数(不用逐个点开才更新)。
  useEffect(() => {
    let alive = true;
    void Promise.all(
      DATACENTER_TABLES.map(async (t) => [t.key, (await fetchDatacenterRecords(t.key)).length] as const),
    ).then((pairs) => {
      if (alive) setCounts((c) => ({ ...Object.fromEntries(pairs), ...c }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const editableFields = table.fields.filter(isEditable);
  // 表格列:排除只读(auto_number/formula——本地镜像永远空,展示是噪声);
  // 主字段排首(冻结列),其余按 schema 顺序。
  const visibleCols = table.fields.filter((f) => !f.readonly);
  const primaryFieldDef = visibleCols.find((f) => f.name === table.primaryField);
  const orderedCols = primaryFieldDef
    ? [primaryFieldDef, ...visibleCols.filter((f) => f.name !== table.primaryField)]
    : visibleCols;

  async function submitForm() {
    if (!editing) return;
    setBusy(true);
    const fields = formToFields(table, editing.form);
    const r =
      editing.id === 'new'
        ? await createDatacenterRecord(table.key, fields)
        : await updateDatacenterRecord(table.key, editing.id, fields);
    setBusy(false);
    if (r.error) {
      setNote(`保存失败：${r.error}`);
      return;
    }
    setEditing(null);
    setNote('已保存到本地，正在同步飞书…');
    await load(table.key);
  }

  async function removeRecord(rec: DatacenterRecord) {
    if (!window.confirm(`确定删除这条记录？（本地删除，若已同步飞书会一并删）`)) return;
    setBusy(true);
    const r = await deleteDatacenterRecord(table.key, rec.id);
    setBusy(false);
    if (r.error) {
      setNote(`删除失败：${r.error}`);
      return;
    }
    await load(table.key);
  }

  async function syncTable() {
    setBusy(true);
    setNote('正在同步到飞书…');
    const r = await syncDatacenterTable(table.key);
    setBusy(false);
    setNote(r.error ? `同步失败：${r.error}` : `已同步飞书：成功 ${r.synced} 条${r.failed ? `，失败 ${r.failed} 条` : ''}`);
    await load(table.key);
  }

  const isUser = table.owner === 'user';

  return (
    <section className="entry-section" aria-labelledby="datacenter-title">
      <header className="entry-section__head">
        <h1 id="datacenter-title" className="entry-section__title">
          📊 数据中心
        </h1>
        <p className="plugins-view__lede" style={{ marginTop: 4 }}>
          飞书数据中心的应用内镜像。这里改的会同步回飞书(App 为主)。10 张表 = 你和系统的共享库。
        </p>
      </header>

      <div className={styles.wrap}>
        {/* 左：表列表 */}
        <div className={styles.tableList}>
          <div className={styles.groupLabel}>前台 · 常用</div>
          {front.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`${styles.tableBtn}${t.key === activeKey ? ` ${styles.tableBtnActive}` : ''}`}
              onClick={() => setActiveKey(t.key)}
            >
              <span>{t.label}</span>
              {counts[t.key] != null ? <span className={styles.count}>{counts[t.key]}</span> : null}
            </button>
          ))}
          <div className={styles.groupLabel}>后台 · 高级</div>
          {back.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`${styles.tableBtn}${t.key === activeKey ? ` ${styles.tableBtnActive}` : ''}`}
              onClick={() => setActiveKey(t.key)}
            >
              <span>{t.label}</span>
              {counts[t.key] != null ? <span className={styles.count}>{counts[t.key]}</span> : null}
            </button>
          ))}
        </div>

        {/* 右：记录面板 */}
        <div className={styles.panel}>
          <div className={styles.head}>
            <h2 className={styles.title}>{table.label}</h2>
            <span className={styles.ownerBadge}>{isUser ? '你维护 · 推飞书' : '引擎产出 · 只读'}</span>
          </div>
          <p className={styles.desc}>{table.desc}</p>

          {isUser ? (
            <div className={styles.toolbar}>
              <button
                type="button"
                className={styles.btnPrimary + ' ' + styles.btn}
                disabled={busy || editing?.id === 'new'}
                onClick={() => setEditing({ id: 'new', form: initialForm(table) })}
              >
                ＋ 新建
              </button>
              <button type="button" className={styles.btn} disabled={busy} onClick={syncTable}>
                ⤴ 同步到飞书
              </button>
              {note ? <span className={styles.note}>{note}</span> : null}
            </div>
          ) : (
            <div className={styles.readonlyHint}>
              此表由引擎自动产出(采集/AI 生成)。第一期只读展示;第二期接入「引擎回填 + 从飞书拉取」后这里会有数据。
            </div>
          )}

          {/* 编辑/新建表单 */}
          {editing ? (
            <div className={styles.form}>
              {editableFields.map((f) => (
                <div key={f.name} className={styles.formRow}>
                  <label className={styles.formLabel}>{f.name}</label>
                  <FieldInput
                    field={f}
                    value={editing.form[f.name] ?? (f.type === 'checkbox' ? false : '')}
                    onChange={(v) => setEditing((e) => (e ? { ...e, form: { ...e.form, [f.name]: v } } : e))}
                  />
                </div>
              ))}
              <div className={styles.formActions}>
                <button type="button" className={styles.btn} disabled={busy} onClick={() => setEditing(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary + ' ' + styles.btn}
                  disabled={busy}
                  onClick={submitForm}
                >
                  {editing.id === 'new' ? '创建' : '保存'}
                </button>
              </div>
            </div>
          ) : null}

          {/* 记录列表 */}
          {loading ? (
            <div className={styles.empty}>加载中…</div>
          ) : records.length === 0 ? (
            <div className={styles.empty}>{isUser ? '还没有记录，点「＋ 新建」加一条。' : '暂无数据。'}</div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {isUser ? <th className={styles.actionsCol}>操作</th> : null}
                    {orderedCols.map((f, i) => (
                      <th
                        key={f.name}
                        className={i === 0 ? styles.stickyCol : undefined}
                        style={i === 0 ? { left: isUser ? 112 : 0 } : undefined}
                      >
                        {f.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((rec) => (
                    <tr key={rec.id}>
                      {isUser ? (
                        <td className={styles.actionsCol}>
                          <button
                            type="button"
                            className={styles.iconBtn}
                            disabled={busy}
                            onClick={() => setEditing({ id: rec.id, form: initialForm(table, rec) })}
                          >
                            编辑
                          </button>{' '}
                          <button
                            type="button"
                            className={styles.iconBtn}
                            disabled={busy}
                            onClick={() => removeRecord(rec)}
                          >
                            删除
                          </button>
                        </td>
                      ) : null}
                      {orderedCols.map((f, i) => {
                        const val = displayValue(f, rec.fields[f.name]);
                        return (
                          <td
                            key={f.name}
                            className={i === 0 ? styles.stickyCol : undefined}
                            style={i === 0 ? { left: isUser ? 112 : 0 } : undefined}
                            title={val || undefined}
                          >
                            {i === 0 ? (
                              <span
                                className={`${styles.syncDot} ${
                                  rec.syncState === 'synced'
                                    ? styles.dotSynced
                                    : rec.syncState === 'error'
                                      ? styles.dotError
                                      : styles.dotLocal
                                }`}
                                title={
                                  rec.syncState === 'synced'
                                    ? '已同步飞书'
                                    : rec.syncState === 'error'
                                      ? `同步失败：${rec.syncError ?? ''}`
                                      : '仅本地（待同步）'
                                }
                              />
                            ) : null}
                            {val === '' ? <span className={styles.cellEmpty}>—</span> : val}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
