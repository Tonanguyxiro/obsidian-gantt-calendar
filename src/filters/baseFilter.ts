/**
 * 文件过滤：Bases 过滤表达式 + .base 文件
 *
 * - expression：每行一个 Bases 表达式，行间 AND
 * - .base 文件：读取其顶层 `filters`（及可选视图的 `filters`），语义与 Bases 一致
 *   and:[...] 全部满足 / or:[...] 任一满足 / not:[...] 全部不满足
 */

import { parseYaml, type App, type TFile } from 'obsidian';
import { compileExpression, FilterSyntaxError, type FileContext } from './baseExpression';
import type { FileFilterState } from '../types';

export type FilePredicate = (file: FileContext) => boolean;

export interface CompiledFileFilter {
	/** 无任何有效条件时为 null（不过滤） */
	predicate: FilePredicate | null;
	errors: string[];
}

type FilterNode = string | { and?: FilterNode[]; or?: FilterNode[]; not?: FilterNode[] };

function compileNode(node: FilterNode): FilePredicate {
	if (typeof node === 'string') return compileExpression(node);
	if (node.and) {
		const parts = node.and.map(compileNode);
		return (f) => parts.every((p) => p(f));
	}
	if (node.or) {
		const parts = node.or.map(compileNode);
		return (f) => parts.some((p) => p(f));
	}
	if (node.not) {
		const parts = node.not.map(compileNode);
		return (f) => !parts.some((p) => p(f));
	}
	throw new FilterSyntaxError('Invalid filter node');
}

interface BaseDocument {
	filters?: FilterNode;
	views?: Array<{ name?: string; filters?: FilterNode }>;
}

/** 解析 .base 文本，返回其视图名（供 UI 选择） */
export function listBaseViews(yamlText: string): string[] {
	try {
		const doc = parseYaml(yamlText) as BaseDocument | null;
		return (doc?.views ?? []).map((v) => v.name ?? '').filter(Boolean);
	} catch {
		return [];
	}
}

function compileBase(yamlText: string, viewName: string): FilePredicate | null {
	const doc = parseYaml(yamlText) as BaseDocument | null;
	if (!doc) return null;
	const parts: FilePredicate[] = [];
	if (doc.filters) parts.push(compileNode(doc.filters));
	if (viewName) {
		const view = (doc.views ?? []).find((v) => v.name === viewName);
		if (view?.filters) parts.push(compileNode(view.filters));
	}
	return parts.length ? (f) => parts.every((p) => p(f)) : null;
}

/** 读取 .base 文件内容；不存在返回 null */
export async function readBaseText(app: App, path: string): Promise<string | null> {
	if (!path) return null;
	const file = app.vault.getFileByPath(path);
	return file ? app.vault.cachedRead(file) : null;
}

/**
 * 编译文件过滤
 * @param baseText state.baseFile 的文件内容（调用方异步读取并缓存）；读取失败/未配置传 null
 */
export function compileFileFilter(state: FileFilterState, baseText: string | null): CompiledFileFilter {
	const parts: FilePredicate[] = [];
	const errors: string[] = [];

	if (state.baseFile) {
		if (baseText === null) errors.push(`Base not found: ${state.baseFile}`);
		else {
			try {
				const p = compileBase(baseText, state.baseView);
				if (p) parts.push(p);
			} catch (e) {
				errors.push(e instanceof Error ? e.message : String(e));
			}
		}
	}

	for (const line of state.expression.split('\n')) {
		const src = line.trim();
		if (!src) continue;
		try {
			parts.push(compileExpression(src));
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}

	return { predicate: parts.length ? (f) => parts.every((p) => p(f)) : null, errors };
}

/** 从 vault 文件构造求值上下文 */
export function buildFileContext(app: App, file: TFile): FileContext {
	const cache = app.metadataCache.getFileCache(file);
	const tags = new Set<string>();
	for (const t of cache?.tags ?? []) tags.add(t.tag.startsWith('#') ? t.tag.slice(1) : t.tag);
	const fmTags = cache?.frontmatter?.tags as unknown;
	const fmList = Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? fmTags.split(',') : [];
	for (const t of fmList) {
		const name = String(t).trim();
		if (name) tags.add(name.startsWith('#') ? name.slice(1) : name);
	}
	const slash = file.path.lastIndexOf('/');
	return {
		path: file.path,
		name: file.name,
		basename: file.basename,
		ext: file.extension,
		folder: slash < 0 ? '' : file.path.slice(0, slash),
		size: file.stat.size,
		ctime: new Date(file.stat.ctime),
		mtime: new Date(file.stat.mtime),
		tags: Array.from(tags),
		links: (cache?.links ?? []).map((l) => l.link),
		frontmatter: { ...(cache?.frontmatter ?? {}) },
	};
}
