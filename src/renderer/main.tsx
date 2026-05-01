import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles.css';
import { App } from './App';
import { HomePage } from './pages/HomePage';
import { WizardPage } from './pages/WizardPage';
import { ProgressPage } from './pages/ProgressPage';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<HomePage />} />
          <Route path="wizard" element={<WizardPage />} />
          <Route path="progress" element={<ProgressPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  </StrictMode>,
);
