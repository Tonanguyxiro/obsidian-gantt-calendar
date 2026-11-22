import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { taskKey } from '../utils/taskKey';
import { getTaskDateField } from '../../types';
import { TaskViewConfig } from '../../components/TaskCard';
import { TaskViewClasses, ViewClasses } from '../../utils/bem';
import { useCalendarStore, selectViewFilter } from '../store/calendarStore';
import { applyStatusFilter, applyTagFilter, applySort } from '../utils/taskFilters';
import { useAdvancedFilters } from '../utils/useAdvancedFilters';
import { useViewTasks } from '../utils/useViewTasks';
import { useTodayKey } from '../utils/useTodayKey';
import { useIsPhone } from '../utils/platform';
import { TaskCard } from '../components/TaskCard';
import { EmptyVaultGuide } from '../components/EmptyVaultGuide';
import { i18n } from '../../i18n/i18n';
import { generateVirtualInstances } from '../../tasks/virtualTaskGenerator';
import { Logger } from '../../utils/logger';

/** 视图容器类名：通用视图块 + 任务视图修饰符 + 任务视图块（序号列元素挂在该块下） */
const VIEW_CLASS = `${ViewClasses.block} ${ViewClasses.modifiers.task} ${TaskViewClasses.block}`;

export function TaskView(): JSX.Element {
	const filter = useCalendarStore((s) => selectViewFilter(s, 'task'));
	const refreshTasks = useCalendarStore((s) => s.refreshTasks);
	const isEmptyVault = useCalendarStore((s) => s.tasksReady && s.tasks.length === 0);
	const timeFieldFilter = useCalendarStore((s) => s.settings.taskViewTimeFieldFilter) || 'dueDate';
	const dateRangeMode = useCalendarStore((s) => s.settings.taskViewDateRangeMode) || 'week';
	const startField = useCalendarStore((s) => s.settings.ganttStartField) || 'startDate';
	const endField = useCalendarStore((s) => s.settings.ganttEndField) || 'dueDate';
	const recurringLimit = useCalendarStore((s) => s.settings.recurringTaskDisplayLimit) ?? 5;

	const advanced = useAdvancedFilters('task');
	// 稳定回调：TaskCard 已 memo，内联箭头函数会使 memo 失效
	const handleCardRefresh = useCallback(() => refreshTasks(), [refreshTasks]);

	const isPhone = useIsPhone();
	const viewRef = useRef<HTMLDivElement | null>(null);
	const [phoneScrollParent, setPhoneScrollParent] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (!isPhone || typeof ResizeObserver === 'undefined') {
			setPhoneScrollParent(null);
			return;
		}
		const appEl = viewRef.current?.closest('.gantt-calendar-app');
		setPhoneScrollParent(appEl instanceof HTMLElement ? appEl : null);
	}, [isPhone]);

	const todayKey = useTodayKey();
	const { effectiveStart, effectiveEnd, taskRange } = useMemo(() => {
		void todayKey;
		const ref = new Date();
		let rangeStart: Date;
		let rangeEnd: Date;
		if (dateRangeMode === 'day' || dateRangeMode === 'custom') {
			rangeStart = startOfDay(ref);
			rangeEnd = endOfDay(ref);
		} else if (dateRangeMode === 'week') {
			rangeStart = startOfWeek(ref);
			rangeEnd = endOfWeek(ref);
		} else if (dateRangeMode === 'month') {
			rangeStart = startOfMonth(ref);
			rangeEnd = endOfMonth(ref);
		} else {
			// "all" 模式：虚拟实例范围覆盖从今天到 1 年后；dateRange 传 undefined 以查询全库
			rangeStart = startOfDay(ref);
			rangeEnd = new Date(ref.getFullYear() + 1, ref.getMonth(), ref.getDate(), 23, 59, 59);
		}
		return {
			effectiveStart: rangeStart,
			effectiveEnd: rangeEnd,
			taskRange: dateRangeMode !== 'all' ? { start: rangeStart, end: rangeEnd } : undefined,
		};
	}, [dateRangeMode, todayKey]);

	const tasks = useViewTasks(startField, endField, timeFieldFilter, false, taskRange);

	const config = useMemo(() => ({
		...TaskViewConfig,
	}), []);

	const viewData = useMemo(() => {
		try {
			let scoped = applyStatusFilter(tasks, filter.status);
			if (dateRangeMode !== 'all') {
				scoped = scoped.filter((task) => {
					const dateValue = getTaskDateField(task, timeFieldFilter);
					if (!dateValue) return false;
					const taskDate = new Date(dateValue);
					if (isNaN(taskDate.getTime())) return false;
					return taskDate >= effectiveStart && taskDate <= effectiveEnd;
				});
			}
			scoped = advanced.filterTasks(applyTagFilter(scoped, filter.tag));
			scoped = applySort(scoped, filter.sort);

			// 重复任务：按日期范围生成虚拟实例并与真实任务合并
			const virtuals = generateVirtualInstances(
				scoped,
				effectiveStart,
				effectiveEnd,
				timeFieldFilter,
				recurringLimit,
			);
			scoped = [...scoped, ...virtuals].sort((a, b) => {
				const da = getTaskDateField(a, timeFieldFilter);
				const db = getTaskDateField(b, timeFieldFilter);
				const ta = da ? da.getTime() : 0;
				const tb = db ? db.getTime() : 0;
				return ta - tb;
			});
			return scoped;
		} catch (error) {
			Logger.error('TaskView', 'Error rendering task view', error);
			return null;
		}
	}, [tasks, filter, advanced, dateRangeMode, timeFieldFilter, effectiveStart, effectiveEnd, recurringLimit]);

	if (isEmptyVault) {
		return (
			<div ref={viewRef} className={VIEW_CLASS}>
				<EmptyVaultGuide />
			</div>
		);
	}

	if (viewData === null) {
		return (
			<div ref={viewRef} className={VIEW_CLASS}>
				<div className={TaskViewClasses.elements.empty}>{i18n.t('views.taskView.loadError')}</div>
			</div>
		);
	}

	if (viewData.length === 0) {
		return (
			<div ref={viewRef} className={VIEW_CLASS}>
				<div className={TaskViewClasses.elements.empty}>{i18n.t('views.taskView.noTasks')}</div>
			</div>
		);
	}

	return (
		<div ref={viewRef} className={VIEW_CLASS}>
			<Virtuoso
				style={isPhone ? undefined : { height: '100%' }}
				useWindowScroll={isPhone && !phoneScrollParent}
				customScrollParent={isPhone && phoneScrollParent ? phoneScrollParent : undefined}
				data={viewData}
				initialItemCount={Math.min(viewData.length, 20)}
				computeItemKey={(_index, task) => taskKey(task)}
				itemContent={(index, task) => (
					<div className={TaskViewClasses.elements.row}>
						{/* 序号是行装饰，不参与无障碍朗读与文本选择 */}
						<span className={TaskViewClasses.elements.index} aria-hidden="true">{index + 1}</span>
						<TaskCard
							task={task}
							config={config}
							onRefresh={handleCardRefresh}
						/>
					</div>
				)}
			/>
		</div>
	);
}


function startOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

function endOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(23, 59, 59, 999);
	return x;
}

function startOfWeek(d: Date): Date {
	const x = startOfDay(d);
	const day = x.getDay();
	const diff = (day + 6) % 7;
	x.setDate(x.getDate() - diff);
	return x;
}

function endOfWeek(d: Date): Date {
	const s = startOfWeek(d);
	const e = new Date(s);
	e.setDate(s.getDate() + 6);
	e.setHours(23, 59, 59, 999);
	return e;
}

function startOfMonth(d: Date): Date {
	const x = startOfDay(d);
	x.setDate(1);
	return x;
}

function endOfMonth(d: Date): Date {
	const x = startOfDay(d);
	x.setMonth(x.getMonth() + 1, 0);
	x.setHours(23, 59, 59, 999);
	return x;
}