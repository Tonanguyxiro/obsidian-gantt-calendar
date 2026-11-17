/**
 * 时间工具 corner case：hmToMin 上界 / 12h 支持、formatHm 24:00 显示。
 */
import { hmToMin, minToHm, formatHm } from '../src/utils/timeOfDay';

describe('hmToMin - 输入校验与 12h 支持', () => {
	it('24h 边界值保持原语义', () => {
		expect(hmToMin('00:00')).toBe(0);
		expect(hmToMin('0:00')).toBe(0);
		expect(hmToMin('01:00')).toBe(60);
		expect(hmToMin('23:59')).toBe(1439);
		expect(hmToMin('24:00')).toBe(1440);
		expect(hmToMin('')).toBeNull();
	});

	it('12h AM/PM 正确换算', () => {
		expect(hmToMin('1:00 PM')).toBe(780);
		expect(hmToMin('2:00 PM')).toBe(840);
		expect(hmToMin('12:00 AM')).toBe(0);
		expect(hmToMin('12:00 PM')).toBe(720);
		expect(hmToMin('09:00 AM')).toBe(540);
		expect(hmToMin('12:30 AM')).toBe(30);
		expect(hmToMin('11:59 PM')).toBe(1439);
		expect(hmToMin('9:00pm')).toBe(1260);
	});

	it('非法值一律拒绝', () => {
		expect(hmToMin('25:00')).toBeNull();
		expect(hmToMin('24:01')).toBeNull();
		expect(hmToMin('12:60')).toBeNull();
		expect(hmToMin('13:00 PM')).toBeNull();
		expect(hmToMin('0:00 AM')).toBeNull();
		expect(hmToMin('garbage')).toBeNull();
	});

	it('与 minToHm 往返一致', () => {
		for (const min of [0, 60, 1439, 1440]) {
			expect(hmToMin(minToHm(min))).toBe(min);
		}
	});
});

describe('formatHm - 24:00 与 12h 显示', () => {
	it('24h 模式保持 24:00', () => {
		expect(formatHm('24:00', '24h')).toBe('24:00');
		expect(formatHm('00:00', '24h')).toBe('00:00');
		expect(formatHm('14:30', '24h')).toBe('14:30');
	});

	it('12h 模式下 24:00 固定显示 24:00，与 12:00 AM 可区分', () => {
		expect(formatHm('24:00', '12h')).toBe('24:00');
		expect(formatHm('00:00', '12h')).toBe('12:00 AM');
		expect(formatHm('12:00', '12h')).toBe('12:00 PM');
		expect(formatHm('14:30', '12h')).toBe('2:30 PM');
	});

	it('非法输入返回空串', () => {
		expect(formatHm('25:00', '24h')).toBe('');
		expect(formatHm('', '12h')).toBe('');
	});
});
