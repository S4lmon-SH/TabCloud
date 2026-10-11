import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AnimationApp from './AnimationApp';
import VideoApp from './VideoApp';

const fractal = location.pathname === '/fractal' || location.pathname.startsWith('/room/');
const animation = location.pathname === '/animation' || location.pathname.startsWith('/studio/');
void (fractal ? import('./styles.css') : animation ? import('./animation.css') : import('./video.css')).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    fractal ? <React.StrictMode><App /></React.StrictMode> : animation ? <AnimationApp /> : <VideoApp />,
  );
});
