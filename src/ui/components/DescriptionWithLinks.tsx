import { Fragment, useMemo, type JSX } from 'react';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { RegularExpressions } from '../../utils/RegularExpressions';
import { LinkClasses } from '../../utils/bem';
import { i18n } from '../../i18n/i18n';
import { openFileInExistingLeaf } from '../../utils/fileOpener';
import { resolveLinkTarget, wikilinkDisplayText } from '../../utils/linkText';
import { tokenizeInlineMarkdown, type InlineMarkdownToken } from '../../utils/inlineMarkdown';

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

/**
 * React 富文本描述组件：渲染任务描述中的可点击链接
 */
/** 行内 Markdown 渲染为对应的 HTML 元素 */
function InlineMarkdown({ text }: { text: string }): JSX.Element {
	const render = (t: InlineMarkdownToken, i: number): JSX.Element => {
		switch (t.kind) {
			case 'bold': return <strong key={i}>{t.text}</strong>;
			case 'italic': return <em key={i}>{t.text}</em>;
			case 'strike': return <del key={i}>{t.text}</del>;
			case 'mark': return <mark key={i}>{t.text}</mark>;
			case 'code': return <code key={i}>{t.text}</code>;
			default: return <Fragment key={i}>{t.text}</Fragment>;
		}
	};
	return <>{tokenizeInlineMarkdown(text).map(render)}</>;
}

export function DescriptionWithLinks({ text, app, sourcePath = '' }: { text: string; app: App; sourcePath?: string }): JSX.Element {
	const segments = useMemo(() => parseDescriptionSegments(text), [text]);

	return (
		<Fragment>
			{segments.map((seg, i) => {
				// 链接段同样带 text 字段，必须按 type 区分
				if (!('type' in seg)) {
					return <InlineMarkdown key={i} text={seg.text} />;
				}
				const link = seg;
				if (link.type === 'obsidian') {
					return (
						<a
							key={i}
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
						key={i}
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
			})}
		</Fragment>
	);
}