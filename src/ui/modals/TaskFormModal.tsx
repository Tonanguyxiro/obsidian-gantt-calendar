import { useCallback,  useEffect, useMemo, useRef, useState, type CSSProperties, type JSX  } from 'react';
import { unwrapTask } from '../../tasks/scheduledFallback';
import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { GCTask, IPluginContext } from '../../types';
import type { CreateTaskData } from '../../utils/dailyNoteHelper';
import { createTaskInDailyNote } from '../../utils/dailyNoteHelper';
import type { TaskUpdates } from '../../tasks/taskSerializer';
import { updateTaskProperties } from '../../tasks/taskUpdater';
import { Logger } from '../../utils/logger';
import { i18n } from '../../i18n/i18n';
import { EditTaskModalClasses } from '../../utils/bem';
import { Modal } from '../components/Modal';
import { TagSelector } from './TagSelector';
import { RepeatSection } from './RepeatSection';
import { DateTimePicker } from '../components/DateTimePicker';
import { DescriptionEditor } from '../components/DescriptionEditor';
import { statusTransitionUpdates, getConfiguredStatuses, getPickerStatuses } from '../../tasks/statusTransition';
import { legacyDaySlot, rewritePlannerPrefix } from '../../tasks/scheduledFallback';
import { stripPlannerTime } from '../../tasks/taskParser/utils';
import { getStatusColor, getCurrentThemeMode } from '../../tasks/taskStatus';
import { openReactModal } from './modalHost';

/**
 * 优先级选项
 */
export interface PriorityOption {
	value: 'highest' | 'high' | 'medium' | 'normal' | 'low' | 'lowest';
	label: string;
	icon: string;
}

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

function getDateFields(): DateFieldDef[] {
	return [
		{ key: 'createdDate', label: i18n.t('modals.createTask.dateFields.created') },
		{ key: 'startDate', label: i18n.t('modals.createTask.dateFields.start') },
		{ key: 'scheduledDate', label: i18n.t('modals.createTask.dateFields.scheduled') },
		{ key: 'dueDate', label: i18n.t('modals.createTask.dateFields.due') },
		{ key: 'completionDate', label: i18n.t('modals.createTask.dateFields.completion') },
		{ key: 'cancelledDate', label: i18n.t('modals.createTask.dateFields.cancelled') },
	];
}

/** 日期字段定义 */
interface DateFieldDef {
	key: string;
	label: string;
}

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
	onSuccess,
	onClose,
}: TaskFormModalProps): JSX.Element {
	const [open, setOpen] = useState(true);
	const priorityOptions = useMemo(getPriorityOptions, []);
	const dateFields = useMemo(getDateFields, []);

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
	const [selectedTags, setSelectedTags] = useState<string[]>(mode === 'edit' ? (task?.tags || []) : []);
	// 描述不含行首时间前缀：时刻由下方「时间片」管理，保存时再写回前缀
	const [description, setDescription] = useState(mode === 'edit' ? stripPlannerTime(task?.description || '').trim() : '');
	// 一天中的具体时间只在时间线里拖动安排；弹窗不提供时刻选项，保存时原样保留已有的时间片（⏳ + 行首时间前缀）
	const slotStart = initialSlot.start;
	const slotEnd = initialSlot.end;
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
			if (dates.createdDate && dates.dueDate && dates.createdDate > dates.dueDate) {
				new Notice(i18n.t('modals.createTask.errorDateOrder'));
				return;
			}
			if (dates.startDate && dates.dueDate && isDueBeforeStart(dates.startDate, dates.dueDate, datePrecision)) {
				new Notice(i18n.t('modals.createTask.errorStartDueOrder'));
				return;
			}
			try {
				// 时间片：⏳ 当日 + 行首时间前缀；只填了时刻没填计划日期时，落到截止 / 开始日（都没有则今天）
				const slotPrefix = slotPrefixOf(slotStart, slotEnd);
				const scheduled = dates.scheduledDate ?? (slotPrefix ? (dates.dueDate ?? dates.startDate ?? dayStartOf(new Date())) : null);
				const taskData: CreateTaskData = {
					description: rewritePlannerPrefix(desc, slotPrefix),
					priority: priority === 'normal' ? undefined : priority,
					status: status !== 'todo' ? status : undefined,
					repeat: repeat || undefined,
					createdDate: dates.createdDate!,
					startDate: dates.startDate,
					scheduledDate: scheduled,
					dueDate: dates.dueDate!,
					completionDate: dates.completionDate,
					cancelledDate: dates.cancelledDate,
					tags: selectedTags.length > 0 ? selectedTags : undefined,
					datePrecision: Object.keys(datePrecision).length > 0 ? datePrecision : undefined,
				};
				const targetFilePath = await createTaskInDailyNote(app, taskData, plugin.settings, plugin.dailyNoteIndex);
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
		if (dates.startDate && dates.dueDate && isDueBeforeStart(dates.startDate, dates.dueDate, datePrecision)) {
			new Notice(i18n.t('modals.editTask.errorStartDueOrder'));
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
			// 时间片：⏳ 当日 + 行首时间前缀。旧写法（起止 / ⏳ 上带时刻）打开时已读成时间片，保存即迁移
			const slotPrefix = slotPrefixOf(slotStart, slotEnd);
			const hasTimedDates = (['startDate', 'dueDate', 'scheduledDate'] as const).some((f) => task.datePrecision?.[f] === 'time');
			const slotChanged = hasTimedDates || initialSlot.legacy;
			const writeDates = datesChanged || slotChanged;
			if (writeDates) {
				updates.createdDate = dates.createdDate;
				updates.startDate = dates.startDate;
				updates.scheduledDate = dates.scheduledDate ?? (slotPrefix ? (dates.dueDate ?? dates.startDate ?? dayStartOf(new Date())) : null);
				updates.dueDate = dates.dueDate;
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

	return (
		<Modal open={open} onClose={handleClose} onExited={onClose} title={title} width={560}>
			<div className={EditTaskModalClasses.block}>
				{/* 滚动容器 */}
				<div className={EditTaskModalClasses.elements.scrollContainer}>
					{/* 1. 任务描述板块（编辑模式仅在允许时显示） */}
					{!isEdit || allowEditContent ? (
						<div className={EditTaskModalClasses.elements.section}>
							<div className={EditTaskModalClasses.elements.descContainer}>
								<label className={EditTaskModalClasses.elements.sectionLabel}>
									{isEdit ? i18n.t('modals.editTask.descriptionLabel') : i18n.t('modals.createTask.descriptionLabel')}
								</label>
								<div className={EditTaskModalClasses.elements.sectionHint}>
									{isEdit ? i18n.t('modals.editTask.submitHint') : i18n.t('modals.createTask.submitHint')}
								</div>
								<DescriptionEditor
									app={app}
									focusRef={descriptionRef}
									sourcePath={task?.filePath}
									placeholder={isEdit ? undefined : i18n.t('modals.createTask.descriptionPlaceholder')}
									value={description}
									onChange={(v) => {
										setDescription(v);
										if (isEdit) setContentChanged(true);
									}}
									onSubmit={() => void saveTask()}
								/>
							</div>
						</div>
					) : null}

					{/* 2. 优先级板块 */}
					<div className={EditTaskModalClasses.elements.section}>
						<div className={EditTaskModalClasses.elements.priorityContainer}>
							<label className={EditTaskModalClasses.elements.sectionLabel}>
								{i18n.t('modals.editTask.priorityLabel')}
							</label>
							<div className={EditTaskModalClasses.elements.priorityGrid}>
								{priorityOptions.map(option => (
									<button
										key={option.value}
										className={[
											EditTaskModalClasses.elements.priorityBtn,
											...(option.value === priority ? [EditTaskModalClasses.elements.priorityBtnSelected] : []),
										].join(' ')}
										data-value={option.value}
										onClick={() => {
											setPriority(option.value);
											if (isEdit) setPriorityChanged(true);
										}}
									>
										{`${option.icon} ${option.label}`}
									</button>
								))}
							</div>
						</div>
					</div>

					{/* 状态板块：设置里配置的全部状态 */}
					<div className={EditTaskModalClasses.elements.section}>
						<div className={EditTaskModalClasses.elements.priorityContainer}>
							<label className={EditTaskModalClasses.elements.sectionLabel}>
								{i18n.t('modals.editTask.statusLabel')}
							</label>
							<div className={EditTaskModalClasses.elements.statusGrid}>
								{statuses.map(st => {
									const colors = getStatusColor(st.key, allStatuses, themeMode);
									return (
										<button
											key={st.key}
											className={[
												EditTaskModalClasses.elements.priorityBtn,
												EditTaskModalClasses.elements.statusBtn,
												...(st.key === status ? [EditTaskModalClasses.elements.priorityBtnSelected] : []),
											].join(' ')}
											style={colors ? ({ '--status-bg': colors.bg, '--status-fg': colors.text } as CSSProperties) : undefined}
											data-value={st.key}
											title={st.description}
											onClick={() => pickStatus(st.key)}
										>
											{`${st.key === status ? '✓ ' : ''}[${st.symbol}] ${st.name}`}
										</button>
									);
								})}
							</div>
						</div>
					</div>

					{/* 3. 时间设置板块 */}
					<div className={EditTaskModalClasses.elements.section}>
						<div className={EditTaskModalClasses.elements.datesContainer}>
							<label className={EditTaskModalClasses.elements.sectionLabel}>
								{i18n.t('modals.editTask.datesLabel')}
							</label>
							<div className={EditTaskModalClasses.elements.datesGrid}>
								{dateFields.map(field => (
									<DateField
										key={field.key}
										label={field.label}
										current={dates[field.key] ?? null}
										onChange={(d) => {
											setDates((prev) => ({ ...prev, [field.key]: d }));
											if (isEdit) setDatesChanged(true);
										}}
									/>
								))}
							</div>
						</div>
					</div>

					{/* 3.5. 周期设置板块 */}
					<div className={EditTaskModalClasses.elements.section} style={{ marginBottom: '20px' }}>
						<RepeatSection
							value={repeat}
							onChange={(rule) => {
								setRepeat(rule);
								if (isEdit) setRepeatChanged(true);
							}}
							prefix={isEdit ? 'editTask' : 'createTask'}
						/>
					</div>

					{/* 4. 标签选择器 */}
					<div className={EditTaskModalClasses.elements.section} style={{ marginBottom: '20px' }}>
						<div className={EditTaskModalClasses.elements.tagsSection}>
							<TagSelector
								allTasks={allTasksForTags}
								initialTags={selectedTags}
								onChange={(tags) => {
									setSelectedTags(tags);
									if (isEdit) setTagsChanged(true);
								}}
							/>
						</div>
					</div>
				</div>

				{/* 操作按钮 */}
				<div className={EditTaskModalClasses.elements.buttons}>
					<button onClick={handleClose}>{i18n.t('common.cancel')}</button>
					<button className="mod-cta" onClick={() => void saveTask()}>
						{saveText}
					</button>
				</div>
			</div>
		</Modal>
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
	onSuccess: () => void;
}): void {
	const close = openReactModal(
		<TaskFormModal
			mode="create"
			app={options.app}
			plugin={options.plugin}
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