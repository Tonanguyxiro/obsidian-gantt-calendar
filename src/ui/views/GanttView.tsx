import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { isChineseLanguage } from '../../i18n/i18n';
import { Notice } from 'obsidian';
import { sortTasks } from '../../tasks/taskSorter';
import { GanttClasses, ViewClasses } from '../../utils/bem';
import { Logger } from '../../utils/logger';
import { generateVirtualInstances } from '../../tasks/virtualTaskGenerator';
import {
	GanttChartAdapter,
	TaskUpdateHandler,
	TaskDataAdapter,
	type GanttChartConfig,
	type GanttChartTask,
	TimeGranularity,
} from '../../gantt';
import { i18n } from '../../i18n/i18n';
import { usePlugin, useApp } from '../pluginContext';
import type { FileTask } from '../../types';
import { useCalendarStore, selectViewFilter } from '../store/calendarStore';
import { useAdvancedFilters } from '../utils/useAdvancedFilters';
import { applyTagFilter } from '../utils/taskFilters';
import { buildGanttRows, isFileTaskFeatureOn } from '../../fileTasks/fileTaskLayer';
import { writeFileTaskDates } from '../../fileTasks/fileTaskWriter';
import { openEditTaskModal } from '../modals/TaskFormModal';
import { openFileInExistingLeaf } from '../../utils/fileOpener';
import { formatDate } from '../../dateUtils/dateUtilsIndex';
import { useViewTasks } from '../utils/useViewTasks';

const GANTT_CONFIG: Omit<GanttChartConfig, 'on_click' | 'on_date_change' | 'on_progress_change'> = {
	view_mode: 'week',
	granularity: TimeGranularity.DAY,
	language: isChineseLanguage() ? 'zh' : 'en',
	header_height: 50,
	column_width: 40,
	step: 24,
	bar_height: 24,
	bar_corner_radius: 4,
	arrow_curve: 5,
	padding: 18,
	date_format: 'YYYY-MM-DD',
};

export function GanttView(): JSX.Element {
	const plugin = usePlugin();
	const app = useApp();
	const filter = useCalendarStore((s) => selectViewFilter(s, 'gantt'));
	const ganttScroll = useCalendarStore((s) => s.ganttScroll);
	const refreshTasks = useCalendarStore((s) => s.refreshTasks);

	const startField = plugin.settings.ganttStartField;
	const endField = plugin.settings.ganttEndField;
	const tasks = useViewTasks(startField, endField, endField);

	const containerRef = useRef<HTMLDivElement | null>(null);
	const engineRef = useRef<GanttChartAdapter | null>(null);
	const readyRef = useRef(false);
	const syncedSigRef = useRef('');
	const lastGanttRef = useRef<GanttChartTask[]>([]);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const updateHandlerRef = useRef<TaskUpdateHandler | null>(null);
	if (!updateHandlerRef.current) {
		updateHandlerRef.current = new TaskUpdateHandler(app, plugin);
	}

	const advanced = useAdvancedFilters('gantt');
	const filteredTasks = useMemo(() => {
		// 标签走与日历视图一致的层级匹配（选父标签包含其子标签）
		const byTag = applyTagFilter(TaskDataAdapter.applyFilters(tasks, filter.status), filter.tag);
		return sortTasks(advanced.filterTasks(byTag), filter.sort);
	}, [tasks, filter, advanced]);

	// 重复任务：为甘特图生成虚拟实例
	const tasksWithVirtuals = useMemo(() => {
		const recurringLimit = plugin.settings.recurringTaskDisplayLimit ?? 5;
		const ref = new Date();
		const rangeStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
		const rangeEnd = new Date(ref.getFullYear() + 1, ref.getMonth(), ref.getDate());
		const virtuals = generateVirtualInstances(
			filteredTasks, rangeStart, rangeEnd,
			startField, recurringLimit,
		);
		return [...filteredTasks, ...virtuals];
	}, [filteredTasks, startField, plugin.settings.recurringTaskDisplayLimit]);

	// file-based task 分区：上方文件时间轴（按项目分组，无项目在分区底部），下方任务时间轴；
	// 归类开启时任务移到所属文件行下，下方只剩不属于 file-based task 的任务
	const allFileTasks = useCalendarStore((s) => s.fileTasks);
	const fileOptions = plugin.settings.fileTaskViews?.gantt;
	const fileTasks = useMemo(
		() => (isFileTaskFeatureOn(plugin.settings) && fileOptions?.show ? advanced.filterFileTasks(allFileTasks) : EMPTY_FILE_TASKS),
		[plugin.settings, fileOptions?.show, advanced, allFileTasks],
	);
	const groupTasks = !!fileOptions?.groupTasks;

	// 文件行折叠状态（持久化到设置，重开视图后保持）
	const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(
		() => new Set(plugin.settings.ganttCollapsedFileTasks ?? []),
	);
	const handleToggleCollapse = useCallback((ganttTask: GanttChartTask) => {
		const path = ganttTask.fileTask?.filePath;
		if (!path) return;
		setCollapsedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			plugin.settings.ganttCollapsedFileTasks = Array.from(next);
			void plugin.saveSettings();
			return next;
		});
	}, [plugin]);

	const ganttTasks = useMemo(() => {
		const items = TaskDataAdapter.toGanttChartTasks(tasksWithVirtuals, startField, endField);
		const rows = buildGanttRows(fileTasks, items, (t) => t.filePath, groupTasks, collapsedFiles);
		return rows.map((row): GanttChartTask => {
			switch (row.kind) {
				case 'section':
					return {
						id: row.id, start: '', end: '', progress: 0, rowKind: 'section',
						name: i18n.t(row.section === 'files' ? 'fileTasks.ganttFilesSection' : 'fileTasks.ganttTasksSection'),
					};
				case 'project':
					return {
						id: row.id, start: '', end: '', progress: 0, rowKind: 'project',
						name: row.label || i18n.t('fileTasks.noProject'), linkPath: row.linkPath,
					};
				case 'file':
					return {
						id: row.id,
						name: row.fileTask.title,
						start: formatDate(row.fileTask.start, 'yyyy-MM-dd'),
						end: formatDate(row.fileTask.end, 'yyyy-MM-dd'),
						progress: 0,
						rowKind: 'file',
						filePath: row.fileTask.filePath,
						fileName: row.fileTask.title,
						fileTask: row.fileTask,
						childCount: row.childCount,
						collapsed: row.collapsed,
					};
				case 'task':
					return row.nested ? { ...row.item, indent: 1 } : row.item;
			}
		});
	}, [tasksWithVirtuals, startField, endField, fileTasks, groupTasks, collapsedFiles]);

	const hasTasks = ganttTasks.length > 0;

	const tasksRef = useRef(filteredTasks);
	tasksRef.current = filteredTasks;
	const ganttTasksRef = useRef(ganttTasks);
	ganttTasksRef.current = ganttTasks;
	const startFieldRef = useRef(startField);
	startFieldRef.current = startField;
	const endFieldRef = useRef(endField);
	endFieldRef.current = endField;

	const handleTaskClick = useCallback((ganttTask: GanttChartTask) => {
		updateHandlerRef.current?.handleTaskClick(ganttTask, tasksRef.current);
	}, []);

	const handleDateChange = useCallback(async (ganttTask: GanttChartTask, start: Date, end: Date) => {
		const updateHandler = updateHandlerRef.current;
		if (!updateHandler) return;
		if (!TaskUpdateHandler.validateDateChange(start, end)) {
			new Notice(i18n.t('views.ganttView.invalidDateRange'));
			return;
		}
		if (ganttTask.fileTask) {
			// file 行：写回 frontmatter 起止属性
			await writeFileTaskDates(app, ganttTask.fileTask, start, end, plugin.settings);
			return;
		}
		try {
			await updateHandler.handleDateChange(
				ganttTask,
				start,
				end,
				startFieldRef.current,
				endFieldRef.current,
				tasksRef.current
			);
			refreshTasks();
		} catch (error) {
			Logger.error('GanttView', 'Error handling date change:', error);
		}
	}, [app, plugin, refreshTasks]);

	const handleProgressChange = useCallback(async (ganttTask: GanttChartTask, progress: number) => {
		const updateHandler = updateHandlerRef.current;
		if (!updateHandler) return;
		try {
			await updateHandler.handleProgressChange(ganttTask, progress, tasksRef.current);
			refreshTasks();
		} catch (error) {
			Logger.error('GanttView', 'Error handling progress change:', error);
		}
	}, [refreshTasks]);

	// 双击：file 行打开文件；任务行按设置弹出编辑面板（默认）或跳转源文件
	const doubleClickAction = plugin.settings.taskCardDoubleClickAction ?? 'editModal';
	const handleTaskDoubleClick = useCallback((ganttTask: GanttChartTask) => {
		if (!ganttTask.filePath) return;
		if (ganttTask.rowKind === 'file' || doubleClickAction === 'openFile') {
			void openFileInExistingLeaf(app, ganttTask.filePath, ganttTask.rowKind === 'file' ? 0 : ganttTask.lineNumber);
			return;
		}
		const task = tasksRef.current.find((t) => t.filePath === ganttTask.filePath && t.lineNumber === ganttTask.lineNumber);
		if (!task) return;
		openEditTaskModal(app, task, plugin.settings.enabledTaskFormats || ['tasks'], () => refreshTasks(), true);
	}, [app, plugin, doubleClickAction, refreshTasks]);

	const config = useMemo<GanttChartConfig>(() => ({
		...GANTT_CONFIG,
		on_click: handleTaskClick,
		on_dblclick: doubleClickAction === 'none' ? undefined : handleTaskDoubleClick,
		on_toggle_collapse: handleToggleCollapse,
		on_date_change: (task, start, end) => { void handleDateChange(task, start, end); },
		on_progress_change: (task, progress) => { void handleProgressChange(task, progress); },
	}), [handleTaskClick, handleTaskDoubleClick, handleToggleCollapse, doubleClickAction, handleDateChange, handleProgressChange]);

	const destroyEngine = useCallback(() => {
		engineRef.current?.destroy();
		engineRef.current = null;
		readyRef.current = false;
		syncedSigRef.current = '';
		lastGanttRef.current = [];
	}, []);

	const buildEngine = useCallback(() => {
		const el = containerRef.current;
		if (!el || engineRef.current) return;
		const engine = new GanttChartAdapter(
			el,
			config,
			plugin,
			tasksRef.current,
			startFieldRef.current,
			endFieldRef.current
		);
		engineRef.current = engine;
		readyRef.current = false;
		void engine.init(ganttTasksRef.current).then(() => {
			readyRef.current = true;
			setErrorMsg(null);
			syncedSigRef.current = tasksSignature(ganttTasksRef.current);
			lastGanttRef.current = ganttTasksRef.current;
			engine.scrollToToday();
		}).catch((error) => {
			Logger.error('GanttView', 'Error initializing gantt:', error);
			setErrorMsg((error as Error).message);
		});
	}, [config, plugin]);

	useEffect(() => {
		if (!hasTasks) return;
		buildEngine();
		return () => destroyEngine();
	}, [hasTasks, startField, endField, buildEngine, destroyEngine]);

	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !readyRef.current || !hasTasks) return;
		const sig = tasksSignature(ganttTasks);
		if (sig === syncedSigRef.current) return;
		syncedSigRef.current = sig;
		const oldTasks = lastGanttRef.current;
		lastGanttRef.current = ganttTasks;
		if (shouldFullRefresh(oldTasks, ganttTasks)) {
			// 行顺序变化（含折叠/展开文件行）：同一引擎全量重绘，保留滚动位置
			engine.refreshTasks(ganttTasks);
			return;
		}
		engine.updateTasks(ganttTasks);
	}, [ganttTasks, hasTasks, startField, endField, buildEngine, destroyEngine]);

	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !readyRef.current || !hasTasks || !ganttScroll) return;
		switch (ganttScroll.action) {
			case 'left': engine.scrollToLeft(); break;
			case 'today': engine.scrollToToday(); break;
			case 'right': engine.scrollToRight(); break;
		}
	}, [ganttScroll, hasTasks]);

	const emptyReasons = useMemo(() => {
		const reasons: string[] = [];
		if (filter.status.selectedStatuses.length > 0) {
			reasons.push(i18n.t('views.ganttView.currentFilter', { count: filter.status.selectedStatuses.length }));
		}
		if (filter.tag.selectedTags.length > 0) {
			reasons.push(i18n.t('views.ganttView.tagFilter', { tags: filter.tag.selectedTags.join(', ') }));
		}
		if (!startField || !endField) {
			reasons.push(i18n.t('views.ganttView.missingFieldConfig'));
		}
		return reasons;
	}, [filter, startField, endField]);

	if (!hasTasks) {
		return (
			<div className={`${ViewClasses.block} ${ViewClasses.modifiers.gantt}`}>
				<div className={GanttClasses.elements.emptyState}>
					<div className={GanttClasses.elements.emptyIcon}>{'📊'}</div>
					<h3 className={GanttClasses.elements.emptyTitle}>{i18n.t('views.ganttView.emptyTitle')}</h3>
					{emptyReasons.length > 0 ? (
						<p className={GanttClasses.elements.emptyReason}>
							{i18n.t('views.ganttView.possibleReasons')}{emptyReasons.join(', ')}
						</p>
					) : null}
					<p className={GanttClasses.elements.emptyHint}>{i18n.t('views.ganttView.checkDatesHint')}</p>
				</div>
			</div>
		);
	}

	return (
		<div className={`${ViewClasses.block} ${ViewClasses.modifiers.gantt}`}>
			{errorMsg ? (
				<div className={GanttClasses.elements.error}>
					{i18n.t('views.ganttView.renderError')}{errorMsg}
				</div>
			) : null}
			<div className={GanttClasses.elements.container}>
				<div ref={containerRef} className={GanttClasses.elements.root} />
			</div>
		</div>
	);
}

const EMPTY_FILE_TASKS: FileTask[] = [];

function tasksSignature(tasks: GanttChartTask[]): string {
	return tasks.map((t) => `${t.id}|${t.indent || 0}|${t.collapsed ? 1 : 0}|${t.childCount || 0}|${t.start}|${t.end}|${t.leadStart || ''}|${t.progress}|${t.completed}|${t.name}|${t.custom_class || ''}`).join('\u0001');
}

/**
 * Full engine rebuild is only needed when the row ORDER changes: bars are
 * positioned by row index, so an insert in the middle shifts every row below.
 * Appending or removing at the tail keeps the prefix sequence intact and can
 * be handled incrementally by the renderer (with stable task ids).
 */
function shouldFullRefresh(oldTasks: GanttChartTask[], newTasks: GanttChartTask[]): boolean {
	const commonLength = Math.min(oldTasks.length, newTasks.length);
	for (let i = 0; i < commonLength; i++) {
		if (oldTasks[i].id !== newTasks[i].id) return true;
	}
	return false;
}