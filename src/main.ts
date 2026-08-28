/**
 * ioBroker.py-controller
 *
 * Manages Python *environments* -- not Python *processes*.
 *
 * Process ownership stays with js-controller: it starts, supervises and stops
 * Python adapters exactly the way it does Node adapters. The stop path through
 * the `sigKill` state, the `alive`/`uptime` telemetry and the restart logic are
 * already language-neutral; all that is missing there is the branch that spawns
 * an interpreter from the venv instead of `node`.
 *
 * This adapter takes on what has no business being in the core: provisioning
 * interpreters, creating and repairing a venv per adapter, installing packages,
 * showing state in the admin UI.
 *
 * The contract between the two runs in exactly one direction:
 *
 *   js-controller starts a Python instance only when its venv exists and
 *   matches the required package version. If it is missing or stale, the
 *   instance is not started and an error state is set instead. This adapter
 *   watches that state, builds the environment and triggers the restart.
 *
 * That way the core needs to know nothing about pip, uv or dependency
 * resolution -- only whether a directory is there.
 */

import * as utils from '@iobroker/adapter-core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Value of `common.platform` that identifies a Python adapter.
 *
 * `platform` has always been the field describing what an adapter is written in; until now its only
 * value was `Javascript/Node.js`.
 */
const PYTHON_PLATFORM = 'python';

/**
 * File written next to a virtual environment recording what it was built for.
 *
 * Without it an environment that has fallen behind its adapter is indistinguishable from a current
 * one, and the adapter would run against dependencies resolved for an older version of itself --
 * failing far away from the cause. js-controller reads the same file and refuses to start on a
 * mismatch, which is how the "exists and matches" half of the contract is kept without the core
 * having to understand Python packaging.
 */
const STAMP_FILE = 'environment.json';

interface EnvironmentStamp {
    /** `common.version` of the adapter the environment was built for */
    adapterVersion: string;
    /** Hash over pyproject.toml, so edits without a version bump are noticed too */
    dependencyHash?: string;
    /** When the environment was built, ISO 8601 */
    builtAt?: string;
    /** Version of the interpreter in the environment */
    pythonVersion?: string;
}

interface PythonAdapterInfo {
    /** Adapter name without the "ioBroker." prefix */
    name: string;
    /** Version of the installed adapter */
    version: string;
    /** Directory of the installed npm package */
    dir: string;
    /** Directory holding pyproject.toml */
    pythonDir: string;
    /** Root of this adapter's environment */
    envDir: string;
    /** Target directory of the venv */
    venvDir: string;
    /** Interpreter inside the venv */
    interpreter: string;
    /** Is the venv present and current? */
    ready: boolean;
    /** The venv exists but was built for another adapter version or other dependencies */
    stale: boolean;
    /** What the environment was built for; null when there is no stamp */
    stamp: EnvironmentStamp | null;
}

class PyController extends utils.Adapter {
    /** Root of all managed environments: iobroker-data/py/<adapter>/ */
    private envRoot = '';
    /** Path to uv, if found or self-installed */
    private uvPath: string | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'py-controller' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        this.envRoot = path.join(utils.getAbsoluteInstanceDataDir(this), '..', 'py');
        await fs.mkdir(this.envRoot, { recursive: true });

        this.uvPath = await this.findUv();
        if (this.uvPath) {
            this.log.info(`Found uv: ${this.uvPath}`);
        } else {
            this.log.warn(
                'uv not found on PATH and no path configured. Without uv a sufficiently ' +
                    'recent system Python is required -- on Debian and Raspberry Pi that is ' +
                    'regularly not the case.',
            );
        }

        const adapters = await this.discoverPythonAdapters();
        this.log.info(`Found ${adapters.length} Python adapter(s)`);
        for (const adapter of adapters) {
            const state = adapter.ready
                ? 'ready'
                : !adapter.stale
                  ? 'missing'
                  : adapter.stamp === null
                    ? 'unstamped'
                    : `stale (built for ${adapter.stamp.adapterVersion})`;
            this.log.info(`  ${adapter.name} ${adapter.version}: venv ${state}`);
        }

        if ((this.config as { autoBuildEnvironments?: boolean }).autoBuildEnvironments !== false) {
            await this.reconcileEnvironments(adapters);
        }

        await this.setState('info.connection', true, true);
    }

    /**
     * Finds installed adapters whose io-package.json carries
     * `common.platform: "Python"`.
     *
     * Python adapters are still shipped as npm packages, which keeps the
     * repository, the repo checker, `iobroker add`, admin updates and backups
     * working unchanged. Only the start path differs.
     */
    private async discoverPythonAdapters(): Promise<PythonAdapterInfo[]> {
        const found: PythonAdapterInfo[] = [];
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.香',
        });

        const seen = new Set<string>();
        for (const row of view?.rows ?? []) {
            const common = row.value?.common;
            // Case-insensitive: platform is hand-written and already wrong in the wild -- adapters
            // shipping 'javascript/Node.js' instead of 'Javascript/Node.js' exist today.
            if (common?.platform?.toLowerCase() !== PYTHON_PLATFORM) {
                continue;
            }
            if (seen.has(common.name)) {
                continue;
            }
            seen.add(common.name);
            found.push(await this.describeAdapter(common.name));
        }
        return found;
    }

    private async describeAdapter(name: string): Promise<PythonAdapterInfo> {
        // js-controller already knows where an adapter is installed and copes
        // with the layout differences between installation types. Guessing the
        // path here would only reproduce that logic badly.
        const dir = utils.commonTools.getAdapterDir(name) ?? '';
        const pythonDir = path.join(dir, 'python');
        const envDir = path.join(this.envRoot, name);
        const venvDir = path.join(envDir, 'venv');
        const interpreter = path.join(venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

        const version = await this.readAdapterVersion(dir);
        const stamp = await this.readStamp(envDir);
        const dependencyHash = await this.hashDependencies(pythonDir);

        let exists = false;
        try {
            await fs.access(interpreter);
            exists = true;
        } catch {
            exists = false;
        }

        // An environment without a stamp was built before stamping existed or by hand. It is
        // rebuilt once so that every environment ends up stamped -- otherwise it would stay
        // unstamped forever and no later version change would ever be noticed. The rebuild costs
        // seconds and happens once per adapter; js-controller meanwhile still starts unstamped
        // environments, so nothing goes down while this catches up.
        const stale =
            exists &&
            (stamp === null ||
                stamp.adapterVersion !== version ||
                (stamp.dependencyHash !== undefined &&
                    dependencyHash !== undefined &&
                    stamp.dependencyHash !== dependencyHash));

        return {
            name,
            version,
            dir,
            pythonDir,
            envDir,
            venvDir,
            interpreter,
            ready: exists && !stale,
            stale,
            stamp,
        };
    }

    /**
     * Read the installed adapter's version from its io-package.json
     *
     * @param adapterDir directory the adapter is installed in
     */
    private async readAdapterVersion(adapterDir: string): Promise<string> {
        try {
            const ioPack = JSON.parse(await fs.readFile(path.join(adapterDir, 'io-package.json'), 'utf8'));
            return ioPack?.common?.version ?? '';
        } catch {
            return '';
        }
    }

    /**
     * Read the stamp of an already built environment
     *
     * @param envDir root of the adapter's environment
     * @returns the stamp, or null when there is none or it cannot be read
     */
    private async readStamp(envDir: string): Promise<EnvironmentStamp | null> {
        try {
            const stamp: EnvironmentStamp = JSON.parse(await fs.readFile(path.join(envDir, STAMP_FILE), 'utf8'));
            return typeof stamp?.adapterVersion === 'string' ? stamp : null;
        } catch {
            return null;
        }
    }

    /**
     * Hash the adapter's dependency declaration
     *
     * Catches what the version alone misses: someone edits pyproject.toml without bumping the
     * adapter version, which happens constantly while developing.
     *
     * @param pythonDir directory holding pyproject.toml
     */
    private async hashDependencies(pythonDir: string): Promise<string | undefined> {
        try {
            const content = await fs.readFile(path.join(pythonDir, 'pyproject.toml'));
            return createHash('sha256').update(content).digest('hex').slice(0, 16);
        } catch {
            return undefined;
        }
    }

    /**
     * Record what an environment was built for, so it can later be told apart from a stale one
     *
     * @param info the adapter whose environment was just built
     */
    private async writeStamp(info: PythonAdapterInfo): Promise<void> {
        let pythonVersion: string | undefined;

        try {
            const { stdout } = await run(info.interpreter, ['-c', 'import platform;print(platform.python_version())']);
            pythonVersion = stdout.trim();
        } catch {
            pythonVersion = undefined;
        }

        const stamp: EnvironmentStamp = {
            adapterVersion: info.version,
            dependencyHash: await this.hashDependencies(info.pythonDir),
            builtAt: new Date().toISOString(),
            pythonVersion,
        };

        await fs.writeFile(path.join(info.envDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
    }

    /**
     * Resolves uv: the configured path first, then PATH. Later: download on demand.
     *
     * The configured path matters more than it looks. `pip install uv` drops the
     * executable into the user scripts directory, which is frequently not on
     * PATH -- so searching PATH alone finds nothing even though uv is installed.
     */
    private async findUv(): Promise<string | null> {
        const configured = (this.config as { uvPath?: string }).uvPath?.trim();
        if (configured) {
            try {
                await fs.access(configured);
                return configured;
            } catch {
                this.log.warn(`Configured uv path does not exist: ${configured}`);
            }
        }

        const probe = process.platform === 'win32' ? 'where' : 'which';
        try {
            const { stdout } = await run(probe, ['uv']);
            const first = stdout.split(/\r?\n/).find(Boolean);
            return first ? first.trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Creates an adapter's venv and installs its dependencies.
     *
     * One venv per adapter, not per instance: the isolation is meant to guard
     * against version conflicts between adapters, not between instances of the
     * same adapter.
     */
    private async buildEnvironment(info: PythonAdapterInfo): Promise<void> {
        if (!this.uvPath) {
            throw new Error('uv is missing -- cannot build the environment');
        }
        this.log.info(`Building environment for ${info.name} ${info.version} ...`);
        await fs.mkdir(info.envDir, { recursive: true });
        // --clear, because uv refuses to touch an existing environment. A rebuild is meant to
        // replace it: reusing one that was resolved for different dependencies is what this whole
        // stamping mechanism exists to prevent.
        await run(this.uvPath, ['venv', '--clear', info.venvDir]);
        // --refresh, because uv caches the package index: a version published minutes ago is
        // otherwise reported as non-existent.
        await run(this.uvPath, ['pip', 'install', '--refresh', '--python', info.interpreter, '.'], {
            cwd: info.pythonDir,
        });
        // Only after the install succeeded -- a stamp written earlier would mark a half-built
        // environment as current.
        await this.writeStamp(info);
        this.log.info(`Environment for ${info.name} ${info.version} is ready`);
    }

    /**
     * Bring environments that are missing or out of date up to date
     *
     * @param adapters the adapters found on this host
     */
    private async reconcileEnvironments(adapters: PythonAdapterInfo[]): Promise<void> {
        for (const adapter of adapters) {
            if (adapter.ready) {
                continue;
            }

            const why = !adapter.stale
                ? 'missing'
                : adapter.stamp === null
                  ? 'unstamped'
                  : `built for ${adapter.stamp.adapterVersion}, installed is ${adapter.version}`;

            if (!this.uvPath) {
                this.log.warn(`Environment for ${adapter.name} is ${why}, but uv is unavailable`);
                continue;
            }

            try {
                this.log.info(`Environment for ${adapter.name} is ${why} -- rebuilding`);
                await this.buildEnvironment(adapter);
                await this.restartInstancesOf(adapter.name);
            } catch (e) {
                this.log.error(`Could not build the environment for ${adapter.name}: ${(e as Error).message}`);
            }
        }
    }

    /**
     * Restart the enabled instances of an adapter after its environment changed
     *
     * js-controller refuses to start a Python instance whose environment is missing or stale, so
     * something has to nudge it once the environment is in place. Toggling `enabled` is the same
     * mechanism the admin UI uses.
     *
     * @param adapterName name of the adapter without the `iobroker.` prefix
     */
    private async restartInstancesOf(adapterName: string): Promise<void> {
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: `system.adapter.${adapterName}.`,
            endkey: `system.adapter.${adapterName}.香`,
        });

        for (const row of view?.rows ?? []) {
            const obj = row.value;

            if (!obj?.common?.enabled) {
                continue;
            }

            this.log.info(`Restarting ${obj._id} now that its environment is ready`);
            await this.extendForeignObjectAsync(obj._id, {
                common: { enabled: false },
            });
            await this.extendForeignObjectAsync(obj._id, {
                common: { enabled: true },
            });
        }
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj?.command) {
            return;
        }
        switch (obj.command) {
            case 'list': {
                const adapters = await this.discoverPythonAdapters();
                this.reply(obj, adapters);
                break;
            }
            case 'rebuild': {
                const name = (obj.message as { name?: string })?.name;
                if (!name) {
                    this.reply(obj, { error: 'No adapter name given' });
                    return;
                }
                try {
                    await this.buildEnvironment(await this.describeAdapter(name));
                    this.reply(obj, { ok: true });
                } catch (e) {
                    this.reply(obj, { error: (e as Error).message });
                }
                break;
            }
            default:
                this.log.warn(`Unknown command: ${obj.command}`);
        }
    }

    private reply(obj: ioBroker.Message, payload: unknown): void {
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, payload, obj.callback);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            callback();
        } catch {
            callback();
        }
    }
}

// This package is ESM ("type": "module"), so the usual CommonJS dance --
// `if (require.main !== module) module.exports = ...` -- is not available.
// It exists only to support compact mode, where the controller loads an
// adapter into its own process. Compact mode is off for this adapter
// (io-package.json: compact=false), because it shells out to uv and should
// not share a process with anything else.
(() => new PyController())();
