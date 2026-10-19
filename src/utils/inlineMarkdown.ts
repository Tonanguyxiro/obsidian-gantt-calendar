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
