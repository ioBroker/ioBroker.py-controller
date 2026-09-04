/**
 * The readiness check behind the "Check prerequisites" button.
 *
 * Its job is to answer one question -- "can this installation build and run Python adapters?" --
 * before anything is attempted, and to say what is missing in terms the user can act on. It is
 * deliberately **read-only**: it never downloads uv and never builds an environment, because a
 * check that changes the system cannot be run to find out what the system looks like.
 *
 * The report is text rather than a structure, because that is what the user ends up pasting into a
 * forum post when something is wrong.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { UV_VERSION, uvTarget } from './uv.js';

/** How much a failed check matters. */
export type Severity = 'ok' | 'warning' | 'error';

export interface Finding {
    /** Short label, e.g. `uv` */
    subject: string;
    severity: Severity;
    /** What was found */
    detail: string;
    /** What to do about it; only set when something is wrong */
    hint?: string;
}

/** The parts of an adapter description the check needs; the caller's type is richer. */
export interface CheckedAdapter {
    name: string;
    version: string;
    envDir: string;
    interpreter: string;
    ready: boolean;
    stale: boolean;
}

export interface CheckInput {
    /** `<iobroker-data>/py` */
    envRoot: string;
    /** Where uv was found, or null when it is not installed. Located *without* downloading. */
    uvPath: string | null;
    /** Result of `uv --version`, when it could be run */
    uvVersion: string | null;
    /** Whether the adapter is allowed to fetch uv by itself */
    mayDownloadUv: boolean;
    adapters: CheckedAdapter[];
    /** Injected so the check can be exercised without touching the network */
    reachable?: (url: string) => Promise<boolean>;
}

export interface CheckOutcome {
    ok: boolean;
    findings: Finding[];
    report: string;
}

const UV_RELEASES = 'https://github.com/astral-sh/uv/releases';
const PYPI = 'https://pypi.org/simple/';

/**
 * A HEAD request with a short deadline -- a hanging probe is worse than an unknown answer.
 *
 * @param url the endpoint to probe
 */
async function defaultReachable(url: string): Promise<boolean> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 4000);

    try {
        await fetch(url, { method: 'HEAD', signal: abort.signal, redirect: 'follow' });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Can this adapter actually write where the environments go?
 *
 * @param envRoot directory the environments are built in
 */
async function checkEnvRoot(envRoot: string): Promise<Finding> {
    const probe = path.join(envRoot, `.write-probe-${process.pid}`);

    try {
        await fs.mkdir(envRoot, { recursive: true });
        await fs.writeFile(probe, 'probe');
        await fs.rm(probe, { force: true });
        return { subject: 'Environment directory', severity: 'ok', detail: `${envRoot} (writable)` };
    } catch (e) {
        return {
            subject: 'Environment directory',
            severity: 'error',
            detail: `${envRoot} cannot be written: ${(e as Error).message}`,
            hint: 'Every environment is built here. Give the ioBroker user write access to this directory.',
        };
    }
}

/** Is this platform one uv publishes a build for at all? */
async function checkPlatform(): Promise<Finding> {
    const where = `${process.platform}/${process.arch}, Node.js ${process.version}`;

    try {
        return { subject: 'Platform', severity: 'ok', detail: `${where} -- uv target ${await uvTarget()}` };
    } catch (e) {
        return {
            subject: 'Platform',
            severity: 'error',
            detail: `${where}: ${(e as Error).message}`,
            hint: 'uv publishes no build for this platform. Install uv yourself and set its path in the settings, or use a supported platform.',
        };
    }
}

function checkUv(input: CheckInput): Finding {
    if (input.uvPath) {
        return {
            subject: 'uv',
            severity: 'ok',
            detail: `${input.uvVersion || 'installed'} at ${input.uvPath}`,
        };
    }
    if (input.mayDownloadUv) {
        return {
            subject: 'uv',
            severity: 'warning',
            detail: 'not installed yet',
            hint: `It will be downloaded automatically (version ${UV_VERSION}) the first time an environment is built. This needs internet access.`,
        };
    }
    return {
        subject: 'uv',
        severity: 'error',
        detail: 'not installed, and automatic download is switched off',
        hint: 'Either switch "Download uv automatically" back on, or install uv yourself and enter its path in the settings.',
    };
}

function checkAdapters(adapters: CheckedAdapter[]): Finding[] {
    if (!adapters.length) {
        return [
            {
                subject: 'Python adapters',
                severity: 'ok',
                detail: 'none installed -- nothing to build yet',
            },
        ];
    }

    return adapters.map((adapter) => {
        const where = `${adapter.name} ${adapter.version}`;

        if (adapter.ready) {
            return { subject: 'Adapter', severity: 'ok' as Severity, detail: `${where}: environment ready` };
        }
        if (adapter.stale) {
            return {
                subject: 'Adapter',
                severity: 'warning' as Severity,
                detail: `${where}: environment was built for a different version`,
                hint: 'It will be rebuilt; js-controller refuses to start the instance until then.',
            };
        }
        return {
            subject: 'Adapter',
            severity: 'warning' as Severity,
            detail: `${where}: no environment yet (${adapter.envDir})`,
            hint: 'It will be built automatically if that is switched on; otherwise use the rebuild command.',
        };
    });
}

function renderReport(findings: Finding[], ok: boolean): string {
    const lines: string[] = [];
    const worst = findings.some((f) => f.severity === 'error')
        ? 'One or more prerequisites are missing.'
        : findings.some((f) => f.severity === 'warning')
          ? 'Usable, but there is something to know.'
          : 'Everything needed is in place.';

    lines.push(`# ${new Date().toISOString()}`);
    lines.push(`ok: ${ok}`);
    lines.push(`summary: ${worst}`);
    lines.push('');
    lines.push('checks:');

    // Single-quoted YAML scalars, not double-quoted: a Windows path is full of backslashes, and
    // inside double quotes YAML reads those as escape sequences -- "C:\Users\..." is not valid
    // YAML at all. In single quotes a backslash is literal and only the quote itself doubles.
    const scalar = (text: string): string => `'${text.replace(/'/g, "''")}'`;

    for (const finding of findings) {
        const mark = finding.severity === 'ok' ? 'OK  ' : finding.severity === 'warning' ? 'WARN' : 'FAIL';
        lines.push(`  - ${scalar(`${mark} | ${finding.subject}: ${finding.detail}`)}`);
        if (finding.hint) {
            lines.push(`    hint: ${scalar(finding.hint)}`);
        }
    }

    return lines.join('\n');
}

/**
 * Run every prerequisite check and render the report.
 *
 * `ok` is false only for findings that actually stop Python adapters from running. A missing
 * environment is a warning, not a failure: it is the normal state right after installing an
 * adapter and this adapter's whole job is to fix it.
 *
 * @param input everything the check observes, gathered by the caller
 */
export async function runCheck(input: CheckInput): Promise<CheckOutcome> {
    const reachable = input.reachable || defaultReachable;
    const findings: Finding[] = [];

    findings.push(await checkPlatform());
    findings.push(await checkEnvRoot(input.envRoot));
    findings.push(checkUv(input));

    // Only worth asking when something still has to be fetched -- an installation whose
    // environments are all built needs no network, and probing anyway would report a false problem
    // on a deliberately offline box.
    const needsNetwork = !input.uvPath || input.adapters.some((a) => !a.ready);

    if (needsNetwork) {
        const [uvHost, pypi] = await Promise.all([reachable(UV_RELEASES), reachable(PYPI)]);

        findings.push(
            uvHost
                ? { subject: 'Network (uv)', severity: 'ok', detail: `${UV_RELEASES} reachable` }
                : {
                      subject: 'Network (uv)',
                      severity: input.uvPath ? 'warning' : 'error',
                      detail: `${UV_RELEASES} not reachable`,
                      hint: 'uv is downloaded from there. Check the internet connection or a proxy.',
                  },
        );
        findings.push(
            pypi
                ? { subject: 'Network (PyPI)', severity: 'ok', detail: `${PYPI} reachable` }
                : {
                      subject: 'Network (PyPI)',
                      severity: 'error',
                      detail: `${PYPI} not reachable`,
                      hint: 'Adapter dependencies are installed from there. Check the internet connection or a proxy.',
                  },
        );
    } else {
        findings.push({
            subject: 'Network',
            severity: 'ok',
            detail: 'not needed -- uv is present and every environment is built',
        });
    }

    findings.push(...checkAdapters(input.adapters));

    const ok = !findings.some((finding) => finding.severity === 'error');

    return { ok, findings, report: renderReport(findings, ok) };
}
