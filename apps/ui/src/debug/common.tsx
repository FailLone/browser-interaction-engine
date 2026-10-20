import type React from 'react';
import { useState } from 'react';
import { ChevronRight, ImageOff, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { seconds } from './text.js';

/** A secondary explanation behind an icon, so it never pushes the main information around. */
export function InfoTip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="说明"
          className={cn('inline-flex text-muted-foreground/70 hover:text-foreground', className)}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}

/** Text with a hover explanation; for labels whose meaning is not obvious. */
export function Hint({
  tip,
  children,
  className,
}: {
  tip: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('cursor-help underline decoration-dotted underline-offset-4', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function Time({ ms, className }: { ms: number; className?: string }) {
  return (
    <span className={cn('shrink-0 font-mono text-xs text-muted-foreground tabular-nums', className)}>
      {seconds(ms)}
    </span>
  );
}

export function Kind({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="secondary" className={cn('rounded-md font-mono', className)}>
      {children}
    </Badge>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

/**
 * A state screenshot, loaded only when shown. Height is bounded so tall mobile screenshots
 * never cover the rest of the panel; click to see it full size.
 */
type Mark = {
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};

export function Screenshot({
  runId,
  state,
  label,
  mark,
  marks,
}: {
  runId: string;
  state: string;
  label: string;
  /** A box to outline, in the screenshot's own pixels (the viewport it was taken in). */
  mark?: Mark;
  /** Several boxes, numbered; the active one stands out and the others are dimmed. */
  marks?: (Mark & { key: string | number; label?: string; active?: boolean })[];
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = `/v1/crawls/${runId}/debug/screenshot/${state}`;
  const all = marks ?? (mark ? [{ ...mark, key: 'mark', active: true }] : []);
  const anyActive = all.some(m => m.active);
  // Percentages of the image, so the outline scales with it at any display size. A box partly
  // off screen is cut at the edge of the picture.
  const outline = all.map(m => {
    const { width: w, height: h } = m.viewport;
    const left = Math.max(0, m.box.x),
      top = Math.max(0, m.box.y);
    const right = Math.min(w, m.box.x + m.box.width),
      bottom = Math.min(h, m.box.y + m.box.height);
    if (right <= left || bottom <= top) return null;
    const dim = anyActive && !m.active;
    return (
      <span
        key={m.key}
        className={cn(
          'pointer-events-none absolute rounded-sm border-2',
          dim ? 'border-rose-500/40' : 'border-rose-500',
          m.active && marks && 'z-10 ring-2 ring-rose-500/30',
        )}
        style={{
          left: `${(left / w) * 100}%`,
          top: `${(top / h) * 100}%`,
          width: `${((right - left) / w) * 100}%`,
          height: `${((bottom - top) / h) * 100}%`,
        }}
      >
        {m.label && (
          <span
            className={cn(
              'absolute -top-px -left-px rounded-br-sm px-1 text-[10px] leading-4 font-medium text-white',
              dim ? 'bg-rose-500/50' : 'bg-rose-500',
            )}
          >
            {m.label}
          </span>
        )}
      </span>
    );
  });
  if (failed)
    return (
      <div className="flex h-24 items-center justify-center gap-2 rounded-md border border-dashed text-xs text-muted-foreground">
        <ImageOff className="size-4" />
        没有截图
      </div>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block overflow-hidden rounded-md border bg-muted/40 hover:ring-2 hover:ring-ring/40"
      >
        <span className="relative mx-auto block w-fit">
          <img
            src={src}
            alt={label}
            loading="lazy"
            onError={() => setFailed(true)}
            className="block max-h-72 w-auto max-w-full object-contain object-top"
          />
          {outline}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-auto max-w-[calc(100vw-2rem)] p-3 sm:max-w-[calc(100vw-4rem)]">
          <DialogTitle className="pr-8 text-sm">{label}</DialogTitle>
          <span className="relative mx-auto block w-fit">
            <img src={src} alt={label} className="block max-h-[80vh] w-auto max-w-full object-contain" />
            {outline}
          </span>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Pretty JSON, scrollable, for model inputs and outputs. */
export function Json({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap',
        className,
      )}
    >
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** A toggle whose content is only rendered once opened, so large JSON costs nothing until asked for. */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('text-xs', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {summary}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
