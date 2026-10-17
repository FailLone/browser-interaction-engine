from pathlib import Path
import hashlib,json
root=Path('/Users/xietian/.codex/worktrees/exploration-layered-refactor/browser-interaction-engine');source=root/'docs/experiments/storage-tiering-2026-10-17/evidence/real-okx-6/audit-steady/worker.ts';s=source.read_text();s=s.replace('allSaves:any[]=[],phases:any[]=[];', 'allSaves:any[]=[],phases:any[]=[],semanticStates:any[]=[];')
s=s.replace('   callOffset=allCalls.length;', '   semanticStates.push({phase,task:structuredClone(task),events:structuredClone(allEvents)});\n   callOffset=allCalls.length;')
s=s.replace('  return phases;', "  writeFileSync(config.semanticOutput,JSON.stringify({initial,states:semanticStates})+'\\n');\n  return phases;")
s=s.replace("protocol:'run6-serial-carried-state-audit-cpu-v1'", "protocol:'run6-factory-carried-state-audit-cpu-v1'")
# The complete original assertions remain byte-identical, including statuses, exact sources and route debt.
def oracle(text):return text[text.index('  const added='):text.index('  const report=')]
assert oracle(s)==oracle(source.read_text())
out=Path('/tmp/bie-run6-audit-factory-prep');(out/'worker.ts').write_text(s)
(out/'worker-provenance.json').write_text(json.dumps({'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'workerSha256':hashlib.sha256(s.encode()).hexdigest(),'oracleByteIdentical':True,'oracleSha256':hashlib.sha256(oracle(s).encode()).hexdigest(),'changes':'After each measured audit and all existing reporting, structuredClone actual task and accumulated event state. Serialize semantic snapshots outside all phase clocks. No task reset or metadata clearing.'},indent=2)+'\n')
