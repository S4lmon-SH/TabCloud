import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AnimationApp from './AnimationApp';

const fractal = location.pathname === '/fractal' || location.pathname.startsWith('/room/');
void (fractal ? import('./styles.css') : import('./animation.css')).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    fractal ? <React.StrictMode><App /></React.StrictMode> : <AnimationApp />,
  );
});
