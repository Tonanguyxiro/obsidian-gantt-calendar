import { parseWhenText, parseDateExpr } from '../src/utils/parseWhenText';

// 2026-11-12 是星期四
const NOW = new Date(2026, 10, 12, 9, 30);
const ymd = (d?: Date) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined);
const p = (s: string) => {
	const r = parseWhenText(s, NOW);
	return r ? { start: ymd(r.start), end: ymd(r.end), timeStart: r.timeStart, timeEnd: r.timeEnd } : null;
};

describe('parseDateExpr', () => {
	test.each([
		['today', '2026-11-12'], ['tod', '2026-11-12'], ['今天', '2026-11-12'],
		['tomorrow', '2026-11-13'], ['tmr', '2026-11-13'], ['tm', '2026-11-13'], ['明天', '2026-11-13'],
		['后天', '2026-11-14'], ['yesterday', '2026-11-11'],
		['thu', '2026-11-12'], ['fri', '2026-11-13'], ['friday', '2026-11-13'], ['mon', '2026-11-16'],
		['next mon', '2026-11-16'], ['next fri', '2026-11-20'], ['周五', '2026-11-13'], ['下周五', '2026-11-20'], ['星期日', '2026-11-15'],
		['+3d', '2026-11-15'], ['+2w', '2026-11-26'], ['in 3 days', '2026-11-15'],
		['2026-12-01', '2026-12-01'], ['11/20', '2026-11-20'], ['11-20', '2026-11-20'], ['11月20日', '2026-11-20'],
	])('%s → %s', (input, expected) => {
		expect(ymd(parseDateExpr(input, NOW) ?? undefined)).toBe(expected);
	});

	test('invalid dates', () => {
		expect(parseDateExpr('2/30', NOW)).toBeNull();
		expect(parseDateExpr('banana', NOW)).toBeNull();
	});
});

describe('parseWhenText', () => {
	test('date + time range', () => {
		expect(p('tmr 14-16')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '14:00', timeEnd: '16:00' });
		expect(p('fri 9:30-11')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '09:30', timeEnd: '11:00' });
		expect(p('today 2pm-4pm')).toEqual({ start: '2026-11-12', end: undefined, timeStart: '14:00', timeEnd: '16:00' });
		expect(p('today 2-4pm')).toEqual({ start: '2026-11-12', end: undefined, timeStart: '14:00', timeEnd: '16:00' });
		expect(p('明天 14:00–15:30')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '14:00', timeEnd: '15:30' });
	});

	test('single times', () => {
		expect(p('tmr 14')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '14:00', timeEnd: undefined });
		expect(p('tmr 2pm')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '14:00', timeEnd: undefined });
		expect(p('tmr 1430')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '14:30', timeEnd: undefined });
		expect(p('明天 下午2点')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '14:00', timeEnd: undefined });
		expect(p('周五 9点半')).toEqual({ start: '2026-11-13', end: undefined, timeStart: '09:30', timeEnd: undefined });
		expect(p('12am-1am')).toEqual({ start: undefined, end: undefined, timeStart: '00:00', timeEnd: '01:00' });
	});

	test('time only', () => {
		expect(p('14-16')).toEqual({ start: undefined, end: undefined, timeStart: '14:00', timeEnd: '16:00' });
		expect(p('9:00')).toEqual({ start: undefined, end: undefined, timeStart: '09:00', timeEnd: undefined });
	});

	test('date ranges', () => {
		expect(p('fri → next wed')).toEqual({ start: '2026-11-13', end: '2026-11-18', timeStart: undefined, timeEnd: undefined });
		expect(p('fri -> next wed')).toEqual({ start: '2026-11-13', end: '2026-11-18', timeStart: undefined, timeEnd: undefined });
		expect(p('11/20 to 11/24')).toEqual({ start: '2026-11-20', end: '2026-11-24', timeStart: undefined, timeEnd: undefined });
		expect(p('今天到周五')).toEqual({ start: '2026-11-12', end: '2026-11-13', timeStart: undefined, timeEnd: undefined });
		expect(p('11/20 3d')).toEqual({ start: '2026-11-20', end: '2026-11-22', timeStart: undefined, timeEnd: undefined });
		expect(p('mon → 2w')).toEqual({ start: '2026-11-16', end: '2026-11-29', timeStart: undefined, timeEnd: undefined });
		// 反向区间自动交换
		expect(p('11/24 ~ 11/20')).toEqual({ start: '2026-11-20', end: '2026-11-24', timeStart: undefined, timeEnd: undefined });
	});

	test('rejects junk', () => {
		expect(p('')).toBeNull();
		expect(p('banana')).toBeNull();
		expect(p('fri → banana')).toBeNull();
		expect(p('25:00')).toBeNull();
	});
});
