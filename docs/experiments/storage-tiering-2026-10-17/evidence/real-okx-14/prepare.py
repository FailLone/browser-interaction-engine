"""Reuse the prior byte-only preparation protocol for an explicitly configured run14."""
import importlib.util
import json
import sys
from pathlib import Path
here=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('run13_files',here.parent/'real-okx-13/window_files.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.HERE=here

def context():
    c=json.loads((here/'window.json').read_text())
    source,destination=m.ROOT/c['source'],m.ROOT/c['destination']
    assert c['window']==14 and source!=destination
    assert source.parent==destination.parent==m.ROOT/'.data'
    prior_path=(here/c['priorClosedEvidence']).resolve()
    assert m.digest(prior_path)==c['priorClosedEvidenceSha256']
    prior=json.loads(prior_path.read_text())
    assert prior['runId']==c['priorRunId'] and prior['source']==str(source)
    return c,source,destination,prior

m.context=context
if __name__=='__main__':
    assert len(sys.argv)==3 and sys.argv[1]=='--prepare'
    m.prepare(sys.argv[2])
