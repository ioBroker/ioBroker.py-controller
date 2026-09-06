// Only for the standalone preview (`npm start` in src-admin); the admin never loads this file.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

window.adapterName = 'py-controller';

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(
        <React.StrictMode>
            <App socket={{ port: 8081 }} />
        </React.StrictMode>,
    );
}
