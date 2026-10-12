# Changelog

Notable changes per release. The format is loose; the version numbers are what
the DSH compatibility gate reads.

## 0.3.4 — 2026-10-13

**`sandbox_clear` mode `status` no longer answers in `inspect`'s words**

- `render` gave every action except `clear` the inspect head line, so a status
  query read `Sandbox copies for <workspace>: 0 found.` — which looks like "this
  workspace has no copy" when the call says nothing about copies at all. `status`
  now has its own head, `Session projection state for <workspace>.`, above the
  projection detail that actually carries the information.
- `test/tool-execute.mjs` pins the rendered text of all three actions, plus the
  empty and truncated copy lines, so the wording cannot silently fall through
  again.

## 0.3.3 — 2026-10-13

**`sandbox_clear` mode `status` never worked**

- `execute` referenced `workspace` in the `status` early return while the
  `const workspace = …` that names it was declared below, in the same function
  body. A `const` in its temporal dead zone throws on *any* earlier reference, so
  `mode: "status"` failed on every call with `ReferenceError: Cannot access
  'workspace' before initialization`. The declaration now precedes every use,
  which is also what `status` was always meant to report: the canonical workspace
  alongside the projection registry's state for the calling session.
- The defect came in with the 0.2.1 import, so it shipped in 0.3.0, 0.3.1 and
  0.3.2; `inspect` and `clear` were unaffected, because they use `workspace`
  after the declaration.
- New `test/tool-execute.mjs` drives all three modes of the real tool offline
  (only the harness loader, the Node lookup and `spawnSync` are redirected), so
  this — and any future runtime failure in a mode nobody exercises by hand — is a
  failed test rather than a report from a user. It reproduces the
  `ReferenceError` on the pre-fix source.

## 0.3.2 — 2026-10-13

**DeepSeek Harness installation lookup**

- The launcher no longer assumes DSH is installed in
  `%LOCALAPPDATA%\Programs\DeepSeek Harness`. `koffi.node` ships *inside* the
  installation, so a relocated DSH failed every command with "koffi native addon
  not found". The new `lib/dsh-locate.mjs` finds the installation instead: the
  interpreter's own path walked upwards (the host starts the launcher with the
  Node the app ships, so that path points back at the installation), then the
  installer's uninstall entry — `InstallLocation`, `DisplayIcon` and
  `UninstallString` are all accepted, and it is found by display name because
  the key is a GUID — then the conventional folders and `PATH`.
- `DSH_SBIE_KOFFI` and `DSH_SBIE_KOFFI_ROOT` remain the explicit overrides, and
  the failure message now says what it looked for and where.
- New `test/dsh-locate.mjs` (18 offline checks) pins the source order and
  includes a regression case for an installation outside every default folder.

**Packaging**

- `bin` no longer carries a leading `./`. npm's `@npmcli/package-json`
  normalizes that away and then reports `"bin[dsh-sbie-run]" script name
  bin/dsh-sbie-run.mjs was invalid and removed` on every publish; the emitted
  path was already the normalized one, so this removes a misleading warning and
  nothing else. `test/unit.mjs` pins the form.

## 0.3.1 — 2026-10-12

**Sandboxie installation lookup**

- The engine is no longer looked for in a fixed four-path list. The new
  `lib/sbie-locate.mjs` reads Sandboxie's own registry entries first — the
  `SbieSvc` service's `ImagePath` above all, which every installation able to
  create a box must have — then the driver service and the installer's uninstall
  entry, then the conventional folders and `PATH`, and only as a last resort
  walks well-known parent folders and fixed-drive roots for a directory named
  after Sandboxie. An installation on another drive, in a per-user folder or in
  a portable directory is now found instead of reported as "not installed".
- `DSH_SBIE_DIR` still wins when set, and the "not installed" error now names it
  as well as `SbieDll.dll`, so the remaining unusual cases are actionable.
- `--manage list` prints the installation folder it resolved and how it found it
  (registry / conventional folder / `PATH` / disk scan).
- The registry is read through `koffi`/`advapi32` when available — exact wide
  characters, no subprocess — and through `reg.exe` when it is not.
- New `test/sbie-locate.mjs` (25 checks, no Sandboxie and no registry needed)
  covers the registry value shapes, the candidate ordering, and the staged
  resolution, including that the disk scan runs only when nothing cheap answers.
  It is part of `npm test`.

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
