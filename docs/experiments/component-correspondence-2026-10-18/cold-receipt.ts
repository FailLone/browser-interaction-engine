import {readFileSync} from 'node:fs';
import {BrowserEngine} from '@interaction/browser';
import {SqliteStore} from '@interaction/storage-sqlite';
import {operationSourceCompletion} from '../../../packages/explorer-plugin/src/operation-source-completion.js';
const [directory,itemPath]=process.argv.slice(2),engine=new BrowserEngine({persistence:new SqliteStore(directory)}),item=JSON.parse(readFileSync(itemPath,'utf8'));
try {const completed=operationSourceCompletion(engine)(item);console.log(JSON.stringify({pid:process.pid,completed,originalId:item.id,receipt:item.resolvedBy}));if(!completed)process.exitCode=1;}finally{await engine.close();}
