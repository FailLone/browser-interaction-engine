import { z } from 'zod';

const cookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().min(1),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
});

/** Device a session was captured on; restored with it so the site sees the same browser. */
export const deviceSchema = z.object({
  userAgent: z.string().min(1),
  locale: z.string().min(2),
  timezoneId: z.string().optional(),
  deviceScaleFactor: z.number().positive().optional(),
  isMobile: z.boolean().default(false),
  hasTouch: z.boolean().default(false),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
});
export type Device = z.infer<typeof deviceSchema>;

/**
 * A logged-in browser session: cookies, per-origin localStorage and IndexedDB (Playwright's
 * storage state format, which restores all three) plus the device. Anything a preset decoder
 * returns is validated against this; a snapshot that does not parse is never imported.
 */
export const snapshotSchema = z.object({
  cookies: z.array(cookie),
  origins: z.array(
    z.object({
      origin: z.string().url(),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
      // Playwright's own IndexedDB serialisation; kept as-is.
      indexedDB: z.array(z.unknown()).optional(),
    }),
  ),
  device: deviceSchema,
  /** ISO time the snapshot was captured / stops being usable. */
  capturedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type SessionSnapshot = z.infer<typeof snapshotSchema>;

export const storageStateOf = (s: SessionSnapshot) => ({
  cookies: s.cookies,
  origins: s.origins as { origin: string; localStorage: { name: string; value: string }[] }[],
});
