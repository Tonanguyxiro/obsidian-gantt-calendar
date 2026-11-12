/**
 * 双链显示文本与目标解析（任务卡片、甘特列表、悬浮窗共用）
 */

import type { App, TFile } from 'obsidian';
import { RegularExpressions } from './RegularExpressions';
import { stripPlannerTime } from '../tasks/taskParser/utils';
import { tokenizeInlineMarkdown } from './inlineMarkdown';

/** 双链目标拆分为文件路径与子路径（#标题 / #^块） */
export function splitLinkTarget(target: string): { path: string; subpath: string } {
	const idx = target.indexOf('#');
	if (idx < 0) return { path: target.trim(), subpath: '' };
	return { path: target.slice(0, idx).trim(), subpath: target.slice(idx + 1).trim() };
}

/**
 * 双链显示文本，与 Obsidian 阅读模式一致：
 * 别名优先；[[Note#Heading]] → "Note > Heading"；[[#Heading]] → "Heading"
 */
export function wikilinkDisplayText(target: string, alias?: string): string {
	if (alias && alias.trim()) return alias.trim();
	const { path, subpath } = splitLinkTarget(target);
	const sub = subpath.replace(/^\^/, '');
	if (!path) return sub;
	return sub ? `${path} > ${sub}` : path;
}

/** 解析双链目标文件（忽略 #子路径） */
export function resolveLinkTarget(app: App, target: string, sourcePath = ''): TFile | null {
	const { path } = splitLinkTarget(target);
	if (!path) return sourcePath ? app.vault.getFileByPath(sourcePath) : null;
	return app.metadataCache.getFirstLinkpathDest(path, sourcePath);
}

/**
 * 链接转纯文本（悬浮窗标题、拖拽浮层等不渲染链接的位置）：
 * 双链 → 显示文本，Markdown 链接 → 链接文字
 */
export function linksToPlainText(text: string): string {
	const plain = text
		.replace(RegularExpressions.Links.obsidianLinkRegex, (_m, target: string, alias?: string) => wikilinkDisplayText(target, alias))
		.replace(RegularExpressions.Links.markdownLinkRegex, (_m, label: string) => label);
	// 去掉粗体/斜体等标记符，只保留文字
	return tokenizeInlineMarkdown(plain).map((t) => t.text).join('');
}

/**
 * 日历中显示的任务文本：隐藏 Day Planner 时间前缀（时间已由视图位置表达），
 * 标签已在解析阶段从描述中移除
 */
export function taskDisplayText(description: string): string {
	return stripPlannerTime(description).trim();
}

/**
 * 任务文字前缀：「显示全局筛选符」开启时在文字前补上筛选符。
 * 标签形式的筛选符（#task）已作为标签在各视图/悬浮窗中显示，不再作为文字前缀重复出现
 */
export function globalFilterPrefix(showInText: boolean | undefined, globalFilter: string | undefined): string {
	const gf = (globalFilter || '').trim();
	return showInText && gf && !gf.startsWith('#') ? `${gf} ` : '';
}

/** Markdown 链接 `[文字](目标)` 的目标分类 */
export type MarkdownHrefKind =
	/** 外部地址（http/https/mailto，以及 zotero:// obsidian:// 等应用协议，交给系统打开） */
	| { kind: 'external'; href: string }
	/** 库内笔记（`[x](Note.md)`、`[x](Folder/Note%20name#标题)`），按双链解析 */
	| { kind: 'internal'; target: string }
	/** 可执行脚本类协议：只显示文字，不生成链接 */
	| { kind: 'blocked' };

const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:']);

/**
 * 分类 Markdown 链接目标（与 Obsidian 阅读模式一致：带协议的是外部链接，否则是库内路径）。
 * 无论哪类，链接文字都要显示——此前非 http 协议的链接整段被丢弃，只有链接的任务就成了空行。
 */
export function classifyMarkdownHref(raw: string): MarkdownHrefKind {
	const href = raw.trim().replace(/^<(.*)>$/, '$1');
	const scheme = RegularExpressions.Links.urlSchemeRegex.exec(href)?.[1]?.toLowerCase();
	if (scheme) {
		if (BLOCKED_SCHEMES.has(`${scheme}:`)) return { kind: 'blocked' };
		return { kind: 'external', href };
	}
	let target = href;
	try {
		target = decodeURI(href);
	} catch {
		// 非法转义保持原样
	}
	return { kind: 'internal', target: target.replace(RegularExpressions.Links.mdExtensionRegex, '$1') };
}
