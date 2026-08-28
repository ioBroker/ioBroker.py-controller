/**
 * Obtaining `uv`.
 *
 * `uv` is what actually creates the virtual environments, and on an ordinary user system it is not
 * installed. Warning about that would make this adapter useless for exactly the people it is meant
 * for, so it fetches a copy itself into `iobroker-data/py/.bin/`.
 *
 * Downloaded from the GitHub release rather than by piping the vendor's install script into a
 * shell: the version is pinned, the checksum is verified, and the binary lands where this adapter
 * can manage it instead of in the user's `~/.local/bin`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Pinned uv version.
 *
 * Deliberately not "latest": an environment should not change because a release happened somewhere
 * else in the night. Raising this is a normal, reviewable change.
 */
export const UV_VERSION = '0.12.7';

const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

/** Where a self-fetched uv is kept, below the environment root. */
export const UV_DIR = '.bin';

/**
 * Determine the release asset for this machine
 *
 * @returns the target triple uv publishes under
 * @throws if the platform and architecture combination has no release
 */
export async function uvTarget(): Promise<string> {
    const arch = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7' }[process.arch as string];

    if (!arch) {
        throw new Error(`No uv release for architecture "${process.arch}"`);
    }

    switch (process.platform) {
        case 'win32':
            return `${arch}-pc-windows-msvc`;
        case 'darwin':
            return `${arch}-apple-darwin`;
        case 'linux': {
            // Alpine and other musl systems need a different build; a glibc binary there fails with
            // a linker error that says nothing about the actual cause.
            const suffix = (await isMusl()) ? 'musl' : 'gnu';
            return arch === 'armv7' ? `armv7-unknown-linux-${suffix}eabihf` : `${arch}-unknown-linux-${suffix}`;
        }
        default:
            throw new Error(`No uv release for platform "${process.platform}"`);
    }
}

/**
 * Detect a musl based Linux
 *
 * `ldd --version` writes its musl banner to stderr and exits non-zero, so both streams are examined
 * and a failure is not treated as an error.
 */
async function isMusl(): Promise<boolean> {
    try {
        await fs.access('/lib/ld-musl-x86_64.so.1');
        return true;
    } catch {
        // not the only possible name, so fall through to ldd
    }

    try {
        const { stdout, stderr } = await run('ldd', ['--version']);
        return `${stdout}${stderr}`.toLowerCase().includes('musl');
    } catch (e) {
        const out = `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`;
        return out.toLowerCase().includes('musl');
    }
}

/** Path the managed uv binary ends up at */
export function managedUvPath(envRoot: string): string {
    return path.join(envRoot, UV_DIR, process.platform === 'win32' ? 'uv.exe' : 'uv');
}

/**
 * Fetch uv into the environment root
 *
 * @param envRoot root of all managed environments, i.e. `iobroker-data/py`
 * @param log where to report progress; downloading takes a moment and silence looks like a hang
 * @returns absolute path to the usable binary
 */
export async function downloadUv(envRoot: string, log: (message: string) => void): Promise<string> {
    const target = await uvTarget();
    const archive = process.platform === 'win32' ? `uv-${target}.zip` : `uv-${target}.tar.gz`;
    const binDir = path.join(envRoot, UV_DIR);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iob-uv-'));

    try {
        log(`Downloading uv ${UV_VERSION} for ${target}`);
        const data = await fetchBuffer(`${RELEASE_BASE}/${archive}`);

        const expected = (await fetchText(`${RELEASE_BASE}/${archive}.sha256`)).trim().split(/\s+/)[0];
        const actual = createHash('sha256').update(data).digest('hex');

        if (expected !== actual) {
            throw new Error(`Checksum mismatch for ${archive}: expected ${expected}, got ${actual}`);
        }

        const archivePath = path.join(tmpDir, archive);
        await fs.writeFile(archivePath, data);
        await extract(archivePath, tmpDir);

        // Both archives put the binary inside a directory named after the target.
        const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
        const extracted = await findBinary(tmpDir, name);

        await fs.mkdir(binDir, { recursive: true });
        const destination = managedUvPath(envRoot);
        await fs.copyFile(extracted, destination);

        if (process.platform !== 'win32') {
            await fs.chmod(destination, 0o755);
        }

        const { stdout } = await run(destination, ['--version']);
        log(`uv ready: ${stdout.trim()}`);

        return destination;
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Unpack the downloaded archive
 *
 * `tar` is present on every supported Unix. Windows has no unzip, so PowerShell does it -- Node
 * itself cannot read zip files.
 *
 * @param archivePath the downloaded file
 * @param intoDir directory to unpack into
 */
async function extract(archivePath: string, intoDir: string): Promise<void> {
    if (process.platform === 'win32') {
        await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${intoDir}' -Force`,
        ]);
    } else {
        await run('tar', ['-xzf', archivePath, '-C', intoDir]);
    }
}

/**
 * Locate the extracted binary, one directory level down
 *
 * @param root directory the archive was unpacked into
 * @param name file name to look for
 */
async function findBinary(root: string, name: string): Promise<string> {
    const direct = path.join(root, name);

    try {
        await fs.access(direct);
        return direct;
    } catch {
        // usually nested in a directory named after the target
    }

    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const candidate = path.join(root, entry.name, name);
            try {
                await fs.access(candidate);
                return candidate;
            } catch {
                // keep looking
            }
        }
    }

    throw new Error(`"${name}" not found in the downloaded archive`);
}

/**
 * Download a URL, following the redirect GitHub release assets always issue
 *
 * @param url what to fetch
 */
async function fetchBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

/**
 * Download a URL as text
 *
 * @param url what to fetch
 */
async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    return response.text();
}
