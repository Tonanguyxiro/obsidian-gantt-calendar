import { icsEventToCalendarTask, type IcsCalendarEvent } from '../src/data-layer/ics/icsTask';

const base: IcsCalendarEvent = {
	uid: 'u1', summary: '会议', location: 'Room A',
	start: new Date(2026, 9, 20, 9, 0), end: new Date(2026, 9, 20, 10, 30), allDay: false,
	calendarId: 'c1', calendarName: 'Work', color: '#4f8cff',
};

describe('icsEventToCalendarTask', () => {
	it('定时事件：起止字段带时间精度，只读标记携带订阅信息', () => {
		const t = icsEventToCalendarTask(base, 'startDate', 'dueDate', 'dueDate');
		expect(t.startDate).toEqual(base.start);
		expect(t.dueDate).toEqual(base.end);
		expect(t.datePrecision).toEqual({ startDate: 'time', dueDate: 'time' });
		expect(t.icsEvent).toMatchObject({ calendarId: 'c1', calendarName: 'Work', color: '#4f8cff', location: 'Room A', allDay: false });
		expect(t.completed).toBe(false);
	});

	it('全天事件归零到 0 点，day 精度', () => {
		const t = icsEventToCalendarTask({ ...base, allDay: true, start: new Date(2026, 9, 22), end: new Date(2026, 9, 23) }, 'startDate', 'dueDate', 'dueDate');
		expect(t.datePrecision).toEqual({ startDate: 'day', dueDate: 'day' });
		expect(t.icsEvent?.allDay).toBe(true);
	});

	it('同一事件的不同出现实例拥有不同的伪路径；dateField 为第三字段时取开始', () => {
		const a = icsEventToCalendarTask(base, 'startDate', 'dueDate', 'scheduledDate');
		const b = icsEventToCalendarTask({ ...base, start: new Date(2026, 9, 27, 9), end: new Date(2026, 9, 27, 10) }, 'startDate', 'dueDate', 'scheduledDate');
		expect(a.filePath).not.toBe(b.filePath);
		expect(a.scheduledDate).toEqual(base.start);
	});
});
