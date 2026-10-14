import { rm, readdir } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
for (const name of await readdir('packages')) await rm(`packages/${name}/dist`, { recursive: true, force: true });
