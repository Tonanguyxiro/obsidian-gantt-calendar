/**
 * ICS（iCalendar, RFC 5545）解析与重复事件展开
 *
 * 纯函数模块，不依赖 Obsidian API。覆盖订阅源常见子集：
 * VEVENT 的 SUMMARY / DTSTART / DTEND / DURATION / RRULE（DAILY/WEEKLY/MONTHLY/YEARLY +
 * INTERVAL/COUNT/UNTIL/WKST/BYDAY(含序数)/BYMONTH/BYMONTHDAY/BYSETPOS）/ EXDATE / RECURRENCE-ID。
 */

export interface IcsEvent {
	uid: string;
	summary: string;
	location: string;
	start: Date;
	/** 结束时刻；全天事件为含当天的最后一天（已处理 DTEND 的排他语义） */
	end: Date;
	allDay: boolean;
}

interface IcsProperty {
	name: string;
	params: Record<string, string>;
	value: string;
}

interface IcsDateValue {
	date: Date;
	allDay: boolean;
}

interface RawEvent {
	uid: string;
	summary: string;
	location: string;
	start: IcsDateValue;
	end: IcsDateValue | null;
	durationMs: number | null;
	rrule: Record<string, string> | null;
	exdates: number[];
	exdateDays: Set<string>;
	recurrenceId: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OCCURRENCES = 5000;
const MAX_ITERATIONS = 100_000;
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ==================== 行解析 ====================

function unfoldLines(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
			out[out.length - 1] += line.slice(1);
		} else {
			out.push(line);
		}
	}
	return out;
}

function parseProperty(line: string): IcsProperty | null {
	let inQuote = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') inQuote = !inQuote;
		else if (ch === ':' && !inQuote) { colon = i; break; }
	}
	if (colon < 0) return null;

	const left = line.slice(0, colon);
	const value = line.slice(colon + 1);
	const segments: string[] = [];
	let cur = '';
	inQuote = false;
	for (const ch of left) {
		if (ch === '"') inQuote = !inQuote;
		if (ch === ';' && !inQuote) { segments.push(cur); cur = ''; } else cur += ch;
	}
	segments.push(cur);

	const params: Record<string, string> = {};
	for (const seg of segments.slice(1)) {
		const eq = seg.indexOf('=');
		if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).split('"').join('');
	}
	return { name: segments[0].toUpperCase(), params, value };
}

function unescapeText(value: string): string {
	let out = '';
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '\\' && i + 1 < value.length) {
			const next = value[i + 1];
			out += next === 'n' || next === 'N' ? ' ' : next;
			i++;
		} else {
			out += ch;
		}
	}
	return out.trim();
}

// ==================== 日期解析 ====================

/** Outlook / Exchange 使用 Windows 时区名，映射到 IANA（常见子集；未收录的退化为本地时间） */
const WINDOWS_TZ: Record<string, string> = {
	'China Standard Time': 'Asia/Shanghai',
	'Taipei Standard Time': 'Asia/Taipei',
	'Tokyo Standard Time': 'Asia/Tokyo',
	'Korea Standard Time': 'Asia/Seoul',
	'Singapore Standard Time': 'Asia/Singapore',
	'India Standard Time': 'Asia/Kolkata',
	'Arabian Standard Time': 'Asia/Dubai',
	'Russian Standard Time': 'Europe/Moscow',
	'Turkey Standard Time': 'Europe/Istanbul',
	'GMT Standard Time': 'Europe/London',
	'W. Europe Standard Time': 'Europe/Berlin',
	'Central Europe Standard Time': 'Europe/Budapest',
	'Romance Standard Time': 'Europe/Paris',
	'Central European Standard Time': 'Europe/Warsaw',
	'E. Europe Standard Time': 'Europe/Chisinau',
	'AUS Eastern Standard Time': 'Australia/Sydney',
	'New Zealand Standard Time': 'Pacific/Auckland',
	'Eastern Standard Time': 'America/New_York',
	'Central Standard Time': 'America/Chicago',
	'Mountain Standard Time': 'America/Denver',
	'Pacific Standard Time': 'America/Los_Angeles',
	'US Mountain Standard Time': 'America/Phoenix',
	'Alaskan Standard Time': 'America/Anchorage',
	'Hawaiian Standard Time': 'Pacific/Honolulu',
	'E. South America Standard Time': 'America/Sao_Paulo',
	'UTC': 'UTC',
};

/** 时区 tz 在 utcMs 时刻相对 UTC 的偏移（毫秒） */
function tzOffsetMs(utcMs: number, tz: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz, hourCycle: 'h23',
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
	}).formatToParts(new Date(utcMs));
	const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function wallClockInZone(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date | null {
	try {
		tz = WINDOWS_TZ[tz] ?? tz;
		const guess = Date.UTC(y, mo, d, h, mi, s);
		let result = guess - tzOffsetMs(guess, tz);
		result = guess - tzOffsetMs(result, tz);
		return new Date(result);
	} catch {
		return null; // 未知时区名（如 Windows 时区），调用方退化为本地时间
	}
}

function parseDateValue(value: string, params: Record<string, string>): IcsDateValue | null {
	const v = value.trim();
	const digits = (from: number, len: number) => Number(v.slice(from, from + len));
	if (v.length < 8 || Number.isNaN(digits(0, 8))) return null;

	const y = digits(0, 4);
	const mo = digits(4, 2) - 1;
	const d = digits(6, 2);

	if (params.VALUE === 'DATE' || v.length === 8) {
		return { date: new Date(y, mo, d), allDay: true };
	}

	const h = digits(9, 2);
	const mi = digits(11, 2);
	const s = v.length >= 15 ? digits(13, 2) : 0;
	if ([h, mi, s].some(Number.isNaN)) return null;

	if (v.endsWith('Z')) return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false };
	if (params.TZID) {
		const zoned = wallClockInZone(y, mo, d, h, mi, s, params.TZID);
		if (zoned) return { date: zoned, allDay: false };
	}
	return { date: new Date(y, mo, d, h, mi, s), allDay: false };
}

/** ISO 8601 持续时间（P1DT2H30M / PT45M / P1W）→ 毫秒 */
function parseDuration(value: string): number | null {
	let rest = value.trim();
	let sign = 1;
	if (rest.startsWith('-')) { sign = -1; rest = rest.slice(1); } else if (rest.startsWith('+')) rest = rest.slice(1);
	if (!rest.startsWith('P')) return null;
	rest = rest.slice(1);

	const unitMs: Record<string, number> = { W: 7 * DAY_MS, D: DAY_MS, H: 3600000, M: 60000, S: 1000 };
	let total = 0;
	let num = '';
	let inTime = false;
	for (const ch of rest) {
		if (ch === 'T') { inTime = true; continue; }
		if (ch >= '0' && ch <= '9') { num += ch; continue; }
		const ms = ch === 'M' && !inTime ? undefined : unitMs[ch];
		if (ms === undefined || num === '') return null;
		total += Number(num) * ms;
		num = '';
	}
	return sign * total;
}

function parseRrule(value: string): Record<string, string> {
	const rule: Record<string, string> = {};
	for (const part of value.split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
	}
	return rule;
}

// ==================== VEVENT 收集 ====================

function parseRawEvents(text: string): RawEvent[] {
	const events: RawEvent[] = [];
	let current: Record<string, IcsProperty[]> | null = null;

	for (const line of unfoldLines(text)) {
		const upper = line.toUpperCase();
		if (upper === 'BEGIN:VEVENT') { current = {}; continue; }
		if (upper === 'END:VEVENT') {
			if (current) {
				const raw = buildRawEvent(current);
				if (raw) events.push(raw);
			}
			current = null;
			continue;
		}
		if (!current) continue;
		const prop = parseProperty(line);
		if (prop) (current[prop.name] ||= []).push(prop);
	}
	return events;
}

function buildRawEvent(props: Record<string, IcsProperty[]>): RawEvent | null {
	const dtstart = props.DTSTART?.[0];
	if (!dtstart) return null;
	const start = parseDateValue(dtstart.value, dtstart.params);
	if (!start) return null;

	const dtend = props.DTEND?.[0];
	const end = dtend ? parseDateValue(dtend.value, dtend.params) : null;
	const duration = props.DURATION?.[0];

	const exdates: number[] = [];
	const exdateDays = new Set<string>();
	for (const ex of props.EXDATE ?? []) {
		for (const v of ex.value.split(',')) {
			const parsed = parseDateValue(v, ex.params);
			if (!parsed) continue;
			exdates.push(parsed.date.getTime());
			if (parsed.allDay) exdateDays.add(localDayKey(parsed.date));
		}
	}

	const recId = props['RECURRENCE-ID']?.[0];
	const recParsed = recId ? parseDateValue(recId.value, recId.params) : null;

	return {
		uid: props.UID?.[0]?.value ?? '',
		summary: unescapeText(props.SUMMARY?.[0]?.value ?? ''),
		location: unescapeText(props.LOCATION?.[0]?.value ?? ''),
		start,
		end,
		durationMs: duration ? parseDuration(duration.value) : null,
		rrule: props.RRULE?.[0] ? parseRrule(props.RRULE[0].value) : null,
		exdates,
		exdateDays,
		recurrenceId: recParsed ? recParsed.date.getTime() : null,
	};
}

// ==================== 重复展开 ====================

interface ByDaySpec {
	ordinal: number | null;
	weekday: number;
}

function localDayKey(d: Date): string {
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function addDays(d: Date, n: number): Date {
	const r = new Date(d.getTime());
	r.setDate(r.getDate() + n);
	return r;
}

function daysInMonth(year: number, month0: number): number {
	return new Date(year, month0 + 1, 0).getDate();
}

function makeWallClockDate(year: number, month0: number, day: number, template: Date): Date {
	const d = new Date(
		year,
		month0,
		day,
		template.getHours(),
		template.getMinutes(),
		template.getSeconds(),
		template.getMilliseconds(),
	);
	if (year >= 0 && year < 100) d.setFullYear(year);
	return d;
}

function parseByDay(value: string | undefined): ByDaySpec[] {
	if (!value) return [];
	const out: ByDaySpec[] = [];
	for (const raw of value.split(',')) {
		const token = raw.trim().toUpperCase();
		const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
		if (!m) continue;
		const weekday = WEEKDAY_CODES.indexOf(m[2]);
		if (weekday < 0) continue;
		let ordinal: number | null = null;
		if (m[1] !== undefined) {
			const parsed = parseInt(m[1], 10);
			if (!Number.isFinite(parsed) || parsed === 0) continue;
			ordinal = parsed;
		}
		out.push({ ordinal, weekday });
	}
	return out;
}

function parseIntList(value: string | undefined, min: number, max: number): number[] {
	if (!value) return [];
	const out: number[] = [];
	for (const raw of value.split(',')) {
		const n = Number(raw.trim());
		if (!Number.isInteger(n) || n === 0 || n < min || n > max) continue;
		out.push(n);
	}
	return out;
}

function applyBySetPos<T>(sortedItems: T[], bySetPos: number[]): T[] {
	if (bySetPos.length === 0) return sortedItems;
	const len = sortedItems.length;
	const picked = new Set<number>();
	for (const pos of bySetPos) {
		const idx = pos > 0 ? pos - 1 : len + pos;
		if (idx >= 0 && idx < len) picked.add(idx);
	}
	return Array.from(picked)
		.sort((a, b) => a - b)
		.map((idx) => sortedItems[idx]);
}

function matchesByMonthDay(d: Date, byMonthDay: number[]): boolean {
	if (byMonthDay.length === 0) return true;
	const total = daysInMonth(d.getFullYear(), d.getMonth());
	const day = d.getDate();
	return byMonthDay.some((md) => (md > 0 ? md : total + 1 + md) === day);
}

/** 解析某年某月内符合 BYMONTHDAY / BYDAY（含序数）的升序日期（1..totalDays） */
function resolveMonthDays(
	year: number,
	month0: number,
	byDay: ByDaySpec[],
	byMonthDay: number[],
	defaultDay: number,
): number[] {
	const totalDays = daysInMonth(year, month0);

	let monthDaySet: Set<number> | null = null;
	if (byMonthDay.length > 0) {
		monthDaySet = new Set<number>();
		for (const md of byMonthDay) {
			const d = md > 0 ? md : totalDays + 1 + md;
			if (d >= 1 && d <= totalDays) monthDaySet.add(d);
		}
	}

	let byDaySet: Set<number> | null = null;
	if (byDay.length > 0) {
		byDaySet = new Set<number>();
		const byWeekday: number[][] = [[], [], [], [], [], [], []];
		for (let d = 1; d <= totalDays; d++) {
			byWeekday[new Date(year, month0, d).getDay()].push(d);
		}
		for (const spec of byDay) {
			const list = byWeekday[spec.weekday];
			if (spec.ordinal === null) {
				for (const d of list) byDaySet.add(d);
			} else {
				const idx = spec.ordinal > 0 ? spec.ordinal - 1 : list.length + spec.ordinal;
				if (idx >= 0 && idx < list.length) byDaySet.add(list[idx]);
			}
		}
	}

	if (monthDaySet && byDaySet) {
		return Array.from(monthDaySet).filter((d) => byDaySet.has(d)).sort((a, b) => a - b);
	}
	if (monthDaySet) return Array.from(monthDaySet).sort((a, b) => a - b);
	if (byDaySet) return Array.from(byDaySet).sort((a, b) => a - b);
	return defaultDay <= totalDays ? [defaultDay] : [];
}

/** YEARLY 无 BYMONTH 但有 BYDAY 时，序数相对于整年计算 */
function resolveYearDaysWithoutByMonth(
	year: number,
	byDay: ByDaySpec[],
	byMonthDay: number[],
	template: Date,
): Date[] {
	const byWeekday: Date[][] = [[], [], [], [], [], [], []];
	for (let month0 = 0; month0 < 12; month0++) {
		const total = daysInMonth(year, month0);
		for (let day = 1; day <= total; day++) {
			const dt = makeWallClockDate(year, month0, day, template);
			byWeekday[dt.getDay()].push(dt);
		}
	}

	const matched = new Map<number, Date>();
	for (const spec of byDay) {
		const list = byWeekday[spec.weekday];
		if (spec.ordinal === null) {
			for (const dt of list) matched.set(dt.getMonth() * 32 + dt.getDate(), dt);
		} else {
			const idx = spec.ordinal > 0 ? spec.ordinal - 1 : list.length + spec.ordinal;
			if (idx >= 0 && idx < list.length) {
				const dt = list[idx];
				matched.set(dt.getMonth() * 32 + dt.getDate(), dt);
			}
		}
	}

	let dates = Array.from(matched.values()).sort((a, b) => a.getTime() - b.getTime());
	if (byMonthDay.length > 0) {
		dates = dates.filter((dt) => matchesByMonthDay(dt, byMonthDay));
	}
	return dates;
}

function occurrenceStarts(raw: RawEvent, winStart: number, winEnd: number): Date[] {
	const rule = raw.rrule;
	const first = raw.start.date;
	if (!rule) return [first];

	const interval = Math.max(1, Number(rule.INTERVAL) || 1);
	const parsedCount = rule.COUNT !== undefined ? Number(rule.COUNT) : Infinity;
	const count = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : Infinity;
	const until = rule.UNTIL ? parseDateValue(rule.UNTIL.trim(), {}) : null;
	// UNTIL 为全天日期时包含当天末尾（按本地日历日计算，规避夏令时长度偏差）
	const untilMs = until
		? (until.allDay
			? new Date(until.date.getFullYear(), until.date.getMonth(), until.date.getDate(), 23, 59, 59, 999).getTime()
			: until.date.getTime())
		: Infinity;
	const limit = Math.min(untilMs, winEnd);
	const firstMs = first.getTime();

	const byDay = parseByDay(rule.BYDAY);
	const byMonth = Array.from(new Set(parseIntList(rule.BYMONTH, 1, 12))).sort((a, b) => a - b);
	const byMonthDay = parseIntList(rule.BYMONTHDAY, -31, 31);
	const bySetPos = parseIntList(rule.BYSETPOS, -366, 366);
	const wkstIdx = WEEKDAY_CODES.indexOf((rule.WKST ?? 'MO').trim().toUpperCase());
	const wkst = wkstIdx >= 0 ? wkstIdx : 1; // RFC 5545 默认周一

	const out: Date[] = [];
	let produced = 0;
	const push = (d: Date): boolean => {
		const t = d.getTime();
		if (t < firstMs) return true;
		if (t > limit || produced >= count || out.length >= MAX_OCCURRENCES) return false;
		if (!Number.isFinite(limit) && produced >= MAX_OCCURRENCES) return false;
		produced++;
		if (t >= winStart) out.push(d);
		return true;
	};

	const freq = (rule.FREQ ?? '').trim().toUpperCase();
	if (freq === 'DAILY') {
		for (let i = 0; i < MAX_ITERATIONS; i++) {
			const rawDay = addDays(first, i * interval);
			const d = makeWallClockDate(rawDay.getFullYear(), rawDay.getMonth(), rawDay.getDate(), first);
			if (d.getTime() > limit) break;
			if (byMonth.length > 0 && !byMonth.includes(d.getMonth() + 1)) continue;
			if (!matchesByMonthDay(d, byMonthDay)) continue;
			if (byDay.length > 0 && !byDay.some((b) => b.weekday === d.getDay())) continue;
			if (!push(d)) break;
		}
	} else if (freq === 'WEEKLY') {
		const days = (byDay.length > 0 ? Array.from(new Set(byDay.map((b) => b.weekday))) : [first.getDay()])
			.sort((a, b) => ((a - wkst + 7) % 7) - ((b - wkst + 7) % 7));
		const weekStart = addDays(first, -((first.getDay() - wkst + 7) % 7));
		outer: for (let w = 0; w < MAX_ITERATIONS; w++) {
			const curWeekStart = addDays(weekStart, w * 7 * interval);
			if (makeWallClockDate(curWeekStart.getFullYear(), curWeekStart.getMonth(), curWeekStart.getDate(), first).getTime() > limit) {
				break;
			}
			let weekDates: Date[] = [];
			for (const wd of days) {
				const rawDay = addDays(curWeekStart, (wd - wkst + 7) % 7);
				const d = makeWallClockDate(rawDay.getFullYear(), rawDay.getMonth(), rawDay.getDate(), first);
				if (byMonth.length > 0 && !byMonth.includes(d.getMonth() + 1)) continue;
				if (!matchesByMonthDay(d, byMonthDay)) continue;
				weekDates.push(d);
			}
			weekDates = applyBySetPos(weekDates, bySetPos);
			for (const d of weekDates) {
				if (!push(d)) break outer;
			}
		}
	} else if (freq === 'MONTHLY') {
		const startTotalMonths = first.getFullYear() * 12 + first.getMonth();
		outer: for (let i = 0; i < MAX_ITERATIONS; i++) {
			const totalMonths = startTotalMonths + i * interval;
			const year = Math.floor(totalMonths / 12);
			const month0 = totalMonths % 12;
			if (makeWallClockDate(year, month0, 1, first).getTime() > limit) break;
			if (byMonth.length > 0 && !byMonth.includes(month0 + 1)) continue;

			const days = applyBySetPos(
				resolveMonthDays(year, month0, byDay, byMonthDay, first.getDate()),
				bySetPos,
			);
			for (const day of days) {
				if (!push(makeWallClockDate(year, month0, day, first))) break outer;
			}
		}
	} else if (freq === 'YEARLY') {
		outer: for (let i = 0; i < MAX_ITERATIONS; i++) {
			const year = first.getFullYear() + i * interval;
			if (makeWallClockDate(year, 0, 1, first).getTime() > limit) break;

			let candidates: Date[] = [];
			if (byMonth.length > 0) {
				for (const m of byMonth) {
					const month0 = m - 1;
					const days = resolveMonthDays(year, month0, byDay, byMonthDay, first.getDate());
					for (const day of days) {
						candidates.push(makeWallClockDate(year, month0, day, first));
					}
				}
			} else if (byDay.length > 0) {
				candidates = resolveYearDaysWithoutByMonth(year, byDay, byMonthDay, first);
			} else {
				const month0 = first.getMonth();
				const days = resolveMonthDays(year, month0, [], byMonthDay, first.getDate());
				for (const day of days) {
					candidates.push(makeWallClockDate(year, month0, day, first));
				}
			}

			candidates = applyBySetPos(candidates, bySetPos);
			for (const d of candidates) {
				if (!push(d)) break outer;
			}
		}
	} else {
		return [first];
	}
	return out;
}

// ==================== 对外接口 ====================

/**
 * 解析 ICS 文本并展开重复事件，返回落在 [windowStart, windowEnd] 内的事件（按开始时间升序）
 */
export function parseIcs(text: string, windowStart: Date, windowEnd: Date): IcsEvent[] {
	const raws = parseRawEvents(text);
	const winStart = windowStart.getTime();
	const winEnd = windowEnd.getTime();

	// 被单独改期/修改的重复实例：用 uid+原始开始时间屏蔽主规则里的对应项
	const overridden = new Set<string>();
	for (const raw of raws) {
		if (raw.recurrenceId !== null) overridden.add(`${raw.uid}|${raw.recurrenceId}`);
	}

	const events: IcsEvent[] = [];
	for (const raw of raws) {
		const allDay = raw.start.allDay;
		const startMs = raw.start.date.getTime();
		let spanMs: number;
		if (raw.end) spanMs = raw.end.date.getTime() - startMs;
		else if (raw.durationMs !== null) spanMs = raw.durationMs;
		else spanMs = allDay ? DAY_MS : 0;
		spanMs = Math.max(0, spanMs);

		for (const s of occurrenceStarts(raw, winStart - spanMs, winEnd)) {
			const t = s.getTime();
			if (
				raw.exdates.includes(t) ||
				raw.exdateDays.has(localDayKey(s)) ||
				(raw.recurrenceId === null && overridden.has(`${raw.uid}|${t}`))
			) {
				continue;
			}
			// 全天事件 DTEND 排他：按天数推算含当天的最后一天（避开夏令时造成的 1 小时偏差）
			const end = allDay ? addDays(s, Math.max(1, Math.round(spanMs / DAY_MS)) - 1) : new Date(t + spanMs);
			if (end.getTime() < winStart || t > winEnd) continue;
			events.push({ uid: raw.uid, summary: raw.summary, location: raw.location, start: s, end, allDay });
		}
	}
	return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}
