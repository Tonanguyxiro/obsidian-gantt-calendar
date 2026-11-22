import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { getWeekOfDate } from '../../dateUtils/dateUtilsIndex';
import { WeekViewConfig } from '../../components/TaskCard';
import { WeekViewClasses } from '../../utils/bem';
import { useCalendarStore, selectViewFilter } from '../store/calendarStore';
import { applyStatusFilter, applyTagFilter, applySort } from '../utils/taskFilters';
import { sortTasks } from '../../tasks/taskSorter';
import { generateVirtualInstances } from '../../tasks/virtualTaskGenerator';
import { i18n } from '../../i18n/i18n';
import { buildWeekTimelineModel, computeMaxLanesForWidth, isOnTimeAxis } from './week/timelineModel';
import { useFileTaskLayer } from '../utils/useFileTaskLayer';
import { useIcsLayer } from '../utils/useIcsLayer';
import { useAdvancedFilters } from '../utils/useAdvancedFilters';
import { FileTaskLayerProvider } from '../components/FileTaskCard';
import { WeekTimelineGrid } from './week/WeekTimelineGrid';
import { useElementWidth, useIsPhone } from '../utils/platform';
import { useViewTasks } from '../utils/useViewTasks';
import { useTodayKey } from '../utils/useTodayKey';

/**
 * React 周视图（常驻时间线模式）
 * 数据编排：周数据 + 筛选/排序 + 虚拟周期实例 → 连续画布模型，渲染交给 WeekTimelineGrid
 */
export function WeekView(): JSX.Element {
	const currentDate = useCalendarStore((s) => s.currentDate);
	const setCurrentDate = useCalendarStore((s) => s.setCurrentDate);
	const filter = useCalendarStore((s) => selectViewFilter(s, 'week'));
	const updateSeq = useCalendarStore((s) => s.updateSeq);
	const refreshTasks = useCalendarStore((s) => s.refreshTasks);

	const startOnMonday = useCalendarStore((s) => !!s.settings.startOnMonday);
	const dateField = useCalendarStore((s) => s.settings.dateFilterField) || 'dueDate';
	const ganttStartField = useCalendarStore((s) => s.settings.ganttStartField) || 'startDate';
	const ganttEndField = useCalendarStore((s) => s.settings.ganttEndField) || 'dueDate';
	const showLunar = useCalendarStore((s) => !!s.settings.showLunar);
	const recurringLimit = useCalendarStore((s) => s.settings.recurringTaskDisplayLimit) ?? 5;
	const weekViewShowCheckbox = useCalendarStore((s) => s.settings.weekViewShowCheckbox);
	const weekViewShowTags = useCalendarStore((s) => s.settings.weekViewShowTags);
	const weekViewShowPriority = useCalendarStore((s) => s.settings.weekViewShowPriority);
	const weekViewShowTicktick = useCalendarStore((s) => s.settings.weekViewShowTicktick);
	const language = useCalendarStore((s) => s.settings.language);

	const config = useMemo(() => ({
		...WeekViewConfig,
		enableDrag: true,
		showCheckbox: weekViewShowCheckbox,
		showTags: weekViewShowTags,
		showPriority: weekViewShowPriority,
		showTicktick: weekViewShowTicktick,
	}), [weekViewShowCheckbox, weekViewShowTags, weekViewShowPriority, weekViewShowTicktick]);
	// 时间块使用紧凑变体，高度由块容器按时长撑开
	const timelineConfig = useMemo(() => ({ ...config, variant: 'timeline' as const }), [config]);

	// todayKey 入依赖：跨午夜后重算 isToday，否则长时间挂着的视图仍高亮昨天
	const todayKey = useTodayKey();
	const weekData = useMemo(() => (
		getWeekOfDate(currentDate, currentDate.getFullYear(), startOnMonday)
	), [currentDate, startOnMonday, todayKey]);

	const weekStart = useMemo(() => {
		const d = new Date(weekData.days[0].date);
		d.setHours(0, 0, 0, 0);
		return d;
	}, [weekData]);

	const weekEnd = useMemo(() => {
		const d = new Date(weekData.days[6].date);
		d.setHours(0, 0, 0, 0);
		return d;
	}, [weekData]);

	const weekRange = useMemo(() => ({ start: weekStart, end: weekEnd }), [weekStart, weekEnd]);
	const tasks = useViewTasks(ganttStartField, ganttEndField, dateField, true, weekRange);

	// 全局筛选 + 排序
	const advanced = useAdvancedFilters('week');
	const scoped = useMemo(() => (
		applySort(advanced.filterTasks(applyTagFilter(applyStatusFilter(tasks, filter.status), filter.tag)), filter.sort)
	), [tasks, filter, advanced]);

	// 预生成整周的虚拟周期实例
	const virtualInstances = useMemo(() => (
		generateVirtualInstances(scoped, weekStart, weekEnd, dateField, recurringLimit)
	), [scoped, weekStart, weekEnd, dateField, recurringLimit]);

	// 本周任务全集（真实 + 虚拟，已排序）
	const combined = useMemo(() => (
		sortTasks([...scoped, ...virtualInstances], filter.sort)
	), [scoped, virtualInstances, filter.sort]);

	// file-based task 图层：文件横跨条进全天行；归类时文件内任务收进悬浮卡片，定时任务仍留在时间轴
	const mergeIcs = useIcsLayer(ganttStartField, ganttEndField, dateField);
	const fileLayer = useFileTaskLayer('week', scoped, ganttStartField, ganttEndField, dateField);

	const viewRef = useRef<HTMLDivElement>(null);
	const viewWidth = useElementWidth(viewRef);
	const isPhone = useIsPhone();
	const visibleCount = isPhone ? 3 : 7;
	const maxLane = useMemo(
		() => computeMaxLanesForWidth(viewWidth > 48 ? (viewWidth - 48) / visibleCount : 0),
		[viewWidth, visibleCount],
	);

	// 连续画布模型：时间块分段 + lane 布局 + 全天横跨条
	const model = useMemo(() => (
		buildWeekTimelineModel(
			mergeIcs(fileLayer.merge(combined, (t) => isOnTimeAxis(t, ganttStartField, ganttEndField, dateField))),
			weekStart, ganttStartField, ganttEndField, dateField, maxLane,
		)
	), [combined, fileLayer, mergeIcs, weekStart, ganttStartField, ganttEndField, dateField, maxLane]);

	const handleRefresh = useCallback(() => refreshTasks(), [refreshTasks]);

	const dayNames = useMemo(() => {
		void language;
		return i18n.t('views.weekView.weekdays') as unknown as string[];
	}, [language]);

	// ===== 手机端 3 日滑动窗口：可见日为周内连续窗口，swipe 翻页，跨周边界滚到相邻周 =====
	const [windowStart, setWindowStart] = useState(0);

	// 切周后窗口定位到今天（若本周含今天）或周首日
	useEffect(() => {
		const todayIdx = weekData.days.findIndex((d) => d.isToday);
		const anchor = todayIdx >= 0 ? todayIdx - 1 : 0;
		setWindowStart(Math.max(0, Math.min(anchor, 7 - visibleCount)));
	}, [weekData, visibleCount]);

	const visibleDayIdxs = useMemo(
		() => Array.from({ length: visibleCount }, (_, i) => Math.min(windowStart + i, 6)),
		[windowStart, visibleCount],
	);

	/** swipe 翻页：窗口内滑动一日，越界滚动到相邻周 */
	const handleSwipe = useCallback((dir: -1 | 1) => {
		const next = windowStart + dir;
		if (next < 0) {
			const d = new Date(weekStart);
			d.setDate(d.getDate() - 7);
			setCurrentDate(d);
			setWindowStart(7 - visibleCount);
			return;
		}
		if (next + visibleCount > 7) {
			const d = new Date(weekStart);
			d.setDate(d.getDate() + 7);
			setCurrentDate(d);
			setWindowStart(0);
			return;
		}
		setWindowStart(next);
	}, [windowStart, visibleCount, weekStart, setCurrentDate]);

	return (
		<FileTaskLayerProvider value={{ tasksByFile: fileLayer.tasksByFile, onRefresh: handleRefresh }}>
		<div ref={viewRef} className="gc-view gc-view--week">
			<div className={WeekViewClasses.elements.grid}>
				<WeekTimelineGrid
					days={weekData.days}
					dayNames={dayNames}
					weekStart={weekStart}
					model={model}
					tasks={combined}
					config={timelineConfig}
					showLunar={showLunar}
					refreshTasks={handleRefresh}
					updateSeq={updateSeq}
					visibleDayIdxs={visibleDayIdxs}
					onSwipe={isPhone ? handleSwipe : undefined}
				/>
			</div>
		</div>
		</FileTaskLayerProvider>
	);
}
