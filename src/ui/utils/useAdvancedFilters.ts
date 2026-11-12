import { useCallback, useEffect, useMemo, useState } from 'react';
import type { App, EventRef } from 'obsidian';
import type { FileTask, GCTask } from '../../types';
import { useApp } from '../pluginContext';
import { useCalendarStore, selectViewFilter, type ViewScope } from '../store/calendarStore';
import { buildFileContext, compileFileFilter, readBaseText } from '../../filters/baseFilter';
import { compileTaskQuery } from '../../filters/taskQuery';
import { dataviewTaskKey, runDataviewTaskQuery } from '../../filters/dataviewQuery';
import {
	detectFileEngine,
	detectTaskEngine,
	onDatacoreUpdate,
	runDatacoreQuery,
	runDataviewFileQuery,
	type EngineResult,
	type FileEngine,
	type TaskEngine,
} from '../../filters/queryEngines';

export interface AdvancedFilters {
	/** 应用文件筛选 + 任务查询 */
	filterTasks: (tasks: GCTask[]) => GCTask[];
	/** 应用文件筛选（文件横跨条） */
	filterFileTasks: (fileTasks: FileTask[]) => FileTask[];
	/** 是否有任何高级条件生效 */
	active: boolean;
	fileErrors: string[];
	taskErrors: string[];
	/** 文件页查询所用引擎（按内容前缀识别，见 queryEngines.ts） */
	fileEngine: FileEngine;
	/** 任务页查询所用引擎 */
	taskEngine: TaskEngine;
	/** 外部引擎（Dataview / Datacore）的查询尚未返回 */
	filePending: boolean;
	taskPending: boolean;
	/** 单独的文件条件判定（按路径）；无条件时为 null。供面板统计命中数 */
	fileMatches: ((path: string) => boolean) | null;
	/** 单独的任务查询判定；无条件时为 null */
	taskMatches: ((task: GCTask) => boolean) | null;
}

type MetadataEvents = { on: (name: string, cb: () => void) => EventRef; offref: (ref: EventRef) => void };

/**
 * 执行外部引擎查询（异步）：内容、任务集或引擎索引变化后防抖重跑
 * engine 为 null 时不执行，返回 null
 */
function useEngineQuery(
	app: App,
	engine: 'dataview' | 'datacore' | null,
	text: string,
	run: (app: App, text: string) => Promise<EngineResult>,
	trigger: unknown,
): { result: EngineResult | null; pending: boolean } {
	const [res, setRes] = useState<{ key: string; result: EngineResult } | null>(null);
	const key = engine ? `${engine}\u0000${text}` : '';
	useEffect(() => {
		if (!engine) return;
		let cancelled = false;
		let timer = 0;
		const exec = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				void run(app, text).then((result) => { if (!cancelled) setRes({ key, result }); });
			}, 150);
		};
		exec();
		const cleanups: Array<() => void> = [];
		if (engine === 'dataview') {
			// Dataview 的索引事件不在 Obsidian 的类型声明里
			const mc = app.metadataCache as unknown as MetadataEvents;
			const refs = [mc.on('dataview:index-ready', exec), mc.on('dataview:metadata-change', exec)];
			cleanups.push(() => refs.forEach((r) => mc.offref(r)));
		} else {
			cleanups.push(onDatacoreUpdate(app, exec));
		}
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			cleanups.forEach((c) => c());
		};
	}, [app, engine, text, run, key, trigger]);
	// 内容变化后、新结果返回前沿用上一次结果过滤（避免视图闪一下全部任务），同时标记为进行中
	return { result: engine && res ? res.result : null, pending: !!engine && res?.key !== key };
}

const runTaskDataview = (app: App, text: string) => runDataviewTaskQuery(app, text);
const runTaskDatacore = (app: App, text: string) => runDatacoreQuery(app, text, 'task');
const runFileDatacore = (app: App, text: string) => runDatacoreQuery(app, text, 'file');

/**
 * 视图作用域的「文件筛选（Bases 表达式 / Dataview LIST / Datacore @page）+
 * 任务查询（Tasks 语法 / Dataview TASK / Datacore @task）」
 * 返回的函数在条件变化时更换引用，可直接作为 useMemo 依赖
 */
export function useAdvancedFilters(scope: ViewScope): AdvancedFilters {
	const app = useApp();
	const { file, taskQuery } = useCalendarStore((s) => selectViewFilter(s, scope));
	const tasksRef = useCalendarStore((s) => s.tasks);
	const baseFile = file?.baseFile ?? '';
	const baseView = file?.baseView ?? '';
	const expression = file?.expression ?? '';
	const query = taskQuery ?? '';

	// .base 需要异步读盘；文件变更（用户改了 base）后重新读取
	const [baseText, setBaseText] = useState<{ path: string; text: string | null } | null>(null);
	useEffect(() => {
		if (!baseFile) {
			setBaseText(null);
			return;
		}
		let cancelled = false;
		const load = () => {
			void readBaseText(app, baseFile).then((text) => {
				if (!cancelled) setBaseText({ path: baseFile, text });
			});
		};
		load();
		const ref = app.vault.on('modify', (f) => { if (f.path === baseFile) load(); });
		return () => {
			cancelled = true;
			app.vault.offref(ref);
		};
	}, [app, baseFile]);

	// ===== 文件页：Bases 表达式（默认）/ Dataview / Datacore；.base 文件的条件始终按 Bases 求值 =====
	const fileEngine = detectFileEngine(expression);
	const compiledFile = useMemo(
		() => compileFileFilter(
			{ baseFile, baseView, expression: fileEngine === 'bases' ? expression : '' },
			// 读取尚未完成时不报"找不到"，也不按空条件过滤
			baseText?.path === baseFile ? baseText.text : null,
		),
		[baseFile, baseView, expression, fileEngine, baseText],
	);
	const basePending = !!baseFile && baseText?.path !== baseFile;
	const fileExternal = fileEngine === 'bases' ? null : fileEngine;
	const { result: fileResult, pending: fileRunning } = useEngineQuery(app, fileExternal, expression, fileEngine === 'datacore' ? runFileDatacore : runDataviewFileQuery, tasksRef);
	const filePaths = fileResult?.keys ?? null;
	const fileErrors = [
		...(basePending ? [] : compiledFile.errors),
		...(fileResult?.error ? [fileResult.error] : []),
	];
	const filePredicate = compiledFile.predicate;

	// ===== 任务页：Tasks 语法（默认）/ Dataview TASK / Datacore @task =====
	const taskEngine = detectTaskEngine(query);
	const compiledQuery = useMemo(
		() => (taskEngine === 'tasks' ? compileTaskQuery(query) : { predicate: null, errors: [] as string[] }),
		[taskEngine, query],
	);
	const taskExternal = taskEngine === 'tasks' ? null : taskEngine;
	const { result: taskResult, pending: taskRunning } = useEngineQuery(app, taskExternal, query, taskEngine === 'datacore' ? runTaskDatacore : runTaskDataview, tasksRef);
	const extKeys = taskResult?.keys ?? null;

	// 结果未返回、查询出错时不按它过滤（错误显示在面板里）
	const taskPredicate = useMemo(
		() => (taskExternal
			? (extKeys ? ((t: GCTask) => extKeys.has(dataviewTaskKey(t))) : null)
			: compiledQuery.predicate),
		[taskExternal, extKeys, compiledQuery],
	);
	const taskErrors = taskExternal ? (taskResult?.error ? [taskResult.error] : []) : compiledQuery.errors;

	const pathPredicate = useCallback((): ((path: string) => boolean) | null => {
		if (!filePredicate && !filePaths) return null;
		const cache = new Map<string, boolean>();
		return (path) => {
			let ok = cache.get(path);
			if (ok === undefined) {
				ok = !filePaths || filePaths.has(path);
				if (ok && filePredicate) {
					const f = app.vault.getFileByPath(path);
					ok = f ? filePredicate(buildFileContext(app, f)) : false;
				}
				cache.set(path, ok);
			}
			return ok;
		};
	}, [app, filePredicate, filePaths]);

	const fileMatches = useMemo(() => pathPredicate(), [pathPredicate]);

	const filterTasks = useCallback((tasks: GCTask[]): GCTask[] => {
		const fileOk = pathPredicate();
		if (!fileOk && !taskPredicate) return tasks;
		return tasks.filter((t) => (!fileOk || fileOk(t.filePath)) && (!taskPredicate || taskPredicate(t)));
	}, [pathPredicate, taskPredicate]);

	const filterFileTasks = useCallback((fileTasks: FileTask[]): FileTask[] => {
		const fileOk = pathPredicate();
		return fileOk ? fileTasks.filter((ft) => fileOk(ft.filePath)) : fileTasks;
	}, [pathPredicate]);

	return {
		filterTasks,
		filterFileTasks,
		active: !!filePredicate || !!filePaths || !!taskPredicate,
		fileErrors,
		taskErrors,
		fileEngine,
		taskEngine,
		filePending: fileRunning || basePending,
		taskPending: taskRunning,
		fileMatches,
		taskMatches: taskPredicate,
	};
}
