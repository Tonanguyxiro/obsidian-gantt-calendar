/**
 * 筛选面板查询框的引擎选择与外部引擎（Dataview / Datacore）执行
 *
 * 引擎按查询框内容的首个有效行（非空、非 # / // 注释）识别：
 *
 * 任务页（Task query）
 *   TASK …          → Dataview（DQL TASK 查询，见 dataviewQuery.ts）
 *   @…              → Datacore（如 `@task and $completed = false`）
 *   其他            → Tasks 插件语法（本插件子集求值，taskQuery.ts）
 *
 * 文件页（File filter）
 *   LIST / TABLE / FROM …（大写）→ Dataview，结果的文件链接即命中的笔记
 *   @…              → Datacore（如 `@page and path("Projects")`）
 *   其他            → Bases 表达式（默认，baseExpression.ts）
 *
 * 外部引擎的结果按 路径（文件页）/ 路径:行号（任务页，行号 1 起）与本插件对象匹配。
 */

import type { App } from 'obsidian';
import { RegularExpressions } from '../utils/RegularExpressions';
import { i18n } from '../i18n/i18n';
import { isDataviewQuery, getDataviewApi } from './dataviewQuery';

export type TaskEngine = 'tasks' | 'dataview' | 'datacore';
export type FileEngine = 'bases' | 'dataview' | 'datacore';
export type QueryEngine = TaskEngine | FileEngine;

/** 外部引擎的执行结果：命中键集合；失败时 keys 为 null 并给出错误 */
export interface EngineResult {
	keys: Set<string> | null;
	error?: string;
}

const RE = RegularExpressions.QueryAssist;

/** 首个有效行（跳过空行、# 注释与 // 注释） */
function firstMeaningfulLine(text: string): string {
	return text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('//')) ?? '';
}

export function detectTaskEngine(text: string): TaskEngine {
	if (isDataviewQuery(text)) return 'dataview';
	return RE.datacoreQuery.test(firstMeaningfulLine(text)) ? 'datacore' : 'tasks';
}

export function detectFileEngine(text: string): FileEngine {
	const first = firstMeaningfulLine(text);
	if (RE.dataviewFileQuery.test(first)) return 'dataview';
	return RE.datacoreQuery.test(first) ? 'datacore' : 'bases';
}

function firstLines(error: unknown): string {
	return String(error).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--') && l !== 'Error:').slice(0, 2).join(' ');
}

// ===== Datacore =====

interface DatacoreResult {
	successful: boolean;
	value?: unknown[];
	error?: unknown;
}

interface DatacoreApi {
	tryQuery: (query: string) => DatacoreResult;
}

interface DatacorePlugin {
	api?: DatacoreApi;
	core?: { on?: (name: string, cb: () => void) => unknown; offref?: (ref: unknown) => void };
}

function getDatacorePlugin(app: App): DatacorePlugin | null {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, DatacorePlugin | undefined> } }).plugins?.plugins;
	return plugins?.datacore ?? null;
}

export function getDatacoreApi(app: App): DatacoreApi | null {
	const api = getDatacorePlugin(app)?.api;
	return api && typeof api.tryQuery === 'function' ? api : null;
}

/** Datacore / Dataview 是否可用（供面板提示与示例标注） */
export function isEngineAvailable(app: App, engine: QueryEngine): boolean {
	if (engine === 'dataview') return !!getDataviewApi(app);
	if (engine === 'datacore') return !!getDatacoreApi(app);
	return true;
}

/** 订阅 Datacore 索引更新；返回取消函数（Datacore 不可用时为空操作） */
export function onDatacoreUpdate(app: App, cb: () => void): () => void {
	const core = getDatacorePlugin(app)?.core;
	if (!core?.on || !core.offref) return () => undefined;
	const refs = [core.on('update', cb), core.on('initialized', cb)];
	return () => refs.forEach((r) => core.offref?.(r));
}

/** Datacore 查询文本：去掉 // 注释行，多行以空格拼接（# 开头是标签，不是注释） */
function datacoreSource(text: string): string {
	return text.split('\n').filter((l) => l.trim() && !RE.slashComment.test(l)).join(' ').trim();
}

interface DatacoreItem {
	$file?: unknown;
	$path?: unknown;
	$line?: unknown;
}

/**
 * 执行 Datacore 查询
 * @param want 'task'：收集 `路径:行号`（Datacore 行号 0 起 → 1 起）；'file'：收集文件路径
 */
export async function runDatacoreQuery(app: App, text: string, want: 'task' | 'file'): Promise<EngineResult> {
	const api = getDatacoreApi(app);
	if (!api) return { keys: null, error: i18n.t('toolbar.filterPanel.datacoreMissing') };
	try {
		// tryQuery 是同步的，解析失败时也可能直接抛出
		const result = await Promise.resolve(api.tryQuery(datacoreSource(text)));
		if (!result.successful) return { keys: null, error: firstLines(result.error) || i18n.t('toolbar.filterPanel.datacoreFailed') };
		const items = (result.value ?? []) as DatacoreItem[];
		const keys = new Set<string>();
		for (const it of items) {
			if (!it || typeof it !== 'object') continue;
			const path = typeof it.$path === 'string' ? it.$path : typeof it.$file === 'string' ? it.$file : null;
			if (!path) continue;
			if (want === 'file') keys.add(path);
			else if (typeof it.$line === 'number') keys.add(`${path}:${it.$line + 1}`);
		}
		if (want === 'task' && items.length > 0 && keys.size === 0) {
			return { keys: null, error: i18n.t('toolbar.filterPanel.datacoreOnlyTask') };
		}
		return { keys };
	} catch (e) {
		return { keys: null, error: firstLines(e) || i18n.t('toolbar.filterPanel.datacoreFailed') };
	}
}

// ===== Dataview（文件页：LIST / TABLE / FROM） =====

/** Dataview 文件查询文本：去掉 // 注释行；只有 FROM 时补成 LIST FROM */
export function dataviewFileSource(text: string): string {
	const src = text.split('\n').filter((l) => l.trim() && !RE.slashComment.test(l)).join('\n').trim();
	return RE.dataviewFromOnly.test(src) ? `LIST ${src}` : src;
}

function linkPath(v: unknown): string | null {
	if (v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string') return (v as { path: string }).path;
	return null;
}

function collectPaths(values: unknown[], into: Set<string>): void {
	for (const v of values) {
		const direct = linkPath(v);
		if (direct) {
			into.add(direct);
			continue;
		}
		if (Array.isArray(v)) {
			// TABLE 行：首列是文件链接
			const p = linkPath(v[0]);
			if (p) into.add(p);
			continue;
		}
		const rows = v && typeof v === 'object' ? (v as { rows?: unknown }).rows : undefined;
		if (Array.isArray(rows)) collectPaths(rows, into);
		else if (rows && typeof (rows as { array?: unknown }).array === 'function') collectPaths((rows as { array: () => unknown[] }).array(), into);
	}
}

/** 执行 Dataview LIST / TABLE 查询，返回结果中文件链接的路径 */
export async function runDataviewFileQuery(app: App, text: string): Promise<EngineResult> {
	const api = getDataviewApi(app);
	if (!api) return { keys: null, error: i18n.t('toolbar.filterPanel.dataviewMissing') };
	try {
		const result = await api.query(dataviewFileSource(text));
		if (!result.successful) return { keys: null, error: firstLines(result.error) || i18n.t('toolbar.filterPanel.dataviewFailed') };
		const type = result.value?.type;
		if (type !== 'list' && type !== 'table') return { keys: null, error: i18n.t('toolbar.filterPanel.dataviewOnlyFile') };
		const values = result.value?.values;
		const items = values && 'array' in values ? values.array() : Array.from(values ?? []);
		const keys = new Set<string>();
		collectPaths(items, keys);
		if (items.length > 0 && keys.size === 0) return { keys: null, error: i18n.t('toolbar.filterPanel.dataviewNoLinks') };
		return { keys };
	} catch (e) {
		return { keys: null, error: firstLines(e) || i18n.t('toolbar.filterPanel.dataviewFailed') };
	}
}
