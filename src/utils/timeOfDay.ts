/**
 * 一天内时刻的小工具："HH:mm" 字符串 ↔ 分钟数、按设置的 12/24 小时制显示。
 */

import { RegularExpressions } from './RegularExpressions';

export type TimeFormat = '24h' | '12h';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * "14:30" → 870；"1:00 PM" → 780；"12:00 AM" → 0；"24:00" → 1440。
 * 空串 / 非法（分钟 ≥ 60、小时 > 24、24:xx 非整点、12h 小时不在 1..12）→ null。
 */
export function hmToMin(hm: string): number | null {
	if (!hm) return null;
	const match = RegularExpressions.DayPlanner.hmValue.exec(hm.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (minute > 59) return null;
	const meridiem = match[3]?.toUpperCase();
	if (meridiem) {
		if (hour < 1 || hour > 12) return null;
		const h12 = hour % 12;
		return (meridiem === 'PM' ? h12 + 12 : h12) * 60 + minute;
	}
	if (hour > 24 || (hour === 24 && minute > 0)) return null;
	return hour * 60 + minute;
}

/** 870 → "14:30"；钳在 0..1440（1440 显示为 "24:00"） */
export function minToHm(min: number): string {
	const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
	return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** 按 12/24 小时制显示："14:30" / "2:30 PM"；次日零点固定显示 "24:00" 以区别于 "12:00 AM" */
export function formatHm(hm: string, fmt: TimeFormat): string {
	const min = hmToMin(hm);
	if (min === null) return '';
	if (fmt === '24h' || min >= 24 * 60) return minToHm(min);
	const h24 = Math.floor(min / 60) % 24;
	const suffix = h24 < 12 ? 'AM' : 'PM';
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	return `${h12}:${pad2(min % 60)} ${suffix}`;
}

/** 时长文本：90 → "1.5 h"，30 → "30 min"，120 → "2 h" */
export function formatDuration(min: number): string {
	if (min < 60) return `${min} min`;
	const h = min / 60;
	return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/** 吸附到 step 分钟 */
export function snapMin(min: number, step = 15): number {
	return Math.round(min / step) * step;
}
