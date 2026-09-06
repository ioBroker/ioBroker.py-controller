import React from 'react';

import {
    Box,
    Chip,
    CircularProgress,
    IconButton,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    CheckCircle as ReadyIcon,
    Error as ProblemIcon,
    HelpOutlined as UnknownIcon,
    Refresh as RebuildIcon,
} from '@mui/icons-material';

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

/** Value of `common.platform` that marks an adapter as Python, as js-controller compares it. */
const PYTHON_PLATFORM = 'python';

/** How long to wait after a change before reading everything again. */
const RELOAD_DEBOUNCE_MS = 300;

/** One instance of a Python adapter. */
interface InstanceLine {
    /** `python.0` */
    id: string;
    /** The user switched it on; not the same as running. */
    enabled: boolean;
    /** Its process is up and saying so. */
    alive: boolean;
}

/** One Python adapter with its environment and its instances. */
interface EnvironmentLine {
    /** Adapter name without instance number, e.g. `python` */
    adapter: string;
    /** The environment is present and current. */
    ready: boolean;
    /** `ready`, `missing`, `unstamped`, or `stale (built for <version>)` */
    status: string;
    /** Version of the installed adapter */
    version: string;
    /** The `iobroker` SDK inside the environment */
    sdkVersion: string;
    /** The Python the environment was built with */
    pythonVersion: string;
    instances: InstanceLine[];
}

interface EnvironmentsState extends ConfigGenericState {
    lines: EnvironmentLine[] | null;
    error: string;
    /** The adapter whose environment is being rebuilt right now, or `''`. */
    rebuilding: string;
}

/**
 * What every Python adapter's environment looks like, as soon as the page opens.
 *
 * This is the same information the states under `py-controller.<n>.adapters.*` carry, which is
 * where it comes from: this adapter writes it whenever it looks at an environment, so the page has
 * nothing to compute and nothing to ask for. The diagnosis table below needs a button pressed and
 * answers a different question -- "is anything wrong with this installation" -- while this answers
 * "what is installed, and is it running", which is what a user opens the page to find out.
 *
 * Instances are shown beside their environment because the two failure modes look identical from
 * the instance list in admin: an instance that is switched off, and an instance the controller
 * refuses to start because its environment is missing. Here they are one row apart.
 */
export default class Environments extends ConfigGeneric<ConfigGenericProps, EnvironmentsState> {
    /** State ids this component subscribed to, so the same list can be unsubscribed. */
    private subscribed: string[] = [];

    private reloadTimer: ReturnType<typeof setTimeout> | null = null;

    private unmounted = false;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            lines: null,
            error: '',
            rebuilding: '',
        };
    }

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        await this.load();
    }

    componentWillUnmount(): void {
        this.unmounted = true;

        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = null;
        }

        if (this.subscribed.length) {
            this.props.oContext.socket.unsubscribeState(this.subscribed, this.onStateChange);
            this.subscribed = [];
        }

        super.componentWillUnmount();
    }

    /** Read everything again shortly; several states change together when an environment is built. */
    private readonly onStateChange = (): void => {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
        }

        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            void this.load();
        }, RELOAD_DEBOUNCE_MS);
    };

    /**
     * Read the environments and the instances, and subscribe to what can change.
     *
     * Everything is read in one pass rather than kept in step field by field: there are a handful
     * of states, and a full read cannot drift out of step with itself the way incremental updates
     * can when an adapter is installed or removed while the page is open.
     */
    private async load(): Promise<void> {
        const { socket, instance, adapterName } = this.props.oContext;
        const prefix = `${adapterName}.${instance}.adapters.`;

        try {
            const environments = await socket.getForeignStates(`${prefix}*`);
            const instances = await socket.getAdapterInstances();

            const python = instances.filter(
                (obj) =>
                    (obj?.common as { platform?: string } | undefined)?.platform?.toLowerCase() === PYTHON_PLATFORM,
            );

            // `system.adapter.python.0` -> `python.0`; the alive state hangs off the instance object.
            const aliveIds = python.map((obj) => `${obj._id}.alive`);
            const alive = aliveIds.length ? await socket.getForeignStates(aliveIds) : {};

            const value = (adapter: string, name: string): string => {
                const state = environments[`${prefix}${adapter}.${name}`];
                return state?.val === undefined || state.val === null ? '' : String(state.val);
            };

            // The adapter names are the second segment after the prefix: one channel per adapter.
            const names = new Set<string>();
            for (const id of Object.keys(environments)) {
                const rest = id.substring(prefix.length);
                const dot = rest.indexOf('.');
                if (dot > 0) {
                    names.add(rest.substring(0, dot));
                }
            }

            // An adapter that is installed but has no environment yet has no states either, and it
            // is exactly the one a user is looking for. Take the names from both sides.
            for (const obj of python) {
                names.add(obj._id.split('.')[2]);
            }

            const lines: EnvironmentLine[] = [...names].sort().map((adapter) => ({
                adapter,
                ready: environments[`${prefix}${adapter}.ready`]?.val === true,
                status: value(adapter, 'status') || I18n.t('py_no environment yet'),
                version: value(adapter, 'version'),
                sdkVersion: value(adapter, 'sdkVersion'),
                pythonVersion: value(adapter, 'pythonVersion'),
                instances: python
                    .filter((obj) => obj._id.split('.')[2] === adapter)
                    .map((obj) => ({
                        id: obj._id.replace('system.adapter.', ''),
                        enabled: !!obj.common?.enabled,
                        alive: alive[`${obj._id}.alive`]?.val === true,
                    }))
                    .sort((a, b) => a.id.localeCompare(b.id)),
            }));

            if (this.unmounted) {
                return;
            }

            await this.subscribe([...Object.keys(environments), ...aliveIds]);
            this.setState({ lines, error: '' });
        } catch (error) {
            if (!this.unmounted) {
                this.setState({ error: (error as Error).message || String(error) });
            }
        }
    }

    /**
     * Follow exactly the states that were just read, and no others.
     *
     * Re-subscribing on every read rather than once at mount: an adapter installed while the page
     * is open brings new states, and a wildcard subscription would instead deliver everything the
     * two prefixes cover, including every other adapter's `alive`.
     *
     * @param ids the states to follow from now on
     */
    private async subscribe(ids: string[]): Promise<void> {
        const wanted = [...new Set(ids)].sort();

        if (wanted.join(' ') === this.subscribed.join(' ')) {
            return;
        }

        if (this.subscribed.length) {
            this.props.oContext.socket.unsubscribeState(this.subscribed, this.onStateChange);
        }

        this.subscribed = wanted;

        if (wanted.length) {
            await this.props.oContext.socket.subscribeState(wanted, this.onStateChange);
        }
    }

    /**
     * Rebuild one adapter's environment, and only that one.
     *
     * The button on the settings page rebuilds all of them, which is the right thing after a new
     * SDK release and the wrong thing when one adapter is stale: every other adapter is stopped,
     * has its environment thrown away and rebuilt from the network for nothing.
     *
     * The adapter is stopped for the duration -- a virtual environment cannot be replaced while an
     * interpreter is running out of it -- and started again afterwards. That is why the confirmation
     * says so: from the outside this looks like the instance crashing.
     *
     * @param adapter name of the adapter whose environment to replace
     */
    private readonly rebuild = async (adapter: string): Promise<void> => {
        if (this.state.rebuilding) {
            return;
        }

        if (!window.confirm(I18n.t('py_Rebuild the environment of %s? The adapter is stopped while it happens.', adapter))) {
            return;
        }

        this.setState({ rebuilding: adapter, error: '' });

        try {
            const answer = (await this.props.oContext.socket.sendTo(
                `${this.props.oContext.adapterName}.${this.props.oContext.instance}`,
                'rebuild',
                { name: adapter },
            )) as { ok?: boolean; error?: string } | undefined;

            if (this.unmounted) {
                return;
            }

            // The states change on their own as the rebuild proceeds and the subscription brings
            // them here; this read is for the case where nothing changed because it failed.
            await this.load();
            this.setState({ rebuilding: '', error: answer?.error || '' });
        } catch (error) {
            if (!this.unmounted) {
                this.setState({ rebuilding: '', error: (error as Error).message || String(error) });
            }
        }
    };

    /** The environment's state as an icon plus the word behind it. */
    private static renderStatus(line: EnvironmentLine): React.JSX.Element {
        const icon = line.ready ? (
            <ReadyIcon color="success" fontSize="small" />
        ) : line.status ? (
            <ProblemIcon color="warning" fontSize="small" />
        ) : (
            <UnknownIcon color="disabled" fontSize="small" />
        );

        return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {icon}
                <span>{line.ready ? I18n.t('py_ready') : line.status}</span>
            </Box>
        );
    }

    /**
     * One chip per instance: whether it is switched on, and whether it is actually running.
     *
     * Both, because they are different answers. An instance that is enabled and not alive is the
     * interesting case -- it is what a missing environment looks like from the outside.
     *
     * @param instances the instances of one adapter
     */
    private static renderInstances(instances: InstanceLine[]): React.JSX.Element {
        if (!instances.length) {
            return <span style={{ opacity: 0.6 }}>{I18n.t('py_no instance')}</span>;
        }

        return (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {instances.map((instance) => (
                    <Tooltip
                        key={instance.id}
                        title={
                            !instance.enabled
                                ? I18n.t('py_switched off')
                                : instance.alive
                                  ? I18n.t('py_running')
                                  : I18n.t('py_enabled, but not running')
                        }
                    >
                        <Chip
                            size="small"
                            label={instance.id}
                            color={!instance.enabled ? 'default' : instance.alive ? 'success' : 'warning'}
                            variant={instance.alive ? 'filled' : 'outlined'}
                            sx={{ opacity: instance.enabled ? 1 : 0.6 }}
                        />
                    </Tooltip>
                ))}
            </Box>
        );
    }

    renderItem(): React.JSX.Element {
        if (this.state.error) {
            return <Typography color="error">{this.state.error}</Typography>;
        }

        if (!this.state.lines) {
            return <Typography sx={{ opacity: 0.6 }}>{I18n.t('py_Reading environments...')}</Typography>;
        }

        if (!this.state.lines.length) {
            return <Typography sx={{ opacity: 0.6 }}>{I18n.t('py_No Python adapter is installed.')}</Typography>;
        }

        return (
            <TableContainer component={Paper} sx={{ width: '100%' }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>{I18n.t('py_Adapter')}</TableCell>
                            <TableCell>{I18n.t('py_Environment')}</TableCell>
                            <TableCell>{I18n.t('py_SDK')}</TableCell>
                            <TableCell>{I18n.t('py_Python')}</TableCell>
                            <TableCell>{I18n.t('py_Instances')}</TableCell>
                            <TableCell align="right" />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {this.state.lines.map((line) => (
                            <TableRow key={line.adapter}>
                                <TableCell>
                                    <b>{line.adapter}</b>
                                    {line.version ? <span style={{ opacity: 0.6 }}> {line.version}</span> : null}
                                </TableCell>
                                <TableCell>{Environments.renderStatus(line)}</TableCell>
                                <TableCell>{line.sdkVersion || '--'}</TableCell>
                                <TableCell>{line.pythonVersion || '--'}</TableCell>
                                <TableCell>{Environments.renderInstances(line.instances)}</TableCell>
                                <TableCell align="right">
                                    <Tooltip title={I18n.t('py_Rebuild only this environment')}>
                                        <span>
                                            <IconButton
                                                size="small"
                                                disabled={!!this.state.rebuilding}
                                                onClick={() => void this.rebuild(line.adapter)}
                                            >
                                                {this.state.rebuilding === line.adapter ? (
                                                    <CircularProgress size={20} />
                                                ) : (
                                                    <RebuildIcon fontSize="small" />
                                                )}
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        );
    }
}
