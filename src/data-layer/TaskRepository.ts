/**
 * TaskRepository - 任务仓库
 *
 * 任务仓库是数据层的核心组件，负责：
 * - 管理数据源
 * - 维护任务缓存
 * - 提供高性能查询接口
 * - 处理数据源变化事件
 *
 * 设计模式：仓库模式（Repository Pattern）
 * 直接使用 GCTask 作为内部格式，避免无意义的转换。
 */

import { EventBus } from './EventBus';
import type { GCTask } from '../types';
import {
	DataSourceChanges,
	Priority,
	QueryOptions
} from './types';
import { IDataSource } from './IDataSource';
import { Logger } from '../utils/logger';

/**
 * 生成任务ID
 */
function generateTaskId(task: GCTask): string {
	return `${task.filePath}:${task.lineNumber}`;
}

const TASK_DATE_FIELDS = [
	'createdDate',
	'startDate',
	'scheduledDate',
	'dueDate',
	'completionDate',
	'cancelledDate',
] as const;

const MAX_BUCKET_SPAN_DAYS = 62;
const FULL_BUCKET_SCAN_THRESHOLD_DAYS = 4000;

function isValidDateValue(d: unknown): d is Date {
	return !!d && typeof (d as Date).getTime === 'function' && !Number.isNaN((d as Date).getTime());
}

function toLocalDayKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function localDaySerial(d: Date): number {
	return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

export class TaskRepository {
	private dataSources: Map<string, IDataSource> = new Map();
	private taskCache: Map<string, GCTask> = new Map();
	private fileIndex: Map<string, Set<string>> = new Map();
	/** 按本地 'YYYY-MM-DD' 分桶的任务 ID 索引 */
	private dateBuckets: Map<string, Set<string>> = new Map();
	/** taskId -> 已写入 dateBuckets 的日期键（更新/删除时精准清理） */
	private taskBucketKeys: Map<string, string[]> = new Map();
	/** 跨度超过 62 天的任务 ID（范围查询时直接并入） */
	private longSpanIds: Set<string> = new Set();
	/** 存在 repeat 规则的任务 ID（范围查询时始终并入以供视图生成虚拟实例） */
	private recurringTaskIds: Set<string> = new Set();
	/** 各缓存 key 的写入序号（越大越新），输出端去重兜底时保留最新的一份 */
	private writeSeq: Map<string, number> = new Map();
	private seqCounter = 0;
	private eventBus: EventBus;

	constructor(eventBus: EventBus) {
		this.eventBus = eventBus;
	}

	/**
	 * 注册数据源
	 * @param source - 数据源实例
	 */
	registerDataSource(source: IDataSource): void {
		this.dataSources.set(source.sourceId, source);
		source.onChange(async (changes, opts) => {
			await this.handleSourceChanges(source.sourceId, changes, opts);
		});
	}

	/**
	 * 注销数据源
	 * @param sourceId - 数据源ID
	 */
	unregisterDataSource(sourceId: string): void {
		const source = this.dataSources.get(sourceId);
		source?.onChange(() => {});
		this.dataSources.delete(sourceId);
	}

	/**
	 * 获取所有任务
	 * @param options - 查询选项
	 * @returns 任务列表
	 */
	getAllTasks(options?: QueryOptions): GCTask[] {
		const tasks = this.dedupeOutput();
		return this.filterTasks(tasks, options);
	}

	/**
	 * 不变量兜底：同一 `路径:行号` 只能出现一次。
	 * 正常情况下缓存 key 与任务的 `路径:行号` 一一对应；若某条路径的 bug 让旧 key
	 * 残留（日历里同一任务出现 2~3 份），这里保留最新写入的一份、清掉其余 key，
	 * 并 warn——让回归出现在日志里而不是界面上。
	 */
	private dedupeOutput(): GCTask[] {
		const winners = new Map<string, { key: string; task: GCTask; seq: number }>();
		const losers: string[] = [];
		for (const [key, task] of this.taskCache) {
			const identity = generateTaskId(task);
			const seq = this.writeSeq.get(key) ?? 0;
			const prev = winners.get(identity);
			if (!prev) {
				winners.set(identity, { key, task, seq });
			} else if (seq >= prev.seq) {
				losers.push(prev.key);
				winners.set(identity, { key, task, seq });
			} else {
				losers.push(key);
			}
		}
		if (losers.length === 0) return Array.from(this.taskCache.values());

		Logger.warn('TaskRepository', `Duplicate tasks by path:line dropped (${losers.length}):`, losers);
		for (const key of losers) this.removeKey(key);
		return Array.from(winners.values(), w => w.task);
	}

	/** 写入缓存并维护文件索引、写入序号与日期桶二级索引 */
	private putTask(taskId: string, task: GCTask): void {
		this.taskCache.set(taskId, task);
		this.writeSeq.set(taskId, ++this.seqCounter);
		if (task.filePath) {
			let ids = this.fileIndex.get(task.filePath);
			if (!ids) {
				ids = new Set();
				this.fileIndex.set(task.filePath, ids);
			}
			ids.add(taskId);
		}
		this.indexTask(taskId, task);
	}

	/** 从缓存、文件索引与日期桶索引中移除一个 key */
	private removeKey(taskId: string, filePath?: string): void {
		const task = this.taskCache.get(taskId);
		this.taskCache.delete(taskId);
		this.writeSeq.delete(taskId);
		this.unindexTask(taskId);
		const paths = new Set<string>();
		if (filePath) paths.add(filePath);
		if (task?.filePath) paths.add(task.filePath);
		const sep = taskId.lastIndexOf(':');
		if (sep > 0) paths.add(taskId.slice(0, sep));
		for (const p of paths) {
			const ids = this.fileIndex.get(p);
			if (ids) {
				ids.delete(taskId);
				if (ids.size === 0) this.fileIndex.delete(p);
			}
		}
	}

	/** 增量维护单任务的日期桶、长跨度与周期模板索引 */
	private indexTask(taskId: string, task: GCTask): void {
		this.unindexTask(taskId);
		if (task.repeat) {
			this.recurringTaskIds.add(taskId);
		}

		let minDate: Date | null = null;
		let minSerial = Infinity;
		let maxSerial = -Infinity;
		const dayKeys = new Set<string>();

		for (const field of TASK_DATE_FIELDS) {
			const value = task[field];
			if (!isValidDateValue(value)) continue;
			dayKeys.add(toLocalDayKey(value));
			const serial = localDaySerial(value);
			if (serial < minSerial) {
				minSerial = serial;
				minDate = value;
			}
			if (serial > maxSerial) {
				maxSerial = serial;
			}
		}

		if (minDate !== null) {
			const spanDays = maxSerial - minSerial;
			if (spanDays > MAX_BUCKET_SPAN_DAYS) {
				this.longSpanIds.add(taskId);
			} else if (spanDays >= 1) {
				const cursor = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
				while (localDaySerial(cursor) <= maxSerial) {
					dayKeys.add(toLocalDayKey(cursor));
					cursor.setDate(cursor.getDate() + 1);
				}
			}
		}

		if (dayKeys.size > 0) {
			const keys = Array.from(dayKeys);
			this.taskBucketKeys.set(taskId, keys);
			for (const key of keys) {
				let bucket = this.dateBuckets.get(key);
				if (!bucket) {
					bucket = new Set();
					this.dateBuckets.set(key, bucket);
				}
				bucket.add(taskId);
			}
		}
	}

	/** 移除单任务在二级索引中的全部条目 */
	private unindexTask(taskId: string): void {
		const keys = this.taskBucketKeys.get(taskId);
		if (keys) {
			for (const key of keys) {
				const bucket = this.dateBuckets.get(key);
				if (bucket) {
					bucket.delete(taskId);
					if (bucket.size === 0) {
						this.dateBuckets.delete(key);
					}
				}
			}
			this.taskBucketKeys.delete(taskId);
		}
		this.longSpanIds.delete(taskId);
		this.recurringTaskIds.delete(taskId);
	}

	/**
	 * 根据日期范围获取任务
	 * - 传入 `dateField`：返回该字段落在 `[start, end]` 内的任务（向后兼容）
	 * - 省略 `dateField`：日历范围查询模式，仅按本地日期桶 + 长跨度 + 周期模板索引在 O(days + matchedTasks) 内返回去重候选集
	 * @param start - 开始日期
	 * @param end - 结束日期
	 * @param dateField - 日期字段名（可选）
	 * @returns 任务列表
	 */
	getTasksByDateRange(
		start: Date,
		end: Date,
		dateField?: keyof GCTask
	): GCTask[] {
		if (!isValidDateValue(start) || !isValidDateValue(end)) {
			return [];
		}

		const startSerial = localDaySerial(start);
		const endSerial = localDaySerial(end);
		if (startSerial > endSerial) {
			return [];
		}

		const candidateIds = new Set<string>();
		const rangeDays = endSerial - startSerial + 1;
		if (rangeDays > FULL_BUCKET_SCAN_THRESHOLD_DAYS && rangeDays > this.dateBuckets.size) {
			const startKey = toLocalDayKey(start);
			const endKey = toLocalDayKey(end);
			for (const [key, bucket] of this.dateBuckets) {
				if (key >= startKey && key <= endKey) {
					for (const id of bucket) candidateIds.add(id);
				}
			}
		} else {
			const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
			while (localDaySerial(cursor) <= endSerial) {
				const bucket = this.dateBuckets.get(toLocalDayKey(cursor));
				if (bucket) {
					for (const id of bucket) candidateIds.add(id);
				}
				cursor.setDate(cursor.getDate() + 1);
			}
		}

		for (const id of this.longSpanIds) {
			candidateIds.add(id);
		}
		if (dateField === undefined) {
			for (const id of this.recurringTaskIds) {
				candidateIds.add(id);
			}
		}

		const result: GCTask[] = [];
		const seenIdentity = new Set<string>();
		const orphanBucketIds: string[] = [];
		for (const id of candidateIds) {
			const task = this.taskCache.get(id);
			if (!task) {
				orphanBucketIds.push(id);
				continue;
			}
			const identity = generateTaskId(task);
			if (identity !== id) {
				// 发现历史残留错位 key：立即执行全局去重自愈
				this.dedupeOutput();
				const healed = this.taskCache.get(identity);
				if (!healed) continue;
				if (dateField !== undefined) {
					const date = healed[dateField] as unknown;
					if (!isValidDateValue(date) || date < start || date > end) continue;
				}
				if (seenIdentity.has(identity)) continue;
				seenIdentity.add(identity);
				result.push(healed);
				continue;
			}
			if (dateField !== undefined) {
				const date = task[dateField] as unknown;
				if (!isValidDateValue(date) || date < start || date > end) continue;
			}
			if (seenIdentity.has(identity)) continue;
			seenIdentity.add(identity);
			result.push(task);
		}
		for (const orphanId of orphanBucketIds) {
			this.unindexTask(orphanId);
		}
		return result;
	}

	/**
	 * 根据文件路径获取任务
	 * @param filePath - 文件路径
	 * @returns 任务列表
	 */
	getTasksByFilePath(filePath: string): GCTask[] {
		const taskIds = this.fileIndex.get(filePath) || new Set();
		return Array.from(taskIds)
			.map(id => this.taskCache.get(id)!)
			.filter(Boolean);
	}

	/**
	 * 静默对账某文件的权威任务 ID 快照：删除仓库中该文件下已不在快照中的残留 key。
	 * 无残留时零事件开销；发现残留时立即清理并发布 task:deleted。
	 */
	reconcileFileSnapshot(filePath: string, taskIds: readonly string[]): number {
		const indexed = this.fileIndex.get(filePath);
		if (!indexed) return 0;
		const keep = new Set(taskIds);
		const stale = Array.from(indexed).filter((id) => !keep.has(id));
		if (stale.length === 0) return 0;
		Logger.warn('TaskRepository', `Stale task keys purged for ${filePath}:`, stale);
		for (const taskId of stale) {
			this.removeKey(taskId, filePath);
			this.eventBus.emit('task:deleted', { taskId });
		}
		return stale.length;
	}

	/**
	 * 获取任务统计信息
	 * @returns 统计信息
	 */
	getStats(): {
		totalTasks: number;
		dataSources: number;
		totalFiles: number;
	} {
		return {
			totalTasks: this.taskCache.size,
			dataSources: this.dataSources.size,
			totalFiles: this.fileIndex.size
		};
	}

	/**
	 * 过滤任务
	 * @param tasks - 任务列表
	 * @param options - 查询选项
	 * @returns 过滤后的任务列表
	 */
	private filterTasks(tasks: GCTask[], options?: QueryOptions): GCTask[] {
		if (!options) return tasks;

		let filtered = tasks;

		if (options.status?.length) {
			filtered = filtered.filter(t => options.status!.includes(t.status as string));
		}

		if (options.priority?.length) {
			filtered = filtered.filter(t => options.priority!.includes(t.priority as Priority));
		}

		if (options.tags?.length) {
			filtered = filtered.filter(t =>
				options.tags!.some(tag => t.tags?.includes(tag))
			);
		}

		if (options.dateRange) {
			const fieldMap: Record<keyof import('./types').TaskDates, keyof GCTask> = {
				created: 'createdDate',
				start: 'startDate',
				scheduled: 'scheduledDate',
				due: 'dueDate',
				completed: 'completionDate',
				cancelled: 'cancelledDate'
			};
			const gcField = fieldMap[options.dateRange.field];

			filtered = filtered.filter(t => {
				const date = t[gcField] as Date | undefined;
				return date && date >= options.dateRange!.start && date <= options.dateRange!.end;
			});
		}

		if (options.sources?.length) {
			filtered = filtered.filter(t => options.sources!.includes(t.filePath));
		}

		return filtered;
	}

	/**
	 * 处理数据源变化
	 * @param sourceId - 数据源ID
	 * @param changes - 变化详情
	 */
	private async handleSourceChanges(
		sourceId: string,
		changes: DataSourceChanges,
		opts?: { initial?: boolean }
	): Promise<void> {
		const isInitialLoad = opts?.initial === true;
		const startTime = performance.now();
		Logger.debug('TaskRepository', `Processing changes from ${sourceId}:`, {
			created: changes.created.length,
			updated: changes.updated.length,
			deleted: changes.deleted.length,
			deletedFilePaths: changes.deletedFilePaths?.length || 0
		});

		// 两阶段原子更新：先移除全部失效/删除的旧 key，再写入全部新增/更新后的任务，
		// 防止链式行号漂移（如 10→12 与 12→14）或 created+updated 同 key 时后一次 removeKey 误删刚写入的新任务。
		const toPut: Array<{ id: string; task: GCTask; event: 'created' | 'updated' }> = [];
		const deletedIds: string[] = [];

		// 收集新增任务
		for (const task of changes.created) {
			const taskId = generateTaskId(task);
			toPut.push({ id: taskId, task, event: 'created' });
		}

		// 收集更新任务（含行号漂移换 key）
		const movedOldKeys: Array<{ id: string; filePath?: string }> = [];
		for (const { id, changes: taskChanges, task: newTask } of changes.updated) {
			if (newTask) {
				const newId = generateTaskId(newTask);
				if (newId !== id) {
					movedOldKeys.push({ id, filePath: newTask.filePath });
				}
				toPut.push({ id: newId, task: newTask, event: 'updated' });
			} else {
				const task = this.taskCache.get(id);
				if (task) {
					const updatedTask = { ...task, ...taskChanges };
					const newId = generateTaskId(updatedTask);
					if (newId !== id) {
						movedOldKeys.push({ id, filePath: updatedTask.filePath });
					}
					toPut.push({ id: newId, task: updatedTask, event: 'updated' });
				}
			}
		}

		// Phase 1: 先移除删除项与漂移旧 key
		for (const task of changes.deleted) {
			const taskId = generateTaskId(task);
			this.removeKey(taskId, task.filePath);
			deletedIds.push(taskId);
		}
		for (const { id, filePath } of movedOldKeys) {
			this.removeKey(id, filePath);
		}

		// Phase 2: 写入全部新/更新任务并发布事件
		for (const { id, task, event } of toPut) {
			this.putTask(id, task);
			if (event === 'created') {
				// 首扫只维护缓存，等批量加载完成后统一通知，避免大库产生任务数级别的定时器 churn
				if (!isInitialLoad) {
					this.eventBus.emit('task:created', { task });
				}
			} else {
				this.eventBus.emit('task:updated', { task });
			}
		}
		for (const taskId of deletedIds) {
			this.eventBus.emit('task:deleted', { taskId });
		}

		// 处理文件删除（按文件路径清理所有任务）
		if (changes.deletedFilePaths) {
			for (const filePath of changes.deletedFilePaths) {
				const taskIds = this.fileIndex.get(filePath);
				if (taskIds) {
					// 删除该文件的所有任务及二级索引
					for (const taskId of Array.from(taskIds)) {
						this.removeKey(taskId, filePath);
						this.eventBus.emit('task:deleted', { taskId });
					}
				}
			}
		}

		// 按数据源给出的权威快照对账：删除该文件下数据源已不认识的残留 key
		if (changes.fileSnapshots) {
			for (const { filePath, taskIds } of changes.fileSnapshots) {
				this.reconcileFileSnapshot(filePath, taskIds);
			}
		}

		if (isInitialLoad) {
			this.eventBus.emit('tasks:loaded', {
				sourceId,
				totalTasks: this.taskCache.size,
			});
		}

		const elapsed = performance.now() - startTime;
		Logger.debug('TaskRepository', `Changes processed in ${elapsed.toFixed(2)}ms`);
	}

	/**
	 * 清空缓存
	 * 【注意】不清空 eventBus，因为 eventBus 的所有权属于 TaskStore
	 */
	clear(): void {
		this.taskCache.clear();
		this.fileIndex.clear();
		this.dateBuckets.clear();
		this.taskBucketKeys.clear();
		this.longSpanIds.clear();
		this.recurringTaskIds.clear();
		this.writeSeq.clear();
		// 【修复】不清空 eventBus，因为它是 TaskStore 的实例，TaskStore 的监听器会受影响
		// this.eventBus.clear();
	}
}
