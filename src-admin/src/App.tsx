// Only for the standalone preview (`npm start` in src-admin); the admin never loads this file.
import React from 'react';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';

import { Box } from '@mui/material';

import {
    GenericApp,
    I18n,
    type IobTheme,
    Loader,
    type GenericAppProps,
    type GenericAppState,
} from '@iobroker/gui-components';

import Environments from './Environments';

import enLocal from './i18n/en.json';
import deLocal from './i18n/de.json';
import ruLocal from './i18n/ru.json';
import ptLocal from './i18n/pt.json';
import nlLocal from './i18n/nl.json';
import frLocal from './i18n/fr.json';
import itLocal from './i18n/it.json';
import esLocal from './i18n/es.json';
import plLocal from './i18n/pl.json';
import ukLocal from './i18n/uk.json';
import zhCNLocal from './i18n/zh-cn.json';

const styles: Record<string, any> = {
    app: (theme: IobTheme): React.CSSProperties => ({
        backgroundColor: theme.palette.background.default,
        color: theme.palette.text.primary,
        height: '100%',
    }),
    item: {
        padding: 20,
    },
};

export default class App extends GenericApp<GenericAppProps, GenericAppState> {
    constructor(props: GenericAppProps) {
        super(props, { ...props });

        this.state = {
            ...this.state,
            theme: this.createTheme(),
        };

        I18n.setTranslations({
            en: enLocal,
            de: deLocal,
            ru: ruLocal,
            pt: ptLocal,
            nl: nlLocal,
            fr: frLocal,
            it: itLocal,
            es: esLocal,
            pl: plLocal,
            uk: ukLocal,
            'zh-cn': zhCNLocal,
        });
        // @ts-expect-error userLanguage exists on some browsers
        I18n.setLanguage((navigator.language || navigator.userLanguage || 'en').substring(0, 2).toLowerCase());
    }

    render(): React.JSX.Element {
        if (!this.state.loaded) {
            return (
                <StyledEngineProvider injectFirst>
                    <ThemeProvider theme={this.state.theme}>
                        <Loader themeType={this.state.themeType} />
                    </ThemeProvider>
                </StyledEngineProvider>
            );
        }

        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>
                    <Box sx={styles.app}>
                        <div style={styles.item}>
                            <Environments
                                oContext={{
                                    // The component reads `<adapterName>.<instance>.adapters.*`, so
                                    // these two decide which installation the preview shows.
                                    adapterName: 'py-controller',
                                    instance: 0,
                                    socket: this.socket,
                                    themeType: this.state.theme.palette.mode,
                                    isFloatComma: true,
                                    dateFormat: '',
                                    forceUpdate: () => {},
                                    systemConfig: {} as ioBroker.SystemConfigCommon,
                                    theme: this.state.theme,
                                    _themeName: this.state.themeName,
                                    onCommandRunning: (): void => {},
                                }}
                                alive
                                changed={false}
                                themeName={this.state.themeName}
                                common={{} as ioBroker.InstanceCommon}
                                data={{}}
                                originalData={{}}
                                onError={() => {}}
                                onChange={() => {}}
                                schema={{
                                    url: 'custom/customComponents.js',
                                    i18n: true,
                                    name: 'PyControllerComponentSet/Components/Environments',
                                    type: 'custom',
                                }}
                            />
                        </div>
                    </Box>
                </ThemeProvider>
            </StyledEngineProvider>
        );
    }
}
