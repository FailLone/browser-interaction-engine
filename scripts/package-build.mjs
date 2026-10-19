import { readdir, cp, rm, mkdir } from 'node:fs/promises';
for (const name of await readdir('packages')) {
  const target = `packages/${name}/dist`;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(`dist/packages/${name}/src`, target, { recursive: true });
}
