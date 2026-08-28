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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Marker in io-package.json that identifies a Python adapter. */
const RUNTIME_MARKER = 'python';

interface PythonAdapterInfo {
    /** Adapter name without the "ioBroker." prefix */
    name: string;
    /** Directory of the installed npm package */
    dir: string;
    /** Directory holding pyproject.toml */
    pythonDir: string;
    /** Target directory of the venv */
    venvDir: string;
    /** Interpreter inside the venv */
    interpreter: string;
    /** Is the venv present and usable? */
    ready: boolean;
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
                'uv not found. Without it a sufficiently recent system Python is required -- ' +
                    'on Debian and Raspberry Pi that is regularly not the case.',
            );
        }

        const adapters = await this.discoverPythonAdapters();
        this.log.info(`Found ${adapters.length} Python adapter(s)`);
        for (const adapter of adapters) {
            this.log.info(`  ${adapter.name}: venv ${adapter.ready ? 'ready' : 'missing'}`);
        }

        await this.setState('info.connection', true, true);
    }

    /**
     * Finds installed adapters whose io-package.json carries
     * `common.runtime: "python"`.
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
            const common = row.value?.common as (ioBroker.InstanceCommon & { runtime?: string }) | undefined;
            if (!common || common.runtime !== RUNTIME_MARKER) {
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
        const venvDir = path.join(this.envRoot, name, 'venv');
        const interpreter = path.join(
            venvDir,
            process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
        );
        let ready = false;
        try {
            await fs.access(interpreter);
            ready = true;
        } catch {
            ready = false;
        }
        return { name, dir, pythonDir: path.join(dir, 'python'), venvDir, interpreter, ready };
    }

    /** Looks for uv on PATH. Later: download it on demand. */
    private async findUv(): Promise<string | null> {
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
        this.log.info(`Building environment for ${info.name} ...`);
        await fs.mkdir(path.dirname(info.venvDir), { recursive: true });
        await run(this.uvPath, ['venv', info.venvDir]);
        await run(this.uvPath, ['pip', 'install', '--python', info.interpreter, '.'], {
            cwd: info.pythonDir,
        });
        this.log.info(`Environment for ${info.name} is ready`);
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

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new PyController(options);
} else {
    (() => new PyController())();
}
