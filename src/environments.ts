/**
 * Deciding what to do with a directory under the environment root.
 *
 * On its own, and tested on its own, because this is the one place in this adapter that deletes
 * something a user cannot get back cheaply. A virtual environment is a few hundred megabytes and
 * minutes of downloading; removing one that is still in use turns a working installation into an
 * adapter that will not start until it is rebuilt.
 *
 * The decision is kept apart from the filesystem work so that the rule can be stated and checked
 * without a directory tree to set up: what the caller supplies is three answers, and what comes
 * back is which of the three things to do.
 */

/** What to do with one directory under the environment root. */
export type PruneDecision =
    /** The adapter is still installed. Leave it alone. */
    | 'keep'
    /** The adapter is gone and this is an environment we built. Remove it. */
    | 'remove'
    /** The adapter is gone but this is not one of ours. Leave it, and say so. */
    | 'foreign';

/** What is known about one directory under the environment root. */
export interface EnvironmentFacts {
    /**
     * The adapter this directory is named after is installed on this host.
     *
     * Installed, not "has an instance". An adapter that has been added but not yet configured has
     * no instance object and would otherwise lose the environment that was just built for it.
     */
    installed: boolean;
    /** The directory carries the stamp file this adapter writes. */
    stamped: boolean;
    /** The directory carries a `venv` directory. */
    venv: boolean;
}

/**
 * Decide what to do with one directory under the environment root.
 *
 * Two conditions have to hold before anything is deleted, and they answer different questions.
 * "Is the adapter gone" is the reason to delete; "does this look like ours" is the check that the
 * directory is the thing that reason applies to. A user who put something else under the
 * environment root -- a backup, a hand-built venv, a directory left by an older layout -- keeps it.
 *
 * @param facts what is known about the directory
 * @returns which of the three things to do with it
 */
export function pruneDecision(facts: EnvironmentFacts): PruneDecision {
    if (facts.installed) {
        return 'keep';
    }

    if (!facts.stamped && !facts.venv) {
        return 'foreign';
    }

    return 'remove';
}

/** Where an adapter's environment is built and what it is built from. */
export interface VenvTarget {
    /** The venv directory to create, `<envRoot>/<adapter>/venv` */
    venvDir: string;
    /** The adapter's `python/` directory, which holds its `pyproject.toml` */
    pythonDir: string;
}

/**
 * The `uv venv` invocation that creates an adapter's environment.
 *
 * Small enough to look pointless, and it is here for the one thing that is not obvious: the
 * working directory. uv reads `requires-python` from a `pyproject.toml` in the directory it runs
 * in, and nowhere else -- so running it anywhere but the adapter's `python/` directory silently
 * drops the adapter's own Python requirement. Measured with a project requiring `>=3.10,<3.11`
 * on a host that has 3.10 and 3.13:
 *
 *     cwd = the project      ->  Using CPython 3.10.0
 *     cwd = anywhere else    ->  Using CPython 3.13.7
 *
 * The consequence is not a wrong version but a confusing failure: on a host whose first Python is
 * older than the adapter needs, the venv is built around that one and the install afterwards ends
 * in a resolution error naming `requires-python`, instead of uv fetching an interpreter that fits
 * -- which it does by default when it cannot find one.
 *
 * `--clear` is here because uv refuses to touch an existing environment, and a rebuild is meant
 * to replace it: reusing one resolved for different dependencies is what the stamping mechanism
 * exists to prevent.
 *
 * @param target the environment to build and the sources it belongs to
 */
export function venvCommand(target: VenvTarget): { args: string[]; options: { cwd: string } } {
    return { args: ['venv', '--clear', target.venvDir], options: { cwd: target.pythonDir } };
}
