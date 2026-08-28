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

## The contract with js-controller

Exactly one direction, so the two never become entangled:

> js-controller starts a Python instance only when its venv exists under
> `iobroker-data/py/<name>/` and matches the required package version. If it is
> missing or stale, the instance is not started and an error state is set
> instead. py-controller watches that state, builds the environment and
> triggers the restart.

This way the core needs to know nothing about `pip`, `uv` or dependency
resolution — only whether a directory is there.

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
