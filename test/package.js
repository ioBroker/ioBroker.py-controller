/**
 * Package tests.
 *
 * Checks that package.json and io-package.json agree and satisfy the ioBroker schema -- the class
 * of mistake that is invisible in development and only surfaces when the adapter is published or
 * installed somewhere else.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import testing from '@iobroker/testing';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

testing.tests.packageFiles(root);
