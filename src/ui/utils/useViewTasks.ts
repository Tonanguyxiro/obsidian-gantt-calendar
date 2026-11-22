import { useContext, useMemo } from 'react';
import type { GCTask } from '../../types';
import type { DateFieldType } from '../../settings/types';
import { PluginContext } from '../pluginContext';
import { useCalendarStore } from '../store/calendarStore';
import { applyScheduledFallbackAll, expandTimeSlots } from '../../tasks/scheduledFallback';

interface RangeQueryableTaskCache {
	getTasksByDateRange?: (start: Date, end: Date) => GCTask[];
}

/**
 * 视图使用的任务集：store 任务经计划日期回退代理
 * （只有 ⏳ 的任务按计划日期 / Day Planner 时间前缀定位到视图字段）。
 *
 * 传入 `dateRange` 且底层 `taskCache.getTasksByDateRange` 可用时，按本地日期桶做范围查询
 * （仅订阅 `updateSeq` 与 `tasks` 回退），避免对全库任务执行 `applyScheduledFallbackAll`/`expandTimeSlots`。
 *
 * @param timeAxis 时间轴视图（周 / 日 / 侧栏每日时间线）传 true：起止只当日期区间条，
 *                 ⏳ + 时间前缀另成「时间片」时间块，二者并存互不干扰（见 expandTimeSlots）
 * @param dateRange 可选的视图可见日期范围
 */
export function useViewTasks(
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
	timeAxis = false,
	dateRange?: { start: Date; end: Date },
): GCTask[] {
	const plugin = useContext(PluginContext);
	const tasks = useCalendarStore((s) => s.tasks);
	const updateSeq = useCalendarStore((s) => s.updateSeq);

	const taskCache = plugin?.taskCache as RangeQueryableTaskCache | undefined;
	const rangeStartMs = dateRange?.start ? dateRange.start.getTime() : null;
	const rangeEndMs = dateRange?.end ? dateRange.end.getTime() : null;
	const canUseRangeQuery =
		rangeStartMs !== null &&
		rangeEndMs !== null &&
		!Number.isNaN(rangeStartMs) &&
		!Number.isNaN(rangeEndMs) &&
		typeof taskCache?.getTasksByDateRange === 'function';

	return useMemo(() => {
		const sourceTasks =
			canUseRangeQuery && taskCache?.getTasksByDateRange && rangeStartMs !== null && rangeEndMs !== null
				? taskCache.getTasksByDateRange(new Date(rangeStartMs), new Date(rangeEndMs))
				: tasks;
		return timeAxis
			? expandTimeSlots(sourceTasks, startField, endField, dateField)
			: applyScheduledFallbackAll(sourceTasks, startField, endField, dateField);
	}, [canUseRangeQuery, taskCache, rangeStartMs, rangeEndMs, tasks, updateSeq, startField, endField, dateField, timeAxis]);
}
