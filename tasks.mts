/**
 * Build the custom admin component and put it where the admin loads it from.
 *
 * The component is a module federation bundle: the admin fetches `customComponents.js` from
 * `/adapter/py-controller/custom/`, reads `mf-manifest.json` beside it to decide whether the build
 * targets a GUI API generation it can host, and only then registers the remote.
 *
 * `npm run build` runs this after the adapter's own `tsc`, and it is the far slower half: it
 * installs a second node_modules tree and bundles React. Use `npm run build:gui` to rebuild only
 * the component, or the numbered steps below (`gui-0-clean` .. `gui-3-copy`) to repeat one stage.
 */
import { deleteFoldersRecursive, npmInstall, buildReact, copyFiles } from '@iobroker/build-tools';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This package is ESM, so there is no `__dirname` to fall back on.
const here = dirname(fileURLToPath(import.meta.url));
const src = `${here}/src-admin/`;

function clean(): void {
    // Everything else in admin/ is hand-written and stays: the schema, the icon, the translations.
    deleteFoldersRecursive(`${here}/admin/custom`);
    deleteFoldersRecursive(`${src}build`);
}

function copyAllFiles(): void {
    // vite emits `customComponents.js` as a stub that imports the real code from `assets/`, and
    // `mf-manifest.json` addresses every chunk the same way, so that folder has to keep its name
    // and its place beside them -- including the shared-module fallbacks, which are large but only
    // ever fetched if the admin does not provide the singleton itself.
    copyFiles(['src-admin/build/assets/*'], 'admin/custom/assets');
    copyFiles(['src-admin/build/customComponents.js'], 'admin/custom');
    // The admin reads this manifest to see which component library the build was made against, and
    // refuses to start the component if it targets an older GUI API generation.
    copyFiles(['src-admin/build/mf-manifest.json'], 'admin/custom');
    copyFiles(['src-admin/src/i18n/*.json'], 'admin/custom/i18n');
}

if (process.argv.includes('--0-clean')) {
    clean();
} else if (process.argv.includes('--1-npm')) {
    npmInstall(src).catch((e: unknown) => console.error(`Cannot install npm: ${e as Error}`));
} else if (process.argv.includes('--2-build')) {
    buildReact(src, { vite: true }).catch((e: unknown) => console.error(`Cannot build: ${e as Error}`));
} else if (process.argv.includes('--3-copy')) {
    copyAllFiles();
} else {
    clean();
    npmInstall(src)
        .then(() => buildReact(src, { vite: true }))
        .then(() => copyAllFiles())
        .catch((e: unknown) => {
            console.error(e);
            process.exit(2);
        });
}
