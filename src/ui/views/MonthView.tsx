import { Fragment, useMemo, useCallback, useEffect, useRef, type JSX } from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { taskKey } from '../utils/taskKey';
import type { DragEvent as ReactDragEvent } from 'react';
import { Notice } from 'obsidian';
import { generateMonthCalendar } from '../../calendar/calendarGenerator';
import type { GCTask } from '../../types';
import { MonthViewConfig } from '../../components/TaskCard';
import { MonthViewClasses, setCssProps } from '../../utils/bem';
import { usePlugin, useApp } from '../pluginContext';
import { useCalendarStore, selectViewFilter } from '../store/calendarStore';
import { applyStatusFilter, applyTagFilter, applySort } from '../utils/taskFilters';
import { updateTaskProperties } from '../../tasks/taskUpdater';
import { toISOStringLocal } from '../../dateUtils/timezone';
import { createMonthWheelStep, shiftMonth, getMonthKey, monthTravelDir } from '../utils/monthWheel';
import { MOTION, easeOutTransition } from '../motion';
import { generateVirtualInstances } from '../../tasks/virtualTaskGenerator';
import { buildMonthTimelineModel, layoutMonthWeekLanes, getTaskInterval, clampSingleFieldWrite } from './week/timelineModel';
import { sortTasks } from '../../tasks/taskSorter';
import { i18n } from '../../i18n/i18n';
import { Logger } from '../../utils/logger';
import type { DateFieldType } from '../../settings/types';
import { useViewTasks } from '../utils/useViewTasks';
import { useFileTaskLayer } from '../utils/useFileTaskLayer';
import { useIcsLayer } from '../utils/useIcsLayer';
import { useAdvancedFilters } from '../utils/useAdvancedFilters';
import { CalendarItemCard, FileTaskLayerProvider } from '../components/FileTaskCard';
import { findTaskById } from '../utils/taskId';

/** lane 条带与格底之间的间隙 */
const SPAN_STRIP_GAP_PX = 4;
/**
 * 横跨条带顶部让位：日期头部高度（格 padding-top 8px + 日号 22px + gap 2px）。
 * 条带从此偏移开始，不遮挡日号/农历
 */
const SPAN_HEADER_OFFSET_PX = 32;

/** dataTransfer.taskId（filePath:lineNumber）→ 任务查找 */
/**
 * React 月视图（时间线语义版）
 * 7 列 × N 周网格；每周行内横跨条（周内钳制 + 延续箭头 + 时刻标注）与单日/定时任务
 * 排进同一套 lane 混排（layoutMonthWeekLanes），单日任务填补横跨条留下的空位，
 * 全部显示、行高随 lane 数自适应；拖放语义与周/日/侧栏画布对齐。
 */
export function MonthView(): JSX.Element {
	const plugin = usePlugin();
	const app = useApp();
	const currentDate = useCalendarStore((s) => s.currentDate);
	const filter = useCalendarStore((s) => selectViewFilter(s, 'month'));
	const setCurrentDate = useCalendarStore((s) => s.setCurrentDate);
	const setViewType = useCalendarStore((s) => s.setViewType);
	const refreshTasks = useCalendarStore((s) => s.refreshTasks);
	// 稳定回调：TaskCard 已 memo，内联箭头函数会使 memo 失效
	const handleCardRefresh = useCallback(() => refreshTasks(), [refreshTasks]);

	// ===== 滚轮切月：悬停月视图滚动即切换月份（累计阈值 + 冷却防惯性连跳） =====
	// 原生监听（passive: false）而非 React onWheel：后者在根容器注册为 passive，
	// preventDefault 可能失效；月视图内容不溢出，滚轮原本无滚动目标，无冲突。
	const viewRef = useRef<HTMLDivElement>(null);
	const stepWheelRef = useRef(createMonthWheelStep());

	useEffect(() => {
		const el = viewRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			const dir = stepWheelRef.current(e.deltaY, e.deltaMode, Date.now());
			if (dir === 0) return;
			e.preventDefault();
			setCurrentDate(shiftMonth(currentDate, dir));
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, [currentDate, setCurrentDate]);

	// ===== 相邻月切月动画：方向由上次渲染的月份键推导（±1 平移 / 其余淡入淡出） =====
	const monthKey = getMonthKey(currentDate);
	const prevMonthKeyRef = useRef(monthKey);
	const slideDir = monthTravelDir(prevMonthKeyRef.current, monthKey);
	useEffect(() => {
		prevMonthKeyRef.current = monthKey;
	}, [monthKey]);

	const startOnMonday = !!plugin.settings.startOnMonday;
	const dateField = plugin.settings.dateFilterField || 'dueDate';
	const startField = plugin.settings.ganttStartField || 'startDate';
	const endField = plugin.settings.ganttEndField || 'dueDate';
	const tasks = useViewTasks(startField, endField, dateField);
	const enabledFormats = plugin.settings.enabledTaskFormats || [];

	// 月视图统一使用 timeline 变体：格内卡片与横跨条同一视觉语言
	const config = useMemo(() => ({
		...MonthViewConfig,
		variant: 'timeline' as const,
		showCheckbox: plugin.settings.monthViewShowCheckbox,
		showTags: plugin.settings.monthViewShowTags,
		showPriority: plugin.settings.monthViewShowPriority,
		showTicktick: plugin.settings.monthViewShowTicktick,
	}), [plugin.settings]);

	const monthData = useMemo(() => {
		return generateMonthCalendar(currentDate.getFullYear(), currentDate.getMonth() + 1, startOnMonday);
	}, [currentDate, startOnMonday]);

	// 全局筛选
	const advanced = useAdvancedFilters('month');
	const scoped = useMemo(() => (
		applySort(advanced.filterTasks(applyTagFilter(applyStatusFilter(tasks, filter.status), filter.tag)), filter.sort)
	), [tasks, filter, advanced]);

	// 预生成整月虚拟周期实例
	const virtualInstances = useMemo(() => {
		if (!monthData) return [];
		const allDays = monthData.days;
		const monthStart = new Date(allDays[0].date);
		monthStart.setHours(0, 0, 0, 0);
		const monthEnd = new Date(allDays[allDays.length - 1].date);
		monthEnd.setHours(0, 0, 0, 0);
		return generateVirtualInstances(
			scoped,
			monthStart,
			monthEnd,
			dateField,
			plugin.settings.recurringTaskDisplayLimit ?? 5
		);
	}, [scoped, monthData, dateField, plugin.settings.recurringTaskDisplayLimit]);

	// file-based task 图层：文件横跨条；归类时文件内任务全部收进悬浮卡片（月视图无时间轴）
	const mergeIcs = useIcsLayer(startField, endField, dateField);
	const fileLayer = useFileTaskLayer('month', scoped, startField, endField, dateField);

	// 月视图时间线模型：跨日横跨条 + 格内任务（锚日语义），渲染时再混排进统一 lane
	const monthModel = useMemo(() => {
		if (!monthData) return [];
		const combined = mergeIcs(fileLayer.merge(sortTasks([...scoped, ...virtualInstances], filter.sort).filter((t) => !t.cancelled)));
		return buildMonthTimelineModel(combined, monthData.weeks, startField, endField, dateField);
	}, [scoped, virtualInstances, fileLayer, mergeIcs, monthData, filter.sort, startField, endField, dateField]);

	// 任务全集（拖放源查找）
	const dragLookupTasks = useMemo(() => tasks.filter((t) => !t.cancelled), [tasks]);

	// ===== 拖放落点：语义与画布对齐 =====
	const handleDayDrop = useCallback(async (e: ReactDragEvent, targetDate: Date) => {
		e.preventDefault();
		const dayCell = e.currentTarget as HTMLElement;
		setCssProps(dayCell, { backgroundColor: '' });

		const taskId = e.dataTransfer?.getData('taskId');
		if (!taskId) return;
		const sourceTask = findTaskById(dragLookupTasks, taskId);
		if (!sourceTask) {
			Logger.error('MonthView', 'Source task not found:', taskId);
			return;
		}

		const target = new Date(targetDate);
		target.setHours(0, 0, 0, 0);
		const interval = getTaskInterval(sourceTask, startField, endField, dateField);
		const updates: Partial<Record<DateFieldType, Date>> = {};
		let precision: Partial<Record<DateFieldType, 'day' | 'time'>> = {};

		try {
			if (interval && interval.kind === 'point') {
				// 点任务拖动 = 双写起止并升级为区间任务（锚点时刻保留，整体移到目标日）
				const durationMin = Math.round((interval.end.getTime() - interval.start.getTime()) / 60000);
				const anchorTime = interval.start.getHours() * 60 + interval.start.getMinutes();
				const anchorMin = anchorTime;
				updates[startField] = atMinutes(target, anchorMin);
				updates[endField] = atMinutes(target, anchorMin + durationMin);
				precision = { [startField]: 'time', [endField]: 'time' };
			} else if (interval) {
				// 区间任务 = 整段平移 Δ 天（开始日锚定目标日，各端点保时/保天精度）
				const dayMsOf = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
				const deltaMs = target.getTime() - dayMsOf(interval.start);
				const newStart = new Date(interval.start.getTime() + deltaMs);
				const newEnd = new Date(interval.end.getTime() + deltaMs);
				const startIsTime = sourceTask.datePrecision?.[startField] === 'time';
				const endIsTime = sourceTask.datePrecision?.[endField] === 'time';
				updates[startField] = startIsTime ? newStart : atMinutes(newStart, 0);
				updates[endField] = endIsTime ? newEnd : atMinutes(newEnd, 0);
				precision = { ...sourceTask.datePrecision };
			} else {
				// 全天单字段：dateField 平移到目标日（day 精度）；
				// 对端钳制：落点越过对端点所在日时钳到对端点日，避免制造倒置数据
				updates[dateField] = clampSingleFieldWrite(sourceTask, dateField, target, startField, endField);
				precision = { [dateField]: 'day' };
			}

			const taskToUpdate = { ...sourceTask, datePrecision: { ...sourceTask.datePrecision, ...precision } };
			await updateTaskProperties(app, taskToUpdate, updates, enabledFormats);
			await plugin.taskCache.refreshFile(sourceTask.filePath);
			refreshTasks();
		} catch (error) {
			Logger.error('MonthView', 'Error updating task date:', error);
			new Notice(i18n.t('views.dayView.updateDateFailed'));
		}
	}, [app, dateField, startField, endField, enabledFormats, dragLookupTasks, plugin, refreshTasks]);

	if (!monthData) {
		return <div ref={viewRef} className="gc-view gc-view--month" />;
	}

	const labelsSunFirst = i18n.t('views.monthView.weekdays') as unknown as string[];
	const labelsMonFirst = i18n.t('views.monthView.weekdaysMon') as unknown as string[];
	const weekdayLabels = startOnMonday ? labelsMonFirst : labelsSunFirst;

	const monthFontSize = plugin.settings.monthLunarFontSize || 10;

	return (
		<FileTaskLayerProvider value={{ tasksByFile: fileLayer.tasksByFile, onRefresh: handleCardRefresh }}>
		<div className="gc-month-anim">
			<AnimatePresence initial={false} custom={slideDir} mode="popLayout">
				<motion.div
					key={monthKey}
					ref={viewRef}
					className="gc-view gc-view--month"
					custom={slideDir}
					variants={monthSlideVariants}
					initial="enter"
					animate="center"
					exit="exit"
					transition={easeOutTransition(MOTION.dur.normal)}
				>
				<div className={`${MonthViewClasses.elements.weekday} gc-month-view__weekday--empty`} />
			{weekdayLabels.map((label, i) => (
				<div key={i} className={MonthViewClasses.elements.weekday}>
					{label}
				</div>
			))}

			{monthData.weeks.map((week, weekIndex) => {
				const weekRow = weekIndex + 2;
				const weekModel = monthModel[weekIndex];
				const dayKeys = week.days.map((d) => toISOStringLocal(d.date));
				// 横跨条与单日任务混排进统一 lane；条带高度按 lane 数（CSS 变量 --gc-month-lane-h 控制行高，手机端压缩为色带）
				const lanes = weekModel ? layoutMonthWeekLanes(weekModel, dayKeys) : { items: [], laneCount: 0 };
				const stripHeight = `calc(var(--gc-month-lane-h) * ${lanes.laneCount} + ${SPAN_STRIP_GAP_PX}px)`;
				/** 条带上的拖放：按落点 x 换算到列，转交日格的拖放语义 */
				const colAt = (e: ReactDragEvent<HTMLDivElement>): number => {
					const rect = e.currentTarget.getBoundingClientRect();
					return Math.min(6, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 7)));
				};
				return (
					<Fragment key={week.weekNumber}>
						<div
							className={MonthViewClasses.elements.weekNumber}
							style={{ gridRow: `${weekRow}`, gridColumn: '1' }}
						>
							<span>W{week.weekNumber}</span>
						</div>
						{/* lane 条带 overlay：与 7 个日格同行同区域，从日期头部下方开始；
						    空白处 pointer-events 穿透到日格，条目自身可交互；条带高度参与行高自适应 */}
						<div
							className={MonthViewClasses.elements.spanStrip}
							style={{ gridRow: `${weekRow}`, gridColumn: '2 / -1', marginTop: `${SPAN_HEADER_OFFSET_PX}px`, height: stripHeight }}
							onDragOver={(e) => {
								e.preventDefault();
								e.dataTransfer.dropEffect = 'move';
							}}
							onDrop={(e) => void handleDayDrop(e, week.days[colAt(e)].date)}
						>
							{lanes.items.map((item) => (
								<div
									key={`lane-${taskKey(item.task)}`}
									className={`${MonthViewClasses.elements.spanBar}${item.isSpan ? '' : ` ${MonthViewClasses.modifiers.spanBarDay}`}${item.continuesBefore ? ` ${MonthViewClasses.modifiers.spanBarContinuesBefore}` : ''}${item.continuesAfter ? ` ${MonthViewClasses.modifiers.spanBarContinuesAfter}` : ''}`}
									style={{
										left: `calc(${(item.startCol / 7) * 100}% + 1px)`,
										width: `calc(${((item.endCol - item.startCol + 1) / 7) * 100}% - 2px)`,
										top: `calc(var(--gc-month-lane-h) * ${item.lane})`,
									}}
								>
									<CalendarItemCard
										task={item.task}
										config={config}
										targetDate={week.days[item.startCol]?.date}
										onRefresh={handleCardRefresh}
									/>
									{item.timeLabel ? (
										<span className={MonthViewClasses.elements.spanBarTime}>{item.timeLabel}</span>
									) : null}
								</div>
							))}
						</div>
						{week.days.map((day, dayIndex) => {
							const cellClasses = [
								MonthViewClasses.elements.dayCell,
								!day.isCurrentMonth ? MonthViewClasses.modifiers.outsideMonth : '',
								day.isToday ? MonthViewClasses.modifiers.today : '',
							].filter(Boolean).join(' ');
							const key = dayKeys[dayIndex];

							const lunarEl = day.lunarText && plugin.settings.showLunar
								? (
									<div
										className={`${MonthViewClasses.elements.lunarText}${(day.festival || day.festivalType) && plugin.settings.showFestivals ? ` ${MonthViewClasses.modifiers.festival}${day.festivalType ? ` ${festivalClass(day.festivalType)}` : ''}` : ''}`}
										style={{ fontSize: `${monthFontSize}px` }}
									>
										{day.lunarText}
									</div>
								) : null;

							return (
								<div
									key={`${week.weekNumber}-${dayIndex}`}
									className={cellClasses}
									data-date={key}
									style={{ gridRow: `${weekRow}`, gridColumn: `${dayIndex + 2}` }}
									role="button"
									tabIndex={0}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											setCurrentDate(day.date);
											setViewType('day');
										}
									}}
									onClick={(e) => {
										if ((e.target as HTMLElement).closest('.gc-task-card')) return;
										setCurrentDate(day.date);
										setViewType('day');
									}}
									onDragOver={(e) => {
										e.preventDefault();
										e.dataTransfer.dropEffect = 'move';
										setCssProps(e.currentTarget, { backgroundColor: 'var(--background-modifier-hover)' });
									}}
									onDragLeave={(e) => {
										setCssProps(e.currentTarget, { backgroundColor: '' });
									}}
									onDrop={(e) => void handleDayDrop(e, day.date)}
								>
									<div className={MonthViewClasses.elements.dayHeader}>
										<div className={MonthViewClasses.elements.dayNumber}>{day.day.toString()}</div>
										{lunarEl}
									</div>
								</div>
							);
						})}
				</Fragment>
			);
		})}
				</motion.div>
			</AnimatePresence>
		</div>
		</FileTaskLayerProvider>
	);
}

/** 目标日 00:00 + 分钟偏移 */
function atMinutes(base: Date, min: number): Date {
	const d = new Date(base);
	d.setHours(0, 0, 0, 0);
	d.setMinutes(min);
	return d;
}

function festivalClass(type: 'solar' | 'lunar' | 'solarTerm'): string {
	switch (type) {
		case 'solar': return MonthViewClasses.modifiers.festivalSolar;
		case 'lunar': return MonthViewClasses.modifiers.festivalLunar;
		case 'solarTerm': return MonthViewClasses.modifiers.festivalSolarTerm;
	}
}

/**
 * 相邻月切换滑入/滑出变体：dir=±1 时整宽双向平移（新板边贴边同速推进），
 * dir=0（同月/跨多月）仅淡入淡出，不做长距离滑屏。
 */
const monthSlideVariants: Variants = {
	enter: (dir: number) => ({ x: dir === 0 ? 0 : `${dir * 100}%`, opacity: 0 }),
	center: { x: 0, opacity: 1 },
	exit: (dir: number) => ({ x: dir === 0 ? 0 : `${-dir * 100}%`, opacity: 0 }),
};
