import { Fragment, useMemo, type JSX } from 'react';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { RegularExpressions } from '../../utils/RegularExpressions';
import { LinkClasses } from '../../utils/bem';
import { i18n } from '../../i18n/i18n';
import { openFileInExistingLeaf } from '../../utils/fileOpener';
import { resolveLinkTarget, wikilinkDisplayText } from '../../utils/linkText';
import { tokenizeInlineRich, type InlineMarkdownKind } from '../../utils/inlineMarkdown';

export interface LinkSegment {
	type: 'obsidian' | 'markdown' | 'url';
	text: string;
	href: string;
	title: string;
}

export type DescriptionSegment = { text: string } | LinkSegment;

/**
 * 从任务描述文本中解析出纯文本段和链接段
 * 与 LinkRenderer.renderTaskDescriptionWithLinks 逻辑保持一致
 */
export function parseDescriptionSegments(text: string): DescriptionSegment[] {
	const obsidianLinkRegex = RegularExpressions.Links.obsidianLinkRegex;
	const markdownLinkRegex = RegularExpressions.Links.markdownLinkRegex;
	const urlRegex = RegularExpressions.Links.urlLinkRegex;

	const matches: Array<{ type: LinkSegment['type']; start: number; end: number; groups: RegExpExecArray }> = [];
	let match: RegExpExecArray | null;

	while ((match = obsidianLinkRegex.exec(text)) !== null) {
		matches.push({ type: 'obsidian', start: match.index, end: match.index + match[0].length, groups: match });
	}
	while ((match = markdownLinkRegex.exec(text)) !== null) {
		matches.push({ type: 'markdown', start: match.index, end: match.index + match[0].length, groups: match });
	}
	while ((match = urlRegex.exec(text)) !== null) {
		matches.push({ type: 'url', start: match.index, end: match.index + match[0].length, groups: match });
	}

	matches.sort((a, b) => a.start - b.start);
	const unique: typeof matches = [];
	let lastEnd = 0;
	for (const m of matches) {
		if (m.start >= lastEnd) {
			unique.push(m);
			lastEnd = m.end;
		}
	}

	const segments: DescriptionSegment[] = [];
	let lastIndex = 0;
	const safeSchemes = ['http:', 'https:', 'mailto:', 'tel:', 'app:'];

	for (const m of unique) {
		if (m.start > lastIndex) {
			segments.push({ text: text.substring(lastIndex, m.start) });
		}

		if (m.type === 'obsidian') {
			const notePath = m.groups[1];
			const displayText = wikilinkDisplayText(notePath, m.groups[2]);
			segments.push({
				type: 'obsidian',
				text: displayText,
				href: notePath,
				title: `${i18n.t('common.open')}: ${notePath}`,
			});
		} else if (m.type === 'markdown') {
			const displayText = m.groups[1];
			const url = m.groups[2];
			try {
				const parsed = new URL(url);
				if (!safeSchemes.includes(parsed.protocol)) {
					lastIndex = m.end;
					continue;
				}
			} catch {
				lastIndex = m.end;
				continue;
			}
			segments.push({ type: 'markdown', text: displayText, href: url, title: url });
		} else if (m.type === 'url') {
			const url = m.groups[1];
			segments.push({ type: 'url', text: url, href: url, title: url });
		}

		lastIndex = m.end;
	}

	if (lastIndex < text.length) {
		segments.push({ text: text.substring(lastIndex) });
	}

	return segments;
}

/** 行内 Markdown 类型 → 包裹元素；纯文字（text）不包裹 */
const KIND_TAGS: Record<Exclude<InlineMarkdownKind, 'text'>, 'strong' | 'em' | 'del' | 'mark' | 'code'> = {
	bold: 'strong', italic: 'em', strike: 'del', mark: 'mark', code: 'code',
};

function renderLink(link: LinkSegment, key: number, app: App, sourcePath: string): JSX.Element {
	if (link.type === 'obsidian') {
		return (
			<a
				key={key}
				className={LinkClasses.modifiers.obsidian}
				role="link"
				data-href={link.href}
				title={link.title}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					void (async () => {
						const file = resolveLinkTarget(app, link.href, sourcePath);
						if (file) {
							await openFileInExistingLeaf(app, file.path, 0);
						} else {
							new Notice(i18n.t('common.fileNotFound', { path: link.href }));
						}
					})();
				}}
			>
				{link.text}
			</a>
		);
	}
	return (
		<a
			key={key}
			className={link.type === 'markdown' ? LinkClasses.modifiers.markdown : LinkClasses.modifiers.url}
			href={link.href}
			target="_blank"
			rel="noopener noreferrer"
			title={link.title}
			onClick={(e) => e.stopPropagation()}
		>
			{link.text}
		</a>
	);
}

/**
 * React 富文本描述组件：渲染任务描述中的可点击链接与行内 Markdown
 * （行内标记可以包裹链接，如 **[[note]]**）
 */
export function DescriptionWithLinks({ text, app, sourcePath = '' }: { text: string; app: App; sourcePath?: string }): JSX.Element {
	const tokens = useMemo(() => {
		// 链接段同样带 text 字段，必须按 type 区分
		const pieces = parseDescriptionSegments(text).map((seg) => ('type' in seg ? seg : seg.text));
		return tokenizeInlineRich<LinkSegment>(pieces);
	}, [text]);

	return (
		<Fragment>
			{tokens.map((token, i) => {
				const children = token.parts.map((part, j) => (
					typeof part === 'string' ? <Fragment key={j}>{part}</Fragment> : renderLink(part, j, app, sourcePath)
				));
				if (token.kind === 'text') return <Fragment key={i}>{children}</Fragment>;
				const Tag = KIND_TAGS[token.kind];
				return <Tag key={i}>{children}</Tag>;
			})}
		</Fragment>
	);
}
