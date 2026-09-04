/**
 * Unit tests for the readiness check.
 *
 * Runs against the built output, so what is tested is what ships. The network probe is injected,
 * which is the point of it being injectable: these tests must not depend on the machine having
 * internet, and they must be able to assert the *offline* case at all.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { runCheck } from '../build/check.js';

const writable = path.join(os.tmpdir(), 'py-controller-check-test');
const online = async () => true;
const offline = async () => false;

const adapter = (over = {}) => ({
    name: 'python',
    version: '0.0.1',
    envDir: path.join(writable, 'python'),
    interpreter: path.join(writable, 'python', 'venv', 'bin', 'python'),
    ready: true,
    stale: false,
    ...over,
});

const base = {
    envRoot: writable,
    uvPath: '/usr/local/bin/uv',
    uvVersion: 'uv 0.12.7',
    mayDownloadUv: true,
    adapters: [],
    reachable: online,
};

/** The finding for one subject, e.g. `uv`. */
const findingFor = (outcome, subject) => outcome.findings.find(f => f.subject === subject);

describe('readiness check', () => {
    it('passes on a healthy installation', async () => {
        const outcome = await runCheck({ ...base, adapters: [adapter()] });

        assert.equal(outcome.ok, true);
        assert.equal(findingFor(outcome, 'uv').severity, 'ok');
    });

    it('does not touch the network when there is nothing to fetch', async () => {
        let probed = false;

        const outcome = await runCheck({
            ...base,
            adapters: [adapter()],
            reachable: async () => {
                probed = true;
                return true;
            },
        });

        // A box that is deliberately offline but fully set up must not be told it has a problem.
        assert.equal(probed, false, 'the check probed the network although nothing had to be fetched');
        assert.equal(findingFor(outcome, 'Network').severity, 'ok');
    });

    it('probes the network as soon as something is missing', async () => {
        const probed = [];

        await runCheck({
            ...base,
            uvPath: null,
            uvVersion: null,
            reachable: async url => {
                probed.push(url);
                return true;
            },
        });

        assert.equal(probed.length, 2, 'both the uv host and PyPI should be probed');
    });

    it('treats a missing environment as a warning, not a failure', async () => {
        // This is the normal state right after installing a Python adapter, and building it is
        // exactly this adapter's job -- reporting it as broken would be wrong.
        const outcome = await runCheck({ ...base, adapters: [adapter({ ready: false })] });

        assert.equal(outcome.ok, true);
        assert.equal(findingFor(outcome, 'Adapter').severity, 'warning');
    });

    it('reports a stale environment', async () => {
        const outcome = await runCheck({
            ...base,
            adapters: [adapter({ ready: false, stale: true })],
        });

        assert.match(findingFor(outcome, 'Adapter').detail, /different version/);
    });

    it('fails when uv is absent and may not be downloaded', async () => {
        const outcome = await runCheck({
            ...base,
            uvPath: null,
            uvVersion: null,
            mayDownloadUv: false,
        });

        assert.equal(outcome.ok, false);
        assert.equal(findingFor(outcome, 'uv').severity, 'error');
        assert.ok(findingFor(outcome, 'uv').hint, 'a failing check must say what to do about it');
    });

    it('only warns about a missing uv while it may still be downloaded', async () => {
        const outcome = await runCheck({ ...base, uvPath: null, uvVersion: null });

        assert.equal(outcome.ok, true);
        assert.equal(findingFor(outcome, 'uv').severity, 'warning');
    });

    it('fails when the environment directory cannot be written', async () => {
        const outcome = await runCheck({
            ...base,
            envRoot: process.platform === 'win32' ? 'Z:\\nope\\py' : '/proc/nope/py',
        });

        assert.equal(outcome.ok, false);
        assert.equal(findingFor(outcome, 'Environment directory').severity, 'error');
    });

    it('fails when the machine is offline and uv still has to be fetched', async () => {
        const outcome = await runCheck({
            ...base,
            uvPath: null,
            uvVersion: null,
            reachable: offline,
        });

        assert.equal(outcome.ok, false);
    });

    describe('the report', () => {
        it('states the verdict and lists every check', async () => {
            const outcome = await runCheck({ ...base, adapters: [adapter()] });

            assert.match(outcome.report, /^ok: true$/m);
            for (const finding of outcome.findings) {
                assert.ok(
                    outcome.report.includes(finding.subject),
                    `the report omits ${finding.subject}`,
                );
            }
        });

        it('survives Windows paths and apostrophes', async () => {
            // The report is handed to admin as YAML. A backslash path inside a double-quoted YAML
            // scalar is not valid YAML at all -- "C:\Users\..." reads as escape sequences -- so the
            // report uses single quotes, where a backslash is literal and a quote doubles.
            const outcome = await runCheck({
                ...base,
                uvPath: 'C:\\Users\\Someone\\tools\\uv.exe',
                uvVersion: "uv 0.12.7 it's fine",
            });

            const line = outcome.report.split('\n').find(l => l.includes('| uv:'));

            assert.ok(line.startsWith("  - '"), 'scalars must be single-quoted');
            assert.ok(line.includes('C:\\Users\\Someone\\tools\\uv.exe'), 'the path was mangled');
            assert.ok(line.includes("it''s fine"), 'the apostrophe must be doubled for YAML');
        });
    });
});
