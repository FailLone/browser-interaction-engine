"""Verify the bounded OKX run offline; --raw also checks original evidence hashes.

This script never starts a browser or sends HTTP requests.
"""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHART = '9c06d5c3-703e-4184-8f60-0ee7c52415fc'
URL = 'https://www.okx.com/convert/btc-to-usd'


def read(path):
    return json.loads(path.read_text())


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def pick(obj, keys):
    return {key: obj[key] for key in keys.split() if key in obj}


def project(raw):
    def load(name):
        return read(raw / (name + '.json'))

    def chart(name):
        return next(g for g in load(name)['groups'] if g['id'] == CHART)

    def observation(o):
        return {
            **pick(o, 'id documentId url stable capturedAt'),
            'boundaries': o['boundaries'],
            'controls': [pick(c, 'localId name role value selected visible enabled')
                         for c in o['controls'] if c['localId'].split(':')[-1]
                         in ['1562', '1747', '1751', '1721', '1722']],
        }

    material = load('final-interventions')
    report = load('final-report')
    audit = report['completionAudit']
    events = load('closed-events')
    responses = load('final-intervention-responses')['items']
    continuations = load('final-continuations')['items']
    all_observations = load('final-observations')['items']
    return {
        'version': 'bounded-okx-upstream-acceptance/v1',
        'source': load('source-start'),
        'sourceEnd': load('source-end'),
        'reviewSource': 'codex-bounded-okx-review',
        'sessions': {name: load(name + '-session') for name in
                     ['initial', 'after-initial', 'after-amount', 'after-chart',
                      'before-retry', 'after-retry', 'closed']},
        'stages': {name: observation(load(name + '-observation')) for name in
                   ['initial', 'after-close', 'after-amount', 'after-chart']},
        'observations': [observation(o) for o in all_observations],
        'attempts': load('after-chart-attempts')['items'],
        'numericReview': load('final-control-reviews')['items'],
        'responses': responses,
        'continuations': [{k: v for k, v in c.items() if k != 'changes'} for c in continuations],
        'deferredChart': next(i for i in load('after-amount-interventions')['items']
                              if i.get('subject', {}).get('groupId') == CHART),
        'staleGuard': {
            'beforeGroup': chart('before-stale-groups'),
            'afterGroup': chart('after-stale-groups'),
            'beforeAttempts': load('before-stale-attempts')['items'],
            'afterAttempts': load('after-stale-attempts')['items'],
        },
        'retry': {
            'original': load('continue-chart-response')['continuation'],
            'repeated': load('retry-continue-chart-response')['continuation'],
            'beforeAttempts': load('before-retry-attempts')['items'],
            'afterAttempts': load('after-retry-attempts')['items'],
        },
        'eventCounts': dict(Counter(e['type'] for e in events)),
        'responseEventIds': [e['data']['id'] for e in events if e['type'] == 'interventions.responded'],
        'continuationEventIds': [e['data']['id'] for e in events if e['type'] == 'exploration.continuation'],
        'remaining': {
            'status': audit['status'], 'exhaustive': audit['exhaustive'],
            'recordedActionCounts': audit['recordedActions']['counts'],
            'unassignedControls': len(load('final-region-review')['unassignedControlIds']),
            'itemKinds': dict(Counter(i['kind'] for i in material['items'])),
            'itemStatuses': dict(Counter(i['status'] for i in material['items'])),
            'items': [pick(i, 'id kind reason status current blocking options subject')
                      for i in material['items']],
            'observationGaps': load('final-observation')['gaps'],
            'recoveryAttempts': load('final-recoveries')['total'],
        },
        'cleanup': load('cleanup'),
        'screenshots': {name: sha(raw / name) for name in ['after-close.png', 'after-chart.png']},
    }


def verify(d):
    assert d['source'] == d['sourceEnd']
    assert len(d['source']['sha256']) == 291
    assert d['source']['commit'] == 'e51297628e7177e8e62987f9aaf480f443f0df57'
    attempts = d['attempts']
    assert [(a['action']['kind'], a['action']['label'], a['action'].get('value')) for a in attempts] == [
        ('click', 'Close', None), ('fill', '0', '2'), ('click', '1h', None)]
    assert all(a['status'] == 'succeeded' and a['beforeId'] != a['afterId'] for a in attempts)
    assert len({o['documentId'] for o in d['observations']}) == 1
    assert all(o['url'] == URL for o in d['observations'])
    observations = {o['id']: o for o in d['observations']}
    assert all(a['beforeId'] in observations and a['afterId'] in observations for a in attempts)

    def control(stage, suffix):
        return next(c for c in d['stages'][stage]['controls'] if c['localId'].endswith(':' + suffix))

    assert d['stages']['initial']['boundaries']
    assert not d['stages']['after-close']['boundaries']
    assert control('after-close', '1747')['value'] == '1'
    assert control('after-amount', '1747')['value'] == '2'
    assert control('after-amount', '1751')['value'] == '164,220.6'
    assert control('after-amount', '1722')['selected'] == ['24h']
    assert control('after-amount', '1721')['selected'] == []
    assert d['sessions']['after-amount']['actionCount'] == 2
    assert d['deferredChart']['status'] == 'deferred'
    assert control('after-chart', '1721')['selected'] == ['1h']
    assert control('after-chart', '1722')['selected'] == []
    assert control('after-chart', '1747')['value'] == '2'
    assert d['numericReview'][0]['samples'] == ['2']

    responses = {r['requestId']: r for r in d['responses']}
    assert len(responses) == 6
    assert all(r['status'] == 'applied' for key, r in responses.items() if key != 'stale-chart-answer')
    assert responses['stale-chart-answer']['status'] == 'rejected'
    assert responses['stale-chart-answer']['error']['code'] == 'STALE_INTERVENTION'
    assert d['staleGuard']['beforeGroup']['revision'] == d['staleGuard']['afterGroup']['revision']
    assert d['staleGuard']['beforeGroup']['decisions'] == d['staleGuard']['afterGroup']['decisions']
    assert d['staleGuard']['beforeAttempts'] == d['staleGuard']['afterAttempts']
    assert len(d['continuations']) == 3
    for c in d['continuations']:
        assert c['status'] == 'started' and c['started']
        assert c['beforeId'] != c['afterId'] and observations[c['afterId']]['stable']
        assert all(check['result'] == 'pass' for check in c['checks'])
    assert d['retry']['original'] == d['retry']['repeated']
    assert d['retry']['beforeAttempts'] == d['retry']['afterAttempts']
    assert d['sessions']['before-retry'] == d['sessions']['after-retry']
    assert set(d['responseEventIds']) == {r['id'] for r in d['responses']}
    assert len(d['responseEventIds']) == 6
    assert set(d['continuationEventIds']) == {c['id'] for c in d['continuations']}
    assert len(d['continuationEventIds']) == 3
    assert d['eventCounts']['interventions.updated'] == 24
    assert d['remaining']['status'] == 'blocked' and d['remaining']['exhaustive'] is False
    assert d['remaining']['unassignedControls'] == 198
    assert d['remaining']['recordedActionCounts']['succeeded'] == 3
    assert d['remaining']['recoveryAttempts'] == 0
    assert d['sessions']['closed']['status'] == 'stopped'
    assert d['sessions']['closed']['actionCount'] == 3
    assert d['cleanup']['serverPortClosed']
    for name, digest in d['screenshots'].items():
        assert sha(HERE / name) == digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw', type=Path)
    parser.add_argument('--write', action='store_true', help='Create projection from the original run')
    args = parser.parse_args()
    if args.write:
        assert args.raw, '--write requires --raw'
        data = project(args.raw)
        (HERE / 'acceptance.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    data = read(HERE / 'acceptance.json')
    verify(data)
    if args.raw:
        assert data == project(args.raw), 'Committed projection differs from raw evidence'
        for name, digest in read(HERE / 'raw-sha256.json').items():
            assert sha(args.raw / name) == digest, name
    print('PASS: 3 bounded actions; defer/resume, stale guard, retry, durable records, retained gaps, cleanup')
