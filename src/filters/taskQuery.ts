/**
 * 任务过滤：Tasks 插件查询语法（子集）
 *
 * Tasks 插件没有公开"对任意任务集执行查询"的接口，这里按其文档实现常用过滤器。
 * 每行一个过滤器，行间 AND；单行内支持 (A) AND (B)、(A) OR (B)、NOT (A)。
 *
 *   done / not done / is recurring / is not recurring
 *   status.type is TODO|IN_PROGRESS|DONE|CANCELLED   status.name includes x
 *   has|no due|scheduled|start|created|done|cancelled date
 *   due|scheduled|starts|created|done|cancelled  before|after|on|on or before|on or after  <date>
 *   due this|next|last  week|month
 *   tag includes|does not include <text>    has tags / no tags
 *   path|filename|folder|description  includes|does not include|regex matches  <text|/re/i>
 *   priority is|is not|above|below  highest|high|medium|none|low|lowest
 *   <date> = today | tomorrow | yesterday | YYYY-MM-DD | N days|weeks (ago)
 */

import type { GCTask } from '../types';
import { RegularExpressions } from '../utils/RegularExpressions';
import { FilterSyntaxError } from './baseExpression';

export type TaskPredicate = (task: GCTask) => boolean;

export interface CompiledTaskQuery {
	predicate: TaskPredicate | null;
	errors: string[];
}

const DAY_MS = 86_400_000;

type DateField = 'dueDate' | 'scheduledDate' | 'startDate' | 'createdDate' | 'completionDate' | 'cancelledDate';

const DATE_FIELDS: Record<string, DateField> = {
	due: 'dueDate',
	scheduled: 'scheduledDate',
	starts: 'startDate',
	start: 'startDate',
	created: 'createdDate',
	done: 'completionDate',
	cancelled: 'cancelledDate',
};

/** Tasks 优先级顺序：highest < high < medium < none < low < lowest（越小越高） */
const PRIORITY_RANK: Record<string, number> = {
	highest: 0, high: 1, medium: 2, normal: 3, none: 3, low: 4, lowest: 5,
};

const STATUS_TYPE_KEYS: Record<string, (t: GCTask) => boolean> = {
	DONE: (t) => !!t.completed,
	CANCELLED: (t) => !!t.cancelled,
	IN_PROGRESS: (t) => !t.completed && !t.cancelled && (t.status ?? '') === 'in_progress',
	TODO: (t) => !t.completed && !t.cancelled && (t.status ?? 'todo') !== 'in_progress',
	NON_TASK: () => false,
};

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseDate(text: string): Date {
	const s = text.trim().toLowerCase();
	const today = startOfDay(new Date());
	if (s === 'today') return today;
	if (s === 'tomorrow') return new Date(today.getTime() + DAY_MS);
	if (s === 'yesterday') return new Date(today.getTime() - DAY_MS);
	if (RegularExpressions.Filters.isoDate.test(s)) {
		const [y, m, d] = s.split('-').map(Number);
		return new Date(y, m - 1, d);
	}
	const rel = RegularExpressions.Filters.relativeDate.exec(s);
	if (rel) {
		const days = Number(rel[1]) * (rel[2].startsWith('week') ? 7 : 1);
		return new Date(today.getTime() + (rel[3] ? -days : days) * DAY_MS);
	}
	throw new FilterSyntaxError(`Invalid date: ${text}`);
}

/** this|next|last week|month 的 [起, 止) 区间 */
function parseRange(which: string, unit: string): [Date, Date] {
	const offset = which === 'next' ? 1 : which === 'last' ? -1 : 0;
	const now = new Date();
	if (unit === 'week') {
		const day = (now.getDay() + 6) % 7; // 周一为一周起点
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + offset * 7);
		return [start, new Date(start.getTime() + 7 * DAY_MS)];
	}
	const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
	return [start, new Date(start.getFullYear(), start.getMonth() + 1, 1)];
}

function textMatcher(op: string, arg: string): (value: string) => boolean {
	if (op === 'regex matches' || op === 'regex does not match') {
		const m = RegularExpressions.Filters.regexLiteral.exec(arg);
		if (!m) throw new FilterSyntaxError(`Expected /pattern/flags: ${arg}`);
		let re: RegExp;
		try {
			re = new RegExp(m[1], m[2]);
		} catch {
			throw new FilterSyntaxError(`Invalid regex: ${arg}`);
		}
		return op === 'regex matches' ? (v) => re.test(v) : (v) => !re.test(v);
	}
	const needle = arg.toLowerCase();
	if (op === 'includes') return (v) => v.toLowerCase().includes(needle);
	if (op === 'does not include') return (v) => !v.toLowerCase().includes(needle);
	if (op === 'is') return (v) => v.toLowerCase() === needle;
	if (op === 'is not') return (v) => v.toLowerCase() !== needle;
	throw new FilterSyntaxError(`Unknown operator: ${op}`);
}

const TEXT_OPS = ['regex does not match', 'regex matches', 'does not include', 'includes', 'include', 'is not', 'is'];

/** 把 "<field> <op> <arg>" 拆成 op 与 arg，op 取最长匹配 */
function splitOp(rest: string): { op: string; arg: string } | null {
	const lower = rest.toLowerCase();
	for (const op of TEXT_OPS) {
		if (lower.startsWith(op + ' ')) {
			return { op: op === 'include' ? 'includes' : op, arg: rest.slice(op.length).trim() };
		}
	}
	return null;
}

function compileFilter(line: string): TaskPredicate {
	const text = line.trim();
	const lower = text.toLowerCase();

	if (lower === 'done') return (t) => t.completed;
	if (lower === 'not done') return (t) => !t.completed;
	if (lower === 'is recurring') return (t) => !!t.repeat;
	if (lower === 'is not recurring') return (t) => !t.repeat;
	if (lower === 'has tags') return (t) => (t.tags?.length ?? 0) > 0;
	if (lower === 'no tags') return (t) => (t.tags?.length ?? 0) === 0;

	const words = lower.split(RegularExpressions.Filters.whitespace);

	// has|no <field> date
	if ((words[0] === 'has' || words[0] === 'no') && words[2] === 'date' && words.length === 3 && DATE_FIELDS[words[1]]) {
		const field = DATE_FIELDS[words[1]];
		return words[0] === 'has' ? (t) => !!t[field] : (t) => !t[field];
	}

	// <field> (this|next|last) (week|month)
	const dateField = DATE_FIELDS[words[0]];
	if (dateField) {
		if (words.length === 3 && ['this', 'next', 'last'].includes(words[1]) && ['week', 'month'].includes(words[2])) {
			const [from, to] = parseRange(words[1], words[2]);
			return (t) => {
				const d = t[dateField];
				return !!d && d >= from && d < to;
			};
		}
		// <field> <comparator> <date>
		const rest = text.slice(words[0].length).trim();
		const restLower = rest.toLowerCase();
		const comparators: Array<[string, (d: number, ref: number) => boolean]> = [
			['on or before', (d, r) => d <= r],
			['on or after', (d, r) => d >= r],
			['before', (d, r) => d < r],
			['after', (d, r) => d > r],
			['on', (d, r) => d === r],
		];
		for (const [name, test] of comparators) {
			if (restLower.startsWith(name + ' ')) {
				const ref = parseDate(rest.slice(name.length)).getTime();
				return (t) => {
					const d = t[dateField];
					return !!d && test(startOfDay(d).getTime(), ref);
				};
			}
		}
		throw new FilterSyntaxError(`Cannot understand: ${text}`);
	}

	// status.type is X / status.name includes x
	if (words[0] === 'status.type' || words[0] === 'status.name') {
		const parts = splitOp(text.slice(words[0].length).trim());
		if (!parts) throw new FilterSyntaxError(`Cannot understand: ${text}`);
		if (words[0] === 'status.type') {
			const test = STATUS_TYPE_KEYS[parts.arg.toUpperCase()];
			if (!test) throw new FilterSyntaxError(`Unknown status type: ${parts.arg}`);
			return parts.op === 'is' ? test : (t) => !test(t);
		}
		const match = textMatcher(parts.op, parts.arg);
		return (t) => match(t.status ?? (t.completed ? 'done' : t.cancelled ? 'canceled' : 'todo'));
	}

	// priority is|is not|above|below <level>
	if (words[0] === 'priority') {
		const rest = text.slice('priority'.length).trim().toLowerCase();
		const m = (['is not', 'is', 'above', 'below'] as const).find((op) => rest.startsWith(op + ' '));
		if (!m) throw new FilterSyntaxError(`Cannot understand: ${text}`);
		const level = rest.slice(m.length).trim();
		const target = PRIORITY_RANK[level];
		if (target === undefined) throw new FilterSyntaxError(`Unknown priority: ${level}`);
		const rank = (t: GCTask) => PRIORITY_RANK[t.priority || 'normal'] ?? 3;
		if (m === 'is') return (t) => rank(t) === target;
		if (m === 'is not') return (t) => rank(t) !== target;
		return m === 'above' ? (t) => rank(t) < target : (t) => rank(t) > target;
	}

	// tag(s) / path / filename / folder / description 文本过滤
	const textFields: Record<string, (t: GCTask) => string[]> = {
		tag: (t) => (t.tags ?? []).map((x) => '#' + x),
		tags: (t) => (t.tags ?? []).map((x) => '#' + x),
		path: (t) => [t.filePath],
		filename: (t) => [t.fileName],
		folder: (t) => [t.filePath.includes('/') ? t.filePath.slice(0, t.filePath.lastIndexOf('/') + 1) : '/'],
		description: (t) => [t.description],
	};
	const getter = textFields[words[0]];
	if (getter) {
		const parts = splitOp(text.slice(words[0].length).trim());
		if (!parts) throw new FilterSyntaxError(`Cannot understand: ${text}`);
		const negative = parts.op === 'does not include' || parts.op === 'regex does not match' || parts.op === 'is not';
		// 否定形式作用于全部值（"标签均不包含"），肯定形式任一值命中
		const positiveOp = parts.op === 'does not include' ? 'includes'
			: parts.op === 'regex does not match' ? 'regex matches'
			: parts.op === 'is not' ? 'is' : parts.op;
		const match = textMatcher(positiveOp, parts.arg);
		return (t) => {
			const values = getter(t);
			const any = values.some(match);
			return negative ? !any : any;
		};
	}

	throw new FilterSyntaxError(`Cannot understand: ${text}`);
}

// ===== 布尔组合：在括号深度 0 处按 OR → AND 拆分，NOT 前缀取反 =====

function splitTopLevel(text: string, keyword: string): string[] {
	const parts: string[] = [];
	const marker = ` ${keyword} `;
	let depth = 0;
	let last = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (depth === 0 && text.startsWith(marker, i)) {
			parts.push(text.slice(last, i));
			last = i + marker.length;
			i = last - 1;
		}
	}
	parts.push(text.slice(last));
	return parts;
}

function isWrapped(text: string): boolean {
	if (!text.startsWith('(') || !text.endsWith(')')) return false;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') depth--;
		if (depth === 0 && i < text.length - 1) return false;
	}
	return true;
}

function compileBoolean(text: string): TaskPredicate {
	const src = text.trim();
	const ors = splitTopLevel(src, 'OR');
	if (ors.length > 1) {
		const parts = ors.map(compileBoolean);
		return (t) => parts.some((p) => p(t));
	}
	const ands = splitTopLevel(src, 'AND');
	if (ands.length > 1) {
		const parts = ands.map(compileBoolean);
		return (t) => parts.every((p) => p(t));
	}
	if (src.startsWith('NOT ')) {
		const inner = compileBoolean(src.slice(4));
		return (t) => !inner(t);
	}
	if (isWrapped(src)) return compileBoolean(src.slice(1, -1));
	return compileFilter(src);
}

/** 编译多行 Tasks 查询：无效行记入 errors 并被忽略 */
export function compileTaskQuery(query: string): CompiledTaskQuery {
	const parts: TaskPredicate[] = [];
	const errors: string[] = [];
	for (const raw of query.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		try {
			parts.push(compileBoolean(line));
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}
	return { predicate: parts.length ? (t) => parts.every((p) => p(t)) : null, errors };
}
