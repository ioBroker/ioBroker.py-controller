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
            it('answers with a report', async function () {
                this.timeout(120_000);
                const harness = getHarness();

                await harness.startAdapterAndWait();

                const response = await new Promise(resolve =>
                    harness.sendTo('py-controller.0', 'check', null, resolve),
                );

                // The button feeds this straight into admin's copy dialog.
                assert.ok(response, 'the check returned nothing');
                assert.ok(response.copyDialog, 'the check must answer with a copyDialog');
                assert.equal(typeof response.copyDialog.text, 'string');
                assert.match(
                    response.copyDialog.text,
                    /^ok: (true|false)$/m,
                    'the report must state whether the installation is usable',
                );
                // Every check the report knows about should appear, whatever their outcome.
                for (const subject of ['Platform', 'Environment directory', 'uv']) {
                    assert.ok(
                        response.copyDialog.text.includes(subject),
                        `the report does not mention ${subject}`,
                    );
                }
            });

            it('does not install uv as a side effect', async function () {
                this.timeout(120_000);
                const harness = getHarness();

                await harness.startAdapterAndWait();

                // Running the check twice must give the same answer about uv. If checking were to
                // fetch uv, the second run would report it as present and the check would be
                // useless for finding out what a machine actually has.
                const ask = () =>
                    new Promise(resolve => harness.sendTo('py-controller.0', 'check', null, resolve));

                const first = (await ask()).copyDialog.text;
                const second = (await ask()).copyDialog.text;

                const uvLine = report => report.split('\n').find(line => line.includes('| uv:'));

                assert.equal(uvLine(second), uvLine(first), 'the check changed what it was checking');
            });
        });
    },
});
