import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ExplorerPlugin } from './runtime.js';
import { ExplorerError } from './types.js';
import { commandSchema } from './schema.js';

export async function registerExplorer(app:FastifyInstance,plugin:ExplorerPlugin) {
  const prefix='/plugins/explorer/v1';
  // Session ownership stays at the application layer.
  app.addHook('preHandler',async(request,reply)=>{
    if(request.method==='GET'||request.method==='HEAD'||!request.url.startsWith('/v1/'))return;
    const sid=/^\/v1\/sessions\/([^/?]+)/.exec(request.url)?.[1];
    const owner=plugin.owner(sid);
    if(!owner)return;
    const command=(request.body as {type?:string}|undefined)?.type;
    if(sid && request.url.split('?')[0]===`/v1/sessions/${sid}/commands` && ['pause','stop'].includes(command || '')){await plugin.takeover(sid);return;}
    return reply.code(409).send({error:{code:'EXPLORER_OWNS_ENGINE',message:'先暂停探索插件或接管会话',taskId:owner}});
  });
  app.get(`${prefix}/status`,async()=>plugin.status());
  app.get(`${prefix}/tasks`,async(request,reply)=>{try{const q=z.object({summary:z.enum(['true','false']).optional()}).parse(request.query);return q.summary==='true'?plugin.store.taskSummaries():plugin.tasks();}catch(e){return failure(reply,e);}});
  app.post(`${prefix}/tasks`,async(request,reply)=>{try{return reply.code(201).send(plugin.create(request.body));}catch(e){return failure(reply,e);}});
  app.get(`${prefix}/tasks/:id`,async(request,reply)=>{try{return plugin.view((request.params as {id:string}).id);}catch(e){return failure(reply,e);}});
  app.get(`${prefix}/tasks/:id/events`,async(request,reply)=>{try{const id=(request.params as {id:string}).id;plugin.store.task(id);const q=z.object({after:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(1000).default(500)}).parse(request.query);return plugin.store.events(id,q.after,q.limit);}catch(e){return failure(reply,e);}});
  app.get(`${prefix}/tasks/:id/updates`,async(request,reply)=>{try{reply.header('Cache-Control','no-store');const id=(request.params as {id:string}).id;const q=z.object({after:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(1000).default(500),taskVersion:z.string().regex(/^[a-f0-9]{64}$/).optional()}).parse(request.query);return plugin.store.updates(id,q.after,q.limit,q.taskVersion);}catch(e){return failure(reply,e);}});
  app.post(`${prefix}/tasks/:id/commands`,async(request,reply)=>{
    try{const id=(request.params as {id:string}).id;const input=commandSchema.parse(request.body);
      switch(input.command){
        case 'start':case 'resume':return plugin.start(id);
        case 'pause':return await plugin.pause(id);
        case 'stop':return await plugin.pause(id,true);
        case 'extend-budget':if(!input.budget)throw new ExplorerError('INVALID_REQUEST');return plugin.extendBudget(id,input.budget);
        case 'accept-limitations':if(!input.limitations)throw new ExplorerError('INVALID_REQUEST');return plugin.acceptLimitations(id,input.limitations);
        case 'replan':return plugin.revise(id,input);
        case 'continue-scope':return plugin.revise(id,input,true);
      }
    }catch(e){return failure(reply,e);}
  });
  app.addHook('onClose',async()=>plugin.close());
}
function failure(reply:import('fastify').FastifyReply,error:unknown) {
  const code=error instanceof ExplorerError?error.code:error instanceof z.ZodError?'INVALID_REQUEST':'PLUGIN_ERROR';
  return reply.code(code==='NOT_FOUND'?404:code==='INVALID_REQUEST'?400:409).send({error:{code,message:code}});
}
