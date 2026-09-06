# ioBroker.py-controller

Manages Python **environments** for Python adapters — provisioning interpreters,
creating and repairing a venv per adapter, installing packages, showing state.

> **Status: 0.0.1, skeleton.** Not yet runnable as an adapter.

## The split

This adapter manages **no processes**. Process ownership stays with
js-controller: it starts, supervises and stops Python adapters exactly the way
it does Node adapters. That is possible because its start path is far more
language-neutral than it looks — stopping goes through the `sigKill` state,
`alive`/`uptime` are written by the adapter itself, stdout is discarded anyway,
and the IPC channel is never used. What is genuinely Node-specific amounts to
the two `cp.fork` call sites and the main-file resolution.

A second process supervisor would reimplement restart backoff, crash counting
and status reporting — with its own bugs, and without `iobroker start`, the
instance list or multihost ever noticing those instances.

## Getting uv

`uv` creates the virtual environments and brings its own Python interpreters, which is what keeps an
outdated distribution Python from blocking an adapter. On an ordinary system it is not installed, so
this adapter obtains it:

1. the path configured in the instance settings, if there is one
2. `uv` on `PATH`
3. a copy fetched earlier, in `iobroker-data/py/.bin/`
4. otherwise it downloads a pinned version there

The download comes from the GitHub release with the checksum verified, rather than by piping the
vendor's install script into a shell: the version is pinned, and the binary lands somewhere this
adapter can manage instead of in the user's `~/.local/bin`. Downloading is last in the order so an
installation that already has `uv` keeps using the version its owner chose, and it can be switched
off entirely in the settings.

## Working on a Python adapter

A copied installation serves the copy: editing an adapter's Python sources changes nothing until the
package is reinstalled, which turns every edit into edit → reinstall → restart.

This adapter therefore installs *linked to the sources* when the adapter's directory is a symlink or
a junction — which is exactly how a working copy is put into an installation, and what `link.bat`
creates on Windows. Node reports junctions as symbolic links, so the same detection covers both
platforms. Edits then take effect on the next restart.

It is deliberately not the default for a normal installation: an editable installation ties the
environment to a directory that may be deleted, and reinstalling is what makes a version
reproducible. The setting overrides the detection in either direction.

Switching a working copy in or out rebuilds the environment, because a copied install would keep
serving the old sources and an editable one would point at a directory that is gone.

## The contract with js-controller

Exactly one direction, so the two never become entangled:

> js-controller starts a Python instance only when its venv exists under
> `iobroker-data/py/<name>/` and matches the required package version. If it is
> missing or stale, the instance is not started and an error state is set
> instead. py-controller watches that state, builds the environment and
> triggers the restart.

This way the core needs to know nothing about `pip`, `uv` or dependency
resolution — only whether a directory is there.

## What it reports

Without opening this adapter's configuration page:

| State | |
|---|---|
| `info.uvVersion` | which uv is in use, or empty when there is none |
| `info.installing` / `info.installStatus` | an environment is being built, and what for |
| `adapters.<name>.ready` | that adapter's environment is present and current |
| `adapters.<name>.status` | `ready`, `missing`, `unstamped`, or `stale (built for <version>)` |
| `adapters.<name>.version` | the installed adapter version |
| `adapters.<name>.sdkVersion` | the `iobroker` SDK inside the environment |
| `adapters.<name>.pythonVersion` | the Python the environment was built with |

An instance that will not start because its environment is missing looks in admin
exactly like an instance that is broken. These states are where the difference is
visible — and they are bindable from a visualisation or a script, which the
configuration dialog is not.

## The diagnosis table

The two buttons on the settings page — "Check prerequisites" and "Rebuild
environments" — fill one table underneath them, with a checkbox per line and the
time the diagnosis was taken above it:

| ✓ | Level | Checked | Result | What to do |
|---|---|---|---|---|
| ☑ | ok | uv | uv 0.12.7 at … | |
| ☐ | warning | uv | not installed yet | It will be downloaded automatically the first time an environment is built. |

The checkbox is what the eye finds first, and the level is beside it because a
checkbox has two states while a finding has three: a warning is not a failure.
Every line that is not ok carries what to do about it, so the table is the whole
answer rather than a pointer to the log.

Sortable, but not filterable: `ConfigTable` remembers a filter as row *indices*
and only recomputes them when the filter itself changes, so a second check with
fewer rows would be displayed against the previous run's indices until the
filter is retyped. Eight rows do not need a filter enough to pay for that.

Nothing in it is a setting. Both attributes start with an underscore, which keeps
them out of the saved configuration — a diagnosis is what was true a minute ago.
The timestamp is there for the same reason: the table stays on screen after the
check that produced it, and a result whose age is invisible gets read as current
long after it stopped being so. Use the export button for a CSV to paste into a
forum post.

## Removing an adapter

Uninstalling a Python adapter leaves a few hundred megabytes of virtual
environment behind, so this adapter clears it out on the next pass. Two things
have to be true before anything is deleted: the adapter has no installation
directory left, and the directory carries either the stamp file or a `venv`.
Anything else under `iobroker-data/py/` is left where it is and reported in the
log — an adapter that is installed but not yet configured keeps its environment,
and so does whatever else somebody put there.

## Distributing Python adapters

A Python adapter is still shipped as an npm package: `io-package.json`,
`admin/jsonConfig.json` and a `python/` directory containing `pyproject.toml`.
That keeps the repository, the repo checker, `iobroker add`, admin updates and
backups working without a single change.

The only change is `common.platform: "Python"` instead of the usual
`Javascript/Node.js`. `platform` has always been the field describing what an adapter
is written in: js-controller decides from it how to start, this adapter decides what to
build a venv for. Every other adapter keeps its existing value and behaves exactly as
before.

## Related

- [iobroker-python](https://github.com/ioBroker/iobroker-python) — the SDK used
  to write Python adapters.

## License

MIT
