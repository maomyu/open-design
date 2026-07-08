// Tiny URL router. We avoid pulling in react-router for two reasons:
// the surface area we need is small (three routes, plain pushState), and
// we want a single source of truth for "what file is open" — encoding
// that in the URL is the simplest way to make it deep-linkable.

import { useEffect, useState } from 'react';

// Entry-shell sub-views. The home/project landing renders one of three
// columns and each sub-view now owns a top-level path so the browser
// back/forward buttons work, deep links are shareable, and per-tab
// state isn't trapped behind a `useState` boundary.
export type EntryHomeView =
  | 'home'
  | 'onboarding'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'accounts'
  | 'studio'
  | 'studio-video'
  | 'studio-note'
  | 'knowledge'
  | 'design-systems'
  | 'integrations';

export type Route =
  | { kind: 'home'; view: EntryHomeView }
  | { kind: 'design-system-create' }
  | { kind: 'design-system-detail'; designSystemId: string }
  | {
      kind: 'project';
      projectId: string;
      /**
       * Deep-link to a specific conversation inside the project. When
       * present, the project view picks this conversation as the active
       * one instead of defaulting to `list[0]`. Falls back to the
       * default picker when the routed conversation no longer exists.
       * Added for issue #1505 (Routines history → specific conversation).
       */
      conversationId?: string | null;
      fileName: string | null;
    }
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; pluginId: string }
  | { kind: 'marketplace-edit'; pluginId: string }
  // AI-draft creation studio. `target` picks what gets created: a workflow
  // plugin (drops into the plugin editor after saving) or a skill.
  | { kind: 'creator'; target: 'plugin' | 'skill' }
  // Skill library — every skill with its origin and which plugins use it.
  | { kind: 'skills-library' };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  // 客户定制(2026-07-08 用户拍板):功能全部是创作台的步骤可视化,主页的
  // 对话式开工整体下线——根路径与一切未知路径都落公众号创作台,home view
  // 不再从任何路径产出(要恢复:根路径映射回 view:'home' 即可)。
  if (parts.length === 0) return { kind: 'home', view: 'studio' };
  if (parts[0] === 'onboarding') {
    return { kind: 'home', view: 'onboarding' };
  }
  if (parts[0] === 'projects') {
    if (parts[1]) {
      const projectId = decodeURIComponent(parts[1]);
      // /projects/:id/conversations/:cid[/files/...]
      if (parts[2] === 'conversations' && parts[3]) {
        const conversationId = decodeURIComponent(parts[3]);
        if (parts[4] === 'files' && parts[5]) {
          return {
            kind: 'project',
            projectId,
            conversationId,
            fileName: decodeURIComponent(parts.slice(5).join('/')),
          };
        }
        return { kind: 'project', projectId, conversationId, fileName: null };
      }
      // /projects/:id/files/...
      if (parts[2] === 'files' && parts[3]) {
        return {
          kind: 'project',
          projectId,
          conversationId: null,
          fileName: decodeURIComponent(parts.slice(3).join('/')),
        };
      }
      return { kind: 'project', projectId, conversationId: null, fileName: null };
    }
    return { kind: 'home', view: 'projects' };
  }
  if (parts[0] === 'design-systems') {
    if (parts[1] === 'create') {
      return { kind: 'design-system-create' };
    }
    if (parts[1]) {
      return { kind: 'design-system-detail', designSystemId: decodeURIComponent(parts[1]) };
    }
    return { kind: 'home', view: 'design-systems' };
  }
  if (parts[0] === 'automations' || parts[0] === 'tasks') {
    return { kind: 'home', view: 'tasks' };
  }
  if (parts[0] === 'plugins' && !parts[1]) {
    return { kind: 'home', view: 'plugins' };
  }
  // /media 曾是独立自媒体 hub;每平台入口本就是插件,与插件页重复,
  // 2026-07 并回 /plugins(旧深链继续可达)。
  if (parts[0] === 'media') {
    return { kind: 'home', view: 'plugins' };
  }
  // 账号中心 — platform-level self-media account management.
  if (parts[0] === 'accounts') {
    return { kind: 'home', view: 'accounts' };
  }
  // 创作台 — Media Studio (spec: specs/current/media-studio.md).
  // /studio → 公众号；/studio/short-video → 短视频。
  if (parts[0] === 'studio') {
    if (parts[1] === 'short-video') return { kind: 'home', view: 'studio-video' };
    if (parts[1] === 'note') return { kind: 'home', view: 'studio-note' };
    return { kind: 'home', view: 'studio' };
  }
  // 公司知识库 — 全局一级入口,对所有创作台生效(2026-07-08 用户拍板)。
  if (parts[0] === 'knowledge') {
    return { kind: 'home', view: 'knowledge' };
  }
  if (parts[0] === 'integrations') {
    return { kind: 'home', view: 'integrations' };
  }
  // Phase 2B / spec §11.6 — marketplace deep UI routes. Two paths:
  //   /marketplace            → catalog grid (MarketplaceView)
  //   /marketplace/<pluginId> → detail page (PluginDetailView)
  // Aliases to /plugins remain reserved for the public site (spec §13);
  // in-app we keep /marketplace canonical.
  if (parts[0] === 'create') {
    return { kind: 'creator', target: parts[1] === 'skill' ? 'skill' : 'plugin' };
  }
  if (parts[0] === 'skills' && !parts[1]) {
    return { kind: 'skills-library' };
  }
  if (parts[0] === 'marketplace' || parts[0] === 'plugins') {
    if (parts[1]) {
      const pluginId = decodeURIComponent(parts[1]);
      // /plugins/create | /marketplace/create → creation studio (must win
      // over the detail route — 'create' is not a plugin id).
      if (pluginId === 'create') {
        return { kind: 'creator', target: parts[2] === 'skill' ? 'skill' : 'plugin' };
      }
      // /marketplace/<pluginId>/edit → full-page prompt editor (left display,
      // right AI-edit chat) instead of a modal.
      if (parts[2] === 'edit') {
        return { kind: 'marketplace-edit', pluginId };
      }
      return { kind: 'marketplace-detail', pluginId };
    }
    return { kind: 'marketplace' };
  }
  return { kind: 'home', view: 'studio' };
}

export function buildPath(route: Route): string {
  if (route.kind === 'home') {
    if (route.view === 'onboarding') return '/onboarding';
    if (route.view === 'projects') return '/projects';
    if (route.view === 'tasks') return '/automations';
    if (route.view === 'plugins') return '/plugins';
    if (route.view === 'accounts') return '/accounts';
    if (route.view === 'studio') return '/studio';
    if (route.view === 'studio-video') return '/studio/short-video';
    if (route.view === 'studio-note') return '/studio/note';
    if (route.view === 'knowledge') return '/knowledge';
    if (route.view === 'design-systems') return '/design-systems';
    if (route.view === 'integrations') return '/integrations';
    // 剩下 'home':主页对话框已下线,'/' 会解析回公众号创作台。
    return '/';
  }
  if (route.kind === 'creator') {
    return route.target === 'skill' ? '/create/skill' : '/create/plugin';
  }
  if (route.kind === 'skills-library') return '/skills';
  if (route.kind === 'marketplace') return '/marketplace';
  if (route.kind === 'marketplace-detail') return `/marketplace/${encodeURIComponent(route.pluginId)}`;
  if (route.kind === 'marketplace-edit') return `/marketplace/${encodeURIComponent(route.pluginId)}/edit`;
  if (route.kind === 'design-system-create') return '/design-systems/create';
  if (route.kind === 'design-system-detail') {
    return `/design-systems/${encodeURIComponent(route.designSystemId)}`;
  }
  const id = encodeURIComponent(route.projectId);
  const file = route.fileName
    ? route.fileName.split('/').map((s) => encodeURIComponent(s)).join('/')
    : null;
  if (route.conversationId) {
    const cid = encodeURIComponent(route.conversationId);
    return file
      ? `/projects/${id}/conversations/${cid}/files/${file}`
      : `/projects/${id}/conversations/${cid}`;
  }
  return file ? `/projects/${id}/files/${file}` : `/projects/${id}`;
}

// Centralized navigation. Components call this instead of mutating
// `window.location` directly so we can fan the change out to any
// `useRoute()` subscriber via a custom event.
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const target = buildPath(route);
  const current = window.location.pathname;
  if (target === current) return;
  if (opts.replace) {
    window.history.replaceState(null, '', target);
  } else {
    window.history.pushState(null, '', target);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}
