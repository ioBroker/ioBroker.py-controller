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
import { runCheck } from './check.js';
import { downloadUv, managedUvPath } from './uv.js';

const run = promisify(execFile);

/**
 * Value of `common.platform` that identifies a Python adapter.
 *
 * `platform` has always been the field describing what an adapter is written in; until now its only
 * value was `Javascript/Node.js`.
 */
const PYTHON_PLATFORM = 'python';

/** Prefix every adapter and instance object carries. */
const SYSTEM_ADAPTER_PREFIX = 'system.adapter.';

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

/** How long to wait for an instance to actually be gone before rebuilding its environment. */
const STOP_TIMEOUT_MS = 15_000;

/** How often to look while waiting for that. */
const STOP_POLL_MS = 250;

interface EnvironmentStamp {
    /** `common.version` of the adapter the environment was built for */
    adapterVersion: string;
    /** Whether the package was installed editable, i.e. linked to its sources */
    editable?: boolean;
    /** Hash over pyproject.toml, so edits without a version bump are noticed too */
    dependencyHash?: string;
    /** When the environment was built, ISO 8601 */
    builtAt?: string;
    /** Version of the interpreter in the environment */
    pythonVersion?: string;
}

/**
 * Extensions Windows can actually launch as a process.
 *
 * Deliberately not all of PATHEXT: `.JS`, `.VBS` and friends are run by the Windows Script Host,
 * which `spawn` does not do -- it needs a real executable image and fails with `EFTYPE` otherwise.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.bat', '.cmd'];

/**
 * Can this file be spawned as a process?
 *
 * @param file path to check; on POSIX every path passes, because `which` only ever reports files
 * that carry the execute bit
 * @returns true when spawning the file has a chance of working
 */
function isExecutableImage(file: string): boolean {
    if (process.platform !== 'win32') {
        return true;
    }

    return WINDOWS_EXECUTABLE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/** Name of the Python SDK package every Python adapter talks to the databases through. */
const SDK_PACKAGE = 'iobroker';

/** PyPI's metadata endpoint for the SDK; `info.version` is the newest non-yanked release. */
const SDK_PYPI_JSON = `https://pypi.org/pypi/${SDK_PACKAGE}/json`;

/**
 * Look up the newest published SDK release.
 *
 * Failure is not an error: an installation may be deliberately offline, and the check must still
 * produce a report. A null answer simply means the report says nothing about updates.
 *
 * @returns the version, or null when it could not be determined
 */
async function latestSdkOnPypi(): Promise<string | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 4000);

    try {
        const response = await fetch(SDK_PYPI_JSON, { signal: abort.signal });

        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as { info?: { version?: string } };

        return body.info?.version ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Read the `iobroker` SDK version out of a built environment.
 *
 * By reading the `.dist-info` directory name rather than running the interpreter: the check must
 * stay read-only and fast, and a venv whose interpreter refuses to start is exactly the situation
 * where knowing the installed version matters most.
 *
 * @param venvDir the environment to look in
 * @returns the version, or null when the package is not installed or the layout is unexpected
 */
async function readSdkVersion(venvDir: string): Promise<string | null> {
    // Windows puts packages in Lib/site-packages, POSIX in lib/python3.x/site-packages -- the
    // minor version is not known here, so the directory is discovered rather than assembled.
    const roots =
        process.platform === 'win32'
            ? [path.join(venvDir, 'Lib', 'site-packages')]
            : await (async () => {
                  const lib = path.join(venvDir, 'lib');

                  try {
                      const entries = await fs.readdir(lib);
                      return entries.map((entry) => path.join(lib, entry, 'site-packages'));
                  } catch {
                      return [];
                  }
              })();

    for (const root of roots) {
        try {
            for (const entry of await fs.readdir(root)) {
                // "iobroker-0.6.0.dist-info"; the name is normalised by the installer, so an exact
                // prefix match is enough and avoids matching "iobroker_something".
                const match = new RegExp(`^${SDK_PACKAGE}-(.+)\\.dist-info$`, 'i').exec(entry);

                if (match) {
                    return match[1];
                }
            }
        } catch {
            // no such directory -- try the next candidate
        }
    }

    return null;
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
    /** Version of the `iobroker` SDK installed in the venv; null when there is none to read */
    sdkVersion: string | null;
    /** What the environment was built for; null when there is no stamp */
    stamp: EnvironmentStamp | null;
    /** Install the package linked to its sources rather than copied */
    editable: boolean;
}

class PyController extends utils.Adapter {
    /** Root of all managed environments: iobroker-data/py/<adapter>/ */
    private envRoot = '';
    /** Path to uv, if found or self-installed */
    private uvPath: string | null = null;
    /** Collects a burst of object changes into a single pass */
    private reconcileTimer: NodeJS.Timeout | null = null;
    /** Guards against a second pass starting while one is still running */
    private reconciling = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'py-controller' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
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
                'uv is unavailable, so environments cannot be built. Either allow this adapter to ' +
                    'download it, install it yourself, or configure the path to an existing copy.',
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

        // Without this, installing a Python adapter did nothing until py-controller happened to be
        // restarted: js-controller refused to start the instance for a missing environment, and
        // nobody was listening for the adapter that had just appeared. A silent dead end.
        await this.subscribeForeignObjectsAsync(`${SYSTEM_ADAPTER_PREFIX}*`);

        await this.setState('info.connection', true, true);
    }

    /**
     * React to an adapter appearing, changing version or becoming a Python adapter
     *
     * @param id the object that changed
     * @param obj its new content, or null when it was deleted
     */
    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (!id.startsWith(SYSTEM_ADAPTER_PREFIX) || !obj) {
            return;
        }

        const common = obj.common as (ioBroker.AdapterCommon & { platform?: string }) | undefined;

        if (common?.platform?.toLowerCase() !== PYTHON_PLATFORM) {
            return;
        }

        this.scheduleReconcile();
    }

    /**
     * Run a reconcile pass shortly, collapsing a burst of changes into one
     *
     * `iobroker add` writes the adapter object and every instance object in quick succession, and
     * restarting an instance writes it twice more. Reacting to each one would rebuild the same
     * environment repeatedly.
     */
    private scheduleReconcile(): void {
        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
        }

        this.reconcileTimer = setTimeout(() => {
            this.reconcileTimer = null;
            void this.reconcileNow();
        }, 2_000);
    }

    /** Discover adapters and bring their environments up to date. */
    private async reconcileNow(): Promise<void> {
        if (this.reconciling) {
            // Building an environment takes seconds, during which more changes arrive. Letting a
            // second pass in would run uv against the same directory twice.
            this.scheduleReconcile();
            return;
        }

        this.reconciling = true;

        try {
            const adapters = await this.discoverPythonAdapters();

            // Everything already current is the normal case here, and saying so on every object
            // change would drown the log.
            if (adapters.some((adapter) => !adapter.ready)) {
                await this.reconcileEnvironments(adapters);
            }
        } catch (e) {
            this.log.error(`Reconcile failed: ${(e as Error).message}`);
        } finally {
            this.reconciling = false;
        }
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
            startkey: SYSTEM_ADAPTER_PREFIX,
            endkey: `${SYSTEM_ADAPTER_PREFIX}香`,
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
        const editable = await this.wantsEditable(dir);

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
                // Switching a working copy in or out has to rebuild: a copied install keeps
                // serving the old sources, an editable one points at a directory that may be gone.
                Boolean(stamp.editable) !== editable ||
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
            editable,
            sdkVersion: exists ? await readSdkVersion(venvDir) : null,
        };
    }

    /**
     * Decide whether an adapter should be installed linked to its sources
     *
     * A copied install serves the copy: editing the adapter's Python sources changes nothing until
     * the package is reinstalled, which turns every edit into a three step cycle. An editable
     * install removes that.
     *
     * It is not the right default for a production installation though -- it ties the environment
     * to a directory that may be deleted, and reinstalling is what makes a version reproducible.
     * So it is decided by how the adapter got there: a symlinked directory is a working copy, the
     * pattern every ioBroker developer already uses. Windows junctions count, which Node reports
     * as symbolic links (verified) -- and those are exactly what `link.bat` creates.
     *
     * The setting overrides the detection in both directions.
     *
     * @param adapterDir directory the adapter is installed in
     */
    private async wantsEditable(adapterDir: string): Promise<boolean> {
        const configured = (this.config as { editableInstall?: string }).editableInstall;

        if (configured === 'always') {
            return true;
        }
        if (configured === 'never') {
            return false;
        }

        try {
            return (await fs.lstat(adapterDir)).isSymbolicLink();
        } catch {
            return false;
        }
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
            editable: info.editable,
            dependencyHash: await this.hashDependencies(info.pythonDir),
            builtAt: new Date().toISOString(),
            pythonVersion,
        };

        await fs.writeFile(path.join(info.envDir, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
    }

    /**
     * Resolves uv: configured path, then PATH, then a copy this adapter fetched earlier, and
     * failing all of those it downloads one.
     *
     * The configured path matters more than it looks. `pip install uv` drops the executable into
     * the user scripts directory, which is frequently not on PATH -- so searching PATH alone finds
     * nothing even though uv is installed.
     *
     * Downloading last rather than first means an installation that already has uv keeps using it,
     * including the version the user chose.
     *
     * @param allowDownload whether uv may be fetched when it is missing; the readiness check passes
     * false, because a check that installs something cannot report what was already there
     */
    private async findUv(allowDownload = true): Promise<string | null> {
        const configured = (this.config as { uvPath?: string }).uvPath?.trim();

        if (configured) {
            try {
                await fs.access(configured);

                if (isExecutableImage(configured)) {
                    return configured;
                }
                this.log.warn(`Configured uv path is not an executable: ${configured}`);
            } catch {
                this.log.warn(`Configured uv path does not exist: ${configured}`);
            }
        }

        const probe = process.platform === 'win32' ? 'where' : 'which';

        try {
            const { stdout } = await run(probe, ['uv']);

            // Every line, and only the ones that are actually an executable image. `where` looks in
            // the *current directory* before PATH and honours PATHEXT, which on Windows contains
            // `.JS` -- so it answered with this adapter's own compiled `build/uv.js`, and spawning
            // that failed with the entirely unhelpful `spawn EFTYPE`.
            for (const line of stdout.split(/\r?\n/)) {
                const candidate = line.trim();

                if (candidate && isExecutableImage(candidate)) {
                    return candidate;
                }
            }
        } catch {
            // not on PATH, which is the normal case on a fresh system
        }

        const managed = managedUvPath(this.envRoot);

        try {
            await fs.access(managed);
            return managed;
        } catch {
            // not fetched yet
        }

        if (!allowDownload || (this.config as { downloadUv?: boolean }).downloadUv === false) {
            return null;
        }

        try {
            return await downloadUv(this.envRoot, (message) => this.log.info(message));
        } catch (e) {
            this.log.error(`Could not obtain uv: ${(e as Error).message}`);
            return null;
        }
    }

    /**
     * Creates an adapter's venv and installs its dependencies.
     *
     * One venv per adapter, not per instance: the isolation is meant to guard
     * against version conflicts between adapters, not between instances of the
     * same adapter.
     *
     * @param info the adapter whose environment to build
     */
    private async buildEnvironment(info: PythonAdapterInfo): Promise<void> {
        if (!this.uvPath) {
            throw new Error('uv is missing -- cannot build the environment');
        }

        // Nothing may be running out of the venv while it is replaced. On Windows an interpreter
        // that is executing holds its own image open, so `uv venv --clear` cannot delete
        // `Scripts\\python.exe` and the whole rebuild fails with "Zugriff verweigert (os error 5)".
        // Elsewhere the removal succeeds and the running process is left with a half-deleted
        // environment, which is worse: it fails later and somewhere else.
        const stopped = await this.stopInstancesOf(info.name);

        try {
            this.log.info(
                `Building environment for ${info.name} ${info.version}${info.editable ? ' (editable, linked to its sources)' : ''} ...`,
            );
            await fs.mkdir(info.envDir, { recursive: true });
            // --clear, because uv refuses to touch an existing environment. A rebuild is meant to
            // replace it: reusing one that was resolved for different dependencies is what this
            // whole stamping mechanism exists to prevent.
            await run(this.uvPath, ['venv', '--clear', info.venvDir]);
            // --refresh, because uv caches the package index: a version published minutes ago is
            // otherwise reported as non-existent.
            const install = ['pip', 'install', '--refresh', '--python', info.interpreter];

            if (info.editable) {
                install.push('-e');
            }

            install.push('.');

            await run(this.uvPath, install, { cwd: info.pythonDir });
            // Only after the install succeeded -- a stamp written earlier would mark a half-built
            // environment as current.
            await this.writeStamp(info);
            this.log.info(`Environment for ${info.name} ${info.version} is ready`);
        } finally {
            // Also after a failed build. Leaving an instance disabled would be this adapter
            // silently changing the user's configuration; js-controller declines to start it while
            // the environment is broken anyway, and says so.
            await this.startInstances(stopped);
        }
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
            } catch (e) {
                this.log.error(`Could not build the environment for ${adapter.name}: ${(e as Error).message}`);
            }
        }
    }

    /**
     * Stop the enabled instances of an adapter so its environment can be replaced
     *
     * Clearing `enabled` is the same mechanism the admin UI uses; js-controller notices the object
     * change and shuts the process down. Waiting for that to happen is the point -- the venv cannot
     * be deleted while an interpreter inside it is running.
     *
     * @param adapterName name of the adapter without the `iobroker.` prefix
     * @returns the instance ids that were enabled, to be handed to {@link startInstances}
     */
    private async stopInstancesOf(adapterName: string): Promise<string[]> {
        const view = await this.getObjectViewAsync('system', 'instance', {
            startkey: `${SYSTEM_ADAPTER_PREFIX}${adapterName}.`,
            endkey: `${SYSTEM_ADAPTER_PREFIX}${adapterName}.香`,
        });
        const stopped: string[] = [];

        for (const row of view?.rows ?? []) {
            const obj = row.value;

            if (!obj?.common?.enabled) {
                continue;
            }

            this.log.info(`Stopping ${obj._id} to rebuild its environment`);
            await this.extendForeignObjectAsync(obj._id, { common: { enabled: false } });
            stopped.push(obj._id);
        }

        await Promise.all(stopped.map((id) => this.waitUntilStopped(id)));

        return stopped;
    }

    /**
     * Wait for an instance's process to be gone
     *
     * @param instanceId full object id, `system.adapter.<name>.<n>`
     */
    private async waitUntilStopped(instanceId: string): Promise<void> {
        const deadline = Date.now() + STOP_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const alive = await this.getForeignStateAsync(`${instanceId}.alive`);

            if (!alive?.val) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
        }

        // Not fatal on its own: the build may still succeed, and if it does not, the error names
        // the real obstacle. Saying so beats a bare permission error further down.
        this.log.warn(`${instanceId} did not stop within ${STOP_TIMEOUT_MS / 1000}s -- rebuilding anyway`);
    }

    /**
     * Re-enable instances that {@link stopInstancesOf} disabled
     *
     * @param instanceIds what that call returned
     */
    private async startInstances(instanceIds: string[]): Promise<void> {
        for (const id of instanceIds) {
            this.log.info(`Starting ${id} again`);
            await this.extendForeignObjectAsync(id, { common: { enabled: true } });
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
            case 'rebuildAll': {
                this.reply(obj, {
                    copyDialog: {
                        title: 'Rebuilt environments',
                        type: 'yaml',
                        text: await this.rebuildAll(),
                    },
                });
                break;
            }
            case 'check': {
                this.reply(obj, {
                    copyDialog: {
                        title: 'Python prerequisites',
                        type: 'yaml',
                        text: (await this.check()).report,
                    },
                });
                break;
            }
            default:
                this.log.warn(`Unknown command: ${obj.command}`);
        }
    }

    /**
     * Rebuild every Python adapter's environment, whether or not it looks current.
     *
     * The one thing an automatic rebuild never does. Environments are replaced only when the
     * adapter itself changes, so a new SDK release reaches nothing on its own -- deliberately,
     * because an installation should not change because a release happened somewhere in the night.
     * This is the other half of that decision: a way to ask for it, at a moment the user chose.
     *
     * Forced, not "only what is stale": an environment that looks current is exactly the one
     * holding an old SDK, and skipping it would make the button do nothing in the case it exists
     * for.
     *
     * @returns a YAML report naming what each environment ended up with
     */
    private async rebuildAll(): Promise<string> {
        const adapters = await this.discoverPythonAdapters();
        const lines = [`# ${new Date().toISOString()}`, 'rebuilt:'];
        const scalar = (text: string): string => `'${text.replace(/'/g, "''")}'`;

        if (!adapters.length) {
            return [...lines, "  - 'no Python adapters installed'"].join('\n');
        }

        for (const adapter of adapters) {
            try {
                await this.buildEnvironment(adapter);
                // Re-read rather than trust the pre-build value: the whole point is which SDK the
                // environment ended up with, and that is only known afterwards.
                const sdk = await readSdkVersion(adapter.venvDir);

                lines.push(`  - ${scalar(`OK   | ${adapter.name} ${adapter.version}${sdk ? `, SDK ${sdk}` : ''}`)}`);
            } catch (e) {
                lines.push(`  - ${scalar(`FAIL | ${adapter.name}: ${(e as Error).message}`)}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Collect everything the readiness check needs, without changing anything.
     *
     * `findUv(false)` on purpose: the check may look for uv but must not fetch it. Otherwise
     * pressing "check" would install something, and the answer to "is uv present?" would always be
     * yes the second time.
     */
    private async check(): Promise<{ ok: boolean; report: string }> {
        const uvPath = await this.findUv(false);
        let uvVersion: string | null = null;

        if (uvPath) {
            try {
                const { stdout } = await run(uvPath, ['--version']);
                uvVersion = stdout.trim();
            } catch (e) {
                this.log.warn(`uv found at ${uvPath} but not runnable: ${(e as Error).message}`);
            }
        }

        const adapters = await this.discoverPythonAdapters();
        // Only worth asking when there is something to compare against. An installation with no
        // built environment learns nothing from the answer and should not pay for the request.
        const latestSdkVersion = adapters.some((adapter) => adapter.sdkVersion) ? await latestSdkOnPypi() : null;

        const outcome = await runCheck({
            envRoot: this.envRoot,
            uvPath,
            uvVersion,
            mayDownloadUv: (this.config as { downloadUv?: boolean }).downloadUv !== false,
            adapters,
            latestSdkVersion,
        });

        this.log[outcome.ok ? 'info' : 'warn'](`Prerequisite check: ${outcome.ok ? 'ok' : 'problems found'}`);

        return outcome;
    }

    private reply(obj: ioBroker.Message, payload: unknown): void {
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, payload, obj.callback);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.reconcileTimer) {
                clearTimeout(this.reconcileTimer);
                this.reconcileTimer = null;
            }
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
