import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Context } from './types.js';

// Standard host primitives; no platform module, filesystem, transport or UI globals.
const host = globalThis as typeof globalThis & {
  crypto: { randomUUID(): string };
  structuredClone<T>(value: T): T;
  queueMicrotask(callback: () => void): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
export const id = () => host.crypto.randomUUID();
export const now = () => new Date().toISOString();
export const clone = <T>(value: T): T => host.structuredClone(value);
export const defer = (callback: () => void) => host.queueMicrotask(callback);
export const sleep = (ms: number) => new Promise<void>(resolve => host.setTimeout(resolve, ms));
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(typeof value === 'string' ? value : canonical(value))));
export const contextKey = (context: Context) => hash(context);
export function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: unknown;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = host.setTimeout(() => reject(new Error(message)), ms); })]).finally(() => host.clearTimeout(timer));
}
