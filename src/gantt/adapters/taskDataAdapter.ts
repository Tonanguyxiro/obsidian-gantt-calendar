import { i18n } from '../../i18n/i18n';
/**
 * 任务数据适配器
 * 将插件的 GCTask 格式转换为 甘特图格式
 */

import type { GCTask } from '../../types';
import { getTaskDateField } from '../../types';
import { buildIntervalTimeLabel } from '../../ui/views/week/timelineModel';
import type { GanttChartTask, DateFieldType } from '../types';
import type { StatusFilterState } from '../../types';
import { taskDisplayText } from '../../utils/linkText';

/**
 * 任务数据适配器
 */
export class TaskDataAdapter {
	/**
	 * 转换单个任务为 甘特图格式
	 *
	 * @param task - 原始任务对象
	 * @param startField - 开始时间字段
	 * @param endField - 结束时间字段
	 * @returns 甘特图任务对象，如果缺少必要字段则返回 null
	 */
	static toGanttChartTask(
		task: GCTask,
		startField: DateFieldType,
		endField: DateFieldType,
		id?: string
	): GanttChartTask | null {
		let startDate: Date;
		let normalizedEndDate: Date;
		let leadStart: string | undefined;
		let startSourceField: DateFieldType = startField;
		let timeLabel: string | undefined;
		let datePrecision = task.datePrecision;
		let scheduledProxy = task.scheduledProxy;

		if (this.isScheduledOnlySingleDay(task, startField, endField)) {
			const scheduledDate = task.scheduledDate as Date;
			const isScheduledTimed = task.datePrecision?.scheduledDate === 'time';
			startDate = scheduledDate;
			normalizedEndDate = scheduledDate;
			leadStart = undefined;
			startSourceField = 'scheduledDate';
			timeLabel = buildIntervalTimeLabel(scheduledDate, scheduledDate, isScheduledTimed, isScheduledTimed);
			if (!scheduledProxy) {
				scheduledProxy = { source: task, startField, endField, dateField: endField };
				if (isScheduledTimed) {
					datePrecision = { ...task.datePrecision, [endField]: 'time' };
				}
			}
		} else {
			const endDate = getTaskDateField(task, endField);

			// End field is always required.
			if (!this.isValidDate(endDate)) {
				return null;
			}

			// Start resolution: the configured field first, then the two supported
			// fallbacks. createdDate and startDate are both valid Gantt start points,
			// so a task is renderable when ANY candidate exists plus the end field.
			const startCandidates: DateFieldType[] = startField === 'createdDate'
				? [startField, 'startDate']
				: startField === 'startDate'
					? [startField, 'createdDate']
					: [startField, 'createdDate', 'startDate'];

			let resolvedStart: Date | undefined;
			for (const candidate of startCandidates) {
				const value = getTaskDateField(task, candidate);
				if (this.isValidDate(value)) {
					resolvedStart = value;
					startSourceField = candidate;
					break;
				}
			}
			if (!resolvedStart) {
				return null;
			}

			startDate = resolvedStart;
			// 确保结束日期不早于开始日期
			normalizedEndDate = endDate < startDate ? startDate : endDate;

			// Lead-in segment: creation → effective start, drawn in a distinct
			// muted color when both dates exist and creation precedes the start.
			const createdDate = task.createdDate;
			leadStart = (this.isValidDate(createdDate) && createdDate < startDate)
				? this.formatDate(createdDate)
				: undefined;

			timeLabel = buildIntervalTimeLabel(
				startDate,
				normalizedEndDate,
				task.datePrecision?.[startField] === 'time',
				task.datePrecision?.[endField] === 'time',
			);
		}

		return {
			id: id ?? this.generateTaskId(task),
			name: taskDisplayText(task.description) || i18n.t('common.untitledTask'),
			timeLabel,
			start: this.formatDate(startDate),
			end: this.formatDate(normalizedEndDate),
			leadStart,
			startSourceField,
			progress: this.calculateProgress(task),
			custom_class: this.getCustomClass(task),

			// 保存原始任务信息，避免后续查找
			completed: task.completed,
			cancelled: task.cancelled,
			filePath: task.filePath,
			fileName: task.fileName,
			lineNumber: task.lineNumber,

			// 完整任务信息（用于更新时保留原始数据）
			content: task.content,
			description: task.description,
			tags: task.tags,
			priority: task.priority,
			format: task.format,
			status: task.status,
			createdDate: task.createdDate,
			startDate: task.startDate,
			scheduledDate: task.scheduledDate,
			dueDate: task.dueDate,
			cancelledDate: task.cancelledDate,
			completionDate: task.completionDate,
			repeat: task.repeat,
			datePrecision,
			metadataFields: task.metadataFields,
			plannerTime: task.plannerTime,
			scheduledProxy,
		};
	}

	private static isValidDate(value: Date | undefined): value is Date {
		return !!value && !isNaN(value.getTime());
	}

	/** 仅含 ⏳ 计划日期（无 Day Planner 时间前缀，非时段/旧写法代理）的甘特单日条判定 */
	private static isScheduledOnlySingleDay(
		task: GCTask,
		startField: DateFieldType,
		endField: DateFieldType,
	): boolean {
		if (!this.isValidDate(task.scheduledDate) || task.plannerTime) {
			return false;
		}
		if (task.scheduledProxy) {
			return !task.scheduledProxy.slot && !task.scheduledProxy.legacy;
		}
		const hasStart = this.isValidDate(getTaskDateField(task, startField));
		const hasEnd = this.isValidDate(getTaskDateField(task, endField));
		return !hasStart && !hasEnd;
	}

	/**
	 * 批量转换任务列表
	 *
	 * @param tasks - 原始任务列表
	 * @param startField - 开始时间字段
	 * @param endField - 结束时间字段
	 * @returns 甘特图任务数组
	 */
	static toGanttChartTasks(
		tasks: GCTask[],
		startField: DateFieldType,
		endField: DateFieldType
	): GanttChartTask[] {
		// Uniqueness must be decided over tasks that pass field validation, so convert first,
		// then append an occurrence suffix only when a duplicate id appears (e.g. recurring
		// virtual instances). Regular tasks keep a fully stable id across inserts/sorts.
		const results: GanttChartTask[] = [];
		const seenIds = new Map<string, number>();
		for (const task of tasks) {
			const converted = this.toGanttChartTask(task, startField, endField);
			if (!converted) continue;

			const occurrence = (seenIds.get(converted.id) ?? 0) + 1;
			seenIds.set(converted.id, occurrence);
			if (occurrence > 1) {
				converted.id = `${converted.id}#${occurrence}`;
			}
			results.push(converted);
		}
		return results;
	}

	/**
	 * 生成唯一任务ID
	 *
	 * 格式: `{fileName}-{lineNumber}-{pathHash}`
	 *
	 * @param task - 原始任务对象
	 * @returns 唯一任务ID
	 */
	private static generateTaskId(task: GCTask): string {
		// 移除文件扩展名并替换特殊字符
		const sanitizedName = task.fileName.replace(/\.md$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
		// Same-named files in different folders are disambiguated by a short path hash
		const pathHash = this.hashString(task.filePath);
		return `${sanitizedName}-${task.lineNumber}-${pathHash}`;
	}

	/**
	 * Deterministic string hash (djb2 variant, base36 output).
	 * Only used to build a short stable path fingerprint; not cryptographic.
	 */
	private static hashString(input: string): string {
		let hash = 5381;
		for (let i = 0; i < input.length; i++) {
			hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
		}
		return (hash >>> 0).toString(36);
	}

	/**
	 * 格式化日期为 YYYY-MM-DD
	 *
	 * @param date - 日期对象
	 * @returns 格式化的日期字符串
	 */
	private static formatDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	/**
	 * 计算任务进度百分比
	 *
	 * @param task - 任务对象
	 * @returns 进度百分比 (0-100)
	 */
	private static calculateProgress(task: GCTask): number {
		if (task.completed) return 100;
		if (task.cancelled) return 0;

		// 可根据更多条件计算进度
		return 0;
	}

	/**
	 * 根据任务状态生成自定义CSS类名
	 *
	 * @param task - 任务对象
	 * @returns CSS类名
	 */
	private static getCustomClass(task: GCTask): string {
		const classes: string[] = [];

		// 完成状态
		if (task.completed) {
			classes.push('task-completed');
		}

		// 取消状态
		if (task.cancelled) {
			classes.push('task-cancelled');
		}

		// 优先级
		if (task.priority) {
			classes.push(`priority-${task.priority}`);
		}

		// 自定义状态
		if (task.status) {
			classes.push(`status-${this.sanitizeClassName(task.status)}`);
		}

		return classes.join(' ');
	}

	/**
	 * 清理类名中的特殊字符
	 *
	 * @param name - 原始名称
	 * @returns 清理后的类名
	 */
	private static sanitizeClassName(name: string): string {
		return name.toLowerCase().replace(/[^a-z0-9]/g, '-');
	}

	/**
	 * 应用筛选条件到任务列表
	 *
	 * @param tasks - 原始任务列表
	 * @param statusFilter - 状态筛选条件
	 * @param selectedTags - 选中的标签列表
	 * @param tagOperator - 标签组合方式 (AND/OR/NOT)
	 * @returns 筛选后的任务列表
	 */
	static applyFilters(
		tasks: GCTask[],
		statusFilter: StatusFilterState,
		selectedTags: string[] = [],
		tagOperator: 'AND' | 'OR' | 'NOT' = 'OR'
	): GCTask[] {
		let filtered = tasks;

		// 状态筛选（支持多选）
		if (statusFilter.selectedStatuses.length > 0) {
			filtered = filtered.filter(task => {
				const taskStatus = task.status || TaskDataAdapter.getInferredStatus(task);
				return statusFilter.selectedStatuses.includes(taskStatus);
			});
		}

		// 标签筛选（大小写不敏感匹配）
		if (selectedTags.length > 0) {
			// 将选中的标签转换为小写，用于大小写不敏感匹配
			const selectedTagsLower = selectedTags.map(tag => tag.toLowerCase());

			filtered = filtered.filter(task => {
				// 对于没有标签的任务
				if (!task.tags || task.tags.length === 0) {
					if (tagOperator === 'NOT') {
						return true;  // NOT 模式：保留没有标签的任务
					} else {
						return false;  // AND/OR 模式：过滤掉没有标签的任务
					}
				}

				// 将任务标签转换为小写用于匹配
				const taskTagsLower = task.tags.map(tag => tag.toLowerCase());

				if (tagOperator === 'AND') {
					return selectedTagsLower.every(tag => taskTagsLower.includes(tag));
				} else if (tagOperator === 'OR') {
					return selectedTagsLower.some(tag => taskTagsLower.includes(tag));
				} else {
					// NOT: 排除包含任一选中标签的任务
					return !selectedTagsLower.some(tag => taskTagsLower.includes(tag));
				}
			});
		}

		return filtered;
	}

	/**
	 * 根据时间颗粒度调整日期（仅支持周视图）
	 *
	 * @param date - 原始日期
	 * @returns 调整后的日期
	 */
	static adjustDateByGranularity(date: Date): Date {
		const adjusted = new Date(date);
		// 按天对齐
		adjusted.setHours(0, 0, 0, 0);
		return adjusted;
	}

	/**
	 * 推断任务状态（当任务没有明确的 status 字段时）
	 */
	private static getInferredStatus(task: GCTask): string {
		if (task.completed) return 'done';
		if (task.cancelled) return 'canceled';
		return 'todo';
	}
}