import { useMemo } from 'react';
import type { GCTask } from '../../types';
import type { DateFieldType } from '../../settings/types';
import { useCalendarStore } from '../store/calendarStore';
import { applyScheduledFallbackAll } from '../../tasks/scheduledFallback';

/**
 * 视图使用的任务集：store 任务经计划日期回退代理
 * （只有 ⏳ 的任务按计划日期 / Day Planner 时间前缀定位到视图字段）
 */
export function useViewTasks(startField: DateFieldType, endField: DateFieldType, dateField: DateFieldType): GCTask[] {
	const tasks = useCalendarStore((s) => s.tasks);
	return useMemo(
		() => applyScheduledFallbackAll(tasks, startField, endField, dateField),
		[tasks, startField, endField, dateField],
	);
}
