import react from '@vitejs/plugin-react';
import commonjs from 'vite-plugin-commonjs';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/gui-components/modulefederation.admin.config';
import { readFileSync } from 'node:fs';

const config = {
    plugins: [
        federation({
            manifest: true,
            // Must be unique across every adapter that ships a custom component, and must match the
            // first segment of `name` in admin/jsonConfig.json -- two sets sharing this name collide
            // at runtime, because the admin registers them in one federation scope.
            name: 'PyControllerComponentSet',
            filename: 'customComponents.js',
            exposes: {
                './Components': './src/Components.tsx',
            },
            remotes: {},
            // React, MUI and the ioBroker component libraries come from the admin as singletons.
            // Bundling our own copies would give the component a second React and a second I18n
            // dictionary, which fails while rendering rather than at build time.
            shared: moduleFederationShared(JSON.parse(readFileSync('./package.json').toString())),
        }),
        react(),
        commonjs(),
    ],
    resolve: {
        tsconfigPaths: true,
    },
    server: {
        port: 3000,
    },
    base: './',
    build: {
        target: 'chrome89',
        outDir: './build',
    },
};

export default config;
