import { useMemo } from 'react';
import type { GCTask } from '../../types';
import type { DateFieldType } from '../../settings/types';
import { useCalendarStore } from '../store/calendarStore';
import { icsEventToCalendarTask } from '../../data-layer/ics/icsTask';

/**
 * 视图的 ICS 订阅事件图层：事件转为只读占位任务，合入时间线模型的任务集
 */
export function useIcsLayer(
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): (tasks: GCTask[]) => GCTask[] {
	const events = useCalendarStore((s) => s.icsEvents);
	const icsTasks = useMemo(
		() => events.map((ev) => icsEventToCalendarTask(ev, startField, endField, dateField)),
		[events, startField, endField, dateField],
	);
	return useMemo(
		() => (tasks) => (icsTasks.length === 0 ? tasks : [...icsTasks, ...tasks]),
		[icsTasks],
	);
}
