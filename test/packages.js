/**
 * Unit tests for reading `native.userPackages`.
 *
 * Runs against the built output, so what is tested is what ships. This is the one place where text
 * a user typed becomes arguments to a package installer, which is why it is tested on its own
 * rather than only through the adapter.
 */

import assert from 'node:assert/strict';

import { readPackages } from '../build/packages.js';

describe('user packages', () => {
    it('accepts a plain name', () => {
        assert.deepEqual(readPackages(['requests']).packages, ['requests']);
    });

    it('accepts extras and version constraints', () => {
        const { packages, refused } = readPackages([
            'httpx[http2]',
            'numpy>=1.26',
            'pandas>=2.0,<3',
            'zeroconf==0.132.2',
            'ruamel.yaml',
            'typing-extensions!=4.7.0',
        ]);

        assert.deepEqual(refused, []);
        assert.equal(packages.length, 6);
    });

    it('sorts and de-duplicates', () => {
        // The list is compared against the environment's stamp: reordering or repeating an entry
        // must not look like a change, or saving the settings would reinstall for nothing.
        const { packages } = readPackages(['requests', 'numpy', 'requests', ' numpy ']);

        assert.deepEqual(packages, ['numpy', 'requests']);
    });

    it('ignores empty entries', () => {
        assert.deepEqual(readPackages(['requests', '', '   ']).packages, ['requests']);
    });

    it('reads a string as a list', () => {
        // A hand-edited object, or an older settings field, yields one string rather than an array.
        assert.deepEqual(readPackages('requests, numpy\nhttpx').packages, ['httpx', 'numpy', 'requests']);
    });

    it('survives a value that is neither', () => {
        assert.deepEqual(readPackages(undefined).packages, []);
        assert.deepEqual(readPackages(null).packages, []);
        assert.deepEqual(readPackages(42).packages, []);
    });

    describe('what it refuses', () => {
        const refuses = (spec, why) => {
            const { packages, refused } = readPackages([spec]);

            assert.deepEqual(packages, [], why);
            assert.deepEqual(refused, [spec], why);
        };

        it('an installer option', () => {
            // The reason this validation exists: these would reach the installer as flags, not as
            // packages, and change where the installation gets its code from.
            refuses('--index-url', 'a bare option');
            refuses('--index-url https://example.invalid/simple', 'an option with a value');
            refuses('-r requirements.txt', 'a short option');
        });

        it('a URL or a repository', () => {
            refuses('git+https://github.com/someone/something', 'a VCS reference');
            refuses('https://example.invalid/pkg.tar.gz', 'a direct download');
            refuses('requests @ https://example.invalid/requests.whl', 'PEP 508 direct reference');
        });

        it('a path', () => {
            refuses('./local-package', 'a relative path');
            refuses('/etc/passwd', 'an absolute path');
            refuses('C:\\Windows\\System32', 'a Windows path');
        });

        it('shell punctuation', () => {
            // Nothing here runs through a shell -- execFile takes an argument list -- but a name
            // that cannot be a package name is a mistake worth reporting either way.
            refuses('requests; rm -rf /', 'a command separator');
            refuses('requests && echo', 'a chain');
            refuses('$(whoami)', 'a substitution');
        });

        it('keeps the good entries beside the bad ones', () => {
            const { packages, refused } = readPackages(['requests', '--index-url http://evil', 'numpy']);

            assert.deepEqual(packages, ['numpy', 'requests'], 'one bad entry must not lose the rest');
            assert.deepEqual(refused, ['--index-url http://evil']);
        });
    });
});
