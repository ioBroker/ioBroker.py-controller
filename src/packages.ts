/**
 * Reading the extra packages a user asked for in an instance's `native.userPackages`.
 *
 * Its own module because this is the one place where text a user typed becomes arguments to a
 * package installer. Kept free of adapter-core so it can be tested for exactly that.
 */

/**
 * A package specification this adapter will install.
 *
 * A name, optional extras, and optional version constraints -- `requests`, `httpx[http2]`,
 * `numpy>=1.26,<2`. Deliberately not URLs, paths or VCS references: a settings field that can point
 * the installation at any git repository is a much larger door than "my scripts need requests"
 * needs, and someone who genuinely wants that can put it in their adapter's own pyproject.toml
 * where it is reviewable. Anything else is refused and named rather than passed along, because an
 * entry beginning with a dash would otherwise reach the installer as an option.
 */
export const PACKAGE_SPEC =
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?(?:\s*(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9._*+!-]+(?:\s*,\s*(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9._*+!-]+)*)?$/;

export interface ReadPackages {
    /** The accepted specifications, sorted and without duplicates */
    packages: string[];
    /** Entries that are not package specifications, in the order they were written */
    refused: string[];
}

/**
 * Turn whatever is in the settings into a list this adapter is willing to install.
 *
 * Sorted and de-duplicated, because the result is compared against the environment's stamp to
 * decide whether a rebuild is needed: reordering two entries, or typing one of them twice, is not a
 * reason to stop an adapter and reinstall.
 *
 * @param raw the value of `native.userPackages`; a user can put anything there, including a string
 * with newlines or commas, which is what an older settings field or a hand-edited object yields
 */
export function readPackages(raw: unknown): ReadPackages {
    const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : [];
    const packages = new Set<string>();
    const refused: string[] = [];

    for (const entry of entries) {
        const spec = String(entry ?? '').trim();

        if (!spec) {
            continue;
        }
        if (PACKAGE_SPEC.test(spec)) {
            packages.add(spec);
        } else {
            refused.push(spec);
        }
    }

    return { packages: [...packages].sort(), refused };
}
