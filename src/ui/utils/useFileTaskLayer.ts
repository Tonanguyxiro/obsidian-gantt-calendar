import { useMemo } from 'react';
import type { GCTask } from '../../types';
import type { DateFieldType, FileTaskViewKey } from '../../settings/types';
import { useCalendarStore } from '../store/calendarStore';
import { usePlugin } from '../pluginContext';
import { useAdvancedFilters } from './useAdvancedFilters';
import { fileTaskToCalendarTask, groupTasksByFile, excludeGroupedTasks, isFileTaskFeatureOn } from '../../fileTasks/fileTaskLayer';

export interface FileTaskLayer {
	/** 本视图是否显示 file-based task */
	enabled: boolean;
	/** 文件占位任务（进入时间线模型，渲染为文件卡片） */
	calendarTasks: GCTask[];
	/** 各文件内的任务（悬浮展开卡片的数据源） */
	tasksByFile: Map<string, GCTask[]>;
	/**
	 * 合入文件占位任务；开启归类时收起文件内的任务
	 * @param keep 归类后仍保留在原位置的任务（日/周视图：定时任务留在时间轴上）
	 */
	merge: (tasks: GCTask[], keep?: (task: GCTask) => boolean) => GCTask[];
}

const EMPTY_MAP = new Map<string, GCTask[]>();

/**
 * 视图的 file-based task 图层
 * @param scopedTasks 已经过视图筛选的任务（悬浮卡片里列出的就是它们）
 */
export function useFileTaskLayer(
	view: FileTaskViewKey,
	scopedTasks: GCTask[],
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): FileTaskLayer {
	const plugin = usePlugin();
	const allFileTasks = useCalendarStore((s) => s.fileTasks);
	const { filterFileTasks } = useAdvancedFilters(view);
	const fileTasks = useMemo(() => filterFileTasks(allFileTasks), [filterFileTasks, allFileTasks]);
	const options = plugin.settings.fileTaskViews?.[view];
	const enabled = isFileTaskFeatureOn(plugin.settings) && !!options?.show && fileTasks.length > 0;
	const groupTasks = enabled && !!options?.groupTasks;

	const calendarTasks = useMemo(
		() => (enabled ? fileTasks.map((ft) => fileTaskToCalendarTask(ft, startField, endField, dateField)) : []),
		[enabled, fileTasks, startField, endField, dateField],
	);
	const tasksByFile = useMemo(
		() => (enabled ? groupTasksByFile(scopedTasks, fileTasks) : EMPTY_MAP),
		[enabled, scopedTasks, fileTasks],
	);

	return useMemo<FileTaskLayer>(() => ({
		enabled,
		calendarTasks,
		tasksByFile,
		merge: (tasks, keep) => {
			if (!enabled) return tasks;
			const visible = groupTasks ? excludeGroupedTasks(tasks, fileTasks, keep) : tasks;
			return [...calendarTasks, ...visible];
		},
	}), [enabled, groupTasks, calendarTasks, tasksByFile, fileTasks]);
}
