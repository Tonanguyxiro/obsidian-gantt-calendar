/**
 * MarkdownDataSource - Markdown 数据源
 *
 * 适配现有的 Markdown 文件解析功能，将其封装为数据源接口。
 *
 * 职责：
 * - 扫描 Markdown 文件并解析任务
 * - 监听文件变化（modify、delete、rename）
 * - 检测任务变化并发布事件
 * - 复用现有的 parseTasksFromListItems 函数
 * - 直接使用 GCTask 格式，无需转换
 *
 * 【内存优化】
 * - 文件缓存只存储任务 ID 引用，不存储完整 GCTask 对象
 * - 完整任务由 TaskRepository 统一存储
 */

import { App, TFile, EventRef, ListItemCache } from 'obsidian';
import { parseTasksFromListItems } from '../tasks/taskParser/main';
import { parseTaskLine } from '../tasks/taskParser/step1';
import { areTasksEqual } from '../tasks/taskUtils';
import type { TaskFormatType } from '../tasks/taskSerializerSymbols';
import { EventBus } from './EventBus';
import type { GCTask } from '../types';
import {
	DataSourceChanges,
	DataSourceConfig,
	TaskChanges
} from './types';
import { IDataSource, ChangeEventHandler } from './IDataSource';
import { Logger } from '../utils/logger';

/**
 * 生成任务ID
 */
function generateTaskId(task: GCTask): string {
	return `${task.filePath}:${task.lineNumber}`;
}

/**
 * Markdown 文件缓存
 *
 * 【内存优化】只存储任务 ID 引用，不存储完整对象
 * 完整的 GCTask 由 TaskRepository 统一管理
 */
interface MarkdownFileCache {
	taskIds: string[];      // 任务ID列表
	lastModified: number;   // 文件修改时间
	taskCount: number;      // 任务数量（用于快速判断）
	// 与 taskIds 同序的轻量指纹：修改事件中用于字段级 diff，
	// 未变化的任务不再进入 updated（事件风暴修复）
	taskFingerprints: string[];
}

/**
 * 生成任务的轻量指纹：覆盖视图渲染依赖的全部字段。
 * content 已包含描述/标签/状态标记原文；datePrecision 影响时间显示；
 * metadataFields 含同步 GUID。任一字段变化指纹即变化。
 */
function fingerprintTask(task: GCTask): string {
	return [
		task.content,
		task.completed ? '1' : '0',
		task.cancelled ? '1' : '0',
		task.status || '',
		task.priority || '',
		task.format || '',
		task.repeat || '',
		task.createdDate?.getTime() ?? '',
		task.startDate?.getTime() ?? '',
		task.scheduledDate?.getTime() ?? '',
		task.dueDate?.getTime() ?? '',
		task.cancelledDate?.getTime() ?? '',
		task.completionDate?.getTime() ?? '',
		task.datePrecision ? JSON.stringify(task.datePrecision) : '',
		task.metadataFields ? JSON.stringify(task.metadataFields) : '',
	].join('|');
}

/**
 * Markdown 数据源
 */
export class MarkdownDataSource implements IDataSource {
	readonly sourceId = 'markdown';
	readonly sourceName = 'Markdown Files';
	readonly isReadOnly = false;

	private app: App;
	private config: DataSourceConfig;
	private cache: Map<string, MarkdownFileCache> = new Map();
	private eventBus: EventBus;
	private changeHandler?: ChangeEventHandler;

	// 性能优化：防抖处理文件修改事件
	private debounceTimers: Map<string, number> = new Map();
	private readonly DEBOUNCE_MS = 50;
	/** 防抖最大等待：连续编辑下最迟重解析间隔 */
	private readonly MAX_WAIT_MS = 500;
	/** 各文件防抖窗口首次事件时间（maxWait 用） */
	private debounceFirstAt: Map<string, number> = new Map();
	// 同一文件的处理严格串行：modify/create/rename/补扫与写回后的 refreshFile
	// 都经 processFileModification 排队。并发的两轮会拿同一份旧 L3 缓存做 diff、
	// 读到不同版本（中间有插行）→ 仓库同时留下两个版本的 `路径:行号` key（任务重复）
	private runningRuns: Map<string, Promise<void>> = new Map();
	// 已排队、尚未开始的一轮：再来的请求直接复用（它开始时会读到最新内容）
	private queuedRuns: Map<string, Promise<void>> = new Map();
	// 防止重复注册事件监听器
	private fileWatchersRegistered: boolean = false;
	// 保存事件监听器引用，用于清理
	private vaultEventRefs: EventRef[] = [];
	// 首扫时 metadataCache 无 listItems 而被跳过的文件。启动时 Obsidian 关闭期间
	// 在磁盘上新建/修改的笔记可能尚未索引，且之后不会再有 vault create 事件；
	// 待其 metadataCache 'changed' 时补扫，'resolved'（全部索引完成）后清空
	private scanSkippedPaths: Set<string> = new Set();
	private metadataEventRefs: EventRef[] = [];

	constructor(app: App, eventBus: EventBus, config: DataSourceConfig) {
		this.app = app;
		this.eventBus = eventBus;
		this.config = config;
	}

	/**
	 * 初始化数据源
	 */
	async initialize(config: DataSourceConfig): Promise<void> {
		Logger.debug('MarkdownDataSource', 'initialize() started');
		const scanStartTime = performance.now();

		// 【性能优化】仅当筛选符/格式配置变化时才清空缓存：
		// 配置不变（如无关设置的保存触发重初始化）时，mtime 未变的文件
		// 可直接跳过重解析（配合 scanAllFiles 的增量跳过），
		// 大库的重初始化从全量扫描降为只扫变更文件
		const configChanged =
			this.config.globalFilter !== config.globalFilter ||
			(this.config.enabledFormats || []).join(',') !== (config.enabledFormats || []).join(',');
		if (configChanged) {
			this.cache.clear();
		}

		this.config = config;

		// 【性能优化】扫描阶段返回所有任务，避免二次解析
		const allTasks = await this.scanAllFiles();

		// 【修复】只注册一次事件监听器，防止重复注册
		if (!this.fileWatchersRegistered) {
			this.setupFileWatchers();
			this.fileWatchersRegistered = true;
		}

		// 通知数据源已初始化，发送所有任务（使用扫描阶段收集的任务）
		await this.notifyInitialTasks(allTasks);

		// 扫描期间（监听器注册前）已完成索引的跳过文件，'changed' 已错过，这里补一次
		for (const path of Array.from(this.scanSkippedPaths)) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && this.app.metadataCache.getFileCache(file)?.listItems?.length) {
				this.rescanSkippedFile(path);
			}
		}

		const scanElapsed = performance.now() - scanStartTime;
		Logger.stats('MarkdownDataSource', `initialize() completed in ${scanElapsed.toFixed(2)}ms`);
	}

	/**
	 * 通知初始任务（用于初始化时）
	 * 【性能优化】直接使用扫描阶段收集的任务，避免重复解析
	 */
	private async notifyInitialTasks(allTasks: GCTask[]): Promise<void> {
		if (!this.changeHandler) {
			return;
		}

		await this.changeHandler({
			sourceId: this.sourceId,
			created: allTasks,
			updated: [],
			deleted: []
		}, { initial: true });
	}

	/**
	 * 获取所有任务
	 */
	async getTasks(): Promise<GCTask[]> {
		const tasks: GCTask[] = [];

		// 需要重新解析文件获取完整任务
		for (const [filePath] of this.cache) {
			const fileTasks = await this.parseFile(filePath);
			if (fileTasks) {
				tasks.push(...fileTasks);
			}
		}

		return tasks;
	}

	/**
	 * 监听数据变化
	 */
	onChange(handler: ChangeEventHandler): void {
		this.changeHandler = handler;
	}

	/**
	 * 创建任务（暂不实现）
	 */
	async createTask(task: GCTask): Promise<string> {
		throw new Error('Creating tasks directly in Markdown files is not yet supported');
	}

	/**
	 * 更新任务（暂不实现）
	 */
	async updateTask(taskId: string, changes: TaskChanges): Promise<void> {
		throw new Error('Updating tasks directly in Markdown files is not yet supported');
	}

	/**
	 * 删除任务（暂不实现）
	 */
	async deleteTask(taskId: string): Promise<void> {
		throw new Error('Deleting tasks directly in Markdown files is not yet supported');
	}

	/**
	 * 获取同步状态
	 */
	async getSyncStatus(): Promise<{
		lastSyncAt?: Date;
		syncDirection: 'bidirectional' | 'import-only' | 'export-only';
		conflictResolution: 'local-win' | 'remote-win' | 'manual';
	}> {
		return {
			syncDirection: 'import-only',
			conflictResolution: 'local-win'
		};
	}

	/**
	 * 处理文件修改
	 * 【修复Bug 2】将文件处理逻辑提取为独立方法，支持待处理队列机制
	 *
	 * 工作流程：
	 * 1. 标记文件为处理中
	 * 2. 获取旧任务ID列表
	 * 3. 解析新任务
	 * 4. 检测变化并通知
	 * 5. 清除处理中标记
	 * 6. 如果有待处理标记，递归重新检查（避免遗漏快速连续的修改）
	 */

	/**
	 * 带重置与 maxWait 的文件级防抖。
	 * 纯 trailing 防抖在连续编辑（间隔 < DEBOUNCE_MS）下会无限期推迟重解析，
	 * 首次事件后最多 MAX_WAIT_MS 强制冲刷一次，保证视图数据最迟刷新间隔。
	 * 取 min：孤立事件按 DEBOUNCE_MS 快速响应；突发临近 maxWait 截止点时
	 * 截止项归零强制冲刷（若取 max，孤立事件反而要等满 MAX_WAIT_MS）。
	 */
	private scheduleFileDebounce(path: string, run: () => void): void {
		const now = Date.now();
		const firstAt = this.debounceFirstAt.get(path) ?? now;
		this.debounceFirstAt.set(path, firstAt);
		const delay = Math.min(this.DEBOUNCE_MS, Math.max(0, this.MAX_WAIT_MS - (now - firstAt)));

		const existing = this.debounceTimers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);

		const timer = window.setTimeout(() => {
			this.debounceTimers.delete(path);
			this.debounceFirstAt.delete(path);
			run();
		}, delay);
		this.debounceTimers.set(path, timer);
	}

	/** 补扫首扫时被跳过的文件（走 modify 同款防抖 + 字段级 diff） */
	private rescanSkippedFile(path: string): void {
		this.scanSkippedPaths.delete(path);
		this.scheduleFileDebounce(path, () => {
			void this.processFileModification(path);
		});
	}

	/**
	 * 重解析文件并把变化通知仓库（同一文件串行排队）。
	 * 供 modify/create/rename/补扫与 TaskStore.refreshFile 共用；
	 * 返回的 Promise 在“覆盖到调用时文件内容”的那一轮完成后结算。
	 */
	private processFileModification(filePath: string): Promise<void> {
		const queued = this.queuedRuns.get(filePath);
		if (queued) return queued;

		const running = this.runningRuns.get(filePath);
		if (!running) return this.startFileRun(filePath);

		Logger.debug('MarkdownDataSource', `File queued behind running pass: ${filePath}`);
		const next = running.then(() => {
			this.queuedRuns.delete(filePath);
			return this.startFileRun(filePath);
		});
		this.queuedRuns.set(filePath, next);
		return next;
	}

	private startFileRun(filePath: string): Promise<void> {
		const run = this.runFileModification(filePath).finally(() => {
			if (this.runningRuns.get(filePath) === run) this.runningRuns.delete(filePath);
		});
		this.runningRuns.set(filePath, run);
		return run;
	}

	private async runFileModification(filePath: string): Promise<void> {
		Logger.debug('MarkdownDataSource', `Processing file modification: ${filePath}`);

		try {
			const oldCache = this.cache.get(filePath);

			const parseResult = await this.parseFileFromContent(filePath);

			// 读文件期间被删除/重命名：读到的是旧内容（任务路径可能已是新路径），
			// 不能写回；按文件清掉旧路径，新路径由 rename 排队的那一轮负责
			const current = this.app.vault.getAbstractFileByPath(filePath);
			const moved = !(current instanceof TFile) ||
				(parseResult?.tasks.some(t => t.filePath !== filePath) ?? false);
			if (moved) {
				this.cache.delete(filePath);
				await this.changeHandler?.({
					sourceId: this.sourceId,
					created: [],
					updated: [],
					deleted: [],
					deletedFilePaths: [filePath]
				});
				return;
			}

			if (parseResult) {
				this.cache.set(filePath, parseResult.cache);
			} else {
				this.cache.delete(filePath);
			}

			if (this.changeHandler) {
				// 当旧缓存不存在时，将旧任务ID列表视为空数组
				// 这样可以正确处理"从无任务到有任务"的场景
				const changes = this.detectChangesByIds(oldCache, parseResult?.tasks || []);

				if (changes) {
					Logger.debug('MarkdownDataSource', `Changes detected for ${filePath}:`, {
						created: changes.created.length,
						updated: changes.updated.length,
						deleted: changes.deleted.length
					});
					// 附带该文件的权威 ID 快照：仓库据此清掉 L3 不知道的残留 key（自愈）。
					// diff 为空时不通知（避免事件风暴），残留在下一次真实变化时清掉
					changes.fileSnapshots = [{ filePath, taskIds: parseResult?.cache.taskIds ?? [] }];
					await this.changeHandler(changes);
				} else {
					Logger.debug('MarkdownDataSource', `No actual changes detected for ${filePath}`);
				}
			}
		} catch (error) {
			Logger.error('MarkdownDataSource', `Error processing file modification: ${filePath}`, error);
		}
	}

	/**
	 * 销毁数据源
	 */
	destroy(): void {
		// 移除所有 vault 事件监听器
		this.vaultEventRefs.forEach((eventRef) => {
			this.app.vault.offref(eventRef);
		});
		this.vaultEventRefs = [];
		this.metadataEventRefs.forEach((eventRef) => {
			this.app.metadataCache.offref(eventRef);
		});
		this.metadataEventRefs = [];
		this.scanSkippedPaths.clear();
		this.fileWatchersRegistered = false;

		this.debounceTimers.forEach((timer) => window.clearTimeout(timer));
		this.debounceTimers.clear();
		this.debounceFirstAt.clear();
		this.runningRuns.clear();
		this.queuedRuns.clear();
		this.cache.clear();
	}

	/**
	 * 扫描所有 Markdown 文件
	 * 【性能优化】返回所有任务，避免 notifyInitialTasks 时重复解析
	 */
	private async scanAllFiles(): Promise<GCTask[]> {
		const markdownFiles = this.app.vault.getMarkdownFiles();
		Logger.stats('MarkdownDataSource', `Scanning ${markdownFiles.length} markdown files`);

		const BATCH_SIZE = 50;
		const batches: TFile[][] = [];

		for (let i = 0; i < markdownFiles.length; i += BATCH_SIZE) {
			batches.push(markdownFiles.slice(i, i + BATCH_SIZE));
		}

		Logger.debug('MarkdownDataSource', `Processing in ${batches.length} batches of ${BATCH_SIZE} files`);

		// 【关键优化】在扫描阶段收集所有任务，避免二次解析
		const allTasks: GCTask[] = [];
		let skippedCount = 0;
		const vaultPaths = new Set(markdownFiles.map(f => f.path));

		// 清理已从 vault 消失的文件的残留缓存（这些任务此前已由
		// repository 持有，需要发 deletedFilePaths 让仓库移除）
		for (const cachedPath of Array.from(this.cache.keys())) {
			if (!vaultPaths.has(cachedPath)) {
				this.cache.delete(cachedPath);
				if (this.changeHandler) {
					await this.changeHandler({
						sourceId: this.sourceId,
						created: [],
						updated: [],
						deleted: [],
						deletedFilePaths: [cachedPath]
					});
				}
			}
		}

		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const batch = batches[batchIndex];

			// 并行处理批次内的文件；mtime 未变的文件跳过重解析
			//（其任务已在 repository 中，无需重发 created）
			const batchResults = await Promise.all(
				batch.map(file => {
					const cached = this.cache.get(file.path);
					if (cached && cached.lastModified === file.stat.mtime) {
						skippedCount++;
						return Promise.resolve(null);
					}
					return this.parseFileForScan(file.path);
				})
			);

			// 将结果合并到 allTasks
			for (let i = 0; i < batchResults.length; i++) {
				const result = batchResults[i];
				if (result) {
					allTasks.push(...result.tasks);
					this.cache.set(result.filePath, result.cache);
				} else if (!this.cache.has(batch[i].path)) {
					this.scanSkippedPaths.add(batch[i].path);
				}
			}

			if (batchIndex < batches.length - 1) {
				await new Promise(resolve => window.setTimeout(resolve, 0));
			}
		}

		if (skippedCount > 0) {
			Logger.stats('MarkdownDataSource', `Incremental scan: skipped ${skippedCount} unchanged files (mtime match)`);
		}
		Logger.debug('MarkdownDataSource', 'All files scanned');
		return allTasks;
	}

	/**
	 * 从文件内容直接解析任务，不依赖 metadataCache
	 * 用于文件修改事件中 metadataCache 可能未及时更新的场景
	 */
	private async parseFileFromContent(filePath: string): Promise<{
		filePath: string;
		tasks: GCTask[];
		cache: MarkdownFileCache;
	} | null> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return null;

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');

		// 从文件内容直接构造 listItems，绕过 metadataCache
		const listItems: ListItemCache[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (parseTaskLine(lines[i])) {
				listItems.push({
					position: { start: { line: i, col: 0, offset: 0 }, end: { line: i, col: lines[i].length, offset: 0 } },
				} as ListItemCache);
			}
		}

		if (listItems.length === 0) return null;

		const tasks = parseTasksFromListItems(
			file, lines, listItems,
			this.config.enabledFormats as TaskFormatType[] || ["tasks", "dataview"],
			this.config.globalFilter
		);

		return {
			filePath,
			tasks,
			cache: {
				taskIds: tasks.map(t => generateTaskId(t)),
				taskFingerprints: tasks.map(t => fingerprintTask(t)),
				lastModified: file.stat.mtime,
				taskCount: tasks.length,
			},
		};
	}

	/**
	 * 解析单个文件（用于扫描阶段，返回任务和缓存信息）
	 */
	private async parseFileForScan(filePath: string): Promise<{
		filePath: string;
		tasks: GCTask[];
		cache: MarkdownFileCache;
	} | null> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return null;
		}

		const fileCache = this.app.metadataCache.getFileCache(file);
		const listItems = fileCache?.listItems;

		if (!listItems || listItems.length === 0) {
			return null;
		}

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');

		const tasks = parseTasksFromListItems(
			file,
			lines,
			listItems,
			this.config.enabledFormats as TaskFormatType[] || ['tasks', 'dataview'],
			this.config.globalFilter
		);

		return {
			filePath,
			tasks,
			cache: {
				taskIds: tasks.map(t => generateTaskId(t)),
				taskFingerprints: tasks.map(t => fingerprintTask(t)),
				lastModified: file.stat.mtime,
				taskCount: tasks.length
			}
		};
	}

	/**
	 * 设置文件监听
	 */
	private setupFileWatchers(): void {
		// 监听文件修改（使用防抖处理）
		// 【修复Bug 2】改进并发处理：使用待处理队列而非直接跳过
		const modifyRef = this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				Logger.debug('MarkdownDataSource', `File modify event received: ${file.path}`);

				// 正在处理时由 processFileModification 排到其后，快速连续的修改不会丢失
				this.scheduleFileDebounce(file.path, () => {
					void this.processFileModification(file.path);
				});
			}
		});
		this.vaultEventRefs.push(modifyRef);

		// 【修复Bug 1】监听文件创建
		// QuickAdd 等插件创建新文件时需要此监听器才能检测到新任务
		const createRef = this.app.vault.on('create', async (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				Logger.debug('MarkdownDataSource', `File create event: ${file.path}`);

				// create 事件常在 metadataCache 索引完成前触发，走 modify 同款的
				// 直接读内容解析；且必须与随后（模板插件写入等）的 modify 同队列串行，
				// 否则两轮各自按“无旧缓存”发 created，版本不同就留下两份任务
				this.scheduleFileDebounce(file.path, () => {
					void this.processFileModification(file.path);
				});
			}
		});
		this.vaultEventRefs.push(createRef);

		// 监听文件删除
		const deleteRef = this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				const oldCache = this.cache.get(file.path);
				this.cache.delete(file.path);

				if (this.changeHandler && oldCache) {
					// 发送文件路径，让仓库清理该文件的所有任务
					void this.changeHandler({
						sourceId: this.sourceId,
						created: [],
						updated: [],
						deleted: [],
						deletedFilePaths: [file.path]
					});
				}
			}
		});
		this.vaultEventRefs.push(deleteRef);

		// 监听文件重命名
		// 任务 ID 含路径，rename 后旧 ID 全部失效。必须：
		// 1) 以 deletedFilePaths 通知仓库清除旧路径下的全部缓存任务
		// 2) 用新路径重新解析产出 created（携带新路径 ID）
		// 仅换 cache key 会让 L2 缓存永久指向旧路径（P0 缓存脏数据）
		const renameRef = this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && file.extension === 'md') {
				// 有缓存，或该文件正在处理（首轮尚未写缓存）时才需要搬迁
				const tracked = this.cache.has(oldPath) ||
					this.runningRuns.has(oldPath) || this.queuedRuns.has(oldPath);
				if (tracked) {
					// 旧路径排在其进行中的处理之后：文件已不在旧路径 → 按文件清掉；
					// 新路径按新文件解析。两者都走串行队列，进行中的旧路径处理
					// 读完旧内容后不会再把任务写回仓库
					void this.processFileModification(oldPath);
					void this.processFileModification(file.path);
				}
			}
		});
		this.vaultEventRefs.push(renameRef);

		// 启动首扫竞态：首扫跳过的文件完成索引后补扫（只处理跳过集合内的文件，
		// 不额外读取其它笔记；普通编辑已由 modify 路径处理）
		this.metadataEventRefs.push(this.app.metadataCache.on('changed', (file) => {
			if (this.scanSkippedPaths.has(file.path)) {
				this.rescanSkippedFile(file.path);
			}
		}));
		this.metadataEventRefs.push(this.app.metadataCache.on('resolved', () => {
			this.scanSkippedPaths.clear();
		}));

		// 【开发模式】监听 metadataCache 变化
		// 用于调试和验证问题，避免生产环境性能开销
		// 通过设置插件实例的 __dev_mode__ 属性为 true 来启用
		const appWithPlugins = this.app as App & { plugins?: { plugins?: Record<string, Record<string, unknown>> } };
		const isDev = appWithPlugins.plugins?.plugins?.['gantt-calendar']?.['__dev_mode__'] === true;

		if (isDev) {
			Logger.debug('MarkdownDataSource', 'Dev mode: Adding metadataCache listener');

			const metadataRef = this.app.metadataCache.on('changed', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					Logger.debug('MarkdownDataSource', `[DEV] Metadata changed: ${file.path}`);

					// 使用相同的防抖机制
					this.scheduleFileDebounce(file.path, () => {
						void this.processFileModification(file.path);
					});
				}
			});
			this.vaultEventRefs.push(metadataRef);
		}
	}

	/**
	 * 解析单个文件获取任务
	 */
	private async parseFile(filePath: string): Promise<GCTask[] | null> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return null;
		}

		const fileCache = this.app.metadataCache.getFileCache(file);
		const listItems = fileCache?.listItems;

		if (!listItems || listItems.length === 0) {
			return null;
		}

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');

		const tasks = parseTasksFromListItems(
			file,
			lines,
			listItems,
			this.config.enabledFormats as TaskFormatType[] || ['tasks', 'dataview'],
			this.config.globalFilter
		);

		return tasks;
	}

	/**
	 * 更新单个文件的缓存
	 */
	private async updateFileCache(filePath: string): Promise<void> {
		const tasks = await this.parseFile(filePath);

		if (tasks && tasks.length > 0) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				this.cache.set(filePath, {
					taskIds: tasks.map(t => generateTaskId(t)),
					taskFingerprints: tasks.map(t => fingerprintTask(t)),
					lastModified: file.stat.mtime,
					taskCount: tasks.length
				});
			}
		} else {
			this.cache.delete(filePath);
		}
	}

	/**
	 * 通过任务ID + 指纹检测变化（字段级 diff）
	 *
	 * 旧实现把文件中所有 ID 交集任务一律标记为 updated——
	 * 编辑含 500 个任务的大文件时，一个字符的修改会触发 500 次
	 * task:updated 事件与缓存失效（事件风暴）。现在用缓存中的
	 * 轻量指纹逐任务比对，只有内容/状态/日期真正变化的才进 updated。
	 */
	private detectChangesByIds(oldCache: MarkdownFileCache | undefined, newTasks: GCTask[]): DataSourceChanges | null {
		const oldTaskIds = oldCache?.taskIds || [];
		const oldFingerprints = oldCache?.taskFingerprints;
		const oldIdSet = new Set(oldTaskIds);
		const oldFingerprintMap = oldFingerprints
			? new Map(oldTaskIds.map((id, i) => [id, oldFingerprints[i]]))
			: undefined;
		const newIdMap = new Map(newTasks.map(t => [generateTaskId(t), t]));

		const changes: DataSourceChanges = {
			sourceId: this.sourceId,
			created: [],
			updated: [],
			deleted: []
		};

		// 检测新增
		for (const [id, task] of newIdMap) {
			if (!oldIdSet.has(id)) {
				changes.created.push(task);
			}
		}

		// 检测删除
		for (const id of oldTaskIds) {
			if (!newIdMap.has(id)) {
				// 删除的任务没有完整对象，只能返回ID
				// 这里我们需要返回一个占位任务对象
				// 按最后一个 ':' 拆：路径本身可能含 ':'
				const sep = id.lastIndexOf(':');
				const filePath = id.slice(0, sep);
				changes.deleted.push({
					filePath,
					lineNumber: parseInt(id.slice(sep + 1)),
					fileName: filePath.split('/').pop() || '',
					content: '',
					description: '',
					completed: false,
					priority: 'normal'
				});
			}
		}

		// 检测更新：ID 交集且指纹变化（无指纹缓存时退化为全量 updated，
		// 与旧行为一致，保证正确性优先）
		for (const [id, newTask] of newIdMap) {
			if (oldIdSet.has(id)) {
				const oldFp = oldFingerprintMap?.get(id);
				if (oldFingerprintMap && oldFp === fingerprintTask(newTask)) {
					continue; // 内容未变化，跳过
				}
				changes.updated.push({
					id,
					changes: {},
					task: newTask
				});
			}
		}

		// ---- 二次匹配：行号漂移重配 ----
		// 上方插行/删行时，下方任务 ID（含行号）全部变化，第一轮产生
		// 大量伪 deleted + created。通过内容指纹重新配对，将它们从
		// deleted+created 降级为 updated（原地更新），避免：
		// 1. React key 全变 → 卡片全部卸载重挂（最坏 0.5-4s 卡顿）
		// 2. 甘特增量更新 added+removed > 5 → 全量重绘
		if (oldFingerprintMap && oldFingerprintMap.size > 0) {
			// 收集第一轮未匹配的旧任务（指纹 → 旧ID）
			const unmatchedOld = new Map<string, string>(); // fingerprint → oldId
			for (const id of oldTaskIds) {
				if (!newIdMap.has(id)) {
					const fp = oldFingerprintMap.get(id);
					if (fp !== undefined && !unmatchedOld.has(fp)) {
						unmatchedOld.set(fp, id);
					}
				}
			}

			if (unmatchedOld.size > 0 && unmatchedOld.size <= 500) {
				// 收集第一轮新创建的任务（指纹 → newTask）
				const unmatchedNew = new Map<string, GCTask>();
				for (const [id, task] of newIdMap) {
					if (!oldIdSet.has(id)) {
						const fp = fingerprintTask(task);
						if (!unmatchedNew.has(fp)) {
							unmatchedNew.set(fp, task);
						}
					}
				}

				// 指纹匹配：相同内容 → 行号漂移，不是真创建/删除
				const matchedNewIds = new Set<string>();
				for (const [fp, oldId] of unmatchedOld) {
					const newTask = unmatchedNew.get(fp);
					if (newTask) {
						const newId = generateTaskId(newTask);
						matchedNewIds.add(newId);
						unmatchedOld.delete(fp);
						unmatchedNew.delete(fp);

						// 从 deleted/created 撤回，改为 updated
						changes.deleted = changes.deleted.filter(d => generateTaskId(d) !== oldId);
						const newTaskIdx = changes.created.findIndex(c => generateTaskId(c) === newId);
						if (newTaskIdx !== -1) changes.created.splice(newTaskIdx, 1);

						// 用旧 ID 做 updated，保持缓存键稳定
						// （新任务对象的 lineNumber 已经是新值，写回正确）
						changes.updated.push({ id: oldId, changes: {}, task: newTask });
					}
				}
			}
		}

		if (changes.created.length === 0 &&
			changes.updated.length === 0 &&
			changes.deleted.length === 0) {
			return null;
		}

		return changes;
	}

	/**
	 * 检测文件变化
	 */
	private detectChanges(
		oldTasks: GCTask[],
		newTasks: GCTask[]
	): DataSourceChanges | null {
		const oldMap = new Map(oldTasks.map(t => [generateTaskId(t), t]));
		const newMap = new Map(newTasks.map(t => [generateTaskId(t), t]));

		const changes: DataSourceChanges = {
			sourceId: this.sourceId,
			created: [],
			updated: [],
			deleted: []
		};

		// 检测新增和修改
		for (const [id, task] of newMap) {
			if (!oldMap.has(id)) {
				changes.created.push(task);
			} else if (!areTasksEqual([oldMap.get(id)!], [task])) {
				changes.updated.push({
					id,
					changes: this.diffTasks(oldMap.get(id)!, task)
				});
			}
		}

		// 检测删除
		for (const [id, task] of oldMap) {
			if (!newMap.has(id)) {
				changes.deleted.push(task);
			}
		}

		if (changes.created.length === 0 &&
			changes.updated.length === 0 &&
			changes.deleted.length === 0) {
			return null;
		}

		return changes;
	}

	/**
	 * 计算任务差异
	 */
	private diffTasks(oldTask: GCTask, newTask: GCTask): TaskChanges {
		const changes: TaskChanges = {};

		if (oldTask.description !== newTask.description) {
			changes.description = newTask.description;
		}

		if (oldTask.completed !== newTask.completed) {
			changes.completed = newTask.completed;
		}

		if (oldTask.status !== newTask.status) {
			changes.status = newTask.status;
		}

		if (oldTask.priority !== newTask.priority) {
			changes.priority = newTask.priority;
		}

		if (oldTask.dueDate !== newTask.dueDate) {
			changes.dueDate = newTask.dueDate;
		}

		return changes;
	}
}
