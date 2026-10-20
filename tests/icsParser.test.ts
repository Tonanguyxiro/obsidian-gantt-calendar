import { parseIcs } from '../src/data-layer/ics/icsParser';

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const ev = (lines: string[]) => `BEGIN:VEVENT\r\nUID:u1\r\n${lines.join('\r\n')}\r\nEND:VEVENT`;
const WIN_START = new Date(2026, 9, 1);
const WIN_END = new Date(2026, 11, 31);
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

describe('parseIcs', () => {
	it('解析 UTC 时刻事件并反转义文本、展开折行', () => {
		const text = wrap(ev([
			'SUMMARY:Team\\, sync\\nroom A',
			'DTSTART:20261020T010000Z',
			'DTEND:20261020T023000Z',
		]).replace('room A', 'room\r\n  A'));
		const [e] = parseIcs(text, WIN_START, WIN_END);
		expect(e.summary).toBe('Team, sync room A');
		expect(e.allDay).toBe(false);
		expect(e.start.toISOString()).toBe('2026-10-20T01:00:00.000Z');
		expect(e.end.getTime() - e.start.getTime()).toBe(90 * 60000);
	});

	it('TZID 事件按该时区换算为绝对时刻', () => {
		const text = wrap(ev(['SUMMARY:x', 'DTSTART;TZID=Asia/Shanghai:20261020T090000', 'DTEND;TZID=Asia/Shanghai:20261020T100000']));
		const [e] = parseIcs(text, WIN_START, WIN_END);
		expect(e.start.toISOString()).toBe('2026-10-20T01:00:00.000Z');
	});

	it('Windows 时区名（Outlook）映射到 IANA', () => {
		const text = wrap(ev(['SUMMARY:x', 'DTSTART;TZID=China Standard Time:20261020T100000', 'DTEND;TZID=China Standard Time:20261020T110000']));
		const [e] = parseIcs(text, WIN_START, WIN_END);
		expect(e.start.toISOString()).toBe('2026-10-20T02:00:00.000Z');
	});

	it('全天事件 DTEND 排他：单日与多日', () => {
		const text = wrap([
			ev(['SUMMARY:one', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261021']),
			ev(['SUMMARY:three', 'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261026']),
			ev(['SUMMARY:noend', 'DTSTART;VALUE=DATE:20261030']),
		].join('\r\n'));
		const [one, three, noend] = parseIcs(text, WIN_START, WIN_END);
		expect([one.allDay, ymd(one.start), ymd(one.end)]).toEqual([true, '2026-10-20', '2026-10-20']);
		expect([ymd(three.start), ymd(three.end)]).toEqual(['2026-10-23', '2026-10-25']);
		expect(ymd(noend.end)).toBe('2026-10-30');
	});

	it('DURATION 代替 DTEND', () => {
		const text = wrap(ev(['SUMMARY:x', 'DTSTART:20261020T100000Z', 'DURATION:PT1H30M']));
		const [e] = parseIcs(text, WIN_START, WIN_END);
		expect(e.end.getTime() - e.start.getTime()).toBe(90 * 60000);
	});

	it('每周 BYDAY + COUNT + EXDATE', () => {
		// 2026-10-19 是周一
		const text = wrap(ev([
			'SUMMARY:standup', 'DTSTART:20261019T090000', 'DTEND:20261019T093000',
			'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5',
			'EXDATE:20261021T090000',
		]));
		const days = parseIcs(text, WIN_START, WIN_END).map(e => ymd(e.start));
		// 5 次：10/19 10/21(排除) 10/26 10/28 11/2 → 排除后 4 个
		expect(days).toEqual(['2026-10-19', '2026-10-26', '2026-10-28', '2026-11-2']);
	});

	it('每日 UNTIL 与窗口裁剪', () => {
		const text = wrap(ev(['SUMMARY:d', 'DTSTART;VALUE=DATE:20260901', 'RRULE:FREQ=DAILY;UNTIL=20261003']));
		const days = parseIcs(text, WIN_START, WIN_END).map(e => ymd(e.start));
		expect(days).toEqual(['2026-10-1', '2026-10-2', '2026-10-3']);
	});

	it('每月 31 号跳过没有该日的月份；每年重复', () => {
		const monthly = wrap(ev(['SUMMARY:m', 'DTSTART;VALUE=DATE:20260831', 'RRULE:FREQ=MONTHLY;COUNT=4']));
		// 8/31 9/31(无) 10/31 11/31(无) 12/31 → COUNT=4 按有效实例计：8/31 10/31 12/31 …窗口内取 10/31 12/31
		expect(parseIcs(monthly, WIN_START, WIN_END).map(e => ymd(e.start))).toEqual(['2026-10-31', '2026-12-31']);
		const yearly = wrap(ev(['SUMMARY:y', 'DTSTART;VALUE=DATE:20150315', 'RRULE:FREQ=YEARLY']));
		expect(parseIcs(yearly, new Date(2026, 0, 1), new Date(2027, 11, 31)).map(e => ymd(e.start))).toEqual(['2026-3-15', '2027-3-15']);
	});

	it('RECURRENCE-ID 覆盖实例：原时间被屏蔽，改期实例保留', () => {
		const text = wrap([
			ev(['SUMMARY:base', 'DTSTART:20261020T090000', 'RRULE:FREQ=DAILY;COUNT=3']),
			ev(['SUMMARY:moved', 'RECURRENCE-ID:20261021T090000', 'DTSTART:20261021T150000']),
		].join('\r\n'));
		const events = parseIcs(text, WIN_START, WIN_END).map(e => `${e.summary}@${ymd(e.start)} ${e.start.getHours()}`);
		expect(events).toEqual(['base@2026-10-20 9', 'moved@2026-10-21 15', 'base@2026-10-22 9']);
	});
});
