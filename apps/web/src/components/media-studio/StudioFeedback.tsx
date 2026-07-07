// 创作台统一反馈层：轻量 toast 单例 + 保存状态徽标。
// toast 是模块级单例（三台共用一套 API），Host 组件挂在各 View 根部；
// 同一时刻只有一个 View 挂载，所以单例监听不会重复弹。
import { useEffect, useState } from 'react';

import { Icon } from '../Icon';
import styles from './MediaStudio.module.css';

type ToastKind = 'ok' | 'err' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  leaving?: boolean;
}

let toastSeq = 0;
let toastItems: ToastItem[] = [];
const toastListeners = new Set<(items: ToastItem[]) => void>();

function emitToasts(): void {
  for (const fn of toastListeners) fn(toastItems);
}

function removeToast(id: number): void {
  const item = toastItems.find((t) => t.id === id);
  if (!item || item.leaving) return;
  item.leaving = true;
  toastItems = [...toastItems];
  emitToasts();
  // 退出动画 140ms 后真正移除（进 200ms / 出 140ms 的不对称节奏）。
  setTimeout(() => {
    toastItems = toastItems.filter((t) => t.id !== id);
    emitToasts();
  }, 150);
}

function pushToast(kind: ToastKind, text: string, ttlMs?: number): void {
  const id = ++toastSeq;
  toastItems = [...toastItems.slice(-3), { id, kind, text }];
  emitToasts();
  setTimeout(() => removeToast(id), ttlMs ?? (kind === 'err' ? 5200 : 2600));
}

export const studioToast = {
  ok: (text: string): void => pushToast('ok', text),
  err: (text: string): void => pushToast('err', text),
  info: (text: string): void => pushToast('info', text),
};

const TOAST_ICON: Record<ToastKind, 'check' | 'close' | 'sparkles'> = {
  ok: 'check',
  err: 'close',
  info: 'sparkles',
};

export function StudioToastHost(): JSX.Element | null {
  const [items, setItems] = useState<ToastItem[]>(toastItems);
  useEffect(() => {
    const fn = (next: ToastItem[]): void => setItems(next);
    toastListeners.add(fn);
    return () => {
      toastListeners.delete(fn);
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <div className={styles.toastHost}>
      {items.map((t) => (
        <div
          key={t.id}
          className={`${styles.toast} ${
            t.kind === 'ok' ? styles.toastOk : t.kind === 'err' ? styles.toastErr : styles.toastInfo
          } ${t.leaving ? styles.toastLeaving : ''}`}
          role="status"
          onClick={() => removeToast(t.id)}
        >
          <Icon name={TOAST_ICON[t.kind]} size={13} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ---- 步骤接力条：当前步完成后引导去下一步 ----

export function NextStepBar(props: {
  hint: string;
  label: string;
  onGo: () => void;
}): JSX.Element {
  return (
    <div className={styles.nextStepBar}>
      <span>{props.hint}</span>
      <button type="button" className={styles.nextStepBtn} onClick={props.onGo}>
        {props.label}
        <Icon name="chevron-right" size={13} />
      </button>
    </div>
  );
}

// ---- 空状态引导 ----

export function EmptyGuide(props: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}): JSX.Element {
  return (
    <div className={styles.emptyGuide}>
      <strong>{props.title}</strong>
      {props.hint ? <span>{props.hint}</span> : null}
      {props.actionLabel && props.onAction ? (
        <button type="button" className={styles.nextStepBtn} onClick={props.onAction}>
          {props.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

// ---- 保存状态徽标 ----

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function SaveStatusBadge(props: {
  state: SaveState;
  savedAt: Date | null;
  onRetry: () => void;
}): JSX.Element | null {
  const { state, savedAt, onRetry } = props;
  if (state === 'idle') return null;
  if (state === 'saving') {
    return (
      <span className={`${styles.saveBadge} ${styles.saveBadgeSaving}`}>
        <span className={styles.saveDot} />
        保存中…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <button type="button" className={`${styles.saveBadge} ${styles.saveBadgeErr}`} onClick={onRetry}>
        <Icon name="close" size={11} />
        保存失败 · 点此重试
      </button>
    );
  }
  return (
    <span className={`${styles.saveBadge} ${styles.saveBadgeOk}`} title={savedAt ? `保存于 ${savedAt.toLocaleString()}` : undefined}>
      <Icon name="check" size={11} />
      已保存{savedAt ? ` · ${formatClock(savedAt)}` : ''}
    </span>
  );
}
