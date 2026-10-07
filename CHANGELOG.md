# Changelog

Notable changes per release. The format is loose; the version numbers are what
the DSH compatibility gate reads.

## 0.3.0 — 2026-10-07

The distribution changed shape, so this is a breaking release for the earlier
hand-mounted installations.

**Distribution**

- The package is now a DSH **bundle**: `dsh.bundle.patch` points at a root
  `cordis.patch.yml` whose rows name the package instead of an absolute Windows
  path. Install with `dsh plugin --profile <name> add @lone-wolf-akela/dsh-sandboxie-redirect`
  (or the in-app Plugins page for the profile a running desktop app owns); the
  profile no longer needs hand-editing.
- `exports["."]` now resolves to `lib/provider.mjs`. It used to be `lib/host.mjs`,
  which would have mounted the wrong half of the plugin under a package row.
- Added `LICENSE`, `files`, `publishConfig.access`, `repository`/`author`/`bugs`,
  `os: ["win32"]`, keywords and the peer ranges the compatibility gate reads
  (`@deepseek-ai/dsh-* ^0.2.0-rc.2`, `@deepseek-ai/cordis ^4.0.4`).
- Removed the `cordis.patch.yml.new` template: with the bundle channel it was the
  one file that could not survive publication (it carried an absolute path).

**Configuration layer**

- The `permission` row's preset list is computed at load time (`!!js`) from the
  layers before it, instead of restating the three shipped presets. A preset
  another bundle contributes is no longer silently dropped, and an unreadable
  earlier layer falls back to the literal stock three.
- The preset's display name and description are bilingual:
  `❐ Copy-on-write 写时复制`.

**Behaviour**

- Diagnostics moved out of the package directory into
  `$DSH_HOME/state/dsh-sandboxie-redirect` (`DSH_SBIE_LOG_DIR` overrides). An
  installed bundle lives in the profile's `node_modules`, possibly served from
  pnpm's content-addressed store, where appending logs is both rude and fragile.
- The launcher's Node runtime is now located through `process.resourcesPath`
  (the desktop app's own Node) before the `$DSH_HOME/dsh-runtimes` pool, and
  `process.execPath` is only accepted on a non-Electron host. Finding no genuine
  Node now fails loudly with `SANDBOX_UNAVAILABLE` instead of silently spawning
  the Electron binary inside the box.
- The copy root follows Sandboxie's configured `FileRootPath` (box setting, then
  `[GlobalSettings]`), with `%USER%`/`%SANDBOX%`/`%SystemDrive%`/`%USERPROFILE%`/
  `%WINDIR%` expanded; `DSH_SBIE_ROOT` still overrides it. A template without
  `%SANDBOX%`, or one that cannot be fully expanded, is refused — the plugin then
  keeps the default layout rather than pointing its cleanup at a shared folder.
- `--manage list` derives the sandbox root from the boxes it lists, and
  `--manage show` resolves a box's own directory the same way.
- The model-facing note names the same resolved root.

**Tooling and docs**

- `tools/install.mjs` (the manual channel) derives its copy list from
  `package.json`'s `files`.
- `test/validate-patch.mjs` accepts both row shapes (package name for bundles,
  absolute path for the manual channel), reads js-yaml from the devDependency /
  `asar-yaml/` / an installed profile, and now EXECUTES the computed preset
  expression against a stub context.
- The module-level import pin for `lib/tool.mjs` follows relative siblings
  recursively instead of banning them.
- GitHub Actions runs the Sandboxie-free tests; `npm test`, `npm run
  test:acceptance` and `npm run pack:check` are wired up. The READMEs are
  rewritten around the bundle install.

## 0.2.1

The last hand-mounted release: copy the tree into
`~/.dsh/plugins/dsh-sandboxie-redirect` and add three rows to the profile's
`cordis.patch.yml`. Functionally it already had the copy-on-write preset, the
title-bar box name, the permission-dropdown icon and the `sandbox_clear` tool.
