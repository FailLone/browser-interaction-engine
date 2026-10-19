import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CrawlPanel } from './CrawlPanel.js';
import './index.css';

// Follow the system color scheme; shadcn's dark tokens hang off the `.dark` class.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyScheme = () => document.documentElement.classList.toggle('dark', dark.matches);
applyScheme();
dark.addEventListener('change', applyScheme);

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <main className="mx-auto max-w-[1600px] p-4 sm:p-6">
      <CrawlPanel />
    </main>
  </TooltipProvider>,
);
