/**
 * 一天内时刻的小工具："HH:mm" 字符串 ↔ 分钟数、按设置的 12/24 小时制显示。
 */

export type TimeFormat = '24h' | '12h';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "14:30" → 870；空串 / 非法 → null */
export function hmToMin(hm: string): number | null {
	if (!hm) return null;
	const [h, m] = hm.split(':').map(Number);
	if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
	return h * 60 + m;
}

/** 870 → "14:30"；钳在 0..1440（1440 显示为 "24:00"） */
export function minToHm(min: number): string {
	const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
	return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** 按 12/24 小时制显示："14:30" / "2:30 PM"；24:00 在 12 小时制显示为 "12:00 AM" */
export function formatHm(hm: string, fmt: TimeFormat): string {
	const min = hmToMin(hm);
	if (min === null) return '';
	if (fmt === '24h') return minToHm(min);
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
