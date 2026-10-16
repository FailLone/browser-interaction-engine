import React,{createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import { ExplorerClient,ExplorerTaskFeed,type PluginStatus,type ExplorerTaskSummary } from './client.js';
import type { Task,TaskView,ExplorerEvent,Decision } from './types.js';
const api=new ExplorerClient();
const C=createContext<{status?:PluginStatus;tasks:ExplorerTaskSummary[];view?:TaskView;selectedEvent?:ExplorerEvent;inspect:(event:ExplorerEvent|undefined)=>void;mode:'autonomous'|'manual';setMode:(mode:'autonomous'|'manual')=>void;select:(id:string)=>void;refresh:()=>Promise<void>}>({tasks:[],inspect:()=>{},mode:'autonomous',setMode:()=>{},select:()=>{},refresh:async()=>{}});
const names:Record<string,string>={idle:'待开始',running:'探索中',paused:'已暂停',stopped:'已停止',completed:'当前计划完成',blocked:'存在阻塞',budget_exhausted:'预算用尽',configuration_required:'需要配置服务',pending:'待执行',succeeded:'已验证',unresolved:'待确认',untested:'未测',excluded:'已排除',requested:'正在调用',returned:'已返回',applied:'已采用',rejected:'未采用',stale:'已过期',cancelled:'已取消',failed:'调用失败'};
const reasons:Record<string,string>={PROVIDER_TIMEOUT:'模型响应超过时限',PROVIDER_UNAVAILABLE:'模型服务暂时不可用',MODEL_OUTPUT_TRUNCATED:'模型输出被长度限制截断',INVALID_MODEL_OUTPUT:'模型输出不符合决策格式',jev_uncertain:'JEV 置信度不足，转交 LLM',jev_low_confidence:'JEV 未达到此类判断的置信度门槛',jev_no_choice:'JEV 无法作出选择',jev_not_configured:'JEV 未配置',jev_circuit_open:'JEV 服务暂时不可用',decision_context_changed:'来源观察已变化，未应用此结果',current_plan_verified:'当前计划内的操作已验证',llm_required_for_planning:'需要配置 LLM 才能生成计划',CONFIGURATION_REQUIRED:'需要配置可用的模型服务',BUDGET_EXHAUSTED:'总预算用尽',ROUND_BUDGET_EXHAUSTED:'轮次预算用尽',sample_unselected:'未选入代表样本',observed_in_scope:'当前范围内发现',scope_deferred:'范围暂缓',scope_not_verified:'目标尚未验证',unknown_action_outcome:'执行结果尚未确认',UNKNOWN_DISPATCH_REQUIRES_REVIEW:'需先核实上次执行结果',operation_basis_unconfirmed:'操作依据未确认',checkpoint_unverified:'返回路径尚未验证',ACTIVE_SESSION:'请先停止当前普通会话',user_paused:'已由用户暂停',user_stopped:'已由用户停止',process_restarted:'服务重启后等待继续',no_new_evidence:'连续探索未获得新证据',plan_revised:'计划已调整'};
Object.assign(reasons,{program_exhaustive_root:'程序建立的全页探索范围',user_excluded:'用户明确排除，未计为已测',TASK_SCOPE_UNSUPPORTED:'任务超出当前页面交互探索能力，请调整范围',INVALID_TASK_CONSTRAINT:'模型给出的排除条件无法对应用户原文，未执行',EXHAUSTIVE_REQUIRES_ALL:'穷尽探索需选择全部已发现交互，不能使用代表样本',PLAN_REVIEW_REQUIRED:'历史任务缺少范围授权记录，请重新规划',jev_required_for_judgments:'需要配置 JEV 才能进行页面判断',JEV_TEMPORARILY_UNAVAILABLE:'JEV 暂时不可用，已暂停；未自动改用 LLM',operation_risk_unresolved:'操作风险证据不足，保留待测',classification_unresolved:'控件类型仍不明确，保留待测',region_unresolved:'区域仍不明确，保留待测'});
const unsupportedNames:Record<string,string>={UNSUPPORTED_CANVAS:'画布内部',UNSUPPORTED_IFRAME:'内嵌页面',UNSUPPORTED_SHADOW_DOM:'Shadow DOM 内容',UNSUPPORTED_FILE_INPUT:'文件上传控件',UNSUPPORTED_INPUT_TYPE:'部分输入控件',SCROLL_WRITING_MODE_UNSUPPORTED:'部分滚动方向'};
const reasonText=(reason?:string)=>reason?.startsWith('missing_capability:')?`当前宿主能力不足：${unsupportedNames[reason.slice('missing_capability:'.length)]||reason.slice('missing_capability:'.length)}`:reason?reasons[reason]||reason:'';
const events:Record<string,string>={'task.created':'创建任务','task.paused':'任务暂停','task.stopped':'任务停止','budget.extended':'预算已追加','round.reattached':'重新观察会话','recovery.reentry_required':'需要重新进入区域','decision.effect':'应用影响','decision.resolved':'按调度规则处理','decision.requested':'请求判断','decision.returned':'返回判断','decision.applied':'采用判断','decision.rejected':'未采用判断','decision.fallback':'转交 LLM','decision.failed':'调用失败','decision.stale':'结果过期','decision.cancelled':'取消判断','round.started':'开始新一轮','round.audit':'本轮审计','action.dispatch':'准备执行','action.verified':'验证执行结果','action.started':'执行操作','action.succeeded':'操作成功','observation.created':'页面观察','task.completed':'当前计划完成','task.halted':'保存并暂停','recovery.result':'返回验证','plan.revised':'补测计划已调整'};
Object.assign(events,{'session.released':'释放已完成的会话','intent.resolved':'已确定探索类型','plan.initialized':'程序建立全页范围','plan.authority_restored':'已核对原始计划范围','decision.deferred':'保留并暂停','routing.updated':'判断规则已更新'});
Object.assign(events,{'navigation.isolated':'保留未知跳转，换会话继续其他范围'});
Object.assign(events,{'boundary.exit_verified':'核验弹层关闭与父页面状态','scope.audit':'检查剩余范围','scope.remapped':'根据原始证据更新补测范围标识','scope.retained':'程序保留全部已发现成员','round.session_limit':'会话时限已到，保留未完成范围'});
Object.assign(events,{'scope.unsupported':'保留宿主无法验证的范围'});
Object.assign(events,{'scope.limitation_accepted':'用户接受能力限制，保留未测'});
Object.assign(events,{'action.priority':'优先当前未测控件，保留返回范围','branch.reentry_deferred':'暂缓重复进入：子目标尚无新证据'});
Object.assign(events,{'review.unchanged':'用途证据未变，保留待测'});
Object.assign(events,{'review.resolved':'分类已验证，关闭审阅缺口','review.reopened':'审阅证据变化，重新待确认'});
Object.assign(events,{'probe.dispatch':'执行观察探测','probe.verified':'核验探测结果，不计为点击覆盖'});
Object.assign(reasons,{probe_unresolved:'探测用途或外部写入风险仍不明确，保留待测'});
Object.assign(reasons,{operation_not_executed:'尚未执行，保留待测',sampling_not_authorized:'按当前范围保留全部已发现成员；执行仍需通过范围、用途和宿主校验。',host_time_limit:'当前会话的时限已用尽，未完成范围已保留。新会话仍受任务总预算约束，未知结果保持不变。'});
const purposes:Record<string,string>={'task-intent':'判断任务类型','initial-plan':'理解任务与生成范围','region-review':'识别探索区域','control-classification':'判断控件类型','identity-review':'判断控件身份','control-risk':'判断操作用途','input-samples':'生成输入样本','scope-review':'决定遍历范围','sample-selection':'选择代表样本','list-purpose':'判断列表用途','purpose-description':'描述列表用途','probe-selection':'选择观察试探','discovery-scan':'补充发现','next-action':'选择下一步','recovery-selection':'判断返回路径','followup-plan':'提出补测计划','followup-strategy':'判断是否需要新计划'};
Object.assign(purposes,{'boundary-exit-risk':'判断弹层外部退出方式'});
Object.assign(purposes,{'probe-risk':'判断观察探测的用途与风险'});
Object.assign(reasons,{BOUNDARY_EXIT_UNVERIFIED:'弹层退出后的状态未通过核验',boundary_exit_unresolved:'尚未找到可验证的弹层退出方式',boundary_preservation_limit:'待保护的父页面字段超过单次核验上限'});
Object.assign(reasons,{CONTROL_REVIEW_EXPIRED:'控件审阅依据已失效，需重新审阅',REGION_REVIEW_REQUIRED:'当前区域尚未通过审阅',DEPTH_REUSE_INVALIDATED:'沿用的遍历决定已失效',IDENTITY_AMBIGUOUS:'当前控件身份存在歧义',UNKNOWN_ACTION_OUTCOME:'上次执行结果未知，需先核实',STALE_OBSERVATION:'观察已经变化，需重新核对',INPUT_REQUIRED:'尚未提供有效输入样本'});
Object.assign(reasons,{interface_risk_required:'尚未确认操作仅影响界面',action_basis_unconfirmed:'操作依据尚未确认',CONTROL_CLASSIFICATION_REQUIRED:'控件类型尚未确认'});
Object.assign(purposes,{'operation-clarification':'澄清控件用途','identity-clarification':'澄清控件身份','classification-clarification':'澄清控件类型'});
Object.assign(reasons,{semantic_review_needed:'JEV 补充观察后仍有歧义，按需交给 LLM',semantic_choice_not_offered:'模型选择不在允许范围内，未采用',semantic_evidence_unknown:'模型引用了未提供的证据，未采用',semantic_evidence_missing:'模型未引用必要证据，未采用',semantic_still_uncertain:'LLM 仍无法确定，保留待测',semantic_effect_unresolved:'界面用途或外部写入风险仍不明确，未采用'});
const policyNames:Record<string,string>={'task-intent':'任务类型判断',ranking:'候选排序',discovery:'区域发现',coverage:'范围保留',classification:'控件分类',identity:'身份核对','evidence-gate':'证据检查','planning-gate':'新计划判断',recovery:'恢复判断'};
const resolutionNames:Record<string,string>={task_intent_classified:'JEV 已判断任务类型；全页穷尽由程序建立范围，指定目标或具体约束交给 LLM 结构化。',task_intent_needs_interpretation:'任务类型尚不明确，交给 LLM 返回结构化任务；不会直接扩大执行范围。',stable_candidate_order:'候选排序不明确，程序按固定顺序选择；其余候选继续保留，执行仍须通过范围和审阅检查。',jev_ranking_only:'JEV 仅用于候选排序，不增加操作许可。',evidence_missing:'证据不足，先补充一次观察；有可解释证据的用途、分类或身份歧义可按需交给 LLM，仍不明确则保留待测。',retain_recorded_gaps:'沿用已有缺口、范围和前置条件，无需生成新计划。',jev_grouping:'历史分组规则；不代表操作授权。',jev_confident:'历史规则：达到置信度门槛。',region_grouping_only:'仅将观察到的控件归入区域，不排除候选，也不授权操作。',retain_observed_members:'保留全部已发现成员；执行范围仍由当前计划限制。',scope_reduction_not_authorized:'未获准收缩范围，程序保留全部已发现成员；没有将未测项目算作完成。',user_enabled_sampling:'用户明确选择了代表样本；其余成员保留为未测。',retain_possible_interaction:'保留可能的交互，不因排序分歧排除候选。',classification_evidence_gate:'分类达到专项参考门槛，且没有与已捕获的交互证据冲突；仍须宿主校验。',contradictory_interaction_evidence:'分类与交互证据冲突或证据被截断，保留待确认。',keep_occurrence_independent:'保留当前控件为独立目标，不因身份不确定而合并或漏测。',identity_evidence_gate:'身份判断达到专项参考门槛，并通过结构比对；仍须宿主校验。',evidence_gate:'此项判断达到专项参考门槛；执行许可仍由宿主校验。',atomic_evidence_checked:'各项条件分别判断，程序组合结果；风险问题按概率处理，不使用 Choice 置信度。',new_plan_needed:'JEV 认为需要新的路径或前置步骤，允许请求 LLM 生成计划。'};
export function ExplorerProvider({children}:{children:ReactNode}) {
  const [selectedEvent,setSelectedEvent]=useState<ExplorerEvent>();
  const [mode,setMode]=useState<'autonomous'|'manual'>('autonomous');
  const [status,setStatus]=useState<PluginStatus>();const [tasks,setTasks]=useState<ExplorerTaskSummary[]>([]);const [id,setId]=useState('');const [view,setView]=useState<TaskView>();const selected=useRef('');
  const feed=useRef<ExplorerTaskFeed|undefined>(undefined),controller=useRef(new AbortController()),requestVersion=useRef(0);
  const select=(next:string)=>{if(next===selected.current)return;controller.current.abort();controller.current=new AbortController();requestVersion.current++;selected.current=next;feed.current=next?new ExplorerTaskFeed(api,next):undefined;setView(undefined);setSelectedEvent(undefined);setId(next);};
  const refresh=async()=>{
    const version=++requestVersion.current,current=selected.current;
    if(controller.current.signal.aborted)controller.current=new AbortController();const signal=controller.current.signal;
    try{
      const [s,items,v]=await Promise.all([api.status(signal),api.taskSummaries(signal),feed.current?.refresh(signal)]);
      if(signal.aborted||version!==requestVersion.current||current!==selected.current)return;
      setStatus(previous=>JSON.stringify(previous)===JSON.stringify(s)?previous:s);setTasks(previous=>JSON.stringify(previous)===JSON.stringify(items)?previous:items);setView(v);
    }catch(error){if(!signal.aborted&&version===requestVersion.current)throw error;}
  };
  useEffect(()=>{let dead=false;let timer:ReturnType<typeof setTimeout>;let available=false;const tick=async()=>{try{if(!dead){await refresh();available=true;}}catch{if(!dead)setStatus(undefined);}if(!dead&&available)timer=setTimeout(tick,1200);};void tick();return()=>{dead=true;controller.current.abort();requestVersion.current++;clearTimeout(timer);};},[]);
  useEffect(()=>{void refresh().catch(()=>{});},[id]);
  return <C.Provider value={{status,tasks,view,selectedEvent,inspect:setSelectedEvent,mode,setMode,select,refresh}}>{children}</C.Provider>;
}
const workspaceStyles = `
.explorer-call-summary{display:grid;gap:8px;padding:14px;font-size:11px;line-height:1.6;border-bottom:1px solid #e8ede5;background:#f4f7f2}.explorer-call-summary span{color:#738377}.explorer-call-summary button{font-size:10px;text-align:left;padding:7px 9px}
.explorer-inspector{display:flex;flex-direction:column;min-height:380px}.explorer-inspector .panel-title button{font-size:10px}.explorer-inspector-summary{padding:14px 17px;font-size:11px;line-height:1.8;border-bottom:1px solid #e8ede5}.explorer-inspector-summary p{margin:5px 0;color:#788875;overflow-wrap:anywhere}.explorer-inspector-tabs{display:flex;gap:18px;padding:0 17px;border-bottom:1px solid #e8ede5}.explorer-inspector-tabs button{border:0;border-radius:0;padding:12px 2px;font-size:11px;color:#7c8b75}.explorer-inspector-tabs button[aria-selected=true]{color:#285b45;border-bottom:2px solid #285b45}.explorer-inspector-body{padding:17px;max-height:560px;overflow:auto;min-width:0;font-size:12px;line-height:1.7}.explorer-inspector-body h3{font-size:12px;margin:0 0 8px}.explorer-inspector-body pre{margin:8px 0 15px;max-height:none}.explorer-inspector-body p{overflow-wrap:anywhere}.explorer-effect{padding:12px 0;border-bottom:1px solid #e8ede5}.explorer-inspector-footer{padding:10px 17px;border-top:1px solid #e8ede5;font-size:10px}.explorer-inspector-footer a{color:#47735a}.explorer-inspector-meta{font-size:10px;color:#8c9985}
.explorer-workspace{display:grid;gap:14px;min-width:0}.explorer-mode{display:grid;grid-template-columns:1fr 1fr;padding:3px;background:#eef2ee;border-radius:8px;gap:3px}.explorer-mode button{border:0;background:transparent;padding:9px 5px;font-size:12px;color:#75867a}.explorer-mode button[aria-pressed=true]{background:#fff;color:#285b45;box-shadow:0 1px 4px #20332e12;font-weight:600}.explorer-setup{display:grid;gap:14px;min-width:0}.explorer-services{display:flex;flex-wrap:wrap;gap:12px;color:#7c8d80;font-size:10px}.explorer-services span{display:flex;align-items:center}.explorer-setup textarea{min-height:100px;line-height:1.7}.explorer-setup select{width:100%;margin-top:7px}.explorer-budget{border-top:1px solid #e8ede5;border-bottom:1px solid #e8ede5;padding:4px 0}.explorer-budget summary{display:flex;justify-content:space-between;gap:8px}.explorer-budget summary small{font-size:10px;color:#95a08f}.explorer-budget-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;padding-bottom:10px}.explorer-budget-grid label{margin-top:0}.explorer-task-status{display:grid;gap:9px;padding:12px;background:#f4f7f2;border:1px solid #e2e9df;border-radius:7px;font-size:11px;line-height:1.6}.explorer-task-status strong{color:#285b45}.explorer-task-status small{color:#7c8d80;overflow-wrap:anywhere}.explorer-usage{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;color:#738377;font-size:10px}.explorer-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}.explorer-controls>.primary{grid-column:1/-1}.explorer-adjust{display:grid;gap:8px;padding-top:5px}.explorer-manual{display:grid;gap:15px}.explorer-workspace [hidden]{display:none}.explorer-plan{margin-bottom:20px}.explorer-plan-body{padding:15px 18px}.explorer-plan-intro{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.explorer-rounds{display:flex;gap:6px;flex-wrap:wrap}.explorer-rounds button{font-size:10px}.explorer-plan-items{display:grid;gap:0}.explorer-plan-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px 15px;padding:13px 0;border-top:1px solid #e9eee5}.explorer-plan-item>label{display:flex;align-items:flex-start;gap:8px;line-height:1.7;font-size:12px;color:#334c3d}.explorer-plan-item input{flex-shrink:0;margin-top:4px}.explorer-plan-item>small{grid-column:1/-1;color:#899681;font-size:10px;overflow-wrap:anywhere}.explorer-plan-item>details{grid-column:1/-1}.explorer-plan-item>details summary{padding:2px 0;font-size:10px}.explorer-plan-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:12px}.explorer-plan-editor{margin-top:14px;border-top:1px solid #e9eee5;padding-top:8px}.explorer-plan-editor textarea{display:block;width:100%;margin:10px 0;font-family:monospace}.explorer-error{font-size:11px;color:#975e4b;overflow-wrap:anywhere;line-height:1.6;margin:0}
`;

/** Optional sidebar integration. The original controls remain usable when unavailable. */
export function ExplorerWorkspace({url,sessionId,onSession,children}:{url:string;sessionId?:string;onSession:(id:string)=>void;children:ReactNode}) {
  const {status,tasks,view,select,inspect,mode,setMode}=useContext(C);
  const linked=useRef<{sessionId:string;taskId?:string}|undefined>(undefined);
  const owner=tasks.find(t=>t.rounds.some(r=>r.sessionId===sessionId))||(view?.task.rounds.some(r=>r.sessionId===sessionId)?view.task:undefined);
  useEffect(()=>{
    if(!status?.enabled||sessionId===undefined||(linked.current?.sessionId===sessionId&&linked.current?.taskId===owner?.id))return;
    linked.current={sessionId,taskId:owner?.id};inspect(undefined);
    if(sessionId){select(owner?.id||'');if(owner)setMode('autonomous');}
  },[status?.enabled,sessionId,owner?.id]);
  if(!status?.enabled)return <>{children}</>;
  return <div className="explorer-workspace"><style>{workspaceStyles}</style>
    <div className="explorer-mode" role="group" aria-label="探索方式">
      <button aria-pressed={mode==='autonomous'} onClick={()=>setMode('autonomous')}>自主探索</button>
      <button aria-pressed={mode==='manual'} onClick={()=>setMode('manual')}>手动探索</button>
    </div>
    <div hidden={mode!=='autonomous'}><ExplorerPanel url={url} sessionId={sessionId} onSession={onSession}/></div>
    <div className="explorer-manual" hidden={mode!=='manual'}>{children}</div>
  </div>;
}

export function ExplorerPanel({url,sessionId,onSession}:{url:string;sessionId?:string;onSession:(id:string)=>void}) {
  const {status,tasks,view,select,refresh}=useContext(C);const [goal,setGoal]=useState('');const [coverageMode,setCoverageMode]=useState<'all'|'representative'>('all');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [limits,setLimits]=useState({rounds:3,actions:300,minutes:30,modelRequests:300});
  const followed=useRef<{taskId:string;sessionId?:string}|undefined>(undefined);
  useEffect(()=>{if(view?.task){setGoal(view.task.goal);setCoverageMode(view.task.coverageMode||'all');}},[view?.task.id,view?.task.coverageMode]);
  useEffect(()=>{
    if(!view)return;const task=view.task,sid=task.rounds.at(-1)?.sessionId,previous=followed.current;
    followed.current={taskId:task.id,sessionId:sid};
    const newRound=previous?.taskId===task.id&&previous.sessionId!==sid;
    if(sid&&(newRound||!task.rounds.some(r=>r.sessionId===sessionId)))onSession(sid);
  },[view?.task.id,view?.task.rounds.at(-1)?.sessionId]);
  if(!status?.enabled)return null;const task=view?.task;
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const command=(name:string,data?:Record<string,unknown>)=>run(()=>api.command(task!.id,name,data));
  return <section className="explorer-setup" aria-label="自主探索">
    <div className="explorer-services">{(['jev','llm'] as const).map(actor=><span key={actor}><i className={`dot ${status.providers[actor].configured?'running':''}`}/>{actor.toUpperCase()} {status.providers[actor].configured?'已就绪':'未配置'}</span>)}</div>
    <label>探索任务（可留空）<textarea aria-label="自主探索目标" placeholder="留空：尽可能穷尽当前页面的 UI 交互。也可填写具体目标或约束。" value={goal} onChange={e=>{setGoal(e.target.value);if(!e.target.value.trim())setCoverageMode('all');}}/></label><p className="scope-note">留空由程序直接建立全页范围；填写任务先由 JEV 判断类型，需要具体计划或约束时才调用 LLM。</p>
    <label>遍历范围<select aria-label="遍历范围" disabled={!goal.trim()} value={coverageMode} onChange={e=>setCoverageMode(e.target.value as 'all'|'representative')}><option value="all">全部已发现交互</option><option value="representative">代表样本（其余保留未测）</option></select></label><p className="scope-note">范围设置用于新建或重新规划；遍历证据不足时保留待测，任务类型不明确时由 LLM 解析。</p>
    <details className="explorer-budget"><summary>探索预算 ▾<small>{limits.rounds} 轮 · {limits.actions} 次动作</small></summary>
      <div className="explorer-budget-grid">{([['rounds','最多轮次'],['actions','总动作数'],['minutes','总分钟数'],['modelRequests','模型请求数']] as const).map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" min={1} value={limits[key]} onChange={e=>setLimits({...limits,[key]:Number(e.target.value)})}/></label>)}</div>
      <p className="scope-note">新建任务使用以上预算；已有任务需在“调整任务”中追加。</p>
    </details>
    <button className={task?'wide':'primary wide'} disabled={busy} onClick={()=>void run(async()=>{const t=await api.create({goal,url,coverageMode,budget:{rounds:limits.rounds,actions:limits.actions,durationMs:limits.minutes*60000,modelRequests:limits.modelRequests}});select(t.id);})}>＋ 创建探索任务</button>
    {!!tasks.length&&<label>探索任务<select aria-label="探索任务" value={task?.id||''} onChange={e=>select(e.target.value)}><option value="">选择任务</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.goal.slice(0,40)||'默认穷尽当前页面'} · {names[t.status]}</option>)}</select></label>}
    {error&&<p className="explorer-error" role="alert">{error}</p>}
    {task&&<>
      <div className="explorer-task-status" role="status"><strong>{names[task.status]}</strong><small>{task.intent?({exhaustive:'全页穷尽',targeted:'指定目标',unsupported:'当前不支持'}[task.intent.mode]):task.plan.length?'沿用已有探索范围':task.goal?'等待判断任务类型':'默认全页穷尽'}{task.intent&&` · 来源：${{default:'程序',jev:'JEV',llm:'LLM',user:'用户调整'}[task.intent.source]}`}</small><small>{reasonText(task.reason)||'点击下方按钮开始探索'}</small>
        <div className="explorer-usage"><span>轮次 {task.usage.rounds} / {task.budget.rounds}</span><span>动作 {task.usage.actions} / {task.budget.actions}</span><span>模型 {task.usage.modelRequests} / {task.budget.modelRequests}</span><span>{((task.usage.durationMs+(task.activeSince?Date.now()-task.activeSince:0))/60000).toFixed(1)} / {Math.ceil(task.budget.durationMs/60000)} 分钟</span></div>
        {!!task.acceptedLimitations?.length&&<small>已接受能力限制，保留未测：{task.acceptedLimitations.map(x=>unsupportedNames[x.code]||x.code).join('、')}</small>}
      </div>
      <div className="explorer-controls"><button className="primary" disabled={busy||task.status==='running'||task.status==='completed'} onClick={()=>void command('resume')}>开始 / 继续探索</button><button disabled={busy||task.status!=='running'} onClick={()=>void command('pause')}>暂停 / 接管</button><button disabled={busy} onClick={()=>void command('stop')}>停止探索</button></div>
      <details><summary>调整任务</summary><div className="explorer-adjust"><button disabled={busy||task.status==='running'} onClick={()=>void command('replan',{goal,coverageMode})}>按新目标重新规划</button><button disabled={busy||task.status==='running'} onClick={()=>void command('extend-budget',{budget:{rounds:limits.rounds,actions:limits.actions,durationMs:limits.minutes*60000,modelRequests:limits.modelRequests}})}>追加上方预算</button></div></details>
    </>}
  </section>;
}

/** Plans and evidence stay in the main workspace; task inputs and execution controls live in the sidebar. */
export function ExplorerPlan({onSession}:{onSession:(id:string)=>void}) {
  const {status,view,refresh,mode}=useContext(C);const [picked,setPicked]=useState<string[]>([]);const [editing,setEditing]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{setPicked([]);setEditing('');setError('');},[view?.task.id]);
  if(!status?.enabled||!view||mode==='manual')return null;const task=view.task;
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="panel explorer-plan" aria-label="探索计划">
    <div className="panel-title"><h2>探索计划与未完成范围</h2><span>{task.plan.filter(i=>i.status!=='succeeded').length} 项待处理</span></div>
    <div className="explorer-plan-body"><div className="explorer-plan-intro"><p className="scope-note">{task.intent?.mode==='exhaustive'?'程序覆盖起始页面 URL 下新出现的控件、菜单和弹窗；明确排除项和未解决缺口单独保留。':'当前计划完成不代表全站穷尽；未选样本仍为未测。'}</p><div className="explorer-rounds">{task.rounds.map(r=><button key={r.id} onClick={()=>onSession(r.sessionId)}>第 {r.number} 轮 · {r.actions} 次操作 · {r.status==='running'?'进行中':r.status==='paused'?'已暂停':'已结束'}</button>)}</div></div>
      {!task.plan.length&&<p className="scope-note">{task.status==='running'?(task.goal?'正在识别任务类型并建立探索范围…':'正在由程序建立全页探索范围…'):'开始探索后，将在这里展示计划、执行证据和未完成范围。'}</p>}
      <div className="explorer-plan-items">{task.plan.map(i=>{
        const code=i.reason.startsWith('missing_capability:')?i.reason.slice('missing_capability:'.length):undefined,accepted=task.acceptedLimitations?.find(x=>x.code===code);
        return <div className="explorer-plan-item" key={i.id}><label><input type="checkbox" checked={picked.includes(i.id)} disabled={task.status==='running'} onChange={e=>setPicked(e.target.checked?[...picked,i.id]:picked.filter(x=>x!==i.id))}/>{reasonText(i.title)}</label><span className={`badge ${i.status}`}>{names[i.status]}</span><small>{reasonText(i.reason)} · {i.required?'计划内':accepted?'用户已接受此限制，保留未测':'待选择'}{i.dispatchScope===false?' · 此记录不扩展执行范围':''}{i.resolvedBy?' · 有实际执行证据':''}{i.reviewResolvedBy?' · 有分类证据（不计操作次数）':''}</small>
          {i.required&&code&&/^(UNSUPPORTED_.+|.+_UNSUPPORTED)$/.test(code)&&<button disabled={busy||task.status==='running'} onClick={()=>void run(()=>api.command(task.id,'accept-limitations',{limitations:{codes:[code],reason:'用户明确跳过本任务中宿主不支持的这类内容，保留为未测。'}}))}>跳过此类能力限制（保留未测）</button>}
          <details><summary>范围、前置条件与证据</summary><pre>{JSON.stringify({scope:i.scope,prerequisites:i.prerequisites,completion:i.completion,evidence:i.evidence,resolvedBy:i.resolvedBy,reviewResolvedBy:i.reviewResolvedBy,acceptedLimitation:accepted,history:i.attempts},null,2)}</pre></details></div>;
      })}</div>
      {!!task.plan.length&&<><div className="explorer-plan-actions"><button disabled={busy||!picked.length||task.status==='running'} onClick={()=>void run(()=>api.command(task.id,'continue-scope',{itemIds:picked}))}>将所选范围设为补测计划</button><small className="scope-note">设置后从左侧继续探索，沿用剩余总预算。</small></div>
        <details className="explorer-plan-editor"><summary>调整计划范围</summary><button disabled={task.status==='running'} onClick={()=>setEditing(JSON.stringify(task.plan.map(({title,scope,prerequisites,completion,required,reason})=>({title,scope,prerequisites,completion,required,reason})),null,2))}>载入当前计划</button><textarea aria-label="编辑探索计划" rows={8} value={editing} onChange={e=>setEditing(e.target.value)}/><button disabled={busy||!editing||task.status==='running'} onClick={()=>void run(()=>api.command(task.id,'replan',{items:JSON.parse(editing)}))}>保存调整</button></details></>}
      {error&&<p className="explorer-error" role="alert">{error}</p>}
    </div>
  </section>;
}
export function ExplorerTraversal({sessionId,children,onInspect}:{sessionId:string;children:ReactNode;onInspect:(observationId:string)=>void}) {
  const {status,view,selectedEvent,inspect}=useContext(C);
  if(!status?.enabled||!view||!view.task.rounds.some(r=>r.sessionId===sessionId))return <>{children}</>;
  const visible=view.events.filter(e=>(!e.sessionId||e.sessionId===sessionId)&&(e.actor!=='engine'||['action.started','action.succeeded','action.failed','action.unknown','observation.created','checkpoint.result'].includes(e.type)));
  const decisions=view.decisions.filter(d=>d.sessionId===sessionId),latest=decisions.at(-1),latestEvent=latest&&visible.findLast(e=>e.decisionId===latest.id);
  return <div aria-label="包含模型决策的遍历路径"><div className="explorer-call-summary" role="status"><b>本轮模型调用</b><span>JEV {decisions.filter(d=>d.actor==='jev').length} 次 · LLM {decisions.filter(d=>d.actor==='llm').length} 次</span>{latestEvent&&<button onClick={()=>inspect(latestEvent)}>查看最近调用 · {names[latest!.status]}</button>}</div>{visible.map(e=>{
    const decision=e.decisionId?view.decisions.find(d=>d.id===e.decisionId):undefined;
    return <button className={`visit ${selectedEvent?.sequence===e.sequence?'active':''}`} style={{borderLeft:`3px solid ${e.actor==='jev'?'#2b725e':e.actor==='llm'?'#7560a2':'#dce5df'}`}} key={e.sequence} onClick={()=>{inspect(e.actor==='engine'?undefined:e);if(e.sessionId===sessionId&&e.observationId)onInspect(e.observationId);}}><span className="visit-line"><b>{e.actor==='engine'||e.actor==='program'?'程序':e.actor.toUpperCase()}</b> · {events[e.type]||e.type}</span><small>{new Date(e.at).toLocaleTimeString()} · {purposes[decision?.purpose||(e.data as {purpose?:string})?.purpose||'']||((e.data as {label?:string})?.label)||''}</small></button>;
  })}</div>;
}
const effectNames:Record<string,string>={'task-route':'已选择任务处理方式',intent:'已识别结构化任务',plan:'已生成探索计划',review:'已应用审阅决定','review-input':'已作为审阅依据',action:'已派发页面操作',recovery:'已尝试并验证返回路径','followup-plan':'已更新补测建议','followup-strategy':'已选择补测方式','evidence-refresh':'已补充页面观察'};
Object.assign(effectNames,{'semantic-escalation':'转交 LLM 澄清歧义','semantic-validation':'核对结构化结论与证据引用','review-deferred':'暂缓采纳，待新观察后重新判断','recovery-deferred':'未确认返回依据，保留未完成分支'});
Object.assign(effectNames,{'dispatch-validation':'核对宿主执行约束',probe:'已派发观察探测','probe-rejected':'宿主在浏览器操作前拒绝了探测'});
const pretty=(value:unknown)=>JSON.stringify(value,null,2);

/** Replaces the right-hand evidence panel while a model/program node is selected. */
export function ExplorerInspector({children}:{children:ReactNode}) {
  const {status,view,selectedEvent:selected,inspect}=useContext(C);const [tab,setTab]=useState<'input'|'output'|'impact'>('input');
  if(!status?.enabled||!view||!selected)return <>{children}</>;
  const decision=selected.decisionId?view.decisions.find(d=>d.id===selected.decisionId):undefined;
  const effects=decision?view.events.filter(e=>e.decisionId===decision.id&&e.type==='decision.effect'):[];
  const results=decision?view.events.filter(e=>['action.verified','probe.verified'].includes(e.type)&&(e.data as {decisionId?:string})?.decisionId===decision.id):[];
  const origin=decision?.fallbackFrom?view.decisions.find(d=>d.id===decision.fallbackFrom):undefined;
  const triggered=decision?.triggeredBy?view.decisions.find(d=>d.id===decision.triggeredBy):undefined;
  const generated=decision?view.decisions.find(d=>d.triggeredBy===decision.id):undefined;
  const forwarded=decision?view.decisions.find(d=>d.fallbackFrom===decision.id):undefined;
  const messages=decision?.input?.messages as {role:string;content:string}[]|undefined;
  const rejected=decision&&['failed','rejected','stale','cancelled'].includes(decision.status);
  const inputContent=(content:string)=>{try{return pretty(JSON.parse(content));}catch{return content;}};
  return <div className="explorer-inspector" role="region" aria-label="探索决策详情">
    <div className="panel-title"><h2>{decision?`${decision.actor.toUpperCase()} · ${purposes[decision.purpose]||decision.purpose}`:events[selected.type]||selected.type}</h2><button onClick={()=>inspect(undefined)}>返回页面证据</button></div>
    {decision?<>
      <div className="explorer-inspector-summary"><span className={`badge ${decision.status}`}>{names[decision.status]}</span><p>{decision.provider}{typeof decision.output?.provider==='string'?` → ${decision.output.provider}`:''} / {decision.model}</p><span>{decision.elapsedMs===undefined?'等待响应':`${(decision.elapsedMs/1000).toFixed(2)} 秒`}{decision.answer?.confidence===undefined?'':` · 置信度 ${decision.answer.confidence}`}{decision.answer?.probability===undefined?'':` · 概率 ${decision.answer.probability}`}</span>{decision.reason&&<p>{reasonText(decision.reason)}</p>}{decision.actor==='llm'&&<p>调用原因：{triggered?.purpose==='task-intent'?(triggered.resolution?.value==='targeted'?'JEV 识别出具体目标或约束，需要转换为可执行范围。':'JEV 尚不能明确任务类型，需要结构化解析。'):decision.purpose.endsWith('-clarification')?'JEV 补充观察后仍有歧义；仅解释已提供的证据，不扩大操作许可。':decision.request.kind==='generate'?'需要生成结构化计划、用途描述或输入内容':reasonText(origin?.reason||decision.fallbackFrom)||'JEV 无法完成此判断'}</p>}<div className="explorer-inspector-meta">任务版本 {decision.revision} · 请求 {decision.request.id.slice(0,8)} · {events[selected.type]||selected.type}</div></div>
      <div className="explorer-inspector-tabs" role="tablist" aria-label="决策内容">{([['input','输入'],['output','输出'],['impact','决策影响']] as const).map(([key,label])=><button key={key} role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
      <div className="explorer-inspector-body" role="tabpanel" aria-label={tab==='input'?'模型输入':tab==='output'?'模型输出':'决策影响'}>
        {tab==='input'&&<>{messages?messages.map((m,index)=><div key={index}><h3>{m.role==='system'?'系统指令':m.role==='user'?'任务与页面证据':m.role}</h3><pre>{inputContent(m.content)}</pre></div>):<><p>{decision.input?'发送给模型的结构化输入':'此历史记录保存了结构化输入，未保存当时的完整请求体。'}</p><pre>{pretty(decision.input||decision.request)}</pre></>}{decision.input&&<details><summary>实际请求体（不含密钥和认证头）</summary><pre>{pretty(decision.input)}</pre></details>}</>}
        {tab==='output'&&<>{decision.answer?<><h3>模型原始判断</h3><pre>{pretty(decision.answer.value)}</pre>{decision.output&&<details><summary>服务返回内容与用量</summary><pre>{pretty(decision.output)}</pre></details>}</>:decision.output?<><p>服务返回了内容，但未通过校验，未用于执行。</p><pre>{pretty(decision.output)}</pre></>:<><p>{decision.status==='requested'?'正在等待模型返回。':'此次调用没有保存到可用的模型输出。'}</p>{decision.reason&&<p>{reasonText(decision.reason)}（{decision.reason}）</p>}</>}</>}
        {tab==='impact'&&<>
          {decision.resolution&&<div className="explorer-effect"><h3>{decision.resolution.source==='program'?'程序处理结果':'JEV 决策用途'}</h3><p>{resolutionNames[decision.resolution.reason]||decision.resolution.reason}</p><p>判断用途：{policyNames[decision.resolution.policy||'']||'历史规则'}{decision.resolution.threshold===undefined?'':` · 参考置信度门槛 ${decision.resolution.threshold}（待校准）`}{decision.resolution.bounds?` · 概率 ≤ ${decision.resolution.bounds.low} 为否，≥ ${decision.resolution.bounds.high} 为是，中间保留不确定`:""}</p><pre>{pretty(decision.resolution)}</pre></div>}
          {generated&&<p>此判断已触发 LLM 结构化解析（{names[generated.status]}），请求 {generated.request.id.slice(0,8)}。</p>}
          {triggered&&<p className="explorer-inspector-meta">上游判断来源：{triggered.id}</p>}
          {forwarded&&<p>本次结果未直接采用，已转交 {forwarded.actor.toUpperCase()}：{purposes[forwarded.purpose]||forwarded.purpose}（{names[forwarded.status]}）。</p>}
          {!effects.length&&<p>{rejected?'本次未产生可采用的决策，未记录由它派发的页面操作。':decision.status==='requested'?'尚未返回结果，暂未应用。':decision.status==='returned'?'结果已返回，等待程序校验与应用。':'此历史记录仅保存了采纳状态，未保存具体应用明细；不能据此认定页面操作成功。'}</p>}
          {effects.map(e=>{const data=e.data as {kind:string;details:unknown};return <div className="explorer-effect" key={e.sequence}><h3>{effectNames[data.kind]||data.kind}</h3>{data.kind==='review'&&<p>以下审阅命令已由宿主接受，审阅本身不代表页面动作已经执行。</p>}{data.kind==='review-input'&&<p>该判断参与了审阅；最终许可和操作结果以对应的审阅与执行记录为准。</p>}<pre>{pretty(data.details)}</pre></div>;})}
          {results.map(e=><div className="explorer-effect" key={e.sequence}><h3>{e.type==='probe.verified'?'探测实际结果（不计点击覆盖）':'实际操作结果'}</h3><pre>{pretty(e.data)}</pre></div>)}
          {effects.some(e=>['action','probe'].includes((e.data as {kind:string}).kind))&&!effects.some(e=>(e.data as {kind:string}).kind==='probe-rejected')&&!results.length&&<p>操作已经派发，尚未记录到最终结果。</p>}
          {decision.fallbackFrom&&<p className="explorer-inspector-meta">转交来源：{decision.fallbackFrom}</p>}
        </>}
      </div>
    </>:<div className="explorer-inspector-body">{selected.type==='navigation.isolated'&&<p>原链接的执行结果仍未确认，不计为成功，也不会自动重试。后续轮次使用新的会话和审阅探索其他范围，总预算继续累计。</p>}{selected.type==='review.resolved'&&<p>当前宿主审阅已确认该控件是展示内容或容器，相关审阅缺口已核对完成。此证据不代表执行了操作，也不覆盖容器中的其他控件。</p>}{selected.type==='review.unchanged'&&<p>仅控件的屏幕位置发生变化，用途证据仍不足。程序保留原判断和未完成范围，本次未重复调用模型，也未授予执行许可。内容、结构或上下文变化后会重新判断。</p>}{selected.type==='review.reopened'&&<p>原分类已无法支持当前控件，审阅缺口重新保留为待确认；已有历史证据未删除。</p>}{selected.type==='action.priority'&&<p>当前已有可执行的未测控件，先处理这些控件，暂缓重复进入旧范围。暂缓项仍保留在计划中，后续按需返回，不计为已测。</p>}{selected.type==='scope.unsupported'&&<p>宿主报告有内容无法完整观察或操作，已保留为未完成范围。其他控件的执行成功不能替代这部分验证。此步骤由程序记录，无需模型调用。</p>}{selected.type==='scope.retained'&&<p>{reasonText('sampling_not_authorized')} 此步骤由程序处理，无需模型调用。</p>}{selected.type==='round.session_limit'&&<p>{reasonText('host_time_limit')} 此步骤由程序处理，无需模型调用。</p>}<pre>{pretty(selected.data)}</pre></div>}
    {selected.sessionId&&selected.observationId&&<div className="explorer-inspector-footer"><a href={`/v1/sessions/${encodeURIComponent(selected.sessionId)}/evidence/${encodeURIComponent(selected.observationId)}`} target="_blank" rel="noreferrer">打开当时的页面证据 ↗</a><p className="explorer-inspector-meta">观察 {selected.observationId} · 记录顺序 {selected.sequence}</p></div>}
  </div>;
}
