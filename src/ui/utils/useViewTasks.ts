import { useMemo } from 'react';
import type { GCTask } from '../../types';
import type { DateFieldType } from '../../settings/types';
import { useCalendarStore } from '../store/calendarStore';
import { applyScheduledFallbackAll, expandTimeSlots } from '../../tasks/scheduledFallback';

/**
 * 视图使用的任务集：store 任务经计划日期回退代理
 * （只有 ⏳ 的任务按计划日期 / Day Planner 时间前缀定位到视图字段）。
 *
 * @param timeAxis 时间轴视图（周 / 日 / 侧栏每日时间线）传 true：起止只当日期区间条，
 *                 ⏳ + 时间前缀另成「时间片」时间块，二者并存互不干扰（见 expandTimeSlots）
 */
export function useViewTasks(
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
	timeAxis = false,
): GCTask[] {
	const tasks = useCalendarStore((s) => s.tasks);
	return useMemo(
		() => (timeAxis
			? expandTimeSlots(tasks, startField, endField, dateField)
			: applyScheduledFallbackAll(tasks, startField, endField, dateField)),
		[tasks, startField, endField, dateField, timeAxis],
	);
}
