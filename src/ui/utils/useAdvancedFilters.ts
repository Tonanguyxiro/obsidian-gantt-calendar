import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileTask, GCTask } from '../../types';
import { useApp } from '../pluginContext';
import { useCalendarStore, selectViewFilter, type ViewScope } from '../store/calendarStore';
import { buildFileContext, compileFileFilter, readBaseText } from '../../filters/baseFilter';
import { compileTaskQuery } from '../../filters/taskQuery';

export interface AdvancedFilters {
	/** 应用文件筛选 + 任务查询 */
	filterTasks: (tasks: GCTask[]) => GCTask[];
	/** 应用文件筛选（文件横跨条） */
	filterFileTasks: (fileTasks: FileTask[]) => FileTask[];
	/** 是否有任何高级条件生效 */
	active: boolean;
	fileErrors: string[];
	taskErrors: string[];
}

/**
 * 视图作用域的「文件筛选（Bases 语法）+ 任务查询（Tasks 语法）」
 * 返回的函数在条件变化时更换引用，可直接作为 useMemo 依赖
 */
export function useAdvancedFilters(scope: ViewScope): AdvancedFilters {
	const app = useApp();
	const { file, taskQuery } = useCalendarStore((s) => selectViewFilter(s, scope));
	const baseFile = file?.baseFile ?? '';
	const baseView = file?.baseView ?? '';
	const expression = file?.expression ?? '';

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

	const compiledFile = useMemo(
		() => compileFileFilter(
			{ baseFile, baseView, expression },
			// 读取尚未完成时不报"找不到"，也不按空条件过滤
			baseText?.path === baseFile ? baseText.text : null,
		),
		[baseFile, baseView, expression, baseText],
	);
	const basePending = !!baseFile && baseText?.path !== baseFile;
	const fileErrors = basePending ? [] : compiledFile.errors;
	const filePredicate = compiledFile.predicate;

	const compiledQuery = useMemo(() => compileTaskQuery(taskQuery ?? ''), [taskQuery]);
	const taskPredicate = compiledQuery.predicate;

	const pathPredicate = useCallback((): ((path: string) => boolean) | null => {
		if (!filePredicate) return null;
		const cache = new Map<string, boolean>();
		return (path) => {
			let ok = cache.get(path);
			if (ok === undefined) {
				const f = app.vault.getFileByPath(path);
				ok = f ? filePredicate(buildFileContext(app, f)) : false;
				cache.set(path, ok);
			}
			return ok;
		};
	}, [app, filePredicate]);

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
		active: !!filePredicate || !!taskPredicate,
		fileErrors,
		taskErrors: compiledQuery.errors,
	};
}
