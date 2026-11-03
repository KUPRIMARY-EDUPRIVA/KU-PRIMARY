import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/index.css';

if ('serviceWorker' in navigator) {
  if (process.env.NODE_ENV === 'production') {
    window.addEventListener('load', () => {
      const manifestLink = document.createElement('link');
      manifestLink.rel = 'manifest';
      manifestLink.href = `${process.env.PUBLIC_URL}/manifest.json`;
      document.head.appendChild(manifestLink);

      navigator.serviceWorker.register(`${process.env.PUBLIC_URL}/service-worker.js`)
        .catch((error) => console.error('Service worker registration failed:', error));
    });
  } else {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then(() => caches.keys())
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => name.startsWith('edupriva-'))
          .map((name) => caches.delete(name))
      ))
      .catch((error) => console.warn('Could not clear the development service worker:', error));
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
