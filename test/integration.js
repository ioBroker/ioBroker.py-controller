/**
 * Integration tests.
 *
 * A real js-controller is installed into a temporary directory, this adapter is installed into it
 * and started. That covers what unit tests cannot: that the adapter survives its own startup
 * against a real controller and answers on the messagebox.
 *
 * The `check` command is the interesting one to exercise here, because it is the piece a user
 * reaches for when something is wrong -- if it throws, it does so exactly when it is needed most.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import testing from '@iobroker/testing';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

testing.tests.integration(root, {
    defineAdditionalTests({ suite }) {
        suite('the readiness check', getHarness => {
            /** Ask the running adapter for a diagnosis. */
            const check = harness =>
                new Promise(resolve => harness.sendTo('py-controller.0', 'check', null, resolve));

            it('answers with rows for the settings page', async function () {
                this.timeout(120_000);
                const harness = getHarness();

                await harness.startAdapterAndWait();

                const response = await check(harness);

                // The button writes these two straight into the form, where a text field and a
                // table are bound to them. Both start with an underscore, which is what keeps a
                // diagnosis out of the saved configuration.
                assert.ok(response, 'the check returned nothing');
                assert.ok(response.native, 'the check must answer with native values');
                assert.equal(typeof response.native._diagnosedAt, 'string');
                assert.ok(Array.isArray(response.native._diagnosis), '_diagnosis must be a list of rows');
                assert.ok(response.native._diagnosis.length, 'the diagnosis is empty');

                for (const row of response.native._diagnosis) {
                    assert.equal(typeof row.ok, 'boolean', 'every row needs its checkbox');
                    assert.ok(['ok', 'warning', 'error'].includes(row.severity), `unknown severity ${row.severity}`);
                    assert.equal(typeof row.subject, 'string');
                    assert.equal(typeof row.detail, 'string');
                    assert.equal(typeof row.hint, 'string');
                }

                // Every check the diagnosis knows about should appear, whatever its outcome.
                const subjects = response.native._diagnosis.map(row => row.subject);
                for (const subject of ['Platform', 'Environment directory', 'uv']) {
                    assert.ok(subjects.includes(subject), `the diagnosis does not mention ${subject}`);
                }
            });

            it('does not install uv as a side effect', async function () {
                this.timeout(120_000);
                const harness = getHarness();

                await harness.startAdapterAndWait();

                // Running the check twice must say the same thing about uv. If checking were to
                // fetch uv, the second run would report it as present and the check would be
                // useless for finding out what a machine actually has.
                const uvRow = response => response.native._diagnosis.find(row => row.subject === 'uv');

                const first = uvRow(await check(harness));
                const second = uvRow(await check(harness));

                assert.deepEqual(second, first, 'the check changed what it was checking');
            });
        });
    },
});
