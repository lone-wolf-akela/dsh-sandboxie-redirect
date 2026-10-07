# Contributing

Thanks for looking. This is a small plugin with an unusually large amount of
hard-won context; the fastest way in is to read [AGENTS.md](AGENTS.md) after this
file. User-facing behaviour lives in [README.md](README.md) / [README.zh.md](README.zh.md).

## What you need

- **Windows 10/11** with [Sandboxie-Plus](https://sandboxie-plus.com/) installed.
  The plugin is built around Sandboxie's API; there is no fallback, and the
  acceptance tests create real boxes.
- **Node >= 20** (the desktop app ships Node 24; CI runs that).
- A DSH installation, for anything beyond the offline tests.

## Setup and the offline suite

```powershell
git clone https://github.com/lone-wolf-akela/dsh-sandboxie-redirect
cd dsh-sandboxie-redirect
npm install            # one devDependency: js-yaml, used by validate-patch
npm test               # unit + host projection + bundle-layer validation
```

`npm test` needs no DSH, no Sandboxie and no network. It is the same suite CI
runs, and it is expected to stay green before every commit.

## The on-machine suite

```powershell
npm run test:acceptance     # 19 cases against real boxes
npm run test:soak           # stability/latency, e.g. npm run test:soak 30
```

Both **must run outside any sandbox**, as a normal user token (medium integrity):
a process inside a box cannot see Sandboxie's box list, so the results would be
meaningless. Run them from a plain console, or from a DSH session whose preset is
`danger-full-access`.

The acceptance suite writes outside the workspace on purpose (that is what it
tests) and cleans up after itself; see `test/run-tests.mjs`.

## Iterating on the plugin

The distribution is a DSH **bundle**, and the development loop is the official
one:

```powershell
dsh plugin --profile dev add C:\path\to\dsh-sandboxie-redirect   # links the checkout
dsh --profile dev --dump-config                                  # check the layer without booting
dsh --profile dev
```

- Editing `cordis.patch.yml` is picked up by a **live** profile within seconds.
- Editing `lib/*.mjs` requires **restarting the client**: the module is cached in
  the host process.
- `node test/validate-patch.mjs [patch.yml]` validates any layer file — the
  bundle's own by default, or a profile patch (both row shapes are supported), and
  it actually evaluates the computed preset expression.

## What to keep in mind

The constraints in `AGENTS.md` are not style preferences — each one is a failure
that was observed and diagnosed. The ones that bite most often:

1. Never `session.append()` a new event type (it makes sessions unloadable).
2. Keep module-level imports to Node builtins plus sibling modules that do the
   same (a native import that throws kills the loader row silently).
3. Run installation and verification **outside** the box: under copy-on-write, a
   write outside the workspace reports success while landing in the copy.
4. Diagnostics go to `$DSH_HOME/state/dsh-sandboxie-redirect`, never into the
   package directory.
5. Anything that resolves a path Sandboxie owns must fail towards "do nothing",
   never towards "delete the wrong directory".

## Commits and pull requests

- Small, focused commits with a message that says **why**, not just what — the
  repository's history is the design log.
- Update `CHANGELOG.md` for user-visible changes and `AGENTS.md` when you learn
  something a future maintainer would otherwise rediscover the hard way.
- Keep the version bump for a release commit; the DSH compatibility gate reads
  `peerDependencies`, so a DSH upgrade usually needs one.
- Plain ESM, no build step, no runtime dependencies. Please keep it that way: it
  is why installing this plugin needs no build permission from pnpm.

## Reporting a bug

Include:

- what you expected and what happened, with the exact command;
- DSH version, Sandboxie-Plus version, Windows version;
- whether the command ran inside a box (`$env:DSH_SBIE_BOX`) or outside;
- the diagnostics from `$DSH_HOME/state/dsh-sandboxie-redirect/`
  (`provider.log`, `host.log`, `tool.log`);
- for "the write did not happen / did happen" reports, **which side** you read it
  from (a shell command reads the merged view; the DSH file tools read the real
  disk).

Security issues: see [SECURITY.md](SECURITY.md).
