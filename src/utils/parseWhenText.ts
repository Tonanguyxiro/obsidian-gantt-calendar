/**
 * 任务弹窗「时间」快速输入解析（纯函数，无 Obsidian 依赖）。
 *
 * 支持（中英文）：
 * - 日期：today/tod/今天、tomorrow/tmr/tm/明天、后天、yesterday/昨天、星期（fri / next fri / 周五 / 下周五）、
 *   +3d / +2w / in 3 days、2026-11-20、11/20、11月20日
 * - 区间：`a → b`（→ -> ~ to 至 到）、`a 3d`（从 a 起共 3 天）
 * - 时刻（放在末尾）：14-16、9:30-11、2pm-4pm、14:30、2pm、1430、`tmr 14`、下午2点、14点半
 *
 * 只返回识别到的部分；什么都没识别出时返回 null。时刻统一为 "HH:mm"（24 小时）。
 */

import { RegularExpressions } from './RegularExpressions';

export interface WhenParseResult {
	start?: Date;
	end?: Date;
	timeStart?: string;
	timeEnd?: string;
}

const R = RegularExpressions.WhenText;

const day0 = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pad2 = (n: number): string => String(n).padStart(2, '0');

const WEEKDAY_EN: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_ZH: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 12 小时制换算；suffix 为 am/pm/a/p，无后缀时原样（0–23） */
function toHour(h: number, suffix: string | undefined): number {
	if (!suffix) return h;
	const pm = suffix.startsWith('p');
	if (h === 12) return pm ? 12 : 0;
	return pm ? h + 12 : h;
}

function hm(h: number, m: number): string | null {
	if (h < 0 || m < 0 || m > 59) return null;
	if (h > 24 || (h === 24 && m > 0)) return null;
	return `${pad2(h)}:${pad2(m)}`;
}

/** "1430" / "930" → [14, 30] */
function splitCompact(s: string): [number, number] {
	const n = s.padStart(4, '0');
	return [Number(n.slice(0, 2)), Number(n.slice(2))];
}

/** 解析单个日期表达式；无法识别返回 null */
export function parseDateExpr(raw: string, now: Date): Date | null {
	const t = raw.trim().toLowerCase();
	if (!t) return null;
	const today = day0(now);
	if (t === 'today' || t === 'tod' || t === '今天' || t === '今日') return today;
	if (t === 'tomorrow' || t === 'tmr' || t === 'tm' || t === 'tmrw' || t === '明天' || t === '明日') return addDays(today, 1);
	if (t === '后天' || t === '後天') return addDays(today, 2);
	if (t === 'yesterday' || t === '昨天') return addDays(today, -1);

	let m = R.relative.exec(t);
	if (m) return addDays(today, Number(m[1]) * (m[2].startsWith('w') ? 7 : 1));

	m = R.weekday.exec(t);
	if (m) {
		const target = m[2] !== undefined ? WEEKDAY_EN[m[2]] : WEEKDAY_ZH[m[3]];
		// 本周内（含今天）的下一个该星期；"next"/"下" = 下一周的该星期（周一为一周之始）
		let diff = (target - today.getDay() + 7) % 7;
		if (m[1]) {
			const mondayOffset = (today.getDay() + 6) % 7;
			const nextMonday = 7 - mondayOffset;
			diff = nextMonday + ((target + 6) % 7);
		}
		return addDays(today, diff);
	}

	m = R.isoDate.exec(t);
	if (m) {
		const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
		return d.getMonth() === Number(m[2]) - 1 ? d : null;
	}
	m = R.monthDay.exec(t) ?? R.monthDayZh.exec(t);
	if (m) {
		const month = Number(m[1]) - 1;
		const d = new Date(today.getFullYear(), month, Number(m[2]));
		return d.getMonth() === month ? d : null;
	}
	return null;
}

/** 从文本末尾剥出时刻部分 */
function takeTime(text: string, hasDateBefore: (rest: string) => boolean): { rest: string; timeStart?: string; timeEnd?: string } {
	let m = R.timeRangeTail.exec(text);
	if (m) {
		const [sh, sm] = m[2] === undefined && m[1].length > 2 ? splitCompact(m[1]) : [Number(m[1]), Number(m[2] ?? 0)];
		const [eh, em] = m[5] === undefined && m[4].length > 2 ? splitCompact(m[4]) : [Number(m[4]), Number(m[5] ?? 0)];
		// "2-4pm"：只有结束带 pm 时，开始沿用同一后缀（若会使开始晚于结束则不沿用）
		const endSuffix = m[6];
		let startSuffix = m[3];
		if (!startSuffix && endSuffix && toHour(sh, endSuffix) <= toHour(eh, endSuffix)) startSuffix = endSuffix;
		const s = hm(toHour(sh, startSuffix), sm);
		const e = hm(toHour(eh, endSuffix), em);
		if (s && e) return { rest: text.slice(0, m.index).trim(), timeStart: s, timeEnd: e };
	}
	m = R.timeSingleTail.exec(text);
	if (m) {
		let s: string | null = null;
		if (m[1] !== undefined) s = hm(toHour(Number(m[1]), m[3]), Number(m[2]));
		else if (m[4] !== undefined) s = hm(toHour(Number(m[4]), m[5]), 0);
		else if (m[6] !== undefined) {
			const [h, mm] = splitCompact(m[6]);
			s = hm(h, mm);
		}
		if (s) return { rest: text.slice(0, m.index).trim(), timeStart: s };
	}
	m = R.timeZhTail.exec(text);
	if (m) {
		let h = Number(m[2]);
		if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12;
		if (m[1] === '中午' && h < 11) h += 12;
		const min = m[3] === '半' ? 30 : Number(m[4] ?? 0);
		const s = hm(h, min);
		if (s) return { rest: text.slice(0, m.index).trim(), timeStart: s };
	}
	m = R.timeBareHourTail.exec(text);
	if (m) {
		const rest = text.slice(0, m.index).trim();
		const s = hm(Number(m[1]), 0);
		if (s && hasDateBefore(rest)) return { rest, timeStart: s };
	}
	return { rest: text };
}

/**
 * 解析整段快速输入。
 * @returns 识别到的日期 / 时刻；完全无法识别返回 null
 */
export function parseWhenText(input: string, now: Date = new Date()): WhenParseResult | null {
	const text = input.trim().replace(R.whitespaceRun, ' ');
	if (!text) return null;

	const isDate = (s: string) => {
		if (!s) return false;
		const parts = s.split(R.rangeSeparator);
		return parts.every((p) => parseDateExpr(p, now) !== null || R.duration.test(p.trim().toLowerCase()) || splitDuration(p.trim(), now) !== null);
	};
	const { rest, timeStart, timeEnd } = takeTime(text, isDate);
	const result: WhenParseResult = {};
	if (timeStart) result.timeStart = timeStart;
	if (timeEnd) result.timeEnd = timeEnd;

	if (rest) {
		const parts = rest.split(R.rangeSeparator).filter(Boolean);
		if (parts.length === 1) {
			const withDur = splitDuration(parts[0], now);
			if (withDur) {
				result.start = withDur.start;
				result.end = withDur.end;
			} else {
				const d = parseDateExpr(parts[0], now);
				if (!d) return null;
				result.start = d;
			}
		} else if (parts.length === 2) {
			const a = parseDateExpr(parts[0], now);
			if (!a) return null;
			const durM = R.duration.exec(parts[1].trim().toLowerCase());
			const b = durM
				? addDays(a, Number(durM[1]) * (R.weekUnit.test(durM[2]) ? 7 : 1) - 1)
				: parseDateExpr(parts[1], now);
			if (!b) return null;
			[result.start, result.end] = b < a ? [b, a] : [a, b];
		} else {
			return null;
		}
	}
	return Object.keys(result).length ? result : null;
}

/** "fri 3d" → 从周五起共 3 天 */
function splitDuration(s: string, now: Date): { start: Date; end: Date } | null {
	const idx = s.lastIndexOf(' ');
	if (idx < 0) return null;
	const dur = R.duration.exec(s.slice(idx + 1).toLowerCase());
	const start = parseDateExpr(s.slice(0, idx), now);
	if (!dur || !start) return null;
	const n = Number(dur[1]) * (R.weekUnit.test(dur[2]) ? 7 : 1);
	return { start, end: addDays(start, Math.max(n - 1, 0)) };
}
