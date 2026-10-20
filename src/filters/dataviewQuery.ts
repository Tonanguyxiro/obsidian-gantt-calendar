/**
 * 任务查询里的 Dataview 查询（DQL TASK）
 *
 * 任务查询框的内容以 TASK 开头时，整段文本交给 Dataview 插件执行（需安装并启用），
 * 结果任务集用 路径:行号 与本插件的任务对应；其余情况仍按 Tasks 语法（taskQuery.ts）。
 *
 *   TASK FROM "Projects" WHERE !completed AND due <= date(today) + dur(7 days)
 */

import type { App } from 'obsidian';
import type { GCTask } from '../types';
import { RegularExpressions } from '../utils/RegularExpressions';
import { i18n } from '../i18n/i18n';

interface DataviewTaskItem {
	path?: string;
	/** Dataview 的 line 从 0 起，本插件的 lineNumber 从 1 起 */
	line?: number;
	rows?: DataviewTaskItem[];
}

interface DataviewQueryResult {
	successful: boolean;
	value?: { type?: string; values?: Iterable<DataviewTaskItem> | { array: () => DataviewTaskItem[] } };
	error?: unknown;
}

interface DataviewApi {
	query: (source: string) => Promise<DataviewQueryResult>;
}

/** 文本是否是 Dataview TASK 查询（首个非空、非 # 注释行以 TASK 开头） */
export function isDataviewQuery(text: string): boolean {
	const first = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
	return !!first && RegularExpressions.Filters.dataviewTask.test(first);
}

/** 任务的匹配键：路径:行号（1 起） */
export function dataviewTaskKey(task: Pick<GCTask, 'filePath' | 'lineNumber'>): string {
	return `${task.filePath}:${task.lineNumber}`;
}

export function getDataviewApi(app: App): DataviewApi | null {
	const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { api?: DataviewApi } | undefined> } }).plugins?.plugins?.dataview;
	return plugin?.api ?? null;
}

/** 展开 GROUP BY 产生的嵌套 rows，收集所有任务键 */
function collectKeys(items: Iterable<DataviewTaskItem>, into: Set<string>): void {
	for (const it of items) {
		if (it.rows) collectKeys(it.rows, into);
		else if (typeof it.path === 'string' && typeof it.line === 'number') into.add(`${it.path}:${it.line + 1}`);
	}
}

function firstLines(error: unknown): string {
	return String(error).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--') && l !== 'Error:').slice(0, 2).join(' ');
}

export interface DataviewTaskResult {
	keys: Set<string> | null;
	error?: string;
}

/** 执行 Dataview TASK 查询，返回命中任务的键集合；插件缺失 / 语法错误 / 非 TASK 查询时 keys 为 null 并给出错误 */
export async function runDataviewTaskQuery(app: App, dql: string): Promise<DataviewTaskResult> {
	const api = getDataviewApi(app);
	if (!api) return { keys: null, error: i18n.t('toolbar.filterPanel.dataviewMissing') };
	try {
		const result = await api.query(dql.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'));
		if (!result.successful) return { keys: null, error: firstLines(result.error) || i18n.t('toolbar.filterPanel.dataviewFailed') };
		if (result.value?.type !== 'task') return { keys: null, error: i18n.t('toolbar.filterPanel.dataviewOnlyTask') };
		const values = result.value.values;
		const items = values && 'array' in values ? values.array() : Array.from(values ?? []);
		const keys = new Set<string>();
		collectKeys(items, keys);
		return { keys };
	} catch (e) {
		return { keys: null, error: firstLines(e) || i18n.t('toolbar.filterPanel.dataviewFailed') };
	}
}
