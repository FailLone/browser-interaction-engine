import ts from 'typescript';
import { resolve } from 'node:path';

// Compile a consumer against package exports, without the development condition.
// Source typechecks alone miss return types erased by private declaration emit.
const file = resolve('.data/public-types-consumer.mts');
const source = `
import type { BrowserEngine } from '@interaction/browser';
declare const engine: BrowserEngine;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Assert<T extends true> = T;
const full = engine.explorationSnapshot('session');
const current = engine.explorationSnapshot('session', undefined, {includeHistoryAudit: false});
type FullIsTyped = Assert<NotAny<typeof full>>;
type CurrentIsTyped = Assert<NotAny<typeof current>>;
type ActionIsTyped = Assert<NotAny<typeof current.actions[number]>>;
type BlockerIsTyped = Assert<NotAny<typeof current.availability.actions[number]['blockers'][number]>>;
const fullHistory: true = full.historyAuditIncluded;
const noHistory: false = current.historyAuditIncluded;
const noFrontier: undefined = current.frontier;
full.frontier.map(item => item.status);
current.actions.map(action => action.observationId);
// @ts-expect-error Current facts do not contain historical coverage.
current.frontier.map(item => item.status);
// @ts-expect-error An omitted historical audit cannot supply completion evidence.
engine.explorationSnapshot('session', undefined, {includeHistoryAudit: false, includeCompletionAudit: true}).completionAudit.nonexistent;
// @ts-expect-error Structured availability does not permit invented fields.
current.availability.actions[0].blockers[0].inventedPermission;
`;
const options = {module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: ['node'], customConditions: []};
const host = ts.createCompilerHost(options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version, true) : getSourceFile(name, version, ...rest);
const program = ts.createProgram([file], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: x => x, getNewLine: () => '\n'}));
console.log('Published exploration snapshot types: passed');
