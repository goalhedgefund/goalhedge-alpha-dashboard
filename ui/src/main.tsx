import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

// No StrictMode: its double-mount would churn the gateway WebSocket.
const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('missing #root');
createRoot(rootEl).render(<App />);
