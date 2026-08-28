/**
 * ioBroker.py-controller
 *
 * Verwaltet Python-*Umgebungen* -- nicht Python-*Prozesse*.
 *
 * Die Prozesshoheit bleibt beim js-controller: er startet, ueberwacht und
 * stoppt Python-Adapter genauso wie Node-Adapter. Der Stopp-Weg ueber den
 * `sigKill`-State, die `alive`/`uptime`-Telemetrie und die Neustart-Logik sind
 * bereits sprachneutral; es fehlt dort nur der Zweig, der statt `node` einen
 * Interpreter aus dem venv startet.
 *
 * Dieser Adapter uebernimmt das, was im Kern nichts zu suchen hat: Interpreter
 * beschaffen, venv je Adapter anlegen und reparieren, Pakete installieren,
 * Zustand in der Admin anzeigen.
 *
 * Der Vertrag zwischen beiden hat genau eine Richtung:
 *
 *   js-controller startet eine Python-Instanz nur, wenn ihr venv existiert und
 *   zur geforderten Paketversion passt. Fehlt oder hinkt es, wird nicht
 *   gestartet, sondern ein Fehlerzustand gesetzt. Dieser Adapter beobachtet den
 *   Zustand, baut die Umgebung und stoesst den Neustart an.
 *
 * Damit muss der Kern nichts ueber pip, uv oder Paketaufloesung wissen --
 * nur, ob ein Verzeichnis da ist.
 */

import * as utils from '@iobroker/adapter-core';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Marker im io-package.json, an dem ein Python-Adapter erkannt wird. */
const RUNTIME_MARKER = 'python';

interface PythonAdapterInfo {
    /** Adaptername ohne "ioBroker."-Praefix */
    name: string;
    /** Verzeichnis des installierten npm-Pakets */
    dir: string;
    /** Verzeichnis mit pyproject.toml */
    pythonDir: string;
    /** Zielverzeichnis des venv */
    venvDir: string;
    /** Interpreter im venv */
    interpreter: string;
    /** venv vorhanden und benutzbar? */
    ready: boolean;
}

class PyController extends utils.Adapter {
    /** Wurzel aller verwalteten Umgebungen: iobroker-data/py/<adapter>/ */
    private envRoot = '';
    /** Pfad zu uv, sofern gefunden oder selbst installiert */
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
            this.log.info(`uv gefunden: ${this.uvPath}`);
        } else {
            this.log.warn(
                'uv nicht gefunden. Ohne uv muss ein ausreichend neues System-Python vorhanden sein -- ' +
                    'auf Debian und Raspberry ist das regelmaessig nicht der Fall.',
            );
        }

        const adapters = await this.discoverPythonAdapters();
        this.log.info(`${adapters.length} Python-Adapter gefunden`);
        for (const adapter of adapters) {
            this.log.info(`  ${adapter.name}: venv ${adapter.ready ? 'bereit' : 'fehlt'}`);
        }

        await this.setState('info.connection', true, true);
    }

    /**
     * Sucht installierte Adapter, deren io-package.json `common.runtime: "python"` traegt.
     *
     * Python-Adapter werden weiterhin als npm-Paket ausgeliefert -- damit
     * funktionieren Repository, Repo-Checker, `iobroker add`, Admin-Update und
     * Backup unveraendert. Nur der Startpfad ist ein anderer.
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
            if (!common || (common as { runtime?: string }).runtime !== RUNTIME_MARKER) {
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
        const dir = utils.getAbsoluteDefaultDataDir
            ? path.join(utils.controllerDir, 'node_modules', `iobroker.${name}`)
            : '';
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

    /** Sucht uv im PATH. Spaeter: bei Bedarf selbst herunterladen. */
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
     * Legt das venv eines Adapters an und installiert seine Abhaengigkeiten.
     *
     * Ein venv je Adapter, nicht je Instanz: die Isolation soll gegen
     * Versionskonflikte zwischen Adaptern schuetzen, nicht zwischen Instanzen
     * desselben Adapters.
     */
    private async buildEnvironment(info: PythonAdapterInfo): Promise<void> {
        if (!this.uvPath) {
            throw new Error('uv fehlt -- Umgebung kann nicht gebaut werden');
        }
        this.log.info(`Baue Umgebung fuer ${info.name} ...`);
        await fs.mkdir(path.dirname(info.venvDir), { recursive: true });
        await run(this.uvPath, ['venv', info.venvDir]);
        await run(this.uvPath, ['pip', 'install', '--python', info.interpreter, '.'], {
            cwd: info.pythonDir,
        });
        this.log.info(`Umgebung fuer ${info.name} steht`);
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
                    this.reply(obj, { error: 'Kein Adaptername angegeben' });
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
                this.log.warn(`Unbekanntes Kommando: ${obj.command}`);
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
