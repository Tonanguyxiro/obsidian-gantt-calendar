/**
 * 任务文字的行内 Markdown 分词（React 与命令式渲染共用）
 * 只处理单层：粗体 / 斜体 / 删除线 / 高亮 / 行内代码；不嵌套，无法匹配的标记按原文输出
 */

import { RegularExpressions } from './RegularExpressions';

export type InlineMarkdownKind = 'text' | 'bold' | 'italic' | 'strike' | 'mark' | 'code';

export interface InlineMarkdownToken {
	kind: InlineMarkdownKind;
	text: string;
}

/** 捕获组下标（从 1 起）→ 类型，顺序同 RegularExpressions.InlineMarkdown.pattern */
const GROUP_KINDS: InlineMarkdownKind[] = ['bold', 'bold', 'strike', 'mark', 'code', 'italic'];

export function tokenizeInlineMarkdown(text: string): InlineMarkdownToken[] {
	// 共享的全局正则带 lastIndex 状态，这里用独立实例
	const re = new RegExp(RegularExpressions.InlineMarkdown.pattern.source, 'g');
	const tokens: InlineMarkdownToken[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) tokens.push({ kind: 'text', text: text.slice(last, m.index) });
		const group = GROUP_KINDS.findIndex((_, i) => m![i + 1] !== undefined);
		tokens.push({ kind: GROUP_KINDS[group], text: m[group + 1] });
		last = m.index + m[0].length;
	}
	if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) });
	return tokens;
}

/** 行内 Markdown 片段：内部由文字与链接（泛型 L）交错组成 */
export interface InlineRichToken<L> {
	kind: InlineMarkdownKind;
	parts: Array<string | L>;
}

const LINK_OPEN = '';
const LINK_CLOSE = '';

/**
 * 在「文字 + 链接」交错的片段序列上做行内 Markdown 分词，使 **[[note]]**、~~[text](url)~~ 这类
 * 标记包裹链接的写法生效：链接先以占位符顶替参与分词（链接内部的 * _ 等不会被当成标记），分词后再还原。
 */
export function tokenizeInlineRich<L>(pieces: Array<string | L>): Array<InlineRichToken<L>> {
	const links: L[] = [];
	const joined = pieces.map((p) => {
		if (typeof p === 'string') return p.split(LINK_OPEN).join('').split(LINK_CLOSE).join('');
		links.push(p);
		return `${LINK_OPEN}${links.length - 1}${LINK_CLOSE}`;
	}).join('');

	const restore = (text: string): Array<string | L> => {
		const parts: Array<string | L> = [];
		let rest = text;
		for (;;) {
			const open = rest.indexOf(LINK_OPEN);
			if (open < 0) break;
			const close = rest.indexOf(LINK_CLOSE, open);
			if (open > 0) parts.push(rest.slice(0, open));
			parts.push(links[Number(rest.slice(open + 1, close))]);
			rest = rest.slice(close + 1);
		}
		if (rest) parts.push(rest);
		return parts;
	};

	return tokenizeInlineMarkdown(joined).map((t) => ({ kind: t.kind, parts: restore(t.text) }));
}
