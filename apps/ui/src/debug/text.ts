import type { ResolvedViewport, Run, ViewportOption, ViewportPreset } from './types.js';

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || response.statusText);
  return body as T;
}

export const statusText: Record<Run['status'], string> = {
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  interrupted: '已中断',
};
export const pluginText: Record<string, string> = { rules: 'UI 规则' };
export const viewportText: Record<ViewportPreset | 'custom', string> = {
  desktop: '桌面 1280×800',
  'desktop-edge': '桌面临界（按页面断点）',
  mobile: '移动 iPhone 393×852',
  custom: '自定义',
};
const presetText: Record<ViewportPreset, string> = { desktop: '桌面', 'desktop-edge': '桌面临界', mobile: '移动' };
/** The requested viewport in a few words, for runs whose actual viewport is not known yet. */
export const requestedViewport = (v: ViewportOption = { width: 1440, height: 900 }) =>
  typeof v === 'string' ? presetText[v] : `${v.width}×${v.height}${v.mobile ? ' 移动' : ''}`;
/** The viewport a run used, with how desktop-edge chose its width. */
export const resolvedViewport = (v: ResolvedViewport) =>
  `${v.preset ? presetText[v.preset] : '自定义'} ${v.width}×${v.height}${v.mobile && v.preset !== 'mobile' ? ' 移动' : ''}` +
  (v.source === 'detected' ? '（页面断点）' : v.source === 'fallback' ? '（未探测到断点，用默认值）' : '');
export const severityText: Record<string, string> = { info: '提示', warning: '警告', error: '错误' };
export const outcomeText: Record<string, string> = { ok: '有变化', no_change: '无变化', failed: '失败' };
export const kindText: Record<string, string> = {
  click: '点击',
  hover: '悬停',
  fill: '输入',
  select: '选择',
  press: '按键',
};
export const tierText: Record<string, string> = {
  overlay: '弹层内',
  body: '正文',
  'in-page-disclosure': '展开',
  chrome: '页头页脚',
  navigate: '跳转',
  route: '路由',
};
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
export const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
};
export const usd = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(3)}`;
/** Stop reasons as the user should read them; older runs only recorded budget_exhausted. */
export const stopText: Record<string, string> = {
  goal_answered: '目标问题已得到回答',
  scope_exhausted: '页面已测完',
  no_progress: '页面反复回到同一状态，停止',
  time_limit: '到达时长上限',
  action_limit: '到达动作数上限',
  budget_exhausted: '到达时长或动作数上限',
  stopped: '手动停止',
  session_invalid: '登录态校验未通过，已阻止继续检查',
  error: '运行出错',
};
export const backtrackText: Record<string, string> = {
  state_exhausted: '这条路测完了，回到还有事可做的状态',
  'state_exhausted:escape': '弹层测完了，按 Esc 关闭',
  left_scope: '离开了当前页面，返回',
  capture_failed: '页面抓取失败，重放回原状态',
  'capture_failed:escape': '页面抓取失败，按 Esc 关闭弹层',
};
export const navigationText: Record<string, string> = {
  intercepted: '已拦截',
  kept: '同页路由，保留',
  reverted: '同页路由，已撤回',
  followed: '已跟随',
};
/** Why the crawler asked a model, by question / request purpose. */
export const questionText: Record<string, { title: string; why: string }> = {
  interactive: {
    title: '值不值得点',
    why: '控件只有弱交互信号（手型光标、tabindex、事件属性），程序判断不了它是不是可操作的。判为"否"的不会被点击。',
  },
  effect: {
    title: '算不算新内容',
    why: '动作后页面结构没变，但出现了新文字，需要判断是有意义的新内容（提示、展开），还是行情数字跳动、页面自己加载出来的内容。判为"无实质变化"或"与动作无关"的不算新状态。',
  },
  'same-kind': {
    title: '列表是否同类',
    why: '一组列表项名字各不相同。同类（币种、文章）只抽样测一两个；不同类（不同功能入口）会逐个测试。',
  },
  exit: {
    title: '是不是关闭弹窗',
    why: '弹窗里没有从结构或中英文名称认出的关闭按钮（其他语言、只有图标），需要判断哪些控件只是关掉弹窗。关闭类控件排在最后，先测弹窗里的内容。',
  },
  'input-kind': {
    title: '输入框类型',
    why: '从输入框的属性判断不出它要填什么（数字、搜索、邮箱……），按类型决定填入的样本值。',
  },
  relevance: { title: '和目标是否相关', why: '目标模式下，判断动作是否属于要测的目标，不相关的不执行。' },
  'goal-relevance': { title: '和目标是否相关', why: '目标模式下，判断动作是否属于要测的目标，不相关的不执行。' },
  'goal-plan': { title: '拆解测试目标', why: '目标模式下，把测试目标拆成关注点和任务。' },
  'goal-pursuit': {
    title: '找目标问题的答案',
    why: '目标模式下，每到一个新状态，让 LLM 读新出现的文字：答案找到了没有，没有的话下一步点哪个最可能找到。',
  },
};
/** `crawler-interactive+same-kind` → the question kinds in a call. */
export const purposeKinds = (purpose: string) => purpose.replace(/^crawler-/, '').split('+');
export const verdictText: Record<string, string> = { yes: '是', no: '否', uncertain: '不确定' };
export const sourceText: Record<string, string> = {
  jev: 'JEV',
  llm: 'LLM',
  none: '模型不可用',
  structure: '按结构',
  default: '默认',
};
/** JEV and LLM are told apart by color wherever they appear. */
export const providerClass: Record<'jev' | 'llm', string> = {
  jev: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  llm: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
};
/** A judgement's conclusion in a few words; an effect rejected as the page's own change says so. */
export const verdictLabel = (j: { verdict: string; detail?: string; unrelated?: number }) =>
  j.detail ?? (j.verdict === 'no' && j.unrelated !== undefined && j.unrelated >= 0.5 ? '无关' : verdictText[j.verdict]);
/**
 * What each verdict means and what the crawler does with it, per question kind. Uncertain
 * follows the crawler: weak controls are still tried, unclear text still counts as a state,
 * unclear lists are still sampled.
 */
export const verdictMeaning: Record<string, Partial<Record<'yes' | 'no' | 'uncertain', string>>> = {
  interactive: { yes: '可操作，会点击', no: '只是展示信息，不点击', uncertain: '拿不准，仍会点一次试试' },
  'same-kind': { yes: '同类，只抽样测一两个', no: '不同功能，逐个测试', uncertain: '拿不准，按同类抽样' },
  exit: { yes: '只是关闭弹窗，最后再点', no: '是弹窗里的功能，先测', uncertain: '拿不准，按弹窗内容先测' },
  effect: { yes: '是新内容，记为新状态', no: '无实质变化，不算新状态', uncertain: '拿不准，仍记为新状态' },
  'goal-relevance': { yes: '与目标相关，会执行', no: '与目标无关，不执行' },
  relevance: { yes: '与目标相关，会执行', no: '与目标无关，不执行' },
};
export const inputKindText: Record<string, string> = {
  number: '数字',
  search: '搜索',
  email: '邮箱',
  date: '日期',
  text: '文本',
};
