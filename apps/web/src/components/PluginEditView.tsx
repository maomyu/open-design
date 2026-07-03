// Full-page plugin prompt editor.
//
// The plugin IS the asset — its prompts are files (SKILL.md body + the
// kickoff query). This is the detail/edit page, not a modal: a split
// layout where the LEFT is the display/edit area (the prompts you can
// read and hand-edit) and the RIGHT is an AI chat where you describe a
// change in one line and the model rewrites the prompts in place. Review
// on the left, then 保存并发布 (writes back + re-registers the folder).

import { Fragment, useEffect, useRef, useState } from 'react';
import type {
  InstalledPluginRecord,
  PluginSourceStage,
  PluginSourceStageMode,
  PluginConfigKeyView,
} from '@open-design/contracts';
import { useI18n } from '../i18n';
import { navigate } from '../router';
import { Icon } from './Icon';
import { Toast } from './Toast';
import {
  fetchPluginSource,
  savePluginSource,
  fetchPluginConfig,
  savePluginConfig,
  revealPluginConfigKey,
  assistEditPlugin,
  assistEditFieldStream,
} from '../providers/daemon';
import './PluginEditView.css';

interface Props {
  pluginId: string;
}

// One chat turn. The assistant turn carries the pre-edit snapshot so its
// 撤销 can roll the prompts back to exactly what they were before it ran.
type Snapshot = { skill: string; query: string; stages: PluginSourceStage[] };

type ChatTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; before: Snapshot }
  | { role: 'error'; text: string };

const GATES: PluginSourceStage['gate'][] = ['confirm', 'choice', 'none'];

// Which single field the next chat turn rewrites (set by "AI 改这步").
type Scope = { stageIdx: number; modeIdx: number | null };

// Which canvas node the focused editor below is showing.
// 'query' = kickoff brief, 'skill' = SKILL.md methodology, stage = one step,
// mode = one per-step prompt slot (a step's child node on the canvas).
type Selection =
  | { kind: 'query' }
  | { kind: 'stage'; idx: number }
  | { kind: 'mode'; stageIdx: number; modeIdx: number }
  | { kind: 'skill' };

// First non-empty line of a prompt — the mode node's one-line preview.
function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim();
}

export function PluginEditView({ pluginId }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [editable, setEditable] = useState(true);
  const [title, setTitle] = useState<string>(pluginId);
  const [skill, setSkill] = useState('');
  const [query, setQuery] = useState('');
  const [stages, setStages] = useState<PluginSourceStage[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Per-plugin config (od.config keys). `configKeys` is the declared shape from
  // the manifest (+ whether each is set); `configValues` holds what the user
  // typed into each input. Secret inputs start empty (the stored value is never
  // returned) — saving sends only non-empty inputs, so leaving one blank keeps it.
  const [configKeys, setConfigKeys] = useState<PluginConfigKeyView[]>([]);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = useState(false);
  // Collapsed by default — the panel is a "settings" entry the operator opens.
  const [configOpen, setConfigOpen] = useState(false);
  // Which secret inputs are currently revealed (eye toggle). Revealing a saved-
  // but-empty secret fetches its value on demand (never sent in the list).
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  // Pipeline-rail selection — the detail area below renders only this node.
  const [selected, setSelected] = useState<Selection>({ kind: 'query' });

  // Keep the selection valid after a wholesale stages replacement (AI assist,
  // history restore, undo): a selected step that no longer exists falls back
  // to the kickoff node; a selected mode whose slot is gone falls back to its
  // step (or kickoff when the step is gone too).
  function reconcileSelection(nextStages: PluginSourceStage[]) {
    setSelected((prev) => {
      if (prev.kind === 'stage') {
        return prev.idx >= nextStages.length ? { kind: 'query' } : prev;
      }
      if (prev.kind === 'mode') {
        const stage = nextStages[prev.stageIdx];
        if (!stage) return { kind: 'query' };
        if (prev.modeIdx >= stage.modes.length) return { kind: 'stage', idx: prev.stageIdx };
        return prev;
      }
      return prev;
    });
  }

  const [instruction, setInstruction] = useState('');
  const [assisting, setAssisting] = useState(false);
  const [scope, setScope] = useState<Scope | null>(null);
  const [streamText, setStreamText] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // The most-recent assistant turn index that can still be undone (only the
  // latest edit is reversible — later edits build on earlier ones).
  const [undoableAt, setUndoableAt] = useState<number | null>(null);

  const logRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // Global skill catalog for the per-stage skill picker. Stage-bound skills
  // scope a skill's methodology to that one step at compose time.
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/skills')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { skills?: Array<{ id?: string; name?: string }> } | null) => {
        if (cancelled || !data?.skills) return;
        setCatalog(
          data.skills
            .filter((s): s is { id: string; name?: string } => typeof s.id === 'string' && !s.id.includes(':'))
            .map((s) => ({ id: s.id, name: s.name || s.id })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function skillName(id: string): string {
    return catalog.find((s) => s.id === id)?.name ?? id;
  }

  // Edit history — restore points recorded on every save (hand or AI).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<Array<{ id: string; savedAt: number }>>([]);
  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (!next) return;
    const resp = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/source/history`).catch(() => null);
    const data = resp?.ok ? await resp.json() : null;
    setVersions(Array.isArray(data?.versions) ? data.versions : []);
  }
  async function restore(versionId: string) {
    const resp = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/source/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    }).catch(() => null);
    if (!resp?.ok) {
      setToast(t('pluginEditor.failed'));
      return;
    }
    const data = (await resp.json()) as { source?: { skill: string; query: string; stages: PluginSourceStage[] } };
    if (data.source) {
      setSkill(data.source.skill);
      setQuery(data.source.query);
      setStages(data.source.stages ?? []);
      reconcileSelection(data.source.stages ?? []);
      setScope(null);
      setDirty(false);
      setUndoableAt(null);
    }
    setHistoryOpen(false);
    setToast(t('pluginEditor.restored'));
  }
  function addStageSkill(i: number, skillId: string) {
    if (!skillId) return;
    setStages((prev) =>
      prev.map((s, idx) =>
        idx === i && !s.skills.includes(skillId) ? { ...s, skills: [...s.skills, skillId] } : s,
      ),
    );
    setDirty(true);
  }
  function removeStageSkill(i: number, skillId: string) {
    setStages((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, skills: s.skills.filter((x) => x !== skillId) } : s)),
    );
    setDirty(true);
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchPluginSource(pluginId),
      fetch(`/api/plugins/${encodeURIComponent(pluginId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetchPluginConfig(pluginId),
    ]).then(([src, row, cfg]) => {
      if (cancelled) return;
      if (src) {
        setSkill(src.skill);
        setQuery(src.query);
        setStages(src.stages ?? []);
        setEditable(src.editable);
      }
      if (cfg) {
        setConfigKeys(cfg.keys);
        // Prefill non-secret keys with their stored value; secret keys start
        // empty (placeholder shows whether one is saved).
        const init: Record<string, string> = {};
        for (const k of cfg.keys) if (!k.secret && typeof k.value === 'string') init[k.name] = k.value;
        setConfigValues(init);
      }
      const rec = row as InstalledPluginRecord | null;
      if (rec?.title) setTitle(rec.title);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  // Save the per-plugin config. Sends only non-empty inputs (so a blank secret
  // input keeps the stored value); `clearKey` sends an explicit empty to clear.
  async function saveConfig(clearKey?: string) {
    setConfigSaving(true);
    const values: Record<string, string> = {};
    if (clearKey) {
      values[clearKey] = '';
    } else {
      for (const [name, v] of Object.entries(configValues)) {
        if (typeof v === 'string' && v.trim()) values[name] = v.trim();
      }
    }
    const ok = await savePluginConfig(pluginId, values);
    if (ok) {
      const fresh = await fetchPluginConfig(pluginId);
      if (fresh) {
        setConfigKeys(fresh.keys);
        const init: Record<string, string> = {};
        for (const k of fresh.keys) if (!k.secret && typeof k.value === 'string') init[k.name] = k.value;
        setConfigValues(init);
      }
      setToast(t('pluginEditor.published'));
    } else {
      setToast(t('pluginEditor.failed'));
    }
    setConfigSaving(false);
  }

  // Eye toggle: reveal/hide a secret input. When first revealing a saved-but-
  // empty key, fetch its plaintext on demand so the operator can see/verify it.
  async function toggleReveal(k: PluginConfigKeyView) {
    const isOpen = !!revealed[k.name];
    if (!isOpen) {
      if (!(configValues[k.name] ?? '').trim() && k.set) {
        const v = await revealPluginConfigKey(pluginId, k.name);
        if (typeof v === 'string') setConfigValues((p) => ({ ...p, [k.name]: v }));
      }
      setRevealed((p) => ({ ...p, [k.name]: true }));
    } else {
      setRevealed((p) => ({ ...p, [k.name]: false }));
    }
  }

  // Keep the chat pinned to the newest turn / working indicator.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, assisting, streamText]);

  function onBack() {
    // Return to wherever the user came from (the plugins gallery, or the
    // detail page) — the real previous layer, not a hard-coded one. Falls
    // back to the plugins gallery for deep links / refreshed-on-edit.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate({ kind: 'home', view: 'plugins' });
    }
  }

  async function runAssist() {
    const text = instruction.trim();
    if (assisting || !editable || !text) return;
    const before: Snapshot = { skill, query, stages };
    setTurns((prev) => [...prev, { role: 'user', text }]);
    setInstruction('');
    setAssisting(true);
    const out = await assistEditPlugin(pluginId, { instruction: text, skill, query, stages });
    setAssisting(false);
    if ('error' in out) {
      setTurns((prev) => [...prev, { role: 'error', text: out.error || t('pluginEditor.aiFailed') }]);
      return;
    }
    setSkill(out.skill);
    setQuery(out.query);
    if (Array.isArray(out.stages)) {
      setStages(out.stages);
      reconcileSelection(out.stages);
    }
    setDirty(true);
    setTurns((prev) => {
      const next: ChatTurn[] = [...prev, { role: 'assistant', before }];
      setUndoableAt(next.length - 1);
      return next;
    });
  }

  function undo(at: number) {
    const turn = turns[at];
    if (!turn || turn.role !== 'assistant') return;
    setSkill(turn.before.skill);
    setQuery(turn.before.query);
    setStages(turn.before.stages);
    reconcileSelection(turn.before.stages);
    setScope(null);
    setUndoableAt(null);
    setDirty(true);
  }

  // Step-editor mutators.
  function updateStage(i: number, patch: Partial<PluginSourceStage>) {
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    setDirty(true);
  }
  function removeStage(i: number) {
    const lastIdx = stages.length - 2; // highest valid index after removal
    setStages((prev) => prev.filter((_, idx) => idx !== i));
    // A pending scoped AI edit indexes into the old order — drop it.
    setScope(null);
    setSelected((prev) => {
      // A selected mode follows its owning step's fate.
      const sIdx = prev.kind === 'stage' ? prev.idx : prev.kind === 'mode' ? prev.stageIdx : null;
      if (sIdx == null) return prev;
      if (sIdx === i) {
        // Deleted the selected step (or the selected mode's step): keep focus
        // on the nearest surviving step, or fall back to the kickoff node.
        return lastIdx < 0 ? { kind: 'query' } : { kind: 'stage', idx: Math.min(i, lastIdx) };
      }
      if (sIdx > i) {
        return prev.kind === 'mode'
          ? { ...prev, stageIdx: sIdx - 1 }
          : { kind: 'stage', idx: sIdx - 1 };
      }
      return prev;
    });
    setDirty(true);
  }
  function moveStage(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    setStages((prev) => {
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    // A pending scoped AI edit indexes into the old order — drop it.
    setScope(null);
    // The selection follows the moved/displaced step (and a selected mode
    // follows its owning step) so the detail pane keeps showing the same
    // content.
    setSelected((prev) => {
      if (prev.kind === 'stage') {
        if (prev.idx === i) return { kind: 'stage', idx: j };
        if (prev.idx === j) return { kind: 'stage', idx: i };
        return prev;
      }
      if (prev.kind === 'mode') {
        if (prev.stageIdx === i) return { ...prev, stageIdx: j };
        if (prev.stageIdx === j) return { ...prev, stageIdx: i };
        return prev;
      }
      return prev;
    });
    setDirty(true);
  }
  function addStage() {
    const newIdx = stages.length;
    setStages((prev) => [
      ...prev,
      { id: `step-${prev.length + 1}`, title: '', gate: 'confirm', prompt: '', modes: [], skills: [] },
    ]);
    setSelected({ kind: 'stage', idx: newIdx });
    setDirty(true);
  }

  // Mode mutators (per-step prompt slots).
  function updateMode(i: number, mi: number, patch: Partial<PluginSourceStageMode>) {
    setStages((prev) =>
      prev.map((s, idx) =>
        idx === i ? { ...s, modes: s.modes.map((m, j) => (j === mi ? { ...m, ...patch } : m)) } : s,
      ),
    );
    setDirty(true);
  }
  function addMode(i: number) {
    const newIdx = stages[i]?.modes.length ?? 0;
    setStages((prev) =>
      prev.map((s, idx) =>
        idx === i
          ? { ...s, modes: [...s.modes, { id: `mode-${s.modes.length + 1}`, label: '', prompt: '' }] }
          : s,
      ),
    );
    // Adding from the canvas ghost node focuses the fresh mode for editing.
    setSelected({ kind: 'mode', stageIdx: i, modeIdx: newIdx });
    setDirty(true);
  }
  function removeMode(i: number, mi: number) {
    setStages((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, modes: s.modes.filter((_, j) => j !== mi) } : s)),
    );
    // A pending scoped AI edit into this step's modes indexes the old order.
    setScope((prev) => (prev && prev.stageIdx === i && prev.modeIdx != null ? null : prev));
    setSelected((prev) => {
      if (prev.kind !== 'mode' || prev.stageIdx !== i) return prev;
      // Deleted the selected mode: fall back to its owning step.
      if (prev.modeIdx === mi) return { kind: 'stage', idx: i };
      return prev.modeIdx > mi ? { ...prev, modeIdx: prev.modeIdx - 1 } : prev;
    });
    setDirty(true);
  }

  // "AI 改这步 / 改这模式" — bind the next chat turn to one field and focus.
  function beginScope(s: Scope) {
    if (!editable) return;
    setScope(s);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function scopeLabel(s: Scope): string {
    const stage = stages[s.stageIdx];
    if (!stage) return '';
    const title = stage.title || stage.id;
    if (s.modeIdx != null) {
      const mode = stage.modes[s.modeIdx];
      return `${title} · ${mode?.label || mode?.id || ''}`;
    }
    return title;
  }

  // Streaming, scoped single-field rewrite — fills the field live like the chat.
  async function runFieldAssist(s: Scope, text: string) {
    const stage = stages[s.stageIdx];
    if (!stage) return;
    const isMode = s.modeIdx != null;
    const targetText = isMode ? stage.modes[s.modeIdx as number]?.prompt ?? '' : stage.prompt;
    const label = scopeLabel(s);
    const before: Snapshot = { skill, query, stages };
    setTurns((prev) => [...prev, { role: 'user', text }]);
    setInstruction('');
    setScope(null);
    setAssisting(true);
    setStreamText('');
    let acc = '';
    await assistEditFieldStream(
      pluginId,
      { instruction: text, text: targetText, label },
      {
        onDelta: (chunk) => {
          acc += chunk;
          setStreamText(acc);
          // Fill the field live so the user watches it write.
          if (isMode) updateMode(s.stageIdx, s.modeIdx as number, { prompt: acc });
          else updateStage(s.stageIdx, { prompt: acc });
        },
        onDone: (finalText) => {
          const clean = finalText || acc;
          if (isMode) updateMode(s.stageIdx, s.modeIdx as number, { prompt: clean });
          else updateStage(s.stageIdx, { prompt: clean });
          setStreamText('');
          setAssisting(false);
          setDirty(true);
          setTurns((prev) => {
            const next: ChatTurn[] = [...prev, { role: 'assistant', before }];
            setUndoableAt(next.length - 1);
            return next;
          });
        },
        onError: (msg) => {
          // Roll the field back to its pre-stream value on failure.
          if (isMode) updateMode(s.stageIdx, s.modeIdx as number, { prompt: targetText });
          else updateStage(s.stageIdx, { prompt: targetText });
          setStreamText('');
          setAssisting(false);
          setTurns((prev) => [...prev, { role: 'error', text: msg }]);
        },
      },
    );
  }

  // Composer submit — scoped streaming edit when a step is targeted, else the
  // whole-plugin assist.
  function submit() {
    const text = instruction.trim();
    if (assisting || !editable || !text) return;
    if (scope) void runFieldAssist(scope, text);
    else void runAssist();
  }

  async function save() {
    if (saving || !editable) return;
    setSaving(true);
    const ok = await savePluginSource(pluginId, { skill, query, stages });
    setSaving(false);
    if (ok) {
      setDirty(false);
      setUndoableAt(null);
      setToast(t('pluginEditor.published'));
    } else {
      setToast(t('pluginEditor.failed'));
    }
  }

  return (
    <div className="plugin-edit-view" data-testid="plugin-edit-view">
      <header className="plugin-edit-view__bar">
        <button type="button" className="plugin-edit-view__back" onClick={onBack}>
          <Icon name="arrow-left" size={15} />
          <span>{t('pluginEditor.back')}</span>
        </button>
        <div className="plugin-edit-view__heading">
          <span className="plugin-edit-view__eyebrow">{t('pluginEditor.title')}</span>
          <h1 className="plugin-edit-view__title">{title}</h1>
        </div>
        <div className="plugin-edit-view__bar-actions">
          {dirty ? (
            <span className="plugin-edit-view__unsaved">{t('pluginEditor.unsaved')}</span>
          ) : null}
          <div className="plugin-edit-view__history-wrap">
            <button
              type="button"
              className="plugin-edit-view__history-btn"
              onClick={() => void toggleHistory()}
              disabled={loading}
              aria-expanded={historyOpen}
            >
              <Icon name="reload" size={13} />
              <span>{t('pluginEditor.history')}</span>
            </button>
            {historyOpen ? (
              <div className="plugin-edit-view__history-pop">
                {versions.length === 0 ? (
                  <div className="plugin-edit-view__history-empty">
                    {t('pluginEditor.historyEmpty')}
                  </div>
                ) : (
                  versions.map((v) => (
                    <div className="plugin-edit-view__history-row" key={v.id}>
                      <span>{new Date(v.savedAt).toLocaleString()}</span>
                      <button
                        type="button"
                        className="plugin-edit-view__history-restore"
                        onClick={() => void restore(v.id)}
                        disabled={!editable}
                      >
                        {t('pluginEditor.restore')}
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="plugin-edit-view__publish"
            onClick={save}
            disabled={saving || !editable || loading}
          >
            {saving ? t('pluginEditor.publishing') : t('pluginEditor.publish')}
          </button>
        </div>
      </header>

      {loading ? (
        <div className="plugin-edit-view__loading">{t('common.loading')}</div>
      ) : (
        <div className="plugin-edit-view__body">
          {/* LEFT — 节点画布 + 聚焦编辑: a 2D node canvas mirroring the runtime
              pipeline (kickoff → steps → methodology) with each step's modes
              hanging below it as child nodes; clicking any node focuses it in
              the full-height editor below. */}
          <section className="plugin-edit-view__display">
            <div className="plugin-edit-view__pane-head">
              <Icon name="file-code" size={14} />
              <span>{t('pluginEditor.displayHeading')}</span>
            </div>
            {!editable ? (
              <div className="plugin-edit-view__readonly">{t('pluginEditor.readOnly')}</div>
            ) : null}

            {configKeys.length > 0 ? (
              <section className="plugin-edit-view__config" data-testid="plugin-edit-config">
                <button
                  type="button"
                  className="plugin-edit-view__config-toggle"
                  aria-expanded={configOpen}
                  onClick={() => setConfigOpen((v) => !v)}
                >
                  <Icon name="sliders" size={13} />
                  <span>{t('pluginEditor.configHeading')}</span>
                  <span className="plugin-edit-view__config-count">
                    {configKeys.filter((k) => k.set).length}/{configKeys.length}
                  </span>
                  <span
                    className={`plugin-edit-view__config-chevron${configOpen ? ' is-open' : ''}`}
                    aria-hidden="true"
                  >
                    <Icon name="chevron-down" size={14} />
                  </span>
                </button>
                {configOpen ? (
                  <div className="plugin-edit-view__config-body">
                <p className="plugin-edit-view__config-hint">{t('pluginEditor.configHint')}</p>
                <div className="plugin-edit-view__config-list">
                  {configKeys.map((k) => (
                    <label className="plugin-edit-view__config-row" key={k.name}>
                      <span className="plugin-edit-view__config-label">
                        <code>{k.name}</code>
                        {k.label ? <span className="plugin-edit-view__config-name">{k.label}</span> : null}
                        {k.required ? <span className="plugin-edit-view__config-req">*</span> : null}
                        {k.set ? (
                          <span className="plugin-edit-view__config-set">
                            {t('pluginEditor.configSet')}{k.source === 'env' ? ' · .env' : ''}
                          </span>
                        ) : null}
                      </span>
                      {k.description ? (
                        <span className="plugin-edit-view__config-desc">
                          {k.description}
                          {k.link ? (
                            <a href={k.link} target="_blank" rel="noopener noreferrer"> ↗</a>
                          ) : null}
                        </span>
                      ) : null}
                      <span className="plugin-edit-view__config-input-wrap">
                        <input
                          type={k.secret && !revealed[k.name] ? 'password' : 'text'}
                          className="plugin-edit-view__config-input"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={!editable || configSaving}
                          placeholder={k.set ? '••••••  ·  ' + t('pluginEditor.configSet') : (k.required ? '*' : '')}
                          value={configValues[k.name] ?? ''}
                          onChange={(e) => setConfigValues((p) => ({ ...p, [k.name]: e.target.value }))}
                        />
                        {k.secret ? (
                          <button
                            type="button"
                            className="plugin-edit-view__config-eye"
                            aria-label="toggle value visibility"
                            onClick={() => void toggleReveal(k)}
                          >
                            <Icon name={revealed[k.name] ? 'eye-off' : 'eye'} size={15} />
                          </button>
                        ) : null}
                        {k.set && editable ? (
                          <button
                            type="button"
                            className="plugin-edit-view__config-clear"
                            disabled={configSaving}
                            onClick={() => void saveConfig(k.name)}
                          >
                            {t('pluginEditor.configClear')}
                          </button>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
                {editable ? (
                  <button
                    type="button"
                    className="plugin-edit-view__config-save"
                    disabled={configSaving}
                    onClick={() => void saveConfig()}
                  >
                    {t('common.save')}
                  </button>
                ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            <div className="plugin-edit-view__canvas" aria-label={t('pluginEditor.stepsLabel')}>
              <div className="plugin-edit-view__canvas-row">
                {/* Kickoff node — the composer-seeded query. */}
                <div className="plugin-edit-view__canvas-col">
                  <button
                    type="button"
                    className={`plugin-edit-view__node plugin-edit-view__node--terminal${
                      selected.kind === 'query' ? ' plugin-edit-view__node--active' : ''
                    }`}
                    aria-pressed={selected.kind === 'query'}
                    onClick={() => setSelected({ kind: 'query' })}
                  >
                    <Icon name="play" size={12} />
                    <span className="plugin-edit-view__node-label">
                      {t('pluginEditor.nodeQuery')}
                    </span>
                  </button>
                </div>
                <span className="plugin-edit-view__canvas-arrow" aria-hidden="true">
                  <Icon name="chevron-right" size={12} />
                </span>

                {/* One column per workflow step: the step node on the main
                    chain, its modes hanging below as child nodes. */}
                {stages.map((stage, i) => {
                  const active = selected.kind === 'stage' && selected.idx === i;
                  const missing =
                    catalog.length > 0 && stage.skills.some((id) => !catalog.some((s) => s.id === id));
                  const gateKey =
                    stage.gate === 'confirm'
                      ? ('pluginEditor.gateConfirm' as const)
                      : ('pluginEditor.gateChoice' as const);
                  return (
                    <Fragment key={i}>
                      <div className="plugin-edit-view__canvas-col">
                        <span
                          role="button"
                          tabIndex={0}
                          className={`plugin-edit-view__node plugin-edit-view__node--step${
                            active ? ' plugin-edit-view__node--active' : ''
                          }`}
                          aria-pressed={active}
                          onClick={() => setSelected({ kind: 'stage', idx: i })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelected({ kind: 'stage', idx: i });
                            }
                          }}
                        >
                          <span className="plugin-edit-view__node-main">
                            <span className="plugin-edit-view__node-num">{i + 1}</span>
                            <span className="plugin-edit-view__node-label">
                              {stage.title || stage.id || t('pluginEditor.stepTitlePlaceholder')}
                            </span>
                            {stage.gate !== 'none' ? (
                              <span className="plugin-edit-view__node-gate" title={t(gateKey)}>
                                <Icon name={stage.gate === 'choice' ? 'help-circle' : 'check'} size={10} />
                              </span>
                            ) : null}
                          </span>
                          {/* Bound-skill badges — display only; binding is
                              managed in the step editor below. */}
                          {stage.skills.length > 0 ? (
                            <span className="plugin-edit-view__node-badges">
                              {stage.skills.map((skillId) => {
                                const badgeMissing =
                                  catalog.length > 0 && !catalog.some((s) => s.id === skillId);
                                return (
                                  <span
                                    className={`plugin-edit-view__node-badge${
                                      badgeMissing ? ' plugin-edit-view__node-badge--missing' : ''
                                    }`}
                                    key={skillId}
                                    title={
                                      badgeMissing
                                        ? t('pluginEditor.skillMissing')
                                        : skillName(skillId)
                                    }
                                  >
                                    <Icon name="sparkles" size={9} />
                                    <span>{skillName(skillId)}</span>
                                  </span>
                                );
                              })}
                            </span>
                          ) : null}
                          {missing ? (
                            <span
                              className="plugin-edit-view__node-warn"
                              title={t('pluginEditor.skillMissing')}
                            />
                          ) : null}
                          {/* Hover-revealed node actions — reorder along the
                              main chain + delete. Kept mounted; opacity-toggled
                              via CSS. */}
                          <span className="plugin-edit-view__node-actions">
                            <button
                              type="button"
                              className="plugin-edit-view__node-action"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveStage(i, -1);
                              }}
                              disabled={!editable || i === 0}
                              aria-label={t('pluginEditor.stepLeft')}
                              title={t('pluginEditor.stepLeft')}
                            >
                              <Icon name="arrow-left" size={11} />
                            </button>
                            <button
                              type="button"
                              className="plugin-edit-view__node-action"
                              onClick={(e) => {
                                e.stopPropagation();
                                moveStage(i, 1);
                              }}
                              disabled={!editable || i === stages.length - 1}
                              aria-label={t('pluginEditor.stepRight')}
                              title={t('pluginEditor.stepRight')}
                            >
                              <Icon name="arrow-left" size={11} className="plugin-edit-view__node-flip" />
                            </button>
                            <button
                              type="button"
                              className="plugin-edit-view__node-action plugin-edit-view__node-action--danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeStage(i);
                              }}
                              disabled={!editable}
                              aria-label={t('pluginEditor.stepRemove')}
                              title={t('pluginEditor.stepRemove')}
                            >
                              <Icon name="trash" size={11} />
                            </button>
                          </span>
                        </span>

                        {/* Mode child nodes — vertical sub-chain under the step. */}
                        {stage.modes.map((mode, mi) => {
                          const modeActive =
                            selected.kind === 'mode' &&
                            selected.stageIdx === i &&
                            selected.modeIdx === mi;
                          return (
                            <Fragment key={mi}>
                              <span className="plugin-edit-view__vlink" aria-hidden="true" />
                              <span
                                role="button"
                                tabIndex={0}
                                className={`plugin-edit-view__mode-node${
                                  modeActive ? ' plugin-edit-view__mode-node--active' : ''
                                }`}
                                aria-pressed={modeActive}
                                onClick={() => setSelected({ kind: 'mode', stageIdx: i, modeIdx: mi })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setSelected({ kind: 'mode', stageIdx: i, modeIdx: mi });
                                  }
                                }}
                              >
                                <span className="plugin-edit-view__mode-node-label">
                                  {mode.label || t('pluginEditor.modeUntitled')}
                                </span>
                                <span className="plugin-edit-view__mode-node-preview">
                                  {firstLine(mode.prompt) || t('pluginEditor.modePromptPlaceholder')}
                                </span>
                                <button
                                  type="button"
                                  className="plugin-edit-view__mode-node-x"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeMode(i, mi);
                                  }}
                                  disabled={!editable}
                                  aria-label={t('pluginEditor.modeRemove')}
                                  title={t('pluginEditor.modeRemove')}
                                >
                                  <Icon name="trash" size={10} />
                                </button>
                              </span>
                            </Fragment>
                          );
                        })}
                        <span className="plugin-edit-view__vlink" aria-hidden="true" />
                        <button
                          type="button"
                          className="plugin-edit-view__mode-node plugin-edit-view__mode-node--ghost"
                          onClick={() => addMode(i)}
                          disabled={!editable}
                        >
                          <Icon name="plus" size={11} />
                          <span>{t('pluginEditor.modeAdd')}</span>
                        </button>
                      </div>
                      <span className="plugin-edit-view__canvas-arrow" aria-hidden="true">
                        <Icon name="chevron-right" size={12} />
                      </span>
                    </Fragment>
                  );
                })}

                {/* Ghost node — append a step to the main chain. */}
                <div className="plugin-edit-view__canvas-col">
                  <button
                    type="button"
                    className="plugin-edit-view__node plugin-edit-view__node--ghost"
                    onClick={addStage}
                    disabled={!editable}
                  >
                    <Icon name="plus" size={12} />
                    <span>{t('pluginEditor.stepAdd')}</span>
                  </button>
                </div>
                <span className="plugin-edit-view__canvas-arrow" aria-hidden="true">
                  <Icon name="chevron-right" size={12} />
                </span>

                {/* Methodology node — the SKILL.md body. */}
                <div className="plugin-edit-view__canvas-col">
                  <button
                    type="button"
                    className={`plugin-edit-view__node plugin-edit-view__node--terminal${
                      selected.kind === 'skill' ? ' plugin-edit-view__node--active' : ''
                    }`}
                    aria-pressed={selected.kind === 'skill'}
                    onClick={() => setSelected({ kind: 'skill' })}
                  >
                    <Icon name="sparkles" size={12} />
                    <span className="plugin-edit-view__node-label">
                      {t('pluginEditor.nodeSkill')}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Focused editor — renders only the selected node, full height.
                Keyed on the selection so switching plays the enter animation. */}
            <div
              className="plugin-edit-view__detail"
              key={
                selected.kind === 'stage'
                  ? `stage-${selected.idx}`
                  : selected.kind === 'mode'
                    ? `mode-${selected.stageIdx}-${selected.modeIdx}`
                    : selected.kind
              }
            >
              {selected.kind === 'query' ? (
                <label className="plugin-edit-view__field plugin-edit-view__field--fill">
                  <span className="plugin-edit-view__label">{t('pluginEditor.queryLabel')}</span>
                  <span className="plugin-edit-view__hint">{t('pluginEditor.queryHint')}</span>
                  <textarea
                    className="plugin-edit-view__textarea plugin-edit-view__textarea--fill"
                    value={query}
                    disabled={!editable}
                    spellCheck={false}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
              ) : selected.kind === 'skill' ? (
                <label className="plugin-edit-view__field plugin-edit-view__field--fill">
                  <span className="plugin-edit-view__label">{t('pluginEditor.skillLabel')}</span>
                  <span className="plugin-edit-view__hint">{t('pluginEditor.skillHint')}</span>
                  <textarea
                    className="plugin-edit-view__textarea plugin-edit-view__textarea--fill"
                    value={skill}
                    disabled={!editable}
                    spellCheck={false}
                    onChange={(e) => {
                      setSkill(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
              ) : selected.kind === 'mode' ? (
                (() => {
                  const { stageIdx, modeIdx } = selected;
                  const stage = stages[stageIdx];
                  const mode = stage?.modes[modeIdx];
                  if (!stage || !mode) return null;
                  return (
                    <div className="plugin-edit-view__stage-pane">
                      {/* Breadcrumb — owning step → this mode. */}
                      <div className="plugin-edit-view__crumb">
                        <button
                          type="button"
                          className="plugin-edit-view__crumb-link"
                          onClick={() => setSelected({ kind: 'stage', idx: stageIdx })}
                        >
                          <span className="plugin-edit-view__step-num">{stageIdx + 1}</span>
                          <span className="plugin-edit-view__crumb-text">
                            {stage.title || stage.id || t('pluginEditor.stepTitlePlaceholder')}
                          </span>
                        </button>
                        <Icon name="chevron-right" size={12} />
                        <span className="plugin-edit-view__crumb-here">
                          {mode.label || t('pluginEditor.modeUntitled')}
                        </span>
                      </div>

                      <div className="plugin-edit-view__mode-head">
                        <input
                          className="plugin-edit-view__mode-label-input"
                          value={mode.label}
                          disabled={!editable}
                          placeholder={t('pluginEditor.modeLabelPlaceholder')}
                          onChange={(e) => updateMode(stageIdx, modeIdx, { label: e.target.value })}
                        />
                        <button
                          type="button"
                          className="plugin-edit-view__step-btn plugin-edit-view__step-btn--danger"
                          onClick={() => removeMode(stageIdx, modeIdx)}
                          disabled={!editable}
                          aria-label={t('pluginEditor.modeRemove')}
                          title={t('pluginEditor.modeRemove')}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </div>

                      {/* This mode's own prompt — full height. */}
                      <textarea
                        className="plugin-edit-view__mode-prompt plugin-edit-view__mode-prompt--fill"
                        value={mode.prompt}
                        disabled={!editable}
                        spellCheck={false}
                        placeholder={t('pluginEditor.modePromptPlaceholder')}
                        onChange={(e) => updateMode(stageIdx, modeIdx, { prompt: e.target.value })}
                      />

                      <div className="plugin-edit-view__step-foot">
                        <button
                          type="button"
                          className="plugin-edit-view__step-link plugin-edit-view__step-link--ai"
                          onClick={() => beginScope({ stageIdx, modeIdx })}
                          disabled={!editable || assisting}
                        >
                          <Icon name="sparkles" size={12} />
                          <span>{t('pluginEditor.modeAiEdit')}</span>
                        </button>
                      </div>
                    </div>
                  );
                })()
              ) : (
                (() => {
                  const i = selected.idx;
                  const stage = stages[i];
                  if (!stage) return null;
                  return (
                    <div className="plugin-edit-view__stage-pane">
                      <div className="plugin-edit-view__step-head">
                        <span className="plugin-edit-view__step-num">{i + 1}</span>
                        <input
                          className="plugin-edit-view__step-id"
                          value={stage.id}
                          disabled={!editable}
                          spellCheck={false}
                          placeholder={t('pluginEditor.stepIdPlaceholder')}
                          onChange={(e) => updateStage(i, { id: e.target.value })}
                        />
                        <input
                          className="plugin-edit-view__step-title"
                          value={stage.title}
                          disabled={!editable}
                          placeholder={t('pluginEditor.stepTitlePlaceholder')}
                          onChange={(e) => updateStage(i, { title: e.target.value })}
                        />
                        <select
                          className="plugin-edit-view__step-gate"
                          value={stage.gate}
                          disabled={!editable}
                          onChange={(e) =>
                            updateStage(i, { gate: e.target.value as PluginSourceStage['gate'] })
                          }
                        >
                          {GATES.map((g) => (
                            <option key={g} value={g}>
                              {t(`pluginEditor.gate${g.charAt(0).toUpperCase()}${g.slice(1)}` as
                                | 'pluginEditor.gateConfirm'
                                | 'pluginEditor.gateChoice'
                                | 'pluginEditor.gateNone')}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* This step's own prompt — the heart of it. */}
                      <textarea
                        className="plugin-edit-view__step-prompt plugin-edit-view__step-prompt--fill"
                        value={stage.prompt}
                        disabled={!editable}
                        spellCheck={false}
                        placeholder={t('pluginEditor.stepPromptPlaceholder')}
                        onChange={(e) => updateStage(i, { prompt: e.target.value })}
                      />

                      {/* Stage-bound skills — this step runs on these skills'
                          methodologies (injected under the step at compose time). */}
                      <div className="plugin-edit-view__stage-skills">
                        <span className="plugin-edit-view__stage-skills-label">
                          {t('pluginEditor.stageSkillsLabel')}
                        </span>
                        {stage.skills.map((skillId) => {
                          // Bound skill ids that no longer resolve in the
                          // catalog would silently inject nothing at run time
                          // — flag them so the operator rebinds or creates
                          // the missing skill.
                          const missing =
                            catalog.length > 0 && !catalog.some((s) => s.id === skillId);
                          return (
                            <span
                              className={`plugin-edit-view__skill-chip${missing ? ' plugin-edit-view__skill-chip--missing' : ''}`}
                              key={skillId}
                              title={missing ? t('pluginEditor.skillMissing') : skillId}
                            >
                              <Icon name={missing ? 'info' : 'sparkles'} size={11} />
                              <span>{skillName(skillId)}</span>
                              <button
                                type="button"
                                className="plugin-edit-view__skill-chip-x"
                                onClick={() => removeStageSkill(i, skillId)}
                                disabled={!editable}
                                aria-label={t('pluginEditor.skillUnbind')}
                                title={t('pluginEditor.skillUnbind')}
                              >
                                <Icon name="close" size={10} />
                              </button>
                            </span>
                          );
                        })}
                        <select
                          className="plugin-edit-view__skill-add"
                          value=""
                          disabled={!editable}
                          onChange={(e) => addStageSkill(i, e.target.value)}
                        >
                          <option value="">{t('pluginEditor.skillBindPlaceholder')}</option>
                          {catalog
                            .filter((s) => !stage.skills.includes(s.id))
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                      </div>

                      {/* Modes moved to the canvas — this pane stays focused
                          on the step's own prompt. */}
                      <div className="plugin-edit-view__step-foot">
                        <button
                          type="button"
                          className="plugin-edit-view__step-link plugin-edit-view__step-link--ai"
                          onClick={() => beginScope({ stageIdx: i, modeIdx: null })}
                          disabled={!editable || assisting}
                        >
                          <Icon name="sparkles" size={12} />
                          <span>{t('pluginEditor.stepAiEdit')}</span>
                        </button>
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          </section>

          {/* RIGHT — 对话: describe a change, AI rewrites the prompts on the left. */}
          <aside className="plugin-edit-view__chat">
            <div className="plugin-edit-view__pane-head">
              <Icon name="sparkles" size={14} />
              <span>{t('pluginEditor.aiTitle')}</span>
            </div>
            <div className="plugin-edit-view__log" ref={logRef}>
              {turns.length === 0 ? (
                <div className="plugin-edit-view__empty">{t('pluginEditor.chatEmpty')}</div>
              ) : (
                turns.map((turn, i) => {
                  if (turn.role === 'user') {
                    return (
                      <div key={i} className="plugin-edit-view__msg plugin-edit-view__msg--user">
                        <div className="plugin-edit-view__msg-role">{t('pluginEditor.youLabel')}</div>
                        <div className="plugin-edit-view__bubble">{turn.text}</div>
                      </div>
                    );
                  }
                  if (turn.role === 'error') {
                    return (
                      <div key={i} className="plugin-edit-view__msg plugin-edit-view__msg--ai">
                        <div className="plugin-edit-view__msg-role">{t('pluginEditor.aiLabel')}</div>
                        <div className="plugin-edit-view__bubble plugin-edit-view__bubble--error">
                          {turn.text}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className="plugin-edit-view__msg plugin-edit-view__msg--ai">
                      <div className="plugin-edit-view__msg-role">{t('pluginEditor.aiLabel')}</div>
                      <div className="plugin-edit-view__bubble plugin-edit-view__bubble--done">
                        <span>{t('pluginEditor.aiDone')}</span>
                        {undoableAt === i ? (
                          <button
                            type="button"
                            className="plugin-edit-view__undo"
                            onClick={() => undo(i)}
                          >
                            <Icon name="reload" size={12} />
                            <span>{t('pluginEditor.aiUndo')}</span>
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
              {assisting ? (
                <div className="plugin-edit-view__msg plugin-edit-view__msg--ai">
                  <div className="plugin-edit-view__msg-role">{t('pluginEditor.aiLabel')}</div>
                  {streamText ? (
                    <div className="plugin-edit-view__bubble plugin-edit-view__bubble--stream">
                      {streamText}
                      <span className="plugin-edit-view__caret" />
                    </div>
                  ) : (
                    <div className="plugin-edit-view__bubble plugin-edit-view__bubble--working">
                      <Icon name="spinner" size={13} />
                      <span>{t('pluginEditor.aiWorking')}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <div className="plugin-edit-view__composer-wrap">
              {scope ? (
                <div className="plugin-edit-view__scope">
                  <Icon name="sparkles" size={12} />
                  <span className="plugin-edit-view__scope-text">{scopeLabel(scope)}</span>
                  <button
                    type="button"
                    className="plugin-edit-view__scope-clear"
                    onClick={() => setScope(null)}
                    aria-label={t('common.close')}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ) : null}
              <div className="plugin-edit-view__composer">
                <textarea
                  ref={composerRef}
                  className="plugin-edit-view__composer-input"
                  rows={2}
                  value={instruction}
                  disabled={!editable || assisting}
                  placeholder={t('pluginEditor.aiPlaceholder')}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
                <button
                  type="button"
                  className="plugin-edit-view__send"
                  onClick={submit}
                  disabled={!editable || assisting || !instruction.trim()}
                  aria-label={t('pluginEditor.aiButton')}
                >
                  <Icon name={assisting ? 'spinner' : 'send'} size={15} />
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
      {toast ? <Toast message={toast} ttlMs={2400} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
