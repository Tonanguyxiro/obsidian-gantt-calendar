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

export class TaskRepository {
	private dataSources: Map<string, IDataSource> = new Map();
	private taskCache: Map<string, GCTask> = new Map();
	private fileIndex: Map<string, Set<string>> = new Map();
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

	/** 写入缓存并维护文件索引与写入序号 */
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
	}

	/** 从缓存、文件索引（按任务实际路径与 key 推得的路径）中移除一个 key */
	private removeKey(taskId: string, filePath?: string): void {
		const task = this.taskCache.get(taskId);
		this.taskCache.delete(taskId);
		this.writeSeq.delete(taskId);
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

	/**
	 * 根据日期范围获取任务
	 * @param start - 开始日期
	 * @param end - 结束日期
	 * @param dateField - 日期字段名
	 * @returns 任务列表
	 */
	getTasksByDateRange(
		start: Date,
		end: Date,
		dateField: keyof GCTask = 'dueDate'
	): GCTask[] {
		return Array.from(this.taskCache.values()).filter(task => {
			const date = task[dateField] as Date | undefined;
			return date && date >= start && date <= end;
		});
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

		// 处理新增任务
		for (const task of changes.created) {
			const taskId = generateTaskId(task);
			this.putTask(taskId, task);

			// 首扫只维护缓存，等批量加载完成后统一通知，避免大库产生任务数级别的定时器 churn
			if (!isInitialLoad) {
				this.eventBus.emit('task:created', { task });
			}
		}

		// 处理更新任务
		for (const { id, changes: taskChanges, task: newTask } of changes.updated) {
			let updatedTask: GCTask | undefined;

			// 优先使用完整的新任务对象（如果提供）
			if (newTask) {
				updatedTask = newTask;
				// 行号漂移的指纹重配以旧 ID 发 updated：换到新 key，否则旧 key 残留成重复任务
				const newId = generateTaskId(newTask);
				if (newId !== id) {
					this.removeKey(id, newTask.filePath);
				}
				// 同 key 也走 putTask：仓库此前缺该 key 时补上文件索引
				this.putTask(newId, newTask);
			} else {
				// 否则使用增量更新
				const task = this.taskCache.get(id);
				if (task) {
					updatedTask = { ...task, ...taskChanges };
					this.putTask(id, updatedTask);
				}
			}

			if (updatedTask) {
				// 发布事件
				this.eventBus.emit('task:updated', { task: updatedTask });
			}
		}

		// 处理删除任务
		for (const task of changes.deleted) {
			const taskId = generateTaskId(task);
			this.removeKey(taskId, task.filePath);

			// 发布事件
			this.eventBus.emit('task:deleted', { taskId });
		}

		// 处理文件删除（按文件路径清理所有任务）
		if (changes.deletedFilePaths) {
			for (const filePath of changes.deletedFilePaths) {
				const taskIds = this.fileIndex.get(filePath);
				if (taskIds) {
					// 删除该文件的所有任务
					for (const taskId of taskIds) {
						this.taskCache.delete(taskId);
						this.writeSeq.delete(taskId);
						this.eventBus.emit('task:deleted', { taskId });
					}
					// 清理文件索引
					this.fileIndex.delete(filePath);
				}
			}
		}

		// 按数据源给出的权威快照对账：删除该文件下数据源已不认识的残留 key
		if (changes.fileSnapshots) {
			for (const { filePath, taskIds } of changes.fileSnapshots) {
				const indexed = this.fileIndex.get(filePath);
				if (!indexed) continue;
				const keep = new Set(taskIds);
				const stale = Array.from(indexed).filter(id => !keep.has(id));
				if (stale.length === 0) continue;
				Logger.warn('TaskRepository', `Stale task keys purged for ${filePath}:`, stale);
				for (const taskId of stale) {
					this.removeKey(taskId, filePath);
					this.eventBus.emit('task:deleted', { taskId });
				}
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
		this.writeSeq.clear();
		// 【修复】不清空 eventBus，因为它是 TaskStore 的实例，TaskStore 的监听器会受影响
		// this.eventBus.clear();
	}
}
