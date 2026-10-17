"""Exact, fail-closed instrumentation of the archived 551a6b9 selector only.

No product file is edited by preparing/importing this module. apply_runtime is
called only by the explicitly authorized runner after creating its owned archive.
Diagnostic helpers never feed a value back into a product decision. Additional
explanatory reads/projections are labeled, isolated from product caches, and run
only for actually rejected present/policy candidates, or the original wait read.
"""

PREFIX = r'''
    // BEGIN offline exclusion diagnostic: not product behavior or dispatch proof.
    const diag=(kind:string,data:unknown)=>(globalThis as any).__bieRecoveryDiagnostic(kind,data);
    const diagPlans=new Map(task.plan.map(item=>[item.id,{ordered:false,pending:false,terminal:'not_in_ordered_obligations'}]));
    let diagCompleted=false,diagSelected=false,diagActual:{itemId:string;checkpointId:string;sourceId:string;index:number}|undefined;
    let diagProjectionId=0,diagLatestProjection=0;
    const diagProjectionOrigins=new Map<string,Map<string,number>>();
    const diagPending=(item:PlanItem,reason:string,pending=false)=>{Object.assign(diagPlans.get(item.id)!,{ordered:true,pending,terminal:reason});};
    const diagDone=(id:string,reason:string)=>{diagPlans.get(id)!.terminal=reason;};
    const diagExit=(reason:string,extra:Record<string,unknown>={})=>diag('candidate.exit',{...diagActual,reason,...extra});
    const diagClassification=new WeakMap<Observation,WeakMap<Observation['controls'][number],unknown>>();
    const diagClass=(observed:Observation,control:Observation['controls'][number])=>{
      let cache=diagClassification.get(observed);if(!cache){cache=new WeakMap();diagClassification.set(observed,cache);}
      if(!cache.has(control)){
        let value:unknown=null;
        try{const x=classificationCorrespondenceConditions(control,observed);value=x?{identityKey:x.identityKey,conditionKey:x.conditionKey}:null;}catch{}
        cache.set(control,value);
        diag('explanation.classification',{sourceId:observed.id,localId:control.localId,instanceId:control.instanceId,conditions:value,undefinedRepresentedByNull:true});
      }
      return cache.get(control) as {identityKey:string;conditionKey:string}|null;
    };
    const diagAction=(observed:Observation,action:ActionCandidate)=>{
      let targetKey:string|undefined,schedulingKey:string|undefined;
      try{targetKey=browserTargetConditions(action,observed)?.key;}catch{}
      try{schedulingKey=keyFor(action,observed);}catch{}
      const {kind,label,value,risk,replayable,basis,excluded,exclusionReason,preconditions,sampleValidity}=action;
      return {id:action.id,localId:action.localId,targetKey:targetKey??null,schedulingKey:schedulingKey??null,
        fingerprint:digest({kind,label,value,risk,replayable,basis,excluded,exclusionReason,preconditions,sampleValidity})};
    };
    for(const item of task.plan)diag('plan.input',{itemId:item.id,required:item.required,status:item.status,reason:item.reason,scope:item.scope,
      dispatchScope:item.dispatchScope,completionStatus:item.conditionCompletion?.status,completionWaiting:item.conditionCompletion?.waiting,
      migrationStatus:item.conditionMigration?.status,hasWait:!!item.reviewRecoveryWait});
    diag('current.availability',{observationId:o.id,actions:actions.length,executable:availability.actions.filter(x=>x.executable).length,
      limitation:'scheduledRecovery null does not mean step has no local work'});
    // END diagnostic prelude.
'''

EXPLANATION = r'''
    // Read only for actual present/policy exits. Never populate/touch the product
    // retained/projection/condition caches from this explanatory path.
    const diagExplained=new Set<string>();
    const diagExplain=(item:PlanItem,sourceId:string,reason:string,available?:Retained)=>{
      if(!['current_review_occurrence_present','current_target_policy_blocked'].includes(reason))return;
      const key=JSON.stringify([item.id,sourceId,reason]);if(diagExplained.has(key)){diag('explanation.reused',{itemId:item.id,sourceId,reason,key});return;}
      diagExplained.add(key);
      let facts=available||retained.get(sourceId);
      if(!facts){
        diag('explanation.source_read.begin',{itemId:item.id,sourceId,reason});
        try{facts=selectionView?selectionView.source(sourceId):undefined;}catch(error){diag('explanation.source_read.error',{itemId:item.id,sourceId,error:String(error)});}
        diag('explanation.source_read.end',{itemId:item.id,sourceId,available:!!facts});
      }
      if(!facts){diag('explanation.unavailable',{itemId:item.id,sourceId,reason});return;}
      try{
        const {source,actions:sourceActions}=facts;
        const sourceMatcher=controlScopeMatcher(source,sourceActions),currentMatcher=controlScopeMatcher(o,actions);
        const sourceScope=source.controls.filter(control=>sourceMatcher(item.scope,control));
        const currentScope=o.controls.filter(control=>currentMatcher(item.scope,control));
        const transition=facts.transition||this.host.interactionTransition(o.sessionId,source.id,o.id);
        if(reason==='current_review_occurrence_present'){
          const previous=new Set(sourceScope.map(c=>c.localId));
          const retainedPairs=transition.retainedControls.filter(c=>previous.has(c.beforeLocalId));
          const currentIds=new Set(retainedPairs.map(c=>c.afterLocalId));
          const matched=o.controls.filter(c=>c.visible&&c.enabled&&(currentIds.has(c.localId)||currentMatcher(item.scope,c)));
          const sourceRows=sourceScope.map(c=>({localId:c.localId,instanceId:c.instanceId,visible:c.visible,conditions:diagClass(source,c)}));
          const currentRows=matched.map(c=>{
            const conditions=diagClass(o,c),viaRetained=retainedPairs.filter(p=>p.afterLocalId===c.localId).map(p=>p.beforeLocalId);
            return {localId:c.localId,instanceId:c.instanceId,viaRetained,scopeMatch:currentMatcher(item.scope,c),scopeOnly:!viaRetained.length,conditions,
              equalConditionSourceLocalIds:conditions?sourceRows.filter(s=>s.conditions?.identityKey===conditions.identityKey&&s.conditions.conditionKey===conditions.conditionKey).map(s=>s.localId):[]};
          });
          diag('explanation.present',{itemId:item.id,sourceId,reason,scope:item.scope,
            sourceScopeCount:sourceScope.length,sourceScopeUnique:sourceScope.length===1,currentScopeCount:currentScope.length,currentScopeUnique:currentScope.length===1,
            matchedCurrentCount:matched.length,matchedCurrentUnique:matched.length===1,sourceControls:sourceRows,currentControls:currentRows,
            sameConditionIsProjectionEvidenceOnly:true,reviewMaterialNotQueried:true});
        }else{
          const sourceIndex=observationActionIndex(source,sourceActions),condition=boundOperationCondition(item);
          const targets=sourceIndex.matching(item.scope).filter(action=>!condition||condition===sourceIndex.condition(action));
          const previous=new Set(targets.map(a=>a.localId)),currentIds=new Set(transition.retainedControls.filter(c=>previous.has(c.beforeLocalId)).map(c=>c.afterLocalId));
          const scoped=new Set(observationActionIndex(o,actions).matching(item.scope));
          const present=actions.filter(a=>scoped.has(a)||a.kind===item.scope.kind&&!!a.localId&&currentIds.has(a.localId));
          const blocked=present.filter(a=>availability.actions.find(f=>f.actionId===a.id)?.blockers.some(b=>b.code==='ACTION_BLOCKED'&&['submission_not_authorized','interface_risk_required','action_basis_unconfirmed'].includes(b.reason)));
          const sourceRows=targets.map(a=>diagAction(source,a)),currentRows=blocked.map(a=>({...diagAction(o,a),
            blockers:availability.actions.find(f=>f.actionId===a.id)?.blockers.map(b=>({code:b.code,reason:b.reason}))}));
          diag('explanation.policy',{itemId:item.id,sourceId,reason,sourceActions:sourceRows,currentActions:currentRows,
            comparisons:sourceRows.flatMap(s=>currentRows.map(c=>({sourceActionId:s.id,currentActionId:c.id,
              sameTargetKey:!!s.targetKey&&s.targetKey===c.targetKey,sameSchedulingKey:!!s.schedulingKey&&s.schedulingKey===c.schedulingKey}))),
            currentScopeActionCount:scoped.size,presentCount:present.length,blockedCount:blocked.length});
        }
      }catch(error){diag('explanation.error',{itemId:item.id,sourceId,reason,error:String(error)});}
    };
    const diagWaitSource=(item:PlanItem,id:string)=>{
      const facts=read(id),source=facts?.source;
      if(source&&item.reviewRecoveryWait){
        const wait=item.reviewRecoveryWait,controls=source.controls.filter(c=>c.localId===wait.localId);
        diag('explanation.wait',{itemId:item.id,sourceId:id,materialKey:wait.materialKey,identityKey:wait.identityKey,conditionKey:wait.conditionKey,
          controls:controls.map(c=>({localId:c.localId,instanceId:c.instanceId,conditions:diagClass(source,c)})),
          actions:facts!.actions.filter(a=>a.localId===wait.localId).map(a=>diagAction(source,a)),
          historicalReviewMaterialUnavailable:true,materialKeyRevalidated:false});
      }
      return source;
    };
'''


def apply_runtime(original):
    """Return injected text and exact-match replacement inventory; no file I/O."""
    changes = []
    marker = '  private async scheduledRecovery('
    start = original.index(marker)
    end = original.index('  private async step(', start)
    prefix, body, suffix = original[:start], original[start:end], original[end:]

    def replace(old, new, label):
        nonlocal body
        assert body.count(old) == 1, (label, body.count(old))
        body = body.replace(old, new, 1)
        changes.append(label)

    # Default implementations and call order are retained; split short-circuit
    # expressions keep the original operand evaluation order.
    replace('    const revision=task.revision,', PREFIX + '    const revision=task.revision,', 'diagnostic prelude')
    replace('    const deferSelection=(itemId:string,conditionVersion:string,reason:string,observationId:string)=>this.deferObligation(task,itemId,conditionVersion,reason,observationId,emitSelection);',
            "    const deferSelection=(itemId:string,conditionVersion:string,reason:string,observationId:string)=>{diagDone(itemId,reason);diag('item.deferred',{itemId,reason,conditionVersion});return this.deferObligation(task,itemId,conditionVersion,reason,observationId,emitSelection);};", 'actual deferred including unchanged rows')
    replace('        for(const event of pendingEvents)this.event(liveTask,event.type,event.data,event.observationId);\n      }\n    };',
            '        for(const event of pendingEvents)this.event(liveTask,event.type,event.data,event.observationId);\n      }\n      diagCompleted=true;\n    };', 'completion marker')
    replace('    for(const item of orderedObligations(task.plan,schedule)){',
            "    const diagOrdered=orderedObligations(task.plan,schedule),diagOrderedIds=new Set(diagOrdered.map(item=>item.id));\n    for(const item of task.plan)if(!diagOrderedIds.has(item.id)){\n      const reason=!item.required?'not_required':['succeeded','excluded','superseded'].includes(item.status)?'finished_'+item.status\n        :item.scope.kind&&item.conditionCompletion?.status==='unverified'&&item.conditionCompletion.waiting!==false?'condition_completion_wait'\n        :item.conditionMigration?.status==='split'?'condition_migration_split'\n        :item.dispatchScope===false&&item.conditionMigration?.status==='invalidated'?'condition_migration_invalidated':'unexplained_not_ordered';\n      diagDone(item.id,reason);\n    }\n    diag('plan.ordered',{itemIds:diagOrdered.map(item=>item.id)});\n    for(const item of diagOrdered){\n      diagPending(item,'pending_filter_not_completed');", 'ordered exact result')
    replace("      if(!authorities.some(authority=>contains(authority.scope,item)||authority.prerequisites.some(scope=>contains(scope,item)))||exclusions.some(excluded=>contains(excluded.scope,item)))continue;",
            "      if(!authorities.some(authority=>contains(authority.scope,item)||authority.prerequisites.some(scope=>contains(scope,item)))){diagPending(item,'no_matching_authority');continue;}\n      if(exclusions.some(excluded=>contains(excluded.scope,item))){diagPending(item,'scope_excluded');continue;}", 'authority exclusion split')
    replace("      if(item.reason.startsWith('missing_capability:')||item.reason==='unknown_action_outcome')continue;",
            "      if(item.reason.startsWith('missing_capability:')){diagPending(item,'missing_capability');continue;}\n      if(item.reason==='unknown_action_outcome'){diagPending(item,'unknown_action_outcome');continue;}", 'missing capability unknown split')
    replace("      if(entry?.state==='alias')continue;", "      if(entry?.state==='alias'){diagPending(item,'alias');continue;}", 'alias')
    replace("        if(fact?.executable||!current.preconditions.enabled||fact?.blockers.some(blocker=>blocker.code==='ACTION_BLOCKED'&&['submission_not_authorized','interface_risk_required','action_basis_unconfirmed'].includes(blocker.reason)))continue;",
            "        if(fact?.executable){diagPending(item,'current_action_executable');continue;}\n        if(!current.preconditions.enabled){diagPending(item,'current_action_disabled');continue;}\n        if(fact?.blockers.some(blocker=>blocker.code==='ACTION_BLOCKED'&&['submission_not_authorized','interface_risk_required','action_basis_unconfirmed'].includes(blocker.reason))){diagPending(item,'current_action_policy_blocked');continue;}", 'current pending filter split')
    replace("      if(broadScope(item.scope)){if(item.scope.url&&item.scope.url!==o.url)pending.push(item);}\n      else if(item.evidence.length||item.dispatchScope===true)pending.push(item);",
            "      if(broadScope(item.scope)){if(item.scope.url&&item.scope.url!==o.url){pending.push(item);diagPending(item,'pending_not_visited',true);}else diagPending(item,'broad_current_or_unspecified_url');}\n      else if(item.evidence.length||item.dispatchScope===true){pending.push(item);diagPending(item,'pending_not_visited',true);}\n      else diagPending(item,'no_evidence_or_dispatch_scope');", 'pending status')
    replace('    if(!pending.length){complete();return;}', "    diag('plan.pending',{itemIds:pending.map(item=>item.id)});\n    if(!pending.length){complete();return;}", 'pending exact order')
    replace('    const projectSourceItem=(item:PlanItem,facts:Retained):SourceProjection=>{',
            "    const projectSourceItem=(item:PlanItem,facts:Retained,diagMode:'actual'|'speculative'='actual'):SourceProjection=>{\n      const diagId=++diagProjectionId;diagLatestProjection=diagId;\n      const finish=(result:SourceProjection,reason:string,detail:Record<string,unknown>={})=>{diag('projection.computed',{id:diagId,itemId:item.id,sourceId:facts.source.id,mode:diagMode,reason,skip:result.skip,stop:!!result.stop,productReason:result.reason,...detail});return result;};", 'projection provenance')
    replace("      if(source.gaps.some(g=>g.critical)||Object.values(source.context).some(value=>value.status!=='known'))return unverified;",
            "      if(source.gaps.some(g=>g.critical))return finish(unverified,'critical_gaps');\n      if(Object.values(source.context).some(value=>value.status!=='known'))return finish(unverified,'unknown_context');", 'gaps context split')
    replace('      if(item.scope.url&&item.scope.url!==source.url)return unverified;', "      if(item.scope.url&&item.scope.url!==source.url)return finish(unverified,'source_url_mismatch');", 'source URL')
    for reason in ['native_source_position_unavailable', 'source_review_target_not_available', 'source_target_already_disabled', 'current_target_policy_blocked']:
        replace("return {skip:true,reason:'" + reason + "'};", "return finish({skip:true,reason:'" + reason + "'},'" + reason + "');", reason)
    # The same expression also occurs later in the route path: replace only
    # within the projectSourceItem block, still preserving one matching/filter.
    old = "      const targets=index.matching(item.scope).filter(action=>!condition||condition===index.condition(action));\n      if(item.scope.kind&&(targets.length!==1||!targetConditions(facts,targets[0])))return unverified;"
    new = "      const diagScopeTargets=index.matching(item.scope),targets=diagScopeTargets.filter(action=>!condition||condition===index.condition(action));\n      if(item.scope.kind){\n        if(targets.length!==1)return finish(unverified,!diagScopeTargets.length?'scope_matches_zero':!targets.length?'bound_condition_matches_zero':'scope_matches_multiple',{scopeCount:diagScopeTargets.length,boundCount:targets.length,boundConditionPresent:!!condition});\n        if(!targetConditions(facts,targets[0]))return finish(unverified,'browser_target_conditions_missing',{scopeCount:diagScopeTargets.length,boundCount:targets.length});\n      }"
    replace(old, new, 'target matching split')
    replace('          if(!previous.size)return unverified;', "          if(!previous.size)return finish(unverified,'source_previous_controls_zero');", 'previous controls')
    replace("return {skip:true,reason:'current_review_occurrence_present',stop:!o.boundaries?.at(-1)};",
            "return finish({skip:true,reason:'current_review_occurrence_present',stop:!o.boundaries?.at(-1)},'current_review_occurrence_present');", 'review current present')
    replace('      return sameObservedState(source,o)?unverified:eligible;', "      return sameObservedState(source,o)?finish(unverified,'same_observed_state'):finish(eligible,'eligible');", 'same observed state')
    replace('            try{values.set(item.id,projectSourceItem(item,facts));projectionCount++;}',
            "            try{values.set(item.id,projectSourceItem(item,facts,'speculative'));\n              let origins=diagProjectionOrigins.get(facts.source.id);if(!origins){origins=new Map();diagProjectionOrigins.set(facts.source.id,origins);}\n              origins.set(item.id,diagLatestProjection);projectionCount++;}", 'cache origin registry')
    replace('            catch{selectionView?.assertCurrent();/* Speculation cannot fail an unrelated item; retry its actual candidate normally. */}',
            "            catch(error){diag('projection.error',{itemId:item.id,sourceId:facts.source.id,mode:'speculative',error:String(error)});selectionView?.assertCurrent();/* Speculation cannot fail an unrelated item; retry its actual candidate normally. */}", 'speculative failure')
    replace('    // Strict-checkpoint strategy facts are lazy and bounded to this selection.', EXPLANATION + '    // Strict-checkpoint strategy facts are lazy and bounded to this selection.', 'actual-only explanations')
    replace('      projections.clear();projectionCount=0;', '      projections.clear();projectionCount=0;diagProjectionOrigins.clear();', 'diagnostic origin invalidation')
    replace('      if(reviewFallback&&!reviewFallback.pageIds.has(item.id))continue;', "      if(reviewFallback&&!reviewFallback.pageIds.has(item.id)){diagDone(item.id,'review_fallback_page_priority');continue;}", 'review fallback item gate')
    replace("      if(validReviewRecoveryWait(task,item,o,id=>read(id)?.source)){deferSelection(item.id,recoveryConditionVersion(o),'unchanged_unresolved_review',o.id);continue;}",
            "      const diagWaitValid=validReviewRecoveryWait(task,item,o,id=>diagWaitSource(item,id));\n      if(item.reviewRecoveryWait)diag('wait.result',{itemId:item.id,valid:diagWaitValid});\n      if(diagWaitValid){deferSelection(item.id,recoveryConditionVersion(o),'unchanged_unresolved_review',o.id);continue;}", 'wait original read explanation')
    replace("      let reason=candidates.length?'source_target_unverified':", "      diag('item.candidates',{itemId:item.id,checkpointIds:candidates.map(c=>c.id),sourceIds:candidates.map(c=>c.observationId),refs,returnToSource});\n      let reason=candidates.length?'source_target_unverified':", 'actual candidate order')
    replace('        const checkpoint=candidates[candidateIndex];', "        const checkpoint=candidates[candidateIndex];\n        diagActual={itemId:item.id,checkpointId:checkpoint.id,sourceId:checkpoint.observationId,index:candidateIndex};\n        diag('candidate.begin',diagActual);", 'actual candidate begin')
    replace('        if(projected?.skip){if(projected.reason)reason=projected.reason;if(projected.stop)break;continue;}',
            "        if(projected)diag('projection.hit',{...diagActual,origin:diagProjectionOrigins.get(checkpoint.observationId)?.get(item.id),skip:projected.skip,stop:!!projected.stop,productReason:projected.reason});\n        if(projected?.skip){diagExplain(item,checkpoint.observationId,projected.reason||'source_target_unverified');diagExit('projection_rejected',{cacheHit:true,origin:diagProjectionOrigins.get(checkpoint.observationId)?.get(item.id),stop:!!projected.stop});if(projected.reason)reason=projected.reason;if(projected.stop)break;continue;}", 'cache hit and actual cached exit')
    replace('        const facts=read(checkpoint.observationId);if(!facts)continue;', "        const facts=read(checkpoint.observationId);if(!facts){diagExit('source_material_unavailable');continue;}", 'missing source')
    replace('        projected||=projectSourceItem(item,facts);', "        const diagCached=!!projected;projected||=projectSourceItem(item,facts);\n        const diagOrigin=diagCached?diagProjectionOrigins.get(checkpoint.observationId)?.get(item.id):diagLatestProjection;\n        diag('candidate.projected',{...diagActual,origin:diagOrigin,cacheHit:diagCached,skip:projected.skip});", 'actual projection source')
    replace('        if(projected.skip){\n          // After', "        if(projected.skip){\n          diagExplain(item,checkpoint.observationId,projected.reason||'source_target_unverified',facts);\n          diagExit('projection_rejected',{cacheHit:false,origin:diagOrigin,stop:!!projected.stop});\n          // After", 'actual uncached exit')
    for reason in ['mapped_route_debt_source_unverified', 'legacy_route_debt_unmapped', 'route_condition_unverified', 'checkpoint_no_known_path']:
        replace("reason='" + reason + "';continue;", "reason='" + reason + "';diagExit(reason);continue;", 'route gate ' + reason)
    replace('if(!retry.allowed){reason=`route_retry_${retry.reason}`;continue;}', 'if(!retry.allowed){reason=`route_retry_${retry.reason}`;diagExit(reason,{routeKey:key});continue;}', 'retry gate')
    replace('          if(pageIds.size){reviewFallback={recovery,route,pageIds,epoch};break;}', "          if(pageIds.size){reviewFallback={recovery,route,pageIds,epoch};diagExit('retained_as_review_fallback');diagDone(item.id,'review_fallback_retained');break;}", 'review fallback candidate')
    replace('        guard();bindScheduledRoute(schedule,key,route);complete();return recovery;', "        guard();bindScheduledRoute(schedule,key,route);complete();diagSelected=true;diagExit('selected');diagDone(item.id,'selected');return recovery;", 'selected actual')
    replace('      guard();bindScheduledRoute(schedule,recovery.routeKey,route);complete();return recovery;', "      guard();bindScheduledRoute(schedule,recovery.routeKey,route);complete();diagSelected=true;diagDone(recovery.itemId,'selected_review_fallback');return recovery;", 'selected fallback')
    replace('      selectionView?.close();selectionView=undefined;', "      selectionView?.close();selectionView=undefined;\n      for(const item of task.plan)diag('plan.final',{itemId:item.id,...diagPlans.get(item.id),completed:diagCompleted,selected:diagSelected});", 'all plan terminal states')
    import_line = "import { browserOperationCorrespondenceHint, browserTargetConditions, hasReviewedDismissal, sameObservedState } from '@interaction/browser';"
    assert prefix.count(import_line) == 1
    prefix = prefix.replace(import_line, import_line.replace('browserOperationCorrespondenceHint,', 'classificationCorrespondenceConditions, browserOperationCorrespondenceHint,'))
    return prefix + body + suffix, changes


def apply_worker(original):
    """Retain the proven worker guards and add one bounded, post-selector query."""
    old = '  report.resourcesAtSelectionEnd = { memory: process.memoryUsage(), usage: process.resourceUsage() };'
    assert original.count(old) == 1
    new = r'''
  await stage('diagnostic_all_checkpoint_strategies', () => {
    const checkpoints=host.list(cfg.sessionId,'checkpoint');
    assert.equal(checkpoints.length,57);assert.equal(new Set(checkpoints.map((c:any)=>c.id)).size,57);
    let calls=0;
    for(let start=0;start<checkpoints.length;start+=8){
      const batch=checkpoints.slice(start,start+8),ids=batch.map((c:any)=>c.id);
      (globalThis as any).__bieRecoveryDiagnostic('checkpoint.batch.begin',{ids});
      const results=host.checkpointRecoveryCandidates(cfg.sessionId,{observationId:cfg.currentObservationId,checkpointIds:ids});calls++;
      for(const checkpoint of batch){
        const matches=results.filter((row:any)=>row.checkpointId===checkpoint.id);
        (globalThis as any).__bieRecoveryDiagnostic('checkpoint.assessment',{checkpointId:checkpoint.id,sourceId:checkpoint.observationId,
          rows:matches.length,assessment:matches.length===1?matches[0]:null,
          diagnosticOnly:true,tryableIsNotArrivalOrExecutionPermission:true});
      }
    }
    (globalThis as any).__bieRecoveryDiagnostic('checkpoint.complete',{calls,checkpoints:checkpoints.length});
  });
''' + old
    return original.replace(old, new, 1)
