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

import type { GCTask, PlannerTime } from '../types';
import { getTaskDateField, setTaskDateField } from '../types';
import type { DateFieldType } from '../settings/types';
import type { TaskUpdates } from './taskSerializer';
import { RegularExpressions } from '../utils/RegularExpressions';

/** 只有开始时刻的 Day Planner 前缀，按此默认时长成块（与时间画布点任务一致） */
const PLANNER_DEFAULT_DURATION_MIN = 60;

/** 把任务拖进时间轴时新建时间片的默认时长（分钟） */
export const SLOT_DEFAULT_MIN = PLANNER_DEFAULT_DURATION_MIN;

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

	return buildPlannerProxy(task, startField, endField, dateField, {});
}

/** ⏳ + 行首时间前缀 → 当日时段代理（起止字段改写为该时段，时间精度） */
function buildPlannerProxy(
	task: GCTask,
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
	flags: { slot?: boolean },
): GCTask {
	const planner = task.plannerTime as PlannerTime;
	const day = dayOf(task.scheduledDate as Date);
	const endMin = planner.endMin ?? Math.min(planner.startMin + PLANNER_DEFAULT_DURATION_MIN, 24 * 60);
	const proxy: GCTask = { ...task, datePrecision: { ...task.datePrecision } };
	setTaskDateField(proxy, startField, atMinutes(day, planner.startMin));
	setTaskDateField(proxy, endField, atMinutes(day, endMin));
	proxy.datePrecision![startField] = 'time';
	proxy.datePrecision![endField] = 'time';
	proxy.scheduledProxy = { source: task, startField, endField, dateField, ...flags };
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

// ===== 时间片：起止只管日期区间，具体时刻由 ⏳ + 行首时间前缀决定，二者互不干扰 =====

function minutesOfDay(d: Date): number {
	return d.getHours() * 60 + d.getMinutes();
}

/** 终点恰为次日 00:00 视为当日 24:00 */
function lastDayOf(d: Date): Date {
	return dayOf(new Date(d.getTime() - 1));
}

function hasPlannerSlot(task: GCTask): boolean {
	return isValid(task.scheduledDate) && !!task.plannerTime && task.datePrecision?.scheduledDate !== 'time';
}

/** 任务在视图字段上有日期区间 / 单日定位（即会出现在全天条或日历格里） */
function hasViewDateRange(task: GCTask, startField: DateFieldType, endField: DateFieldType, dateField: DateFieldType): boolean {
	if (isValid(getTaskDateField(task, startField)) || isValid(getTaskDateField(task, endField))) return true;
	return dateField !== 'scheduledDate' && isValid(getTaskDateField(task, dateField));
}

/**
 * 旧写法：起止字段上带时刻，且同在一天（或只有一个时刻）。时刻属于「时间片」，不属于日期区间。
 * 跨日且带时刻的旧数据不处理（保持原有显示，写回时只去掉时刻）。
 */
export function legacyDaySlot(task: GCTask, startField: DateFieldType, endField: DateFieldType): { day: Date; startMin: number; endMin?: number } | null {
	const s = getTaskDateField(task, startField);
	const e = getTaskDateField(task, endField);
	const sTimed = isValid(s) && task.datePrecision?.[startField] === 'time';
	const eTimed = isValid(e) && task.datePrecision?.[endField] === 'time';
	if (!sTimed && !eTimed) return null;
	if (isValid(s) && isValid(e) && dayOf(s).getTime() !== lastDayOf(e).getTime() && e > s) return null;
	const anchor = (sTimed ? s : e) as Date;
	const startMin = minutesOfDay(anchor);
	if (sTimed && eTimed && e > s) {
		return { day: dayOf(s), startMin, endMin: e.getHours() === 0 && e.getMinutes() === 0 ? 24 * 60 : minutesOfDay(e) };
	}
	return { day: dayOf(anchor), startMin };
}

function buildLegacyProxy(task: GCTask, startField: DateFieldType, endField: DateFieldType, dateField: DateFieldType, slot: { day: Date; startMin: number; endMin?: number }): GCTask {
	const endMin = slot.endMin ?? Math.min(slot.startMin + PLANNER_DEFAULT_DURATION_MIN, 24 * 60);
	const proxy: GCTask = { ...task, datePrecision: { ...task.datePrecision } };
	setTaskDateField(proxy, startField, atMinutes(slot.day, slot.startMin));
	setTaskDateField(proxy, endField, atMinutes(slot.day, endMin));
	proxy.datePrecision![startField] = 'time';
	proxy.datePrecision![endField] = 'time';
	proxy.scheduledProxy = { source: task, startField, endField, dateField, legacy: true };
	return proxy;
}

/** 日期区间条：把起止字段降为日期精度（时刻已由时间片承担） */
function toDateLevel(task: GCTask, startField: DateFieldType, endField: DateFieldType): GCTask {
	const copy: GCTask = { ...task, datePrecision: { ...task.datePrecision } };
	for (const f of [startField, endField]) {
		const v = getTaskDateField(copy, f);
		if (isValid(v) && copy.datePrecision![f] === 'time') {
			setTaskDateField(copy, f, dayOf(v));
			copy.datePrecision![f] = 'day';
		}
	}
	return copy;
}

/**
 * 时间轴视图（周 / 日 / 侧栏每日时间线）使用的任务集：
 * - 起止（🛫/📅）只表示日期区间 → 全天横条
 * - ⏳ + 行首 Day Planner 前缀表示当日时间片 → 时间轴块；任务同时有区间时，区间条与时间块并存（时间块为 slot 代理）
 * - 旧写法（起止上带时刻的同日任务）按时间片显示，首次写回时迁移
 */
export function expandTimeSlots(
	tasks: GCTask[],
	startField: DateFieldType,
	endField: DateFieldType,
	dateField: DateFieldType,
): GCTask[] {
	const out: GCTask[] = [];
	for (const task of tasks) {
		const base = applyScheduledFallback(task, startField, endField, dateField);
		if (base.scheduledProxy || task.fileTask) {
			out.push(base);
			continue;
		}
		const planner = hasPlannerSlot(task);
		const range = hasViewDateRange(task, startField, endField, dateField);
		if (planner && range) {
			// 区间条（日期精度）+ 时间片
			out.push(toDateLevel(task, startField, endField));
			out.push(buildPlannerProxy(task, startField, endField, dateField, { slot: true }));
			continue;
		}
		const legacy = !planner ? legacyDaySlot(task, startField, endField) : null;
		if (legacy) {
			out.push(buildLegacyProxy(task, startField, endField, dateField, legacy));
			continue;
		}
		out.push(planner || !range ? base : toDateLevel(task, startField, endField));
	}
	return out;
}

/** 视图项的拖拽 / 列表 id：时间片代理与同任务的区间条区分开 */
export function isSlotItem(task: GCTask): boolean {
	return !!task.scheduledProxy?.slot;
}

/**
 * 把任务当作「时间片目标」写回：对视图字段写入的时间，会被还原成 ⏳ + 行首时间前缀（起止区间不动）。
 * 用于把区间条 / 全天任务 / 列表任务拖进时间轴。
 */
export function asSlotTarget(task: GCTask, startField: DateFieldType, endField: DateFieldType, dateField: DateFieldType): GCTask {
	if (task.scheduledProxy) return task;
	return { ...task, scheduledProxy: { source: task, startField, endField, dateField, slot: true } };
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
	let end = valueOf(proxy.endField);
	// 时间片限制在一天内：越过午夜的终点钳到当日 24:00（区间条才可以跨日，由起止日期承担）
	if (proxy.slot && isValid(start) && isValid(end) && end > start && dayOf(start).getTime() !== lastDayOf(end).getTime()) {
		end = atMinutes(dayOf(start), 24 * 60);
	}
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

	// 跨日区间（非时间片，如甘特拉长）：写入真实起止字段（计划日期 + 前缀只能表达单日时段）
	// 终点恰为次日 00:00 视为当日 24:00（时段延续到午夜仍属同一天）
	if (isValid(start) && isValid(end) && dayOf(start).getTime() !== lastDayOf(end).getTime() && end > start) {
		// 起止只管日期：跨日区间写日期精度，时刻不再写进起止
		out[proxy.startField] = dayOf(start);
		out[proxy.endField] = dayOf(end);
		sourcePrecision[proxy.startField] = 'day';
		sourcePrecision[proxy.endField] = 'day';
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
