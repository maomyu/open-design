# Plugin Directory Guide

This directory owns Open Design plugin content and plugin authoring material.

## Boundaries

- `plugins/_official/` contains bundled first-party plugins. The daemon boot walker scans only this subtree and registers it as `source_kind='bundled'`.
- `plugins/spec/` is the portable plugin specification and authoring kit. It is documentation, starter material, and example source for contributors and external agents; it must not be treated as an installed first-party catalog.
- Keep runnable plugin examples portable: every example should have a `SKILL.md`; add `open-design.json` only as the OD sidecar.
- Keep `SKILL.md` bodies free of OD-only marketplace metadata. Put OD display, inputs, preview, pipeline, capabilities, and source information in `open-design.json`.
- Do not import app-private code from plugin content. A plugin may reference OD atoms, design systems, craft docs, assets, scripts, MCP servers, or connectors through the manifest.

## Authoring Rules

- New spec examples belong under `plugins/spec/examples/<plugin-id>/`.
- New first-party bundled plugins belong under `plugins/_official/<tier>/<plugin-id>/` only when the product should auto-register them on daemon startup.
- Use the v1 JSON schema at `docs/schemas/open-design.plugin.v1.json`.
- Contribution-facing spec docs are bilingual. When editing `README.md`, `SPEC.md`, `CONTRIBUTING.md`, `AGENT-DEVELOPMENT.md`, or example README files under `plugins/spec/`, update the matching `*.zh-CN.md` mirror in the same change.
- Prefer TypeScript for project-owned scripts. Avoid adding new `.js`, `.mjs`, or `.cjs` files unless they are generated, vendored, or explicitly allowlisted by `scripts/guard.ts`.
- Keep example plugins concise and agent-readable. Move long reference material to `references/` and tell the agent when to load it.
- **Multi-step plugins keep per-step artifacts in the project CWD for traceability.** Any file a plugin writes into the run's project directory (`.od/projects/<id>/`, non-dotfile, not a `.artifact.json` sidecar) is automatically listed and openable in the conversation's "设计文件" / Design Files panel. So a plugin whose run has several steps MUST write each step's reviewable output into the project CWD with a step-number prefix (`01-…`, `02-…`) and MUST NOT delete or overwrite earlier steps' files — that lets the user browse back through every step's output while a later step runs. The live-artifact board (`index.html`) is the interaction surface; these numbered files are the durable per-step record. (If the plugin drives an external workbench, the workbench's own archive is at most a secondary copy — the reviewable artifacts live in the project CWD.)
- **External local-tool workbenches use ONE unified root, as copies.** When a first-party plugin drives an external local tool the user installed (e.g. `social-auto-upload` behind `short-video-copy`, or the WeChat-MP workbench behind `wechat-mp-publish`), the tool is **copied** into `~/.open-design/workbenches/<tool>` and that copy is the working version — overridable with the `OD_WORKBENCH_DIR` env var. The `SKILL.md` MUST locate the tool there; never hardcode a deep, user-specific absolute path (`~/Desktop/...`, `~/social-auto-upload`), and never reach back to the tool's original location — all optimization happens on the workbench copy. Note for copying a tool's venv: its `bin/*` script shebangs hold the old absolute venv path, so after `rsync` (exclude `.git`, `__pycache__`, large regenerable output dirs like `archives/`), rewrite those shebangs to the new venv path (`grep -rIl <old-venv> .venv/bin | xargs sed -i '' 's|<old-venv>|<new-venv>|g'`) and verify the tool runs. State the path once near the top of the `SKILL.md`; if the dir is missing, tell the user to copy the tool there rather than searching elsewhere.

## Validation

For plugin content changes, run:

```bash
pnpm guard
pnpm --filter @open-design/plugin-runtime typecheck
```

When the daemon CLI is built and available, also validate runnable plugin folders with:

```bash
od plugin validate ./plugins/spec/examples/<plugin-id>
```
