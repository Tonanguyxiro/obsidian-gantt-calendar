/**
 * Obsidian Bases 过滤表达式（子集）的解析与求值
 *
 * Obsidian 没有公开"在插件里执行 Bases 过滤"的接口，因此在此实现 .base 文件
 * `filters` 中最常用的语法：
 *   file.hasTag("a") / file.inFolder("x") / file.name == "y" / status != "done"
 *   !、&&、||、比较、+ - * /、列表字面量、字符串/列表/日期上的常用方法
 * 不支持的函数在编译阶段抛出 FilterSyntaxError，由 UI 提示而非静默过滤掉全部内容。
 */

import { RegularExpressions } from '../utils/RegularExpressions';

export class FilterSyntaxError extends Error {}

/** 表达式求值上下文：一个笔记文件的信息 */
export interface FileContext {
	path: string;
	name: string;
	basename: string;
	ext: string;
	folder: string;
	size: number;
	ctime: Date;
	mtime: Date;
	/** 不带 # 的标签（含正文与 frontmatter） */
	tags: string[];
	/** 出链目标（路径或链接文本） */
	links: string[];
	frontmatter: Record<string, unknown>;
}

type Value = string | number | boolean | Date | null | undefined | Value[];

type Node =
	| { type: 'lit'; value: Value }
	| { type: 'id'; name: string }
	| { type: 'member'; object: Node; name: string }
	| { type: 'call'; callee: Node; args: Node[] }
	| { type: 'unary'; op: '!' | '-'; arg: Node }
	| { type: 'binary'; op: string; left: Node; right: Node }
	| { type: 'list'; items: Node[] };

// ===== 词法 =====

type Token =
	| { t: 'num'; v: number }
	| { t: 'str'; v: string }
	| { t: 'id'; v: string }
	| { t: 'op'; v: string };

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '-', '*', '/', '%', '(', ')', '[', ']', ',', '.'];

function isDigit(c: string): boolean {
	return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
	return c === '_' || c === '$' || (c.toLowerCase() !== c.toUpperCase()) || c > '\u007f';
}

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			i++;
		} else if (c === '"' || c === "'") {
			let out = '';
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === '\\' && i + 1 < src.length) i++;
				out += src[i++];
			}
			if (i >= src.length) throw new FilterSyntaxError(`Unterminated string: ${src}`);
			i++;
			tokens.push({ t: 'str', v: out });
		} else if (isDigit(c)) {
			let j = i;
			while (j < src.length && (isDigit(src[j]) || (src[j] === '.' && isDigit(src[j + 1] ?? '')))) j++;
			tokens.push({ t: 'num', v: Number(src.slice(i, j)) });
			i = j;
		} else if (isIdentStart(c)) {
			let j = i + 1;
			while (j < src.length && (isIdentStart(src[j]) || isDigit(src[j]))) j++;
			tokens.push({ t: 'id', v: src.slice(i, j) });
			i = j;
		} else {
			const op = OPERATORS.find((o) => src.startsWith(o, i));
			if (!op) throw new FilterSyntaxError(`Unexpected character "${c}" in: ${src}`);
			tokens.push({ t: 'op', v: op });
			i += op.length;
		}
	}
	return tokens;
}

// ===== 语法（递归下降，优先级：|| < && < 比较 < 加减 < 乘除 < 一元 < 后缀） =====

class Parser {
	private pos = 0;
	constructor(private readonly tokens: Token[], private readonly src: string) {}

	parse(): Node {
		const node = this.parseOr();
		if (this.pos < this.tokens.length) throw new FilterSyntaxError(`Unexpected token in: ${this.src}`);
		return node;
	}

	private peekOp(...ops: string[]): string | null {
		const tok = this.tokens[this.pos];
		return tok && tok.t === 'op' && ops.includes(tok.v) ? tok.v : null;
	}

	private expectOp(op: string): void {
		if (!this.peekOp(op)) throw new FilterSyntaxError(`Expected "${op}" in: ${this.src}`);
		this.pos++;
	}

	private parseBinary(next: () => Node, ...ops: string[]): Node {
		let left = next();
		let op = this.peekOp(...ops);
		while (op) {
			this.pos++;
			left = { type: 'binary', op, left, right: next() };
			op = this.peekOp(...ops);
		}
		return left;
	}

	private parseOr(): Node { return this.parseBinary(() => this.parseAnd(), '||'); }
	private parseAnd(): Node { return this.parseBinary(() => this.parseCompare(), '&&'); }
	private parseCompare(): Node { return this.parseBinary(() => this.parseAdd(), '==', '!=', '<=', '>=', '<', '>'); }
	private parseAdd(): Node { return this.parseBinary(() => this.parseMul(), '+', '-'); }
	private parseMul(): Node { return this.parseBinary(() => this.parseUnary(), '*', '/', '%'); }

	private parseUnary(): Node {
		const op = this.peekOp('!', '-');
		if (op) {
			this.pos++;
			return { type: 'unary', op: op as '!' | '-', arg: this.parseUnary() };
		}
		return this.parsePostfix();
	}

	private parsePostfix(): Node {
		let node = this.parsePrimary();
		for (;;) {
			if (this.peekOp('.')) {
				this.pos++;
				const tok = this.tokens[this.pos++];
				if (!tok || tok.t !== 'id') throw new FilterSyntaxError(`Expected property name in: ${this.src}`);
				node = { type: 'member', object: node, name: tok.v };
			} else if (this.peekOp('(')) {
				this.pos++;
				const args: Node[] = [];
				if (!this.peekOp(')')) {
					do args.push(this.parseOr()); while (this.peekOp(',') && ++this.pos);
				}
				this.expectOp(')');
				node = { type: 'call', callee: node, args };
			} else {
				return node;
			}
		}
	}

	private parsePrimary(): Node {
		const tok = this.tokens[this.pos++];
		if (!tok) throw new FilterSyntaxError(`Unexpected end of expression: ${this.src}`);
		if (tok.t === 'num' || tok.t === 'str') return { type: 'lit', value: tok.v };
		if (tok.t === 'id') {
			if (tok.v === 'true') return { type: 'lit', value: true };
			if (tok.v === 'false') return { type: 'lit', value: false };
			if (tok.v === 'null') return { type: 'lit', value: null };
			return { type: 'id', name: tok.v };
		}
		if (tok.v === '(') {
			const inner = this.parseOr();
			this.expectOp(')');
			return inner;
		}
		if (tok.v === '[') {
			const items: Node[] = [];
			if (!this.peekOp(']')) {
				do items.push(this.parseOr()); while (this.peekOp(',') && ++this.pos);
			}
			this.expectOp(']');
			return { type: 'list', items };
		}
		throw new FilterSyntaxError(`Unexpected "${tok.v}" in: ${this.src}`);
	}
}

// ===== 内置函数 / 方法白名单（编译期校验） =====

const GLOBAL_FUNCTIONS = new Set(['now', 'today', 'date', 'if', 'list', 'number', 'min', 'max']);
const METHODS = new Set([
	'hasTag', 'inFolder', 'hasLink', 'hasProperty',
	'contains', 'containsAny', 'containsAll', 'startsWith', 'endsWith', 'isEmpty',
	'lower', 'upper', 'trim', 'toString', 'join', 'isType', 'format', 'date',
]);

function validate(node: Node, src: string): void {
	switch (node.type) {
		case 'call': {
			const callee = node.callee;
			const name = callee.type === 'id' ? callee.name : callee.type === 'member' ? callee.name : '';
			const known = callee.type === 'id' ? GLOBAL_FUNCTIONS.has(name) : METHODS.has(name);
			if (!known) throw new FilterSyntaxError(`Unsupported function "${name}" in: ${src}`);
			if (callee.type === 'member') validate(callee.object, src);
			node.args.forEach((a) => validate(a, src));
			break;
		}
		case 'member': validate(node.object, src); break;
		case 'unary': validate(node.arg, src); break;
		case 'binary': validate(node.left, src); validate(node.right, src); break;
		case 'list': node.items.forEach((n) => validate(n, src)); break;
		default: break;
	}
}

// ===== 求值 =====

const DURATION_MS: Record<string, number> = {
	s: 1000, sec: 1000, second: 1000, seconds: 1000,
	m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
	h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
	d: 86_400_000, day: 86_400_000, days: 86_400_000,
	w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
	M: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000,
	y: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
};

/** "7d" / "1 week" → 毫秒；不是时长返回 null */
function parseDuration(text: string): number | null {
	const m = RegularExpressions.Filters.duration.exec(text.trim());
	if (!m) return null;
	const unit = DURATION_MS[m[2]] ?? DURATION_MS[m[2].toLowerCase()];
	return unit ? Number(m[1]) * unit : null;
}

function toDate(v: Value): Date | null {
	if (v instanceof Date) return v;
	if (typeof v === 'string') {
		const d = new Date(v);
		return isNaN(d.getTime()) ? null : d;
	}
	return null;
}

function isEmptyValue(v: Value): boolean {
	return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function toStr(v: Value): string {
	if (v === null || v === undefined) return '';
	if (Array.isArray(v)) return v.map(toStr).join(', ');
	if (v instanceof Date) return v.toISOString();
	return String(v);
}

function looseEquals(a: Value, b: Value): boolean {
	if (isEmptyValue(a) && isEmptyValue(b)) return true;
	if (a instanceof Date || b instanceof Date) {
		const da = toDate(a);
		const db = toDate(b);
		return !!da && !!db && da.getTime() === db.getTime();
	}
	if (Array.isArray(a) || Array.isArray(b)) return false;
	return toStr(a) === toStr(b);
}

/** 比较：日期按时间，数字按数值，其余按字符串；不可比较返回 null */
function compare(a: Value, b: Value): number | null {
	if (isEmptyValue(a) || isEmptyValue(b)) return null;
	if (a instanceof Date || b instanceof Date) {
		const da = toDate(a);
		const db = toDate(b);
		return da && db ? da.getTime() - db.getTime() : null;
	}
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	const na = Number(a);
	const nb = Number(b);
	if (!isNaN(na) && !isNaN(nb) && toStr(a) !== '' && toStr(b) !== '') return na - nb;
	return toStr(a).localeCompare(toStr(b));
}

function trimSlashes(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && text[start] === '/') start++;
	while (end > start && text[end - 1] === '/') end--;
	return text.slice(start, end);
}

function tagMatches(tag: string, wanted: string): boolean {
	const t = tag.toLowerCase();
	const w = (wanted.startsWith('#') ? wanted.slice(1) : wanted).toLowerCase();
	return t === w || t.startsWith(w + '/');
}

function lookupProperty(fm: Record<string, unknown>, name: string): Value {
	if (name in fm) return fm[name] as Value;
	const lower = name.toLowerCase();
	const key = Object.keys(fm).find((k) => k.toLowerCase() === lower);
	return key === undefined ? undefined : (fm[key] as Value);
}

interface FileObject { __file: FileContext }

function isFileObject(v: unknown): v is FileObject {
	return typeof v === 'object' && v !== null && '__file' in v;
}

function evalFileProperty(f: FileContext, name: string): Value {
	switch (name) {
		case 'name': return f.name;
		case 'basename': return f.basename;
		case 'path': return f.path;
		case 'folder': return f.folder;
		case 'ext': return f.ext;
		case 'size': return f.size;
		case 'ctime': return f.ctime;
		case 'mtime': return f.mtime;
		case 'tags': return f.tags;
		case 'links': return f.links;
		default: return undefined;
	}
}

function callMethod(target: unknown, name: string, args: Value[], file: FileContext): Value {
	if (isFileObject(target)) {
		const f = target.__file;
		switch (name) {
			case 'hasTag': return args.some((a) => f.tags.some((t) => tagMatches(t, toStr(a))));
			case 'inFolder': {
				const folder = trimSlashes(toStr(args[0]));
				return folder === '' || f.folder === folder || f.folder.startsWith(folder + '/');
			}
			case 'hasLink': {
				const wanted = toStr(args[0]).toLowerCase();
				return f.links.some((l) => l.toLowerCase() === wanted || l.toLowerCase().endsWith('/' + wanted));
			}
			case 'hasProperty': return lookupProperty(f.frontmatter, toStr(args[0])) !== undefined;
			default: throw new FilterSyntaxError(`Unsupported file function "${name}"`);
		}
	}
	const v = target as Value;
	switch (name) {
		case 'isEmpty': return isEmptyValue(v);
		case 'toString': return toStr(v);
		case 'lower': return toStr(v).toLowerCase();
		case 'upper': return toStr(v).toUpperCase();
		case 'trim': return toStr(v).trim();
		case 'startsWith': return toStr(v).startsWith(toStr(args[0]));
		case 'endsWith': return toStr(v).endsWith(toStr(args[0]));
		case 'join': return Array.isArray(v) ? v.map(toStr).join(toStr(args[0] ?? ',')) : toStr(v);
		case 'date': return toDate(v);
		case 'isType': return typeof v === toStr(args[0]) || (toStr(args[0]) === 'list' && Array.isArray(v));
		case 'contains':
			if (Array.isArray(v)) return v.some((x) => looseEquals(x, args[0]));
			return toStr(v).toLowerCase().includes(toStr(args[0]).toLowerCase()) && !isEmptyValue(v);
		case 'containsAny':
			return Array.isArray(v) && args.some((a) => v.some((x) => looseEquals(x, a)));
		case 'containsAll':
			return Array.isArray(v) && args.every((a) => v.some((x) => looseEquals(x, a)));
		default:
			// file 与 note 之外的方法在编译期已校验；运行期未知接收者视为无匹配
			void file;
			return undefined;
	}
}

function evaluate(node: Node, file: FileContext): Value | FileObject {
	switch (node.type) {
		case 'lit': return node.value;
		case 'list': return node.items.map((n) => evaluate(n, file) as Value);
		case 'id':
			if (node.name === 'file') return { __file: file };
			if (node.name === 'note') return { __file: file, __note: true } as FileObject;
			return lookupProperty(file.frontmatter, node.name);
		case 'member': {
			const obj = evaluate(node.object, file);
			if (isFileObject(obj)) {
				if ('__note' in obj) return lookupProperty(file.frontmatter, node.name);
				return evalFileProperty(obj.__file, node.name);
			}
			if (node.name === 'length') {
				if (Array.isArray(obj)) return obj.length;
				return typeof obj === 'string' ? obj.length : undefined;
			}
			return undefined;
		}
		case 'call': {
			const args = node.args.map((a) => evaluate(a, file) as Value);
			if (node.callee.type === 'id') return callGlobal(node.callee.name, args);
			if (node.callee.type === 'member') {
				return callMethod(evaluate(node.callee.object, file), node.callee.name, args, file);
			}
			return undefined;
		}
		case 'unary': {
			const v = evaluate(node.arg, file) as Value;
			return node.op === '!' ? !truthy(v) : -(Number(v));
		}
		case 'binary': return evalBinary(node.op, node.left, node.right, file);
	}
}

function callGlobal(name: string, args: Value[]): Value {
	switch (name) {
		case 'now': return new Date();
		case 'today': {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			return d;
		}
		case 'date': return toDate(args[0]);
		case 'if': return truthy(args[0]) ? args[1] : args[2];
		case 'list': return Array.isArray(args[0]) ? args[0] : [args[0]];
		case 'number': return Number(args[0]);
		case 'min': return Math.min(...args.map(Number));
		case 'max': return Math.max(...args.map(Number));
		default: return undefined;
	}
}

function truthy(v: Value | FileObject): boolean {
	if (isFileObject(v)) return true;
	if (Array.isArray(v)) return v.length > 0;
	return !!v && v !== '';
}

function evalBinary(op: string, l: Node, r: Node, file: FileContext): Value {
	if (op === '&&') return truthy(evaluate(l, file)) && truthy(evaluate(r, file));
	if (op === '||') return truthy(evaluate(l, file)) || truthy(evaluate(r, file));
	const a = evaluate(l, file) as Value;
	const b = evaluate(r, file) as Value;
	switch (op) {
		case '==': return looseEquals(a, b);
		case '!=': return !looseEquals(a, b);
		case '<': case '>': case '<=': case '>=': {
			const c = compare(a, b);
			if (c === null) return false;
			return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
		}
		case '+': case '-': {
			// 日期 ± 时长字符串："now() - '7d'"
			const da = a instanceof Date ? a : null;
			const dur = typeof b === 'string' ? parseDuration(b) : null;
			if (da && dur !== null) return new Date(da.getTime() + (op === '+' ? dur : -dur));
			if (op === '+' && (typeof a === 'string' || typeof b === 'string')) return toStr(a) + toStr(b);
			return op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
		}
		case '*': return Number(a) * Number(b);
		case '/': return Number(a) / Number(b);
		case '%': return Number(a) % Number(b);
		default: return undefined;
	}
}

/** 编译表达式；语法错误或不支持的函数抛 FilterSyntaxError */
export function compileExpression(src: string): (file: FileContext) => boolean {
	const ast = new Parser(tokenize(src), src).parse();
	validate(ast, src);
	return (file) => {
		try {
			return truthy(evaluate(ast, file));
		} catch {
			return false;
		}
	};
}
