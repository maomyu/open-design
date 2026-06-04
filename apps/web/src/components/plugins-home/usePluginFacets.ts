// Faceted categorisation hook for the Plugins home section.
//
// Two-level starter model: the top row is the artifact kind
// (Prototype / Slides / Image / Video / HyperFrames / Audio). Prototype,
// Slides, Image, and Video expose scene buckets from the prompt-taxonomy
// analysis; HyperFrames and Audio stay flat.
//
// A small "Saved" toggle sits orthogonally to the category row —
// when active it overrides the category selection and just shows
// the plugins saved by the user. We intentionally make Saved
// override rather than AND-compose so a saved pick is never
// accidentally hidden behind a still-selected category pill.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  applyFacetSelection,
  buildFacetCatalog,
  filterByQuery,
  resolveDefaultSelection,
  type FacetCatalog,
  type FacetSelection,
} from './facets';
import { sortByVisualAppeal } from './visualScore';

export type FilterMode = 'all' | 'saved';

// Source filter: "owned" = built-in plugins YOU developed (open-build tag);
// "official" = plugins from the upstream official repo.
export type PluginSourceFilter = 'owned' | 'official';

// Plugins authored for this product carry a marker tag so the Home
// gallery can default to the operator's own catalog instead of the
// upstream demo plugins bundled with the open-source project. When at
// least one product-owned plugin is installed we hide everything else;
// a vanilla checkout with no tagged plugins keeps the full catalog, so
// upstream behaviour is preserved.
export const PRODUCT_PLUGIN_TAG = 'open-build';

export function isProductOwned(record: InstalledPluginRecord): boolean {
  const tags = record.manifest?.tags;
  return (
    Array.isArray(tags) &&
    tags.some((tag) => String(tag).toLowerCase() === PRODUCT_PLUGIN_TAG)
  );
}

interface UsePluginFacetsArgs {
  plugins: InstalledPluginRecord[];
  savedPluginIds?: ReadonlySet<string>;
  preferDefaultFacet?: boolean;
  // External selection driven by the Home hero chip rail. When this
  // value changes to a new (non-null) selection, the hook applies it,
  // overriding both the user's manual pick and the default-facet
  // bootstrap. We track the last-applied identity so the user can
  // still click a different category afterwards without the effect
  // snapping back on every re-render.
  presetSelection?: FacetSelection | null;
  locale?: string;
}

export interface UsePluginFacetsResult {
  visiblePlugins: InstalledPluginRecord[];
  savedList: InstalledPluginRecord[];
  filtered: InstalledPluginRecord[];
  catalog: FacetCatalog;
  selection: FacetSelection;
  pickCategory: (slug: string | null) => void;
  pickSubcategory: (slug: string | null) => void;
  clearFacets: () => void;
  hasActiveFacet: boolean;
  mode: FilterMode;
  setMode: (next: FilterMode) => void;
  query: string;
  setQuery: (next: string) => void;
  totalVisible: number;
  // Source filter chips: "owned" (内置插件, your own) vs "official" (官方插件,
  // upstream). Default "owned". Counts drive the chip badges; the chips only
  // render when both sources are present.
  sourceFilter: PluginSourceFilter;
  setSourceFilter: (next: PluginSourceFilter) => void;
  ownedCount: number;
  officialCount: number;
}

const EMPTY_SELECTION: FacetSelection = {
  category: null,
  subcategory: null,
};

export function usePluginFacets({
  plugins,
  savedPluginIds,
  preferDefaultFacet = true,
  presetSelection = null,
  locale,
}: UsePluginFacetsArgs): UsePluginFacetsResult {
  const [mode, setMode] = useState<FilterMode>('all');
  const [selection, setSelection] = useState<FacetSelection>(EMPTY_SELECTION);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<PluginSourceFilter>('owned');
  // Apply the preferred default selection once, on the first render that
  // sees a non-empty catalog. Using a flag (instead of a useState lazy
  // initializer) handles the realistic case where `args.plugins` is
  // empty at first paint and arrives a tick later.
  const [bootstrapped, setBootstrapped] = useState(false);
  const lastAppliedPresetKeyRef = useRef<string | null>(null);

  // Atoms are infrastructure pieces (`code-import`, `patch-edit`) that
  // are not user-facing on the home grid; the original section already
  // filtered them out and we preserve that contract. We immediately
  // sort by visual-appeal score so the first viewport leads with the
  // cinematic decks / image / video templates rather than alphabetical
  // bundled noise. Featured plugins get a +1000 score boost inside the
  // sort so curator picks stay anchored to the front of every category view.
  const nonAtom = useMemo(
    () => plugins.filter((p) => p.manifest?.od?.kind !== 'atom'),
    [plugins],
  );
  // Two sources: "owned" = built-in plugins YOU developed (open-build tag);
  // "official" = plugins from the upstream official repo. The filter row
  // offers both as chips; default to your own.
  const ownedPlugins = useMemo(() => nonAtom.filter(isProductOwned), [nonAtom]);
  const officialPlugins = useMemo(() => nonAtom.filter((p) => !isProductOwned(p)), [nonAtom]);
  const ownedCount = ownedPlugins.length;
  const officialCount = officialPlugins.length;
  const visiblePlugins = useMemo(
    () => {
      // No owned plugins yet (vanilla checkout) → show the full catalog so the
      // gallery isn't empty. Otherwise honor the source filter.
      const base =
        ownedCount === 0
          ? nonAtom
          : sourceFilter === 'official'
            ? officialPlugins
            : ownedPlugins;
      return sortByVisualAppeal(base);
    },
    [sourceFilter, nonAtom, ownedPlugins, officialPlugins, ownedCount],
  );

  const savedList = useMemo(
    () => visiblePlugins.filter((plugin) => savedPluginIds?.has(plugin.id)),
    [savedPluginIds, visiblePlugins],
  );

  const catalog = useMemo(() => buildFacetCatalog(visiblePlugins), [visiblePlugins]);

  useEffect(() => {
    if (bootstrapped) return;
    if (visiblePlugins.length === 0) return;
    if (!preferDefaultFacet) {
      setBootstrapped(true);
      return;
    }
    const next = resolveDefaultSelection(catalog);
    if (next.category !== null) {
      setSelection(next);
    }
    setBootstrapped(true);
  }, [bootstrapped, preferDefaultFacet, visiblePlugins.length, catalog]);

  // Sync an externally-driven selection (the Home chip rail) into the
  // facet state. We only apply a preset once per identity so the user
  // can still click a different facet pill afterwards without the
  // effect snapping back. Setting `bootstrapped` here also prevents
  // the default-facet effect above from overriding the preset on the
  // first non-empty render.
  useEffect(() => {
    if (!presetSelection) return;
    const key = `${presetSelection.category ?? ''}::${presetSelection.subcategory ?? ''}`;
    if (lastAppliedPresetKeyRef.current === key) return;
    lastAppliedPresetKeyRef.current = key;
    setSelection(presetSelection);
    setMode((current) => (current === 'saved' ? 'all' : current));
    setBootstrapped(true);
  }, [presetSelection]);

  // The visual-appeal sort is applied at `visiblePlugins` derivation
  // (above), so any downstream `applyFacetSelection` slice preserves
  // the ranking. We do not re-sort here because filter + featured
  // override should both remain stable across selections.
  const filtered = useMemo(() => {
    const base =
      mode === 'saved'
        ? savedList
        : applyFacetSelection(visiblePlugins, selection);
    return filterByQuery(base, query, locale);
  }, [mode, savedList, visiblePlugins, selection, query, locale]);

  function pickCategory(slug: string | null): void {
    if (mode === 'saved') setMode('all');
    setSelection((prev) => ({
      category: prev.category === slug ? null : slug,
      subcategory: null,
    }));
  }

  function pickSubcategory(slug: string | null): void {
    if (mode === 'saved') setMode('all');
    setSelection((prev) => ({
      ...prev,
      subcategory: prev.subcategory === slug ? null : slug,
    }));
  }

  function clearFacets(): void {
    setSelection(EMPTY_SELECTION);
    setQuery('');
    // Saved overrides the facet slice, so the empty-state "Clear
    // filters" CTA also has to leave Saved mode — otherwise clicking
    // it from a Saved + zero-match view just re-renders the same
    // empty state and the user has no one-click escape back to the
    // full catalog.
    setMode('all');
  }

  const hasActiveFacet =
    selection.category !== null || selection.subcategory !== null || query.trim().length > 0;

  return {
    visiblePlugins,
    savedList,
    filtered,
    catalog,
    selection,
    pickCategory,
    pickSubcategory,
    clearFacets,
    hasActiveFacet,
    mode,
    setMode,
    query,
    setQuery,
    totalVisible: visiblePlugins.length,
    sourceFilter,
    setSourceFilter,
    ownedCount,
    officialCount,
  };
}
