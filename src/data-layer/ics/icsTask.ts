/**
 * ICS 事件 → 日历占位任务（纯函数）
 *
 * 与 file-based task 占位任务同类：进入视图的时间线模型，但不对应任何任务行，
 * 一律只读（渲染为 IcsEventCard，无拖动/缩放/右键/编辑）。
 */

import type { GCTask } from '../../types';
import { setTaskDateField } from '../../types';
import type { DateFieldType } from '../../settings/types';
import type { IcsEvent } from './icsParser';

/** 带订阅信息的事件（IcsService 推入 calendarStore） */
export interface IcsCalendarEvent extends IcsEvent {
	calendarId: string;
	calendarName: string;
	color: string;
}

export function icsEventToCalendarTask(
	ev: IcsCalendarEvent,
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): GCTask {
	const precision = ev.allDay ? 'day' : 'time';
	const start = new Date(ev.start);
	const end = new Date(ev.end);
	if (ev.allDay) {
		start.setHours(0, 0, 0, 0);
		end.setHours(0, 0, 0, 0);
	}
	// 每个出现实例唯一的伪路径，保证视图 key 不冲突
	const id = `ics:${ev.calendarId}:${ev.uid}:${ev.start.getTime()}`;
	const description = ev.summary.split('\n').join(' ');
	const task: GCTask = {
		filePath: id,
		fileName: ev.calendarName,
		lineNumber: 0,
		content: '',
		description,
		completed: false,
		priority: 'normal',
		datePrecision: {},
		icsEvent: {
			calendarId: ev.calendarId,
			calendarName: ev.calendarName,
			color: ev.color,
			location: ev.location,
			allDay: ev.allDay,
		},
	};
	setTaskDateField(task, startField, start);
	setTaskDateField(task, endField, end);
	task.datePrecision![startField] = precision;
	task.datePrecision![endField] = precision;
	if (dateField !== startField && dateField !== endField) {
		setTaskDateField(task, dateField, start);
		task.datePrecision![dateField] = precision;
	}
	return task;
}
