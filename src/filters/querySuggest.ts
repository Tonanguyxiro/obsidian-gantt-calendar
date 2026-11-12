/**
 * 筛选查询框的输入补全（纯函数：文本 + 光标 → 候选）
 *
 * 按引擎给出语法关键字，并在值的位置给出库内的标签 / 文件夹 / 属性名 / 属性值：
 * - Tasks：过滤器短语（due before、tags include …）；tag includes 后给 #标签，path includes 后给文件夹，
 *   priority / status.type / 日期比较后给可选值；大写 AND / OR / NOT
 * - Dataview：TASK / LIST / FROM / WHERE … 与字段名；# 后给标签，FROM "… 内给文件夹
 * - Datacore：@task / @page、$completed 等字段；# 后给标签，path(" 内给文件夹
 * - Bases：file.* 成员与方法、属性名；file.hasTag(" 内给标签，file.inFolder(" 内给文件夹，prop == " 后给属性值
 *
 * 关键字列表只在已输入至少一个字符或显式触发（Ctrl+Space）时给出；值位置（引号内、# 后、操作符后）即使为空也给出。
 */

import { RegularExpressions } from '../utils/RegularExpressions';
import type { QueryEngine } from './queryEngines';

export type SuggestionKind = 'keyword' | 'field' | 'function' | 'tag' | 'folder' | 'property' | 'value';

export interface Suggestion {
	/** 列表中显示的文本 */
	label: string;
	/** 替换 [from, to) 的文本 */
	insert: string;
	kind: SuggestionKind;
	/** 插入后光标相对 insert 起点的位置；缺省为 insert 末尾 */
	caret?: number;
}

export interface SuggestResult {
	from: number;
	to: number;
	items: Suggestion[];
}

export interface SuggestVocab {
	/** 不带 # 的标签 */
	tags: string[];
	folders: string[];
	properties: string[];
	propertyValues?: (property: string) => string[];
	/** 今天（YYYY-MM-DD），用于日期值候选 */
	today?: string;
}

export interface SuggestOptions {
	/** 显式触发（Ctrl+Space）：空词也给出关键字 */
	explicit?: boolean;
	/** 'task'：任务页（Dataview / Datacore 给任务字段）；'file'：文件页 */
	page?: 'task' | 'file';
	limit?: number;
}

const RE = RegularExpressions.QueryAssist;
const DEFAULT_LIMIT = 50;

// ===== 关键字表 =====

const TASKS_DATE_FIELDS = ['due', 'scheduled', 'starts', 'created', 'done'];
const TASKS_KEYWORDS: string[] = [
	'not done',
	'done',
	...TASKS_DATE_FIELDS.flatMap((f) => [`${f} before `, `${f} after `, `${f} on `, `${f} on or before `, `${f} on or after `]),
	...['due', 'scheduled', 'starts'].flatMap((f) => [`${f} this week`, `${f} next week`, `${f} last week`, `${f} this month`, `${f} next month`]),
	...['due', 'scheduled', 'start', 'created', 'done', 'cancelled'].flatMap((f) => [`has ${f} date`, `no ${f} date`]),
	'tags include ',
	'tag includes ',
	'tag does not include ',
	'has tags',
	'no tags',
	'path includes ',
	'path does not include ',
	'folder includes ',
	'filename includes ',
	'description includes ',
	'description does not include ',
	'description regex matches /',
	'priority is ',
	'priority is not ',
	'priority above ',
	'priority below ',
	'status.type is ',
	'status.type is not ',
	'status.name includes ',
	'is recurring',
	'is not recurring',
];
const TASKS_BOOLEANS = ['AND ', 'OR ', 'NOT '];
const TASKS_PRIORITIES = ['highest', 'high', 'medium', 'none', 'low', 'lowest'];
const TASKS_STATUS_TYPES = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'];

const DATAVIEW_COMMON = ['FROM ', 'WHERE ', 'SORT ', 'GROUP BY ', 'FLATTEN ', 'LIMIT ', 'AND ', 'OR ', 'ASC', 'DESC'];
const DATAVIEW_TASK_KEYWORDS = [
	'TASK ', ...DATAVIEW_COMMON,
	'completed', '!completed', 'fullyCompleted', 'checked', 'status', 'text', 'tags',
	'due', 'scheduled', 'start', 'created', 'completion', 'priority', 'section',
	'file.name', 'file.path', 'file.folder', 'file.tags', 'file.link',
];
const DATAVIEW_FILE_KEYWORDS = [
	'LIST ', 'TABLE ', ...DATAVIEW_COMMON,
	'file.name', 'file.path', 'file.folder', 'file.tags', 'file.link', 'file.mtime', 'file.ctime',
	'file.size', 'file.day', 'file.outlinks', 'file.inlinks', 'file.frontmatter',
];
const DATAVIEW_FUNCTIONS: Array<[string, number]> = [
	['date(today)', -1], ['date(tomorrow)', -1], ['dur(7 days)', -1], ['contains()', 9], ['length()', 7], ['default()', 8],
];

const DATACORE_TASK_KEYWORDS = [
	'@task', '@list-item', 'and ', 'or ', '!',
	'$completed', '$status', '$text', '$tags', '$symbol', '$file', '$line', '$parent',
	'= true', '= false',
];
const DATACORE_FILE_KEYWORDS = [
	'@page', '@section', 'and ', 'or ', '!',
	'$path', '$name', '$tags', '$ctime', '$mtime', '$size', '$extension', '$links',
];
const DATACORE_FUNCTIONS: Array<[string, number]> = [
	['path("")', 6], ['childof()', 8], ['parentof()', 9], ['exists()', 7],
];

const BASES_FILE_MEMBERS = ['name', 'basename', 'path', 'folder', 'ext', 'size', 'ctime', 'mtime', 'tags', 'links'];
const BASES_FILE_METHODS: Array<[string, number]> = [
	['hasTag("")', 8], ['inFolder("")', 10], ['hasProperty("")', 13], ['hasLink("")', 9],
];
const BASES_VALUE_METHODS: Array<[string, number]> = [
	['contains("")', 10], ['startsWith("")', 12], ['endsWith("")', 10], ['isEmpty()', -1], ['lower()', -1],
	['containsAny("")', 13], ['containsAll("")', 13], ['length', -1],
];
const BASES_GLOBALS: Array<[string, number]> = [
	['now()', -1], ['today()', -1], ['date("")', 6], ['if()', 3], ['list()', 5],
];

// ===== 匹配与排序 =====

/** 0 前缀；1 词首；2 词中包含；-1 不匹配（不区分大小写） */
function rank(candidate: string, query: string): number {
	if (!query) return 0;
	const c = candidate.toLowerCase();
	const q = query.toLowerCase();
	if (c.startsWith(q)) return 0;
	// 词首匹配至少 2 个字符、词中匹配至少 3 个字符，避免单个字母带出一长串
	let best = -1;
	for (let idx = c.indexOf(q, 1); idx >= 0; idx = c.indexOf(q, idx + 1)) {
		const r = RE.wordBoundary.test(c[idx - 1]) ? 1 : 2;
		if ((r === 1 && q.length >= 2) || (r === 2 && q.length >= 3)) best = best < 0 ? r : Math.min(best, r);
		if (best === 1) break;
	}
	return best;
}

function pick(items: Suggestion[], query: string, limit: number, matchOn: (s: Suggestion) => string = (s) => s.label): Suggestion[] {
	const q = query.trim();
	const scored: Array<[number, number, Suggestion]> = [];
	const seen = new Set<string>();
	items.forEach((s, i) => {
		if (seen.has(s.insert)) return;
		const target = matchOn(s);
		// 已经完整输入的候选不再提示
		if (q && target.trim().toLowerCase() === q.toLowerCase()) return;
		const r = rank(target, q);
		if (r < 0) return;
		seen.add(s.insert);
		scored.push([r, i, s]);
	});
	scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return scored.slice(0, limit).map((x) => x[2]);
}

const kw = (list: string[], kind: SuggestionKind = 'keyword'): Suggestion[] => list.map((k) => ({ label: k.trim(), insert: k, kind }));
const fn = (list: Array<[string, number]>, kind: SuggestionKind = 'function'): Suggestion[] =>
	list.map(([k, caret]) => ({ label: k, insert: k, kind, caret: caret < 0 ? undefined : caret }));

function result(from: number, to: number, items: Suggestion[]): SuggestResult | null {
	return items.length ? { from, to, items } : null;
}

function tagItems(vocab: SuggestVocab, withHash: boolean): Suggestion[] {
	return vocab.tags.map((t) => {
		const name = t.startsWith('#') ? t.slice(1) : t;
		const text = withHash ? `#${name}` : name;
		return { label: `#${name}`, insert: text, kind: 'tag' as const };
	});
}

function folderItems(vocab: SuggestVocab, suffix = ''): Suggestion[] {
	return vocab.folders.filter(Boolean).map((f) => ({ label: f, insert: f + suffix, kind: 'folder' as const }));
}

const stripHash = (s: string): string => (s.startsWith('#') ? s.slice(1) : s);

/** 补上闭合引号（光标后紧跟的不是引号时） */
function closingQuote(text: string, caret: number, quote: string): string {
	return text[caret] === quote ? '' : quote;
}

// ===== 各引擎 =====

function suggestTasks(text: string, caret: number, lineBefore: string, vocab: SuggestVocab, opts: SuggestOptions, limit: number): SuggestResult | null {
	// 当前片段：最后一个括号 / 大写 AND / OR / NOT 之后
	const pieces = lineBefore.split(RE.tasksSegmentSplit);
	const rawSeg = pieces[pieces.length - 1] ?? '';
	const seg = rawSeg.trimStart();
	const segFrom = caret - seg.length;

	const valueAt = (arg: string) => caret - arg.length;
	let m = RE.tasksTagArg.exec(seg);
	if (m) return result(valueAt(m[1]), caret, pick(tagItems(vocab, true), stripHash(m[1]), limit));
	m = RE.tasksFolderArg.exec(seg);
	if (m) return result(valueAt(m[1]), caret, pick(folderItems(vocab, '/'), m[1], limit));
	m = RE.tasksPriorityArg.exec(seg);
	if (m) return result(valueAt(m[1]), caret, pick(kw(TASKS_PRIORITIES, 'value'), m[1], limit));
	m = RE.tasksStatusTypeArg.exec(seg);
	if (m) return result(valueAt(m[1]), caret, pick(kw(TASKS_STATUS_TYPES, 'value'), m[1], limit));
	m = RE.tasksDateArg.exec(seg);
	if (m) {
		const dates = ['today', 'tomorrow', 'yesterday', ...(vocab.today ? [vocab.today] : []), 'in 7 days', '7 days ago'];
		const hit = pick(kw(dates, 'value'), m[1], limit);
		if (hit.length) return result(valueAt(m[1]), caret, hit);
		// "due on o…" 也可能是在输入 "due on or before"，落到关键字匹配
	}

	if (!seg && !opts.explicit) return null;
	const keywords = pick(kw(TASKS_KEYWORDS), seg, limit);
	if (keywords.length) return result(segFrom, caret, keywords);

	// 一个完整过滤器之后输入大写 A / O / N → 布尔运算符
	const word = RE.lastWord.exec(lineBefore)?.[0] ?? '';
	if (word && word === word.toUpperCase() && lineBefore.trim().length > word.length) {
		return result(caret - word.length, caret, pick(kw(TASKS_BOOLEANS), word, limit));
	}
	return null;
}

function suggestDataview(text: string, caret: number, lineBefore: string, vocab: SuggestVocab, opts: SuggestOptions, limit: number): SuggestResult | null {
	const fromQuote = RE.dataviewFromQuote.exec(lineBefore);
	if (fromQuote) {
		const arg = fromQuote[1];
		return result(caret - arg.length, caret, pick(folderItems(vocab, closingQuote(text, caret, '"')), arg, limit, (s) => s.label));
	}
	const word = RE.lastWord.exec(lineBefore)?.[0] ?? '';
	if (word.startsWith('#')) return result(caret - word.length, caret, pick(tagItems(vocab, true), word.slice(1), limit));
	if (!word && !opts.explicit) return null;
	const base = opts.page === 'file'
		? [...kw(DATAVIEW_FILE_KEYWORDS), ...vocab.properties.map((p) => ({ label: p, insert: p, kind: 'property' as const }))]
		: kw(DATAVIEW_TASK_KEYWORDS);
	return result(caret - word.length, caret, pick([...base, ...fn(DATAVIEW_FUNCTIONS)], word, limit));
}

function suggestDatacore(text: string, caret: number, lineBefore: string, vocab: SuggestVocab, opts: SuggestOptions, limit: number): SuggestResult | null {
	const pathArg = RE.datacorePathArg.exec(lineBefore);
	if (pathArg) {
		const arg = pathArg[1];
		return result(caret - arg.length, caret, pick(folderItems(vocab), arg, limit));
	}
	const word = RE.lastWord.exec(lineBefore)?.[0] ?? '';
	if (word.startsWith('#')) return result(caret - word.length, caret, pick(tagItems(vocab, true), word.slice(1), limit));
	if (!word && !opts.explicit) return null;
	const base = opts.page === 'file'
		? [...kw(DATACORE_FILE_KEYWORDS), ...vocab.properties.map((p) => ({ label: p, insert: p, kind: 'property' as const }))]
		: kw(DATACORE_TASK_KEYWORDS);
	return result(caret - word.length, caret, pick([...base, ...fn(DATACORE_FUNCTIONS)], word, limit));
}

function suggestBases(text: string, caret: number, lineBefore: string, vocab: SuggestVocab, opts: SuggestOptions, limit: number): SuggestResult | null {
	// 字符串参数：file.hasTag("… / file.inFolder("… / file.hasProperty("…
	const call = RE.callStringArg.exec(lineBefore);
	if (call) {
		const callee = call[1];
		const arg = call[2];
		const from = caret - arg.length;
		if (callee === 'file.hasTag') return result(from, caret, pick(tagItems(vocab, false), stripHash(arg), limit, (s) => s.insert));
		if (callee === 'file.inFolder') return result(from, caret, pick(folderItems(vocab), arg, limit));
		if (callee === 'file.hasProperty') return result(from, caret, pick(vocab.properties.map((p) => ({ label: p, insert: p, kind: 'property' as const })), arg, limit));
		return null;
	}
	// 比较右侧：status == "…
	const cmp = RE.compareStringArg.exec(lineBefore);
	if (cmp) {
		const prop = cmp[1].startsWith('note.') ? cmp[1].slice(5) : cmp[1];
		if (prop.startsWith('file.')) return null;
		const values = (vocab.propertyValues?.(prop) ?? []).map((v) => ({ label: v, insert: v, kind: 'value' as const }));
		return result(caret - cmp[2].length, caret, pick(values, cmp[2], limit));
	}

	const chain = RE.identChain.exec(lineBefore)?.[0] ?? '';
	const dot = chain.lastIndexOf('.');
	if (dot >= 0) {
		const owner = chain.slice(0, dot);
		const partial = chain.slice(dot + 1);
		const from = caret - partial.length;
		if (owner === 'file') {
			return result(from, caret, pick([...kw(BASES_FILE_MEMBERS, 'field'), ...fn(BASES_FILE_METHODS)], partial, limit));
		}
		if (owner === 'note') {
			return result(from, caret, pick(vocab.properties.map((p) => ({ label: p, insert: p, kind: 'property' as const })), partial, limit));
		}
		return result(from, caret, pick(fn(BASES_VALUE_METHODS), partial, limit));
	}
	if (!chain && !opts.explicit) return null;
	const items: Suggestion[] = [
		...BASES_FILE_MEMBERS.map((m) => ({ label: `file.${m}`, insert: `file.${m}`, kind: 'field' as const })),
		...BASES_FILE_METHODS.map(([m, c]) => ({ label: `file.${m}`, insert: `file.${m}`, kind: 'function' as const, caret: c + 5 })),
		...vocab.properties.map((p) => ({ label: p, insert: p, kind: 'property' as const })),
		...fn(BASES_GLOBALS),
	];
	return result(caret - chain.length, caret, pick(items, chain, limit));
}

/**
 * 求光标处的补全候选
 * @returns null 表示不弹出
 */
export function getQuerySuggestions(
	engine: QueryEngine,
	text: string,
	caret: number,
	vocab: SuggestVocab,
	opts: SuggestOptions = {},
): SuggestResult | null {
	const pos = Math.max(0, Math.min(caret, text.length));
	const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
	const lineBefore = text.slice(lineStart, pos);
	const limit = opts.limit ?? DEFAULT_LIMIT;
	switch (engine) {
		case 'tasks': return suggestTasks(text, pos, lineBefore, vocab, opts, limit);
		case 'dataview': return suggestDataview(text, pos, lineBefore, vocab, opts, limit);
		case 'datacore': return suggestDatacore(text, pos, lineBefore, vocab, opts, limit);
		case 'bases': return suggestBases(text, pos, lineBefore, vocab, opts, limit);
	}
}

/** 应用候选：返回新文本与新光标位置 */
export function applySuggestion(text: string, res: Pick<SuggestResult, 'from' | 'to'>, item: Suggestion): { text: string; caret: number } {
	const next = text.slice(0, res.from) + item.insert + text.slice(res.to);
	return { text: next, caret: res.from + (item.caret ?? item.insert.length) };
}
