/**
 * 旧写法迁移：起止（🛫/📅）只管日期区间，具体时刻由 ⏳ 计划日期 + 行首 Day Planner 时间前缀决定。
 *
 * 旧数据里起止字段（或 ⏳）可能带时刻（`📅 2026-10-20 16:00`），经本插件任何一次写回时统一迁移：
 * - 同一天的时刻 → 变成 ⏳ 当日 + 行首前缀（`14:00 - 16:00` / `14:00`），已有前缀时不覆盖
 * - 起止 / ⏳ 去掉时刻，只留日期（跨日且带时刻的旧数据时刻直接丢弃：时间片限制在一天内）
 * 同时也让 Tasks 插件能识别这些日期（它不认日期后的时刻）。
 */

import type { GCTask } from '../types';
import type { TaskUpdates } from './taskSerializer';
import { rewritePlannerPrefix } from './scheduledFallback';
import { stripPlannerTime } from './taskParser/utils';

type Fields = Pick<GCTask, 'startDate' | 'dueDate' | 'scheduledDate' | 'description' | 'datePrecision'>;

function valid(d: Date | null | undefined): d is Date {
	return !!d && !isNaN(d.getTime());
}

function dayOf(d: Date): Date {
	const r = new Date(d);
	r.setHours(0, 0, 0, 0);
	return r;
}

function hm(d: Date): string {
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 应用 updates 后，起止 / ⏳ 上是否还带着时刻（需要迁移） */
export function hasLegacyTimes(task: Fields, updates: TaskUpdates): boolean {
	const precision = { ...task.datePrecision, ...updates.datePrecision };
	return (['startDate', 'dueDate', 'scheduledDate'] as const).some((f) => {
		const v = f in updates ? updates[f] : task[f];
		return valid(v) && precision[f] === 'time';
	});
}

/** 返回迁移后的 updates；没有旧写法时原样返回 */
export function migrateLegacyTimes(task: Fields, updates: TaskUpdates): TaskUpdates {
	if (!hasLegacyTimes(task, updates)) return updates;

	const get = (f: 'startDate' | 'dueDate' | 'scheduledDate'): Date | null | undefined => (f in updates ? updates[f] : task[f]);
	const precision = { ...task.datePrecision, ...updates.datePrecision };
	const timed = (f: 'startDate' | 'dueDate' | 'scheduledDate') => valid(get(f)) && precision[f] === 'time';

	const start = get('startDate');
	const due = get('dueDate');
	const scheduled = get('scheduledDate');
	const description = updates.content !== undefined ? updates.content : task.description;
	const hasPrefix = valid(scheduled) && stripPlannerTime(description || '') !== (description || '');

	const out: TaskUpdates = { ...updates };

	// 1. 还没有时间片 → 用旧时刻生成
	if (!hasPrefix) {
		let slot: { day: Date; prefix: string } | null = null;
		if (timed('startDate') || timed('dueDate')) {
			const s = valid(start) ? start : null;
			const e = valid(due) ? due : null;
			const crossDay = s && e && e > s && dayOf(s).getTime() !== dayOf(new Date(e.getTime() - 1)).getTime();
			if (!crossDay) {
				const bothTimed = timed('startDate') && timed('dueDate') && s && e && e > s;
				const anchor = (timed('startDate') ? s : e) as Date;
				const endText = bothTimed && e ? (e.getHours() === 0 && e.getMinutes() === 0 ? '24:00' : hm(e)) : null;
				slot = { day: dayOf(anchor), prefix: endText ? `${hm(anchor)} - ${endText}` : hm(anchor) };
			}
		} else if (timed('scheduledDate') && valid(scheduled)) {
			slot = { day: dayOf(scheduled), prefix: hm(scheduled) };
		}
		if (slot) {
			out.scheduledDate = slot.day;
			out.content = rewritePlannerPrefix(description || '', slot.prefix);
		}
	}

	// 2. 起止 / ⏳ 只留日期
	const nextPrecision = { ...precision };
	for (const f of ['startDate', 'dueDate', 'scheduledDate'] as const) {
		if (!timed(f)) continue;
		const v = (f === 'scheduledDate' && out.scheduledDate ? out.scheduledDate : get(f)) as Date;
		out[f] = dayOf(v);
		nextPrecision[f] = 'day';
	}
	if (out.scheduledDate && precision.scheduledDate !== 'time') nextPrecision.scheduledDate = 'day';
	out.datePrecision = nextPrecision;
	return out;
}
