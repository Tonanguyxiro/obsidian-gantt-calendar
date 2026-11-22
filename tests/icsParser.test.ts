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

	it('每月第 N 个工作日（2MO / 1MO,3MO / 5MO 跳过无第5个周一的月份）', () => {
		const winEnd = new Date(2026, 11, 31, 23, 59, 59);
		const secondMon = wrap(ev([
			'SUMMARY:2ndMon',
			'DTSTART:20261012T091530',
			'RRULE:FREQ=MONTHLY;BYDAY=2MO',
		]));
		const res2nd = parseIcs(secondMon, WIN_START, winEnd);
		expect(res2nd.map(e => ymd(e.start))).toEqual(['2026-10-12', '2026-11-9', '2026-12-14']);
		// 保留 DTSTART 本地时刻（hours, minutes, seconds）
		for (const e of res2nd) {
			expect([e.start.getHours(), e.start.getMinutes(), e.start.getSeconds()]).toEqual([9, 15, 30]);
		}

		const firstAndThird = wrap(ev([
			'SUMMARY:biweekly-mon',
			'DTSTART:20261001T080000',
			'RRULE:FREQ=MONTHLY;BYDAY=1MO,3MO',
		]));
		expect(parseIcs(firstAndThird, WIN_START, winEnd).map(e => ymd(e.start))).toEqual([
			'2026-10-5', '2026-10-19',
			'2026-11-2', '2026-11-16',
			'2026-12-7', '2026-12-21',
		]);

		// 2026-10/12 只有 4 个周一，2026-11 有 5 个周一（11/30）
		const fifthMon = wrap(ev([
			'SUMMARY:5thMon',
			'DTSTART;VALUE=DATE:20261001',
			'RRULE:FREQ=MONTHLY;BYDAY=5MO',
		]));
		expect(parseIcs(fifthMon, WIN_START, winEnd).map(e => ymd(e.start))).toEqual(['2026-11-30']);
	});

	it('每月负序数星期（-1FR）与无序数 BYDAY（MO,WE）', () => {
		const winEnd = new Date(2026, 11, 31, 23, 59, 59);
		const lastFri = wrap(ev([
			'SUMMARY:lastFri',
			'DTSTART:20261001T173000',
			'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
		]));
		expect(parseIcs(lastFri, WIN_START, winEnd).map(e => ymd(e.start))).toEqual([
			'2026-10-30', '2026-11-27', '2026-12-25',
		]);

		const unprefixed = wrap(ev([
			'SUMMARY:mw',
			'DTSTART;VALUE=DATE:20261019',
			'RRULE:FREQ=MONTHLY;BYDAY=MO,WE;COUNT=4',
		]));
		// 10/19(MO) 10/21(WE) 10/26(MO) 10/28(WE)
		expect(parseIcs(unprefixed, WIN_START, winEnd).map(e => ymd(e.start))).toEqual([
			'2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28',
		]);
	});

	it('每月 BYMONTHDAY 正负值（1,15 与 -1 / -2）及与 BYDAY 交集', () => {
		const win2028 = [new Date(2028, 0, 1), new Date(2028, 3, 30, 23, 59, 59)] as const;
		const lastDay = wrap(ev([
			'SUMMARY:monthEnd',
			'DTSTART;VALUE=DATE:20280131',
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4',
		]));
		// 2028 为闰年，2 月有 29 天
		expect(parseIcs(lastDay, win2028[0], win2028[1]).map(e => ymd(e.start))).toEqual([
			'2028-1-31', '2028-2-29', '2028-3-31', '2028-4-30',
		]);

		const semiMonthly = wrap(ev([
			'SUMMARY:payday',
			'DTSTART;VALUE=DATE:20261001',
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15,-2;COUNT=6',
		]));
		expect(parseIcs(semiMonthly, WIN_START, new Date(2026, 11, 31, 23, 59, 59)).map(e => ymd(e.start))).toEqual([
			'2026-10-1', '2026-10-15', '2026-10-30',
			'2026-11-1', '2026-11-15', '2026-11-29',
		]);

		// BYMONTHDAY=13 + BYDAY=FR 交集：2026 年的黑色星期五
		const fri13 = wrap(ev([
			'SUMMARY:fri13',
			'DTSTART;VALUE=DATE:20260101',
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR',
		]));
		expect(parseIcs(fri13, new Date(2026, 0, 1), new Date(2026, 11, 31)).map(e => ymd(e.start))).toEqual([
			'2026-2-13', '2026-3-13', '2026-11-13',
		]);
	});

	it('每月 BYSETPOS=-1 与 BYSETPOS=1 选取月末/月初工作日', () => {
		const winEnd = new Date(2026, 11, 31, 23, 59, 59);
		const lastWeekday = wrap(ev([
			'SUMMARY:lastBiz',
			'DTSTART:20261001T104512',
			'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
		]));
		const res = parseIcs(lastWeekday, WIN_START, winEnd);
		// 10/31 为周六 → 取 10/30(五)；11/30(一)；12/31(四)
		expect(res.map(e => ymd(e.start))).toEqual(['2026-10-30', '2026-11-30', '2026-12-31']);
		expect([res[0].start.getHours(), res[0].start.getMinutes(), res[0].start.getSeconds()]).toEqual([10, 45, 12]);

		const firstWeekday = wrap(ev([
			'SUMMARY:firstBiz',
			'DTSTART;VALUE=DATE:20261001',
			'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1',
		]));
		// 11/1 为周日 → 第一个工作日为 11/2
		expect(parseIcs(firstWeekday, WIN_START, winEnd).map(e => ymd(e.start))).toEqual([
			'2026-10-1', '2026-11-2', '2026-12-1',
		]);
	});

	it('每年 BYMONTH + BYDAY / BYMONTHDAY / BYSETPOS', () => {
		const thanksgiving = wrap(ev([
			'SUMMARY:thanksgiving',
			'DTSTART:20260101T180000',
			'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH',
		]));
		expect(parseIcs(thanksgiving, new Date(2026, 0, 1), new Date(2027, 11, 31, 23, 59, 59)).map(e => ymd(e.start))).toEqual([
			'2026-11-26', '2027-11-25',
		]);

		const febEnd = wrap(ev([
			'SUMMARY:febEnd',
			'DTSTART;VALUE=DATE:20270101',
			'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1',
		]));
		expect(parseIcs(febEnd, new Date(2027, 0, 1), new Date(2028, 11, 31)).map(e => ymd(e.start))).toEqual([
			'2027-2-28', '2028-2-29',
		]);

		const yearLastWeekday = wrap(ev([
			'SUMMARY:yearLastBiz',
			'DTSTART;VALUE=DATE:20260101',
			'RRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
		]));
		// 2026-12-31 为周四；2027-12-31 为周五
		expect(parseIcs(yearLastWeekday, new Date(2026, 0, 1), new Date(2027, 11, 31)).map(e => ymd(e.start))).toEqual([
			'2026-12-31', '2027-12-31',
		]);
	});

	it('每周 WKST（SU vs MO）与 INTERVAL 交互', () => {
		// 2026-10-21 为周三；INTERVAL=2;BYDAY=SU,WE
		// WKST=MO（默认）: 周0=[10/19..10/25]→10/21,10/25；周2=[11/2..11/8]→11/4,11/8
		const wkstMo = wrap(ev([
			'SUMMARY:mo',
			'DTSTART;VALUE=DATE:20261021',
			'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=SU,WE;COUNT=4',
		]));
		expect(parseIcs(wkstMo, WIN_START, new Date(2026, 11, 31)).map(e => ymd(e.start))).toEqual([
			'2026-10-21', '2026-10-25', '2026-11-4', '2026-11-8',
		]);

		// WKST=SU: 周0=[10/18..10/24]→10/21(10/18<DTSTART跳过)；周2=[11/1..11/7]→11/1,11/4；周4=[11/15..11/21]→11/15
		const wkstSu = wrap(ev([
			'SUMMARY:su',
			'DTSTART;VALUE=DATE:20261021',
			'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SU,WE;COUNT=4',
		]));
		expect(parseIcs(wkstSu, WIN_START, new Date(2026, 11, 31)).map(e => ymd(e.start))).toEqual([
			'2026-10-21', '2026-11-1', '2026-11-4', '2026-11-15',
		]);
	});

	it('COUNT 在窗口裁剪之前从 DTSTART 起顺序计数，UNTIL 支持日期末尾包容与时刻边界', () => {
		// DTSTART=2026-08-10(在窗口 10/1 之前)，1MO,3MO 共 6 次：8/17(1) 9/7(2) 9/21(3) 10/5(4) 10/19(5) 11/2(6)
		const text = wrap(ev([
			'SUMMARY:counted',
			'DTSTART:20260810T090000',
			'RRULE:FREQ=MONTHLY;BYDAY=1MO,3MO;COUNT=6',
		]));
		expect(parseIcs(text, WIN_START, new Date(2026, 11, 31, 23, 59, 59)).map(e => ymd(e.start))).toEqual([
			'2026-10-5', '2026-10-19', '2026-11-2',
		]);

		// UNTIL=YYYYMMDD 包含当天 23:00 的实例
		const untilDate = wrap(ev([
			'SUMMARY:untilDay',
			'DTSTART:20261001T230000',
			'RRULE:FREQ=DAILY;UNTIL=20261003',
		]));
		expect(parseIcs(untilDate, WIN_START, WIN_END).map(e => ymd(e.start))).toEqual([
			'2026-10-1', '2026-10-2', '2026-10-3',
		]);

		// UNTIL=YYYYMMDDTHHMMSSZ 精确到时刻边界
		const untilUtc = wrap(ev([
			'SUMMARY:untilUtc',
			'DTSTART:20261001T090000Z',
			'RRULE:FREQ=DAILY;UNTIL=20261002T090000Z',
		]));
		expect(parseIcs(untilUtc, WIN_START, WIN_END).map(e => e.start.toISOString())).toEqual([
			'2026-10-01T09:00:00.000Z',
			'2026-10-02T09:00:00.000Z',
		]);
	});

	it('复杂月度规则结合 EXDATE（含 VALUE=DATE）与 RECURRENCE-ID', () => {
		const winEnd = new Date(2026, 11, 31, 23, 59, 59);
		const text = wrap([
			ev([
				'SUMMARY:monthlyBiz',
				'DTSTART:20261001T100000',
				'DTEND:20261001T110000',
				'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
				'EXDATE;VALUE=DATE:20261127',
			]),
			ev([
				'SUMMARY:monthlyBiz-moved',
				'RECURRENCE-ID:20261225T100000',
				'DTSTART:20261224T140000',
				'DTEND:20261224T150000',
			]),
		].join('\r\n'));

		const events = parseIcs(text, WIN_START, winEnd).map(e => `${e.summary}@${ymd(e.start)} ${e.start.getHours()}`);
		expect(events).toEqual([
			'monthlyBiz@2026-10-30 10',
			'monthlyBiz-moved@2026-12-24 14',
		]);
	});
});
