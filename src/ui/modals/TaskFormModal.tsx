import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import { unwrapTask } from '../../tasks/scheduledFallback';
import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { GCTask, IPluginContext } from '../../types';
import type { CreateTaskData } from '../../utils/dailyNoteHelper';
import { createTaskInDailyNote, createTaskInFile, createTaskAtLine, type CreateAtLine } from '../../utils/dailyNoteHelper';
import type { TaskUpdates } from '../../tasks/taskSerializer';
import { updateTaskProperties } from '../../tasks/taskUpdater';
import { Logger } from '../../utils/logger';
import { i18n } from '../../i18n/i18n';
import { EditTaskModalClasses, ModalClasses, TaskKindClasses } from '../../utils/bem';
import { Modal } from '../components/Modal';
import { TagSelector } from './TagSelector';
import { RepeatSection } from './RepeatSection';
import { DateTimePicker } from '../components/DateTimePicker';
import { DescriptionEditor } from '../components/DescriptionEditor';
import { Popover } from '../components/Popover';
import { WhenPicker, type WhenValue } from '../components/WhenPicker';
import { formatDuration, formatHm, hmToMin, type TimeFormat } from '../../utils/timeOfDay';
import { Icon } from '../components/Icon';
import { statusTransitionUpdates, getConfiguredStatuses, getPickerStatuses } from '../../tasks/statusTransition';
import { legacyDaySlot, rewritePlannerPrefix } from '../../tasks/scheduledFallback';
import { stripPlannerTime } from '../../tasks/taskParser/utils';
import { getStatusColor, getCurrentThemeMode } from '../../tasks/taskStatus';
import { openReactModal } from './modalHost';
import { useCalendarStore } from '../store/calendarStore';

/**
 * 优先级选项
 */
export interface PriorityOption {
	value: 'highest' | 'high' | 'medium' | 'normal' | 'low' | 'lowest';
	label: string;
	icon: string;
}

/** 任务类型：时间段（开始~截止，跨日）/ 当日（⏳ 某天 + 当日时刻） */
export type TaskKind = 'period' | 'day';

export interface TaskFormModalProps {
	/** 创建或编辑模式 */
	mode: 'create' | 'edit';
	app: App;
	/** 创建模式需要：插件上下文 */
	plugin?: IPluginContext;
	/** 创建模式：目标日期/小时/分钟（预填 dueDate 时刻） */
	targetDate?: Date;
	targetHour?: number;
	targetMinute?: number;
	/** 创建模式：目标起止区间（预填 startDate+dueDate，均带时刻） */
	targetRange?: { start: Date; end: Date };
	/** 编辑模式需要：任务对象 */
	task?: GCTask;
	enabledFormats?: string[];
	allowEditContent?: boolean;
	/** 创建模式：写到指定文件的指定行（「Edit task」命令在空行 / 普通文本行上触发） */
	createAt?: CreateAtLine;
	/** 创建模式：预填的描述 */
	initialDescription?: string;
	onSuccess: () => void;
	/** 宿主关闭函数（真正卸载元素） */
	onClose: () => void;
}

// 模块级常量会在 import 时固化 i18n 文案，语言切换后不生效——
// 改为组件内按当前语言求值
function getPriorityOptions(): PriorityOption[] {
	return [
		{ value: 'highest', label: i18n.t('common.priority.highest'), icon: '🔺' },
		{ value: 'high', label: i18n.t('common.priority.high'), icon: '⏫' },
		{ value: 'medium', label: i18n.t('common.priority.medium'), icon: '🔼' },
		{ value: 'normal', label: i18n.t('common.priority.normal'), icon: '◽' },
		{ value: 'low', label: i18n.t('common.priority.low'), icon: '🔽' },
		{ value: 'lowest', label: i18n.t('common.priority.lowest'), icon: '⏬' },
	];
}

const sameDay = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
	!!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * 截止早于开始判定（保存前保护）：双端均带时刻才按时刻比较，
 * 否则按日粒度比较（day 精度端点不含时刻语义，同日不算倒置）
 */
function isDueBeforeStart(
	start: Date,
	due: Date,
	precision: Record<string, 'day' | 'time'>,
): boolean {
	if (precision.startDate === 'time' && precision.dueDate === 'time') {
		return due.getTime() < start.getTime();
	}
	const dayMs = (d: Date) => {
		const x = new Date(d);
		x.setHours(0, 0, 0, 0);
		return x.getTime();
	};
	return dayMs(due) < dayMs(start);
}

/** 弹窗内联样式（原 BaseTaskModal.addStyles 的内容） */

/** 时间片的时刻输入值（HH:mm） */
function minutesToHm(min: number): string {
	const m = Math.min(min, 24 * 60);
	return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function dateToHm(d: Date): string {
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayStartOf(d: Date): Date {
	const r = new Date(d);
	r.setHours(0, 0, 0, 0);
	return r;
}

/** 时间片前缀文本："09:00 - 10:30" / "09:00" / 无时刻 → null */
function slotPrefixOf(start: string, end: string): string | null {
	if (!start) return null;
	return end && end > start ? `${start} - ${end}` : start;
}

/**
 * 任务创建/编辑弹窗（React，合并原 BaseTaskModal/CreateTaskModal/EditTaskModal）
 */
/**
 * 任务创建/编辑弹窗（React，合并原 BaseTaskModal/CreateTaskModal/EditTaskModal）
 */
export function TaskFormModal({
	mode,
	app,
	plugin,
	targetDate,
	targetHour,
	targetMinute,
	targetRange,
	task,
	enabledFormats,
	allowEditContent,
	createAt,
	initialDescription,
	onSuccess,
	onClose,
}: TaskFormModalProps): JSX.Element {
	const [open, setOpen] = useState(true);
	const priorityOptions = useMemo(getPriorityOptions, []);

	// ========== 表单状态 ==========
	const [priority, setPriority] = useState<PriorityOption['value']>(
		mode === 'edit'
			? ((task?.priority as PriorityOption['value']) || 'normal')
			: (plugin?.settings.defaultTaskPriority || 'normal')
	);
	const [repeat, setRepeat] = useState<string | null>(mode === 'edit' ? (task?.repeat || null) : null);

	// 时间片初值：⏳ + 行首时间前缀（Day Planner 写法）；旧写法里起止带时刻的同日任务按时间片读出
	const initialSlot = useMemo(() => {
		if (mode === 'edit' && task) {
			if (task.plannerTime) {
				return { start: minutesToHm(task.plannerTime.startMin), end: task.plannerTime.endMin !== undefined ? minutesToHm(task.plannerTime.endMin) : '', day: null as Date | null, legacy: false };
			}
			const legacy = legacyDaySlot(task, 'startDate', 'dueDate');
			if (legacy) {
				return { start: minutesToHm(legacy.startMin), end: legacy.endMin !== undefined ? minutesToHm(legacy.endMin) : '', day: legacy.day, legacy: true };
			}
			if (task.scheduledDate && task.datePrecision?.scheduledDate === 'time') {
				return { start: dateToHm(task.scheduledDate), end: '', day: dayStartOf(task.scheduledDate), legacy: true };
			}
			return { start: '', end: '', day: null as Date | null, legacy: false };
		}
		if (targetRange) return { start: dateToHm(targetRange.start), end: dateToHm(targetRange.end), day: dayStartOf(targetRange.start), legacy: false };
		if (targetHour !== undefined) return { start: minutesToHm(targetHour * 60 + (targetMinute ?? 0)), end: '', day: dayStartOf(targetDate || new Date()), legacy: false };
		return { start: '', end: '', day: null as Date | null, legacy: false };
	}, [mode, task, targetDate, targetHour, targetMinute, targetRange]);

	// 日期状态：{ key: Date | null }。起止 / 计划 / 完成等一律只管日期（时刻由下方「时间片」决定）
	const initialDates = useMemo(() => {
		const d: Record<string, Date | null> = {};
		const dayOnly = (v?: Date | null) => (v ? dayStartOf(v) : null);
		if (mode === 'edit' && task) {
			d.createdDate = dayOnly(task.createdDate);
			d.startDate = dayOnly(task.startDate);
			d.scheduledDate = dayOnly(task.scheduledDate) ?? initialSlot.day;
			d.dueDate = dayOnly(task.dueDate);
			d.completionDate = dayOnly(task.completionDate);
			d.cancelledDate = dayOnly(task.cancelledDate);
		} else {
			const base = targetDate || new Date();
			const dayStart = dayStartOf(base);
			d.createdDate = new Date(dayStart);
			d.dueDate = new Date(dayStart);
			d.startDate = null;
			// 从时间轴点选 / 框选新建：直接是一个时间片（⏳ 当日 + 时间前缀）
			d.scheduledDate = initialSlot.day ? new Date(initialSlot.day) : null;
			d.cancelledDate = null;
			d.completionDate = null;
		}
		return d;
	}, [mode, task, targetDate, initialSlot]);

	const [dates, setDates] = useState<Record<string, Date | null>>(initialDates);
	// 日期精度一律为 day（起止 / 计划日期只管日期）
	const datePrecision = useMemo<Record<string, 'day' | 'time'>>(() => ({
		createdDate: 'day', startDate: 'day', scheduledDate: 'day', dueDate: 'day', completionDate: 'day', cancelledDate: 'day',
	}), []);
	// 创建位置（仅创建模式）：'daily' = 当日日记；其余为文件路径（当日 file task 或手选的笔记）；'other' = 手选笔记
	const [createTarget, setCreateTarget] = useState<string>('daily');
	const [otherPath, setOtherPath] = useState('');
	const otherInputRef = useRef<HTMLInputElement>(null);
	const fileTasks = useCalendarStore((st) => st.fileTasks);
	const targetFileOptions = useMemo(() => {
		const day = dayStartOf(targetDate ?? new Date()).getTime();
		return fileTasks.filter((ft) => dayStartOf(ft.start).getTime() <= day && day <= dayStartOf(ft.end).getTime());
	}, [fileTasks, targetDate]);
	useEffect(() => {
		if (createTarget !== 'other' || !otherInputRef.current) return;
		const input = otherInputRef.current;
		let close = (): void => {};
		// 动态加载：AbstractInputSuggest 只在真实 Obsidian 里存在
		void import('../../settings/components/FileSuggest').then(({ FileSuggest }) => {
			const suggest = new FileSuggest(app, input);
			close = () => suggest.close();
		});
		return () => close();
	}, [createTarget, app]);
	const [selectedTags, setSelectedTags] = useState<string[]>(mode === 'edit' ? (task?.tags || []) : []);
	// 描述不含行首时间前缀：时刻由下方「时间片」管理，保存时再写回前缀
	const [description, setDescription] = useState(mode === 'edit' ? stripPlannerTime(task?.description || '').trim() : (initialDescription ?? ''));
	// 当日任务的时刻（写成行首时间前缀 "09:00 - 10:30"）；时间段任务不涉及时刻
	const [slotStart, setSlotStart] = useState(initialSlot.start);
	const [slotEnd, setSlotEnd] = useState(initialSlot.end);
	const [slotChangedByUser, setSlotChangedByUser] = useState(false);

	// 任务类型：有起止 → 时间段；只有 ⏳ / 时间片 → 当日。旧写法（同日带时刻的起止）读成当日任务
	const initialKind: TaskKind = useMemo(() => {
		if (mode === 'edit' && task) {
			if (initialSlot.legacy) return 'day';
			if (task.startDate || task.dueDate) return 'period';
			if (task.scheduledDate || initialSlot.start) return 'day';
			return 'period';
		}
		return initialSlot.start ? 'day' : 'period';
	}, [mode, task, initialSlot]);
	const [kind, setKind] = useState<TaskKind>(initialKind);
	const kindChanged = kind !== initialKind;
	const descriptionRef = useRef<{ focus: () => void } | null>(null);
	// 状态：设置里配置的全部状态（含自定义）；编辑模式默认取任务当前状态
	const initialStatus = mode === 'edit' ? (task?.status ?? (task?.completed ? 'done' : task?.cancelled ? 'canceled' : 'todo')) : 'todo';
	const [status, setStatus] = useState<string>(initialStatus);
	// 只列出设置里勾选「显示在状态选择中」的状态（任务当前状态除外，始终显示）；颜色取自设置里的状态配色
	const allStatuses = useMemo(() => getConfiguredStatuses(app), [app]);
	const statuses = useMemo(() => getPickerStatuses(app, initialStatus), [app, initialStatus]);
	const themeMode = getCurrentThemeMode();
	const [statusChanged, setStatusChanged] = useState(false);

	// 编辑模式：变更跟踪
	const [priorityChanged, setPriorityChanged] = useState(false);
	const [repeatChanged, setRepeatChanged] = useState(false);
	const [datesChanged, setDatesChanged] = useState(false);
	const [contentChanged, setContentChanged] = useState(false);
	const [tagsChanged, setTagsChanged] = useState(false);

	// 创建模式自动聚焦描述框
	// rAF 等一帧让弹窗先进入 DOM 并开始进场动画，随后立即聚焦
	// （原 100ms 定时器造成“弹出后还要等一下才能打字”的感知延迟）
	useEffect(() => {
		if (mode === 'create') {
			const raf = window.requestAnimationFrame(() => descriptionRef.current?.focus());
			return () => window.cancelAnimationFrame(raf);
		}
	}, [mode]);

	// 关闭只切状态，退出动画播完后由 onExited 从宿主移除。
	// 直接调 onClose 会立即卸载整个弹窗，动画中断且可能丢弃动画中的状态。
	// useCallback：Modal 的焦点管理 useEffect 依赖 onClose，
	// 未 memo 化会导致每次键入触发 focus 面板（输入框焦点被抢走）
	const handleClose = useCallback(() => setOpen(false), []);

	const isEdit = mode === 'edit';
	const title = isEdit ? i18n.t('modals.editTask.title') : i18n.t('modals.createTask.title');
	const saveText = isEdit ? i18n.t('common.save') : i18n.t('common.add');

	/** 选择状态：同步完成 / 取消日期（与右键菜单、复选框命令同一套规则），用户仍可在日期区手动改 */
	const pickStatus = (key: string) => {
		setStatus(key);
		if (isEdit) setStatusChanged(true);
		const t = statusTransitionUpdates({
			completed: status === 'done',
			cancelled: status === 'canceled',
			completionDate: dates.completionDate ?? undefined,
			cancelledDate: dates.cancelledDate ?? undefined,
		}, key);
		const next = { ...dates };
		let touched = false;
		if (t.completionDate !== undefined) { next.completionDate = t.completionDate; touched = true; }
		if (t.cancelledDate !== undefined) { next.cancelledDate = t.cancelledDate; touched = true; }
		if (touched) {
			setDates(next);
			if (isEdit) setDatesChanged(true);
		}
	};

	const setDate = (key: string, d: Date | null) => {
		setDates((prev) => ({ ...prev, [key]: d }));
		if (isEdit) setDatesChanged(true);
	};

	/**
	 * 完成 / 取消日期与状态双向联动：直接填完成日期 = 标记完成（并清掉取消日期），
	 * 清空完成日期而状态仍是完成 = 退回待办；取消日期同理。改状态时日期已由 pickStatus 写入 / 清除
	 */
	const setStatusDate = (key: 'completionDate' | 'cancelledDate', d: Date | null) => {
		const linked = key === 'completionDate' ? 'done' : 'canceled';
		const other = key === 'completionDate' ? 'cancelledDate' : 'completionDate';
		setDates((prev) => ({ ...prev, [key]: d, ...(d ? { [other]: null } : {}) }));
		if (isEdit) setDatesChanged(true);
		const nextStatus = d ? linked : (status === linked ? 'todo' : status);
		if (nextStatus !== status) {
			setStatus(nextStatus);
			if (isEdit) setStatusChanged(true);
		}
	};

	// ========== 保存逻辑 ==========
	const saveTask = async () => {
		if (mode === 'create') {
			if (!plugin) return;
			const desc = description.trim().replace(/[\r\n]+/g, ' ');
			if (!desc) {
				new Notice(i18n.t('modals.createTask.errorEmptyDescription'));
				descriptionRef.current?.focus();
				return;
			}
			if (kind === 'period' && dates.startDate && dates.dueDate && isDueBeforeStart(dates.startDate, dates.dueDate, datePrecision)) {
				new Notice(i18n.t('modals.createTask.errorStartDueOrder'));
				return;
			}
			if (kind === 'day' && slotStart && slotEnd && slotEnd <= slotStart) {
				new Notice(i18n.t('modals.task.errorSlotOrder'));
				return;
			}
			try {
				// 时间段：只写开始 / 截止；当日：⏳ 当天 + 行首时间前缀
				const slotPrefix = kind === 'day' ? slotPrefixOf(slotStart, slotEnd) : null;
				const scheduled = kind === 'day' ? (dates.scheduledDate ?? dayStartOf(targetDate ?? new Date())) : null;
				const taskData: CreateTaskData = {
					description: rewritePlannerPrefix(desc, slotPrefix),
					priority: priority === 'normal' ? undefined : priority,
					status: status !== 'todo' ? status : undefined,
					repeat: repeat || undefined,
					createdDate: dates.createdDate!,
					startDate: kind === 'period' ? dates.startDate : null,
					scheduledDate: scheduled,
					dueDate: kind === 'period' ? dates.dueDate : null,
					completionDate: dates.completionDate,
					cancelledDate: dates.cancelledDate,
					tags: selectedTags.length > 0 ? selectedTags : undefined,
					datePrecision: Object.keys(datePrecision).length > 0 ? datePrecision : undefined,
				};
				let targetFilePath: string | null;
				if (createAt) {
					targetFilePath = await createTaskAtLine(app, createAt, taskData);
					if (!targetFilePath) {
						new Notice(i18n.t('modals.createTask.errorNoFile'));
						return;
					}
				} else if (createTarget === 'daily') {
					targetFilePath = await createTaskInDailyNote(app, taskData, plugin.settings, plugin.dailyNoteIndex);
				} else {
					const path = createTarget === 'other' ? otherPath.trim() : createTarget;
					targetFilePath = await createTaskInFile(app, path, taskData);
					if (!targetFilePath) {
						new Notice(i18n.t('modals.createTask.errorNoFile'));
						return;
					}
				}
				// 写回后立即刷新缓存并推送数据，跳过文件事件防抖回流
				if (targetFilePath && plugin.taskCache) {
					await plugin.taskCache.refreshFile(targetFilePath);
					const { useCalendarStore } = await import('../store/calendarStore');
					useCalendarStore.getState().notifyTasksUpdated(
						plugin.taskCache.getAllTasks(), targetFilePath
					);
				}
				new Notice(i18n.t('modals.createTask.success'));
				onSuccess();
				handleClose();
			} catch (error) {
				Logger.error('CreateTaskModal', 'Error creating task:', error);
				new Notice(i18n.t('modals.createTask.error', { error: (error as Error).message }));
			}
			return;
		}

		// 编辑模式
		if (!task) return;
		if (kind === 'period' && dates.startDate && dates.dueDate && isDueBeforeStart(dates.startDate, dates.dueDate, datePrecision)) {
			new Notice(i18n.t('modals.editTask.errorStartDueOrder'));
			return;
		}
		if (kind === 'day' && slotStart && slotEnd && slotEnd <= slotStart) {
			new Notice(i18n.t('modals.task.errorSlotOrder'));
			return;
		}
		try {
			const updates: TaskUpdates = {};
			if (priorityChanged) updates.priority = priority;
			if (statusChanged) {
				const t = statusTransitionUpdates(task, status);
				updates.status = t.status;
				updates.completed = t.completed;
				updates.cancelled = t.cancelled;
			}
			if (repeatChanged) updates.repeat = repeat;
			// 时间片：⏳ 当日 + 行首时间前缀。旧写法（起止 / ⏳ 上带时刻）打开时已读成时间片，保存即迁移。
			// 切换了任务类型 = 转换：时间段 → 当日 清掉起止；当日 → 时间段 清掉 ⏳ 与时刻。
			// 没切换时另一类的字段原样保留（同一任务可以既有日期区间又有时间片）
			const initialPrefix = slotPrefixOf(initialSlot.start, initialSlot.end);
			let slotPrefix: string | null;
			let startDate = dates.startDate;
			let dueDate = dates.dueDate;
			let scheduledDate = dates.scheduledDate;
			if (kind === 'day') {
				slotPrefix = slotPrefixOf(slotStart, slotEnd);
				scheduledDate = dates.scheduledDate ?? dayStartOf(new Date());
				// 转换，或旧写法里与时间片同一天的起止（它们只是时刻的旧载体）：起止去掉
				const legacySameDay = initialSlot.legacy && !!initialSlot.day
					&& (!startDate || sameDay(startDate, initialSlot.day)) && (!dueDate || sameDay(dueDate, initialSlot.day));
				if (kindChanged || legacySameDay) {
					startDate = null;
					dueDate = null;
				}
			} else {
				slotPrefix = kindChanged ? null : initialPrefix;
				if (kindChanged) scheduledDate = null;
			}
			const hasTimedDates = (['startDate', 'dueDate', 'scheduledDate'] as const).some((f) => task.datePrecision?.[f] === 'time');
			const slotChanged = hasTimedDates || initialSlot.legacy || slotChangedByUser || kindChanged;
			const writeDates = datesChanged || slotChanged;
			if (writeDates) {
				updates.createdDate = dates.createdDate;
				updates.startDate = startDate;
				updates.scheduledDate = scheduledDate;
				updates.dueDate = dueDate;
				updates.completionDate = dates.completionDate;
				updates.cancelledDate = dates.cancelledDate;
			}
			if (contentChanged || slotChanged) updates.content = rewritePlannerPrefix(description, slotPrefix);
			if (tagsChanged) updates.tags = selectedTags;

			if (Object.keys(updates).length === 0) {
				handleClose();
				return;
			}
			// 日期精度变化时传入浅拷贝，不变异 store 中的共享任务对象
			const taskToUpdate = writeDates
				? { ...task, datePrecision: { ...datePrecision } }
				: task;
			await updateTaskProperties(app, taskToUpdate, updates, enabledFormats || []);
			if (plugin?.taskCache) {
				await plugin.taskCache.refreshFile(taskToUpdate.filePath);
				const { useCalendarStore } = await import('../store/calendarStore');
				useCalendarStore.getState().notifyTasksUpdated(
					plugin.taskCache.getAllTasks(), taskToUpdate.filePath
				);
			}
			onSuccess();
			handleClose();
			new Notice(i18n.t('modals.editTask.success'));
		} catch (err) {
			Logger.error('editTask', 'Failed to update task', err);
			new Notice(i18n.t('modals.editTask.error'));
		}
	};

	// 编辑模式的标签推荐：通过 Obsidian 内部 API 获取所有任务
	const allTasksForTags = useMemo(() => {
		if (mode === 'create') {
			return plugin?.taskCache.getAllTasks() || [];
		}
		const internal = (app as unknown as Record<string, Record<string, Record<string, unknown>>>).plugins
			?.plugins?.['gantt-calendar'] as { taskCache?: { getAllTasks: () => GCTask[] } } | undefined;
		return internal?.taskCache?.getAllTasks() || [];
	}, [mode, plugin, app]);

	// 「时间」行的摘要（选择器收在弹层里，切换类型时弹窗高度不变、控件不移动）
	// 「时间」面板的值与回写：严格对应 Tasks 字段（时间段 🛫/📅，当日 ⏳ + 时间前缀）
	const timeFormat: TimeFormat = (plugin?.settings.timeFormat
		?? (app as unknown as { plugins?: { plugins?: Record<string, { settings?: { timeFormat?: TimeFormat } }> } }).plugins?.plugins?.['gantt-calendar']?.settings?.timeFormat)
		?? '24h';
	const whenValue: WhenValue = {
		kind,
		start: dates.startDate ?? null,
		due: dates.dueDate ?? null,
		scheduled: dates.scheduledDate ?? null,
		timeStart: slotStart,
		timeEnd: slotEnd,
	};
	const applyWhen = (v: WhenValue) => {
		setKind(v.kind);
		if (v.start !== whenValue.start || v.due !== whenValue.due || v.scheduled !== whenValue.scheduled) {
			setDates((prev) => ({ ...prev, startDate: v.start, dueDate: v.due, scheduledDate: v.scheduled }));
			if (isEdit) setDatesChanged(true);
		}
		if (v.timeStart !== slotStart || v.timeEnd !== slotEnd) {
			setSlotStart(v.timeStart);
			setSlotEnd(v.timeEnd);
			setSlotChangedByUser(true);
		}
	};
	// 摘要：Nov 10 → Nov 14 · 5 days / Due Nov 14 / Fri, Nov 13 · 14:00–16:00 · 2 h
	const fmtDay = (d: Date) => window.moment(d).format(i18n.t('modals.task.summaryDateFormat'));
	const whenSummary = (() => {
		if (kind === 'period') {
			const { startDate: st, dueDate: du } = dates;
			if (st && du) {
				const n = Math.round((dayStartOf(du).getTime() - dayStartOf(st).getTime()) / 86400000) + 1;
				return n > 1 ? `${fmtDay(st)} → ${fmtDay(du)} · ${i18n.t('modals.when.days', { count: n })}` : fmtDay(st);
			}
			if (du) return i18n.t('modals.when.summaryDue', { date: fmtDay(du) });
			if (st) return i18n.t('modals.when.summaryStart', { date: fmtDay(st) });
			return i18n.t('modals.task.notSet');
		}
		if (!dates.scheduledDate && !slotStart) return i18n.t('modals.task.notSet');
		const day = window.moment(dates.scheduledDate ?? new Date()).format(i18n.t('modals.when.previewFormat'));
		if (!slotStart) return `${day} · ${i18n.t('modals.task.allDay')}`;
		const sMin = hmToMin(slotStart);
		const eMin = hmToMin(slotEnd);
		const range = slotEnd ? `${formatHm(slotStart, timeFormat)}–${formatHm(slotEnd, timeFormat)}` : formatHm(slotStart, timeFormat);
		const len = sMin !== null && eMin !== null && eMin > sMin ? ` · ${formatDuration(eMin - sMin)}` : '';
		return `${day} · ${range}${len}`;
	})();

	// 分段控件里 ◽ 几乎看不见，普通优先级用短横表示
	const priorityIcon = (v: PriorityOption['value']) => (v === 'normal' ? '–' : priorityOptions.find((o) => o.value === v)?.icon ?? '');

	return (
		<Modal open={open} onClose={handleClose} onExited={onClose} title={title} width={600} className={ModalClasses.overlayTop}>
			<div className={EditTaskModalClasses.block}>
				<div className={EditTaskModalClasses.elements.scrollContainer}>
					{/* 描述：原生 Live Preview 编辑器，作为弹窗的主角 */}
					{!isEdit || allowEditContent ? (
						<div className={EditTaskModalClasses.elements.descContainer}>
							<DescriptionEditor
								app={app}
								focusRef={descriptionRef}
								sourcePath={task?.filePath ?? createAt?.filePath}
								placeholder={i18n.t('modals.createTask.descriptionPlaceholder')}
								value={description}
								onChange={(v) => {
									setDescription(v);
									if (isEdit) setContentChanged(true);
								}}
								onSubmit={() => void saveTask()}
							/>
							<div className={EditTaskModalClasses.elements.sectionHint}>
								{isEdit ? i18n.t('modals.editTask.submitHint') : i18n.t('modals.createTask.submitHint')}
							</div>
						</div>
					) : null}

					{/* 属性列表：与 Obsidian 笔记属性面板同样的「图标 + 名称 | 值」排版 */}
					<div className={EditTaskModalClasses.elements.props}>
						<PropRow icon="circle-dot" label={i18n.t('modals.editTask.statusLabel')}>
							<div className={EditTaskModalClasses.elements.statusGrid}>
								{statuses.map(st => {
									const colors = getStatusColor(st.key, allStatuses, themeMode);
									return (
										<button
											key={st.key}
											type="button"
											className={[
												EditTaskModalClasses.elements.statusBtn,
												...(st.key === status ? [EditTaskModalClasses.elements.priorityBtnSelected] : []),
											].join(' ')}
											style={colors ? ({ '--status-bg': colors.bg, '--status-fg': colors.text } as CSSProperties) : undefined}
											data-value={st.key}
											title={`[${st.symbol}] ${st.description ?? ''}`}
											onClick={() => pickStatus(st.key)}
										>
											<span className={EditTaskModalClasses.elements.statusDot} />
											{st.name}
										</button>
									);
								})}
							</div>
						</PropRow>

						<PropRow icon="calendar-check" label={i18n.t('modals.task.statusDates')}>
							<div className={EditTaskModalClasses.elements.inlineDates}>
								<DateField
									label={i18n.t('modals.createTask.dateFields.completion')}
									current={dates.completionDate ?? null}
									onChange={(d) => setStatusDate('completionDate', d)}
								/>
								<DateField
									label={i18n.t('modals.createTask.dateFields.cancelled')}
									current={dates.cancelledDate ?? null}
									onChange={(d) => setStatusDate('cancelledDate', d)}
								/>
								<DateField
									label={i18n.t('modals.createTask.dateFields.created')}
									current={dates.createdDate ?? null}
									onChange={(d) => setDate('createdDate', d)}
								/>
							</div>
						</PropRow>

						<PropRow icon="flag" label={i18n.t('modals.editTask.priorityLabel')}>
							<div className={EditTaskModalClasses.elements.prioritySegments} role="radiogroup">
								{priorityOptions.map(option => (
									<button
										key={option.value}
										type="button"
										role="radio"
										aria-checked={option.value === priority}
										aria-label={option.label}
										title={option.label}
										className={[
											EditTaskModalClasses.elements.prioritySegment,
											...(option.value === priority ? [EditTaskModalClasses.elements.priorityBtnSelected] : []),
										].join(' ')}
										data-value={option.value}
										onClick={() => {
											setPriority(option.value);
											if (isEdit) setPriorityChanged(true);
										}}
									>
										<span>{priorityIcon(option.value)}</span>
									</button>
								))}
							</div>
							{/* 选中项名称放在分段控件外的固定位置：切换时按钮不改变宽度、不移动 */}
							<span className={EditTaskModalClasses.elements.priorityName}>
								{priorityOptions.find((o) => o.value === priority)?.label}
							</span>
						</PropRow>

						<PropRow icon="calendar-range" label={i18n.t('modals.task.when')}>
							<Popover
								width={368}
								trigger={({ toggle, open: popOpen, ref }) => (
									<button
										type="button"
										ref={ref}
										aria-expanded={popOpen}
										className={`${TaskKindClasses.elements.summary}${popOpen ? ` ${TaskKindClasses.modifiers.summaryOpen}` : ''}`}
										onClick={toggle}
									>
										<Icon icon={kind === 'period' ? 'calendar-range' : 'clock'} />
										<span className={TaskKindClasses.elements.summaryText}>{whenSummary}</span>
										{kindChanged && isEdit ? (
											<span className={TaskKindClasses.elements.summaryBadge} title={i18n.t(kind === 'day' ? 'modals.task.convertToDay' : 'modals.task.convertToPeriod')}>
												{i18n.t('modals.task.converting')}
											</span>
										) : null}
										<Icon icon="chevron-down" />
									</button>
								)}
							>
								{() => (
									<WhenPicker value={whenValue} onChange={applyWhen} timeFormat={timeFormat} />
								)}
							</Popover>
						</PropRow>

						<PropRow icon="repeat" label={i18n.t('modals.task.repeat')}>
							<RepeatSection
								value={repeat}
								onChange={(rule) => {
									setRepeat(rule);
									if (isEdit) setRepeatChanged(true);
								}}
								prefix={isEdit ? 'editTask' : 'createTask'}
							/>
						</PropRow>

						<PropRow icon="tags" label={i18n.t('modals.task.tags')}>
							<TagSelector
								allTasks={allTasksForTags}
								initialTags={selectedTags}
								onChange={(tags) => {
									setSelectedTags(tags);
									if (isEdit) setTagsChanged(true);
								}}
							/>
						</PropRow>

						{!isEdit && !createAt && (
							<PropRow icon="file-plus" label={i18n.t('modals.createTask.createIn')}>
								<div className={EditTaskModalClasses.elements.createTarget}>
									<select className="dropdown" value={createTarget} onChange={(e) => setCreateTarget(e.target.value)}>
										<option value="daily">{i18n.t('modals.createTask.createInDaily')}</option>
										{targetFileOptions.map((ft) => (
											<option key={ft.filePath} value={ft.filePath}>{ft.title}</option>
										))}
										<option value="other">{i18n.t('modals.createTask.createInOther')}</option>
									</select>
									{createTarget === 'other' && (
										<input
											ref={otherInputRef}
											type="text"
											value={otherPath}
											placeholder={i18n.t('modals.createTask.createInOtherPlaceholder')}
											onChange={(e) => setOtherPath(e.target.value)}
										/>
									)}
								</div>
							</PropRow>
						)}
					</div>
				</div>

				{/* 操作按钮（固定在底部） */}
				<div className={EditTaskModalClasses.elements.buttons}>
					{isEdit && task ? (
						<span className={EditTaskModalClasses.elements.footerMeta} title={task.filePath}>
							{`${task.fileName}:${task.lineNumber}`}
						</span>
					) : null}
					<button type="button" onClick={handleClose}>{i18n.t('common.cancel')}</button>
					<button type="button" className="mod-cta" onClick={() => void saveTask()}>
						{saveText}
					</button>
				</div>
			</div>
		</Modal>
	);
}

// ==================== 属性行 ====================

function PropRow({ icon, label, children }: { icon: string; label: string; children: ReactNode }): JSX.Element {
	return (
		<div className={EditTaskModalClasses.elements.propRow}>
			<div className={EditTaskModalClasses.elements.propLabel}>
				<Icon icon={icon} />
				<span>{label}</span>
			</div>
			<div className={EditTaskModalClasses.elements.propValue}>{children}</div>
		</div>
	);
}

// ==================== 日期字段（Linear 风格日期时间选择器） ====================

interface DateFieldProps {
	label: string;
	current: Date | null;
	onChange: (d: Date | null) => void;
}

function DateField({ label, current, onChange }: DateFieldProps): JSX.Element {
	return (
		<div className={EditTaskModalClasses.elements.dateItem}>
			<label className={EditTaskModalClasses.elements.dateLabel}>{label}</label>
			<div className={EditTaskModalClasses.elements.dateInputContainer}>
				<DateTimePicker
					value={current}
					placeholder={i18n.t('modals.editTask.datePlaceholder')}
					dateOnly
					onChange={onChange}
				/>
			</div>
		</div>
	);
}

// ==================== 命令式 API（兼容旧调用方） ====================

/**
 * 打开创建任务弹窗（命令式，兼容旧 new CreateTaskModal().open()）
 */
export function openCreateTaskModal(options: {
	app: App;
	plugin: IPluginContext;
	targetDate?: Date;
	targetHour?: number;
	targetMinute?: number;
	targetRange?: { start: Date; end: Date };
	createAt?: CreateAtLine;
	initialDescription?: string;
	onSuccess: () => void;
}): void {
	const close = openReactModal(
		<TaskFormModal
			mode="create"
			app={options.app}
			plugin={options.plugin}
			createAt={options.createAt}
			initialDescription={options.initialDescription}
			targetDate={options.targetDate}
			targetHour={options.targetHour}
			targetMinute={options.targetMinute}
			targetRange={options.targetRange}
			onSuccess={options.onSuccess}
			onClose={() => close()}
		/>
	);
}

/**
 * 打开编辑任务弹窗（命令式，兼容旧 openEditTaskModal()）
 */
export function openEditTaskModal(
	app: App,
	task: GCTask,
	enabledFormats: string[],
	onSuccess: () => void,
	allowEditContent?: boolean
): void {
	const close = openReactModal(
		<TaskFormModal
			mode="edit"
			app={app}
			task={unwrapTask(task)}
			enabledFormats={enabledFormats}
			allowEditContent={allowEditContent}
			onSuccess={onSuccess}
			onClose={() => close()}
		/>
	);
}

/** 导出类型（兼容旧 re-export） */
export type { RepeatConfig } from '../../utils/repeatRules';