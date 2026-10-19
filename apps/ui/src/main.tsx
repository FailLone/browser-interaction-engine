import React from 'react';
import { createRoot } from 'react-dom/client';
import { CrawlPanel } from './CrawlPanel.js';
import './style.css';
import './crawl.css';

createRoot(document.getElementById('root')!).render(<div className="crawl-shell"><CrawlPanel /></div>);
