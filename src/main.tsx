import React from 'react';
import ReactDOM from 'react-dom/client';
import Editor from './ui/Editor';
import './ui/styles.css';

if (window.location.pathname !== '/editor') {
  const url = new URL(window.location.href);
  url.pathname = '/editor';
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Editor />
  </React.StrictMode>,
);
