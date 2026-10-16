/** Deliberately killed only by the crash-recovery tests, against their temp DB. */
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { SqliteStore } from '@interaction/storage-sqlite';
const [directory,mode,input]=process.argv.slice(2),path=resolve(directory);
if(dirname(path)!==resolve(tmpdir())||!basename(path).startsWith('observation-sharing-'))throw Error('Crash helper requires its test-owned temporary directory');
const store=new SqliteStore(path);
store.transaction(()=>{
  if(mode==='write')store.put('observation',JSON.parse(readFileSync(input,'utf8')));
  else if(mode==='collect')store.garbageCollectObservations({repack:true});
  else throw Error('Unknown crash test mode');
  process.kill(process.pid,'SIGKILL');
});
