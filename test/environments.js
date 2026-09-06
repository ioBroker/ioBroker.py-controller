/**
 * Unit tests for the one decision in this adapter that deletes something.
 *
 * Runs against the built output, so what is tested is what ships. A virtual environment is a few
 * hundred megabytes and minutes of downloading; the cost of the wrong answer here is not symmetric,
 * which is why the rule is pinned rather than left to reading.
 */

import assert from 'node:assert/strict';

import { pruneDecision } from '../build/environments.js';

describe('pruning environments', () => {
    it('keeps the environment of an installed adapter', () => {
        assert.equal(pruneDecision({ installed: true, stamped: true, venv: true }), 'keep');
    });

    it('keeps it even when the adapter has no instance yet', () => {
        // "Installed" is decided by the adapter's directory, not by an instance object. Between
        // `iobroker add` and configuring it there is a window with an environment and no instance,
        // and deleting there would undo the build that had just finished.
        assert.equal(pruneDecision({ installed: true, stamped: false, venv: true }), 'keep');
    });

    it('keeps a half-built environment while the adapter is there', () => {
        // A build interrupted by a restart leaves a directory with neither stamp nor venv. It is
        // rebuilt on the next pass; it is not rubbish to clear away.
        assert.equal(pruneDecision({ installed: true, stamped: false, venv: false }), 'keep');
    });

    it('removes what an uninstalled adapter left behind', () => {
        assert.equal(pruneDecision({ installed: false, stamped: true, venv: true }), 'remove');
    });

    it('removes it on either sign of ours, not only on both', () => {
        // A build that failed after the stamp but before the venv, or a stamp lost to a crash. One
        // is enough: both are directories this adapter created and nothing else will clean up.
        assert.equal(pruneDecision({ installed: false, stamped: true, venv: false }), 'remove');
        assert.equal(pruneDecision({ installed: false, stamped: false, venv: true }), 'remove');
    });

    it('leaves a directory that is not ours', () => {
        // Somebody's backup, a hand-built venv, a leftover from an older layout. The adapter being
        // gone is the reason to delete; this is the check that the directory is what that reason
        // applies to.
        assert.equal(pruneDecision({ installed: false, stamped: false, venv: false }), 'foreign');
    });
});
