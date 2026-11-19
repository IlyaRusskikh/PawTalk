import React from 'react';
import { createRoot } from 'react-dom/client';
import { ServerApp } from './ServerApp';
import './style.css';
import './interface.css';
import { applyTheme, loadTheme } from './theme';
import { initializeLanguage } from './i18n';
applyTheme(loadTheme());
void initializeLanguage().then(() => createRoot(document.getElementById('root')!).render(<React.StrictMode><ServerApp /></React.StrictMode>));
