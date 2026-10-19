/**
 * File-based task 视图层（纯函数）
 *
 * 日历视图：file-based task 转为占位任务进入时间线模型，按全天横跨条/卡片渲染；
 *           开启「归类」后，文件内的任务从日历中收起，改在文件卡片的悬浮展开卡片里列出
 *           （日/周视图的定时任务仍保留在时间轴上）。
 * 甘特视图：上方是文件时间轴（按项目分组，无项目的排在文件分区底部），
 *           下方是任务时间轴；开启「归类」后任务移到所属文件行下，
 *           下方只剩不属于任何 file-based task 的任务。
 */

import type { FileTask, GCTask } from '../types';
import { setTaskDateField } from '../types';
import type { DateFieldType, GanttCalendarSettings } from '../settings/types';

/** file-based task 是否启用（任一引入来源开启） */
export function isFileTaskFeatureOn(settings: GanttCalendarSettings): boolean {
	return !!settings.fileTaskIncludeDated || !!settings.fileTaskIncludeTaskFiles;
}

/** file-based task → 日历占位任务（day 精度，不可按任务行写回） */
export function fileTaskToCalendarTask(
	ft: FileTask,
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): GCTask {
	const start = new Date(ft.start);
	start.setHours(0, 0, 0, 0);
	const end = new Date(ft.end);
	end.setHours(0, 0, 0, 0);
	const task: GCTask = {
		filePath: ft.filePath,
		fileName: ft.title,
		lineNumber: 0,
		content: '',
		description: ft.title,
		completed: false,
		priority: 'normal',
		datePrecision: {},
		fileTask: ft,
	};
	setTaskDateField(task, startField, start);
	setTaskDateField(task, endField, end);
	task.datePrecision![startField] = 'day';
	task.datePrecision![endField] = 'day';
	if (dateField !== startField && dateField !== endField) {
		setTaskDateField(task, dateField, start);
		task.datePrecision![dateField] = 'day';
	}
	return task;
}

/** 按文件路径收集属于 file-based task 的任务（保持输入顺序） */
export function groupTasksByFile(tasks: GCTask[], fileTasks: FileTask[]): Map<string, GCTask[]> {
	const paths = new Set(fileTasks.map((f) => f.filePath));
	const byFile = new Map<string, GCTask[]>();
	for (const t of tasks) {
		if (!paths.has(t.filePath)) continue;
		const list = byFile.get(t.filePath);
		if (list) list.push(t);
		else byFile.set(t.filePath, [t]);
	}
	return byFile;
}

/**
 * 归类开启时从日历中收起属于 file-based task 的任务
 * @param keep 仍保留在原位置的任务（日/周视图传「定时任务」判定，使其留在时间轴上）
 */
export function excludeGroupedTasks(
	tasks: GCTask[],
	fileTasks: FileTask[],
	keep?: (task: GCTask) => boolean,
): GCTask[] {
	if (fileTasks.length === 0) return tasks;
	const paths = new Set(fileTasks.map((f) => f.filePath));
	return tasks.filter((t) => t.fileTask || !paths.has(t.filePath) || (keep ? keep(t) : false));
}

// ===== 甘特视图行模型 =====

export type GanttRow<T> =
	| { kind: 'section'; id: string; section: 'files' | 'tasks' }
	| { kind: 'project'; id: string; label: string; linkPath?: string }
	| { kind: 'file'; id: string; fileTask: FileTask; childCount: number; collapsed: boolean }
	| { kind: 'task'; item: T; nested: boolean };

/**
 * 构建甘特行序列：
 * [文件分区标题] → 各项目（标题 + 文件行 [+ 归类任务]）→ 无项目文件（有项目分组时带「无项目」标题）
 * → [任务分区标题] → 其余任务
 *
 * @param items     已转换的甘特任务（保持排序）
 * @param filePathOf 取甘特任务所在文件路径
 * @param collapsedFiles 已折叠的文件路径（其归类任务不出行，文件行记录收起的任务数）
 */
export function buildGanttRows<T>(
	fileTasks: FileTask[],
	items: T[],
	filePathOf: (item: T) => string | undefined,
	groupTasks: boolean,
	collapsedFiles: ReadonlySet<string> = new Set(),
): GanttRow<T>[] {
	if (fileTasks.length === 0) {
		return items.map((item) => ({ kind: 'task' as const, item, nested: false }));
	}

	const filePaths = new Set(fileTasks.map((f) => f.filePath));
	const nestedByFile = new Map<string, T[]>();
	const rest: T[] = [];
	for (const item of items) {
		const path = filePathOf(item);
		if (groupTasks && path && filePaths.has(path)) {
			const list = nestedByFile.get(path);
			if (list) list.push(item);
			else nestedByFile.set(path, [item]);
		} else {
			rest.push(item);
		}
	}

	// 项目分组：按显示名排序，无项目的文件放在文件分区最下方
	const projects = new Map<string, { label: string; linkPath?: string; files: FileTask[] }>();
	const noProject: FileTask[] = [];
	for (const ft of fileTasks) {
		if (!ft.project) {
			noProject.push(ft);
			continue;
		}
		const group = projects.get(ft.project.key);
		if (group) group.files.push(ft);
		else projects.set(ft.project.key, { label: ft.project.label, linkPath: ft.project.linkPath, files: [ft] });
	}

	const rows: GanttRow<T>[] = [{ kind: 'section', id: 'section:files', section: 'files' }];
	const pushFile = (ft: FileTask) => {
		const children = nestedByFile.get(ft.filePath) ?? [];
		const collapsed = collapsedFiles.has(ft.filePath);
		rows.push({ kind: 'file', id: `file:${ft.filePath}`, fileTask: ft, childCount: children.length, collapsed });
		if (collapsed) return;
		for (const item of children) {
			rows.push({ kind: 'task', item, nested: true });
		}
	};
	const sortedProjects = Array.from(projects.entries()).sort((a, b) => a[1].label.localeCompare(b[1].label));
	for (const [key, group] of sortedProjects) {
		rows.push({ kind: 'project', id: `project:${key}`, label: group.label, linkPath: group.linkPath });
		group.files.forEach(pushFile);
	}
	if (noProject.length > 0) {
		if (sortedProjects.length > 0) rows.push({ kind: 'project', id: 'project:', label: '' });
		noProject.forEach(pushFile);
	}

	rows.push({ kind: 'section', id: 'section:tasks', section: 'tasks' });
	for (const item of rest) rows.push({ kind: 'task', item, nested: false });
	return rows;
}
