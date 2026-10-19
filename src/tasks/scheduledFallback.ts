/**
 * 计划日期回退（视图层代理）
 *
 * 视图按配置的起止/日期字段（默认 🛫 / 📅）定位任务。只有 ⏳ 计划日期的任务
 * 在这些字段上没有值，原本不会出现在日历中。这里把它们"代理"到视图字段上：
 * - 起止字段与日期字段都缺失、但有计划日期 → 计划日期作为第二顺位定位
 * - 任务文本开头有 Day Planner 时间前缀（"09:00 - 10:00 任务"）→ 当日该时段
 *
 * 代理任务是原任务的浅拷贝，携带 scheduledProxy.source 指回原任务；
 * 所有写回都经 updateTaskProperties → resolveScheduledProxyUpdates 还原成
 * 对 ⏳ 计划日期 + 时间前缀的修改，原任务的起止字段保持不写入。
 */

import type { GCTask } from '../types';
import { getTaskDateField, setTaskDateField } from '../types';
import type { DateFieldType } from '../settings/types';
import type { TaskUpdates } from './taskSerializer';
import { RegularExpressions } from '../utils/RegularExpressions';

/** 只有开始时刻的 Day Planner 前缀，按此默认时长成块（与时间画布点任务一致） */
const PLANNER_DEFAULT_DURATION_MIN = 60;

function atMinutes(day: Date, minutes: number): Date {
	const d = new Date(day);
	d.setHours(0, 0, 0, 0);
	d.setMinutes(minutes);
	return d;
}

function dayOf(d: Date): Date {
	const r = new Date(d);
	r.setHours(0, 0, 0, 0);
	return r;
}

function isValid(d: Date | undefined | null): d is Date {
	return !!d && !isNaN(d.getTime());
}

/**
 * 计划日期回退：返回视图使用的任务（必要时为代理拷贝，否则原样返回）
 *
 * @param startField 视图起点字段（甘特/时间线）
 * @param endField   视图终点字段
 * @param dateField  视图单日定位字段（日历筛选字段；甘特传 endField）
 */
export function applyScheduledFallback(
	task: GCTask,
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): GCTask {
	if (task.scheduledProxy || task.fileTask) return task;
	const scheduled = task.scheduledDate;
	if (!isValid(scheduled)) return task;
	// 字段本身就是计划日期时无需代理（退化配置）
	if (startField === 'scheduledDate' || endField === 'scheduledDate') return task;
	if (isValid(getTaskDateField(task, startField)) || isValid(getTaskDateField(task, endField))) return task;
	const dateFieldIsScheduled = dateField === 'scheduledDate';
	if (!dateFieldIsScheduled && isValid(getTaskDateField(task, dateField))) return task;

	const planner = task.plannerTime;
	// 计划日期本身已带时刻、或无 Day Planner 前缀：日期字段直接定位到计划日期即可
	if (!planner || task.datePrecision?.scheduledDate === 'time') {
		if (dateFieldIsScheduled) return task;
		const proxy: GCTask = { ...task, datePrecision: { ...task.datePrecision } };
		setTaskDateField(proxy, dateField, new Date(scheduled));
		proxy.datePrecision![dateField] = task.datePrecision?.scheduledDate === 'time' ? 'time' : 'day';
		proxy.scheduledProxy = { source: task, startField, endField, dateField };
		return proxy;
	}

	// Day Planner 前缀：当日时段 [start, end)（仅开始时刻时用默认时长）
	const day = dayOf(scheduled);
	const endMin = planner.endMin ?? Math.min(planner.startMin + PLANNER_DEFAULT_DURATION_MIN, 24 * 60);
	const proxy: GCTask = { ...task, datePrecision: { ...task.datePrecision } };
	setTaskDateField(proxy, startField, atMinutes(day, planner.startMin));
	setTaskDateField(proxy, endField, atMinutes(day, endMin));
	proxy.datePrecision![startField] = 'time';
	proxy.datePrecision![endField] = 'time';
	proxy.scheduledProxy = { source: task, startField, endField, dateField };
	return proxy;
}

/** 批量计划日期回退（保持数组顺序；无代理时返回原数组元素） */
export function applyScheduledFallbackAll(
	tasks: GCTask[],
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): GCTask[] {
	return tasks.map((t) => applyScheduledFallback(t, startField, endField, dateField));
}

/** 取回原任务（编辑面板、右键命令等以真实字段为准的入口使用） */
export function unwrapTask(task: GCTask): GCTask {
	return task.scheduledProxy?.source ?? task;
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function formatHm(d: Date): string {
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 重写任务文本开头的 Day Planner 时间前缀
 * @param prefix 新前缀（如 "09:00 - 10:00"），null 表示移除前缀
 */
export function rewritePlannerPrefix(description: string, prefix: string | null): string {
	const body = description.replace(RegularExpressions.DayPlanner.timePrefix, '');
	return prefix ? `${prefix} ${body}`.trim() : body;
}

/**
 * 把针对代理任务视图字段的更新，还原为对原任务的更新。
 *
 * - 只改了非日期属性（勾选、优先级…）→ 原样作用于原任务
 * - 同日时段（两端带时刻）→ ⏳ 改为该日，文本前缀改为 "HH:mm - HH:mm"
 * - 单时刻 → ⏳ 改为该日，前缀改为 "HH:mm"
 * - 全天 → ⏳ 改为该日，移除前缀
 * - 跨日区间（甘特拉长到多天）→ 计划日期无法表达，改为写入真实的起止字段
 * - 清除（null）→ 清除 ⏳ 与前缀
 *
 * @param task    传入写回链路的任务（代理任务，其 datePrecision 已由调用方合并新精度）
 * @param updates 调用方的更新
 */
export function resolveScheduledProxyUpdates(task: GCTask, updates: TaskUpdates): { task: GCTask; updates: TaskUpdates } {
	const proxy = task.scheduledProxy;
	if (!proxy) return { task, updates };
	const source = proxy.source;
	const viewFields = Array.from(new Set([proxy.startField, proxy.endField, proxy.dateField]));
	const touched = viewFields.filter((f) => f in updates);

	const out: TaskUpdates = { ...updates };
	for (const f of viewFields) delete out[f];
	if (touched.length === 0) return { task: source, updates: out };

	const precision = { ...task.datePrecision, ...updates.datePrecision };
	const valueOf = (f: DateFieldType): Date | null | undefined => (
		f in updates ? updates[f] : getTaskDateField(task, f)
	);
	const isTime = (f: DateFieldType) => precision[f] === 'time';

	const start = valueOf(proxy.startField);
	const end = valueOf(proxy.endField);
	const single = proxy.dateField !== proxy.startField && proxy.dateField !== proxy.endField
		? valueOf(proxy.dateField)
		: undefined;

	const sourcePrecision = { ...source.datePrecision };
	const clearAll = touched.every((f) => updates[f] === null);
	if (clearAll) {
		out.scheduledDate = null;
		out.content = rewritePlannerPrefix(source.description, null);
		return { task: source, updates: out };
	}

	// 跨日区间：写入真实起止字段（计划日期 + 前缀只能表达单日时段）
	// 终点恰为次日 00:00 视为当日 24:00（时段延续到午夜仍属同一天）
	const lastDayOf = (d: Date) => dayOf(new Date(d.getTime() - 1));
	if (isValid(start) && isValid(end) && dayOf(start).getTime() !== lastDayOf(end).getTime() && end > start) {
		out[proxy.startField] = start;
		out[proxy.endField] = end;
		sourcePrecision[proxy.startField] = isTime(proxy.startField) ? 'time' : 'day';
		sourcePrecision[proxy.endField] = isTime(proxy.endField) ? 'time' : 'day';
		out.datePrecision = sourcePrecision;
		return { task: { ...source, datePrecision: sourcePrecision }, updates: out };
	}

	let anchor: Date | undefined;
	let prefix: string | null = null;
	if (isValid(start) && isValid(end) && isTime(proxy.startField) && isTime(proxy.endField)) {
		anchor = start;
		// 原前缀只有开始时刻且时长仍为默认时长（只是平移）→ 保持单时刻写法
		const keepStartOnly = source.plannerTime?.endMin === undefined
			&& end.getTime() - start.getTime() === PLANNER_DEFAULT_DURATION_MIN * 60000;
		prefix = keepStartOnly
			? formatHm(start)
			: `${formatHm(start)} - ${end.getHours() === 0 && end.getMinutes() === 0 && end > start ? '24:00' : formatHm(end)}`;
	} else {
		const timed = [proxy.startField, proxy.endField, proxy.dateField]
			.map((f) => ({ f, v: valueOf(f) }))
			.find(({ f, v }) => isValid(v) && isTime(f));
		if (timed && isValid(timed.v)) {
			anchor = timed.v;
			prefix = formatHm(timed.v);
		} else {
			anchor = [single, start, end].find(isValid);
		}
	}
	if (!anchor) return { task: source, updates: out };

	out.scheduledDate = dayOf(anchor);
	sourcePrecision.scheduledDate = 'day';
	out.datePrecision = sourcePrecision;
	out.content = rewritePlannerPrefix(source.description, prefix);
	return { task: { ...source, datePrecision: sourcePrecision }, updates: out };
}
