import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter';
import './styles/app.css';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { unlockAudio } from './lib/beep.js';

const unlock = () => { unlockAudio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
