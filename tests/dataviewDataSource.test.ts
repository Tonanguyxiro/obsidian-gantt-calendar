/**
 * @jest-environment jsdom
 */
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import {
	DataviewDataSource,
	isDataviewIndexingAvailable,
	isDataviewPluginEnabled,
	type DataviewTaskLike,
} from '../src/data-layer/DataviewDataSource';
import { MarkdownDataSource } from '../src/data-layer/MarkdownDataSource';
import { TaskRepository } from '../src/data-layer/TaskRepository';
import { EventBus } from '../src/data-layer/EventBus';
import { TaskStore } from '../src/TaskStore';
import type { GCTask } from '../src/types';

type EventCallback = (...args: unknown[]) => void;

function makeMockObsidianEnv(options: {
	files: Record<string, string>;
	dataviewInstalled?: boolean;
	dataviewEnabled?: boolean;
	dataviewInitialized?: boolean;
	dataviewTasks?: DataviewTaskLike[];
	dataviewThrows?: boolean;
}) {
	const files: Record<string, string> = { ...options.files };
	const tfiles = new Map<string, TFile>();
	let mtime = 100;

	const makeTFile = (filePath: string) => {
		const f = new TFile() as TFile & { basename: string; extension: string; stat: { mtime: number; ctime: number; size: number } };
		f.path = filePath;
		f.basename = (filePath.split('/').pop() || '').replace(/\.md$/i, '');
		f.extension = 'md';
		f.stat = { mtime: mtime++, ctime: 100, size: 100 };
		tfiles.set(filePath, f);
		return f;
	};
	Object.keys(files).forEach(makeTFile);

	const metadataListeners = new Map<string, Set<EventCallback>>();
	const dvTasks: DataviewTaskLike[] = options.dataviewTasks ? [...options.dataviewTasks] : [];

	const buildPageObj = (path: string) => {
		const fileTasks = dvTasks.filter((t) => t.path === path);
		const tf = tfiles.get(path) as unknown as { stat?: { mtime?: number } } | undefined;
		return {
			file: {
				path,
				name: path.split('/').pop(),
				mtime: tf?.stat?.mtime ?? 100,
				tasks: {
					array: () => fileTasks,
					[Symbol.iterator]: () => fileTasks[Symbol.iterator](),
				},
			},
		};
	};

	const dvApi = {
		pages: () => {
			if (options.dataviewThrows) {
				throw new Error('Dataview API exploded');
			}
			const pageList = Array.from(new Set(dvTasks.map((t) => String(t.path)))).map(buildPageObj);
			return {
				array: () => pageList,
				[Symbol.iterator]: () => pageList[Symbol.iterator](),
				file: {
					tasks: {
						array: () => [...dvTasks],
						[Symbol.iterator]: () => dvTasks[Symbol.iterator](),
					},
				},
			};
		},
		page: (path: string) => {
			if (options.dataviewThrows) {
				throw new Error('Dataview page lookup failed');
			}
			if (!tfiles.has(path) && !dvTasks.some((t) => t.path === path)) return undefined;
			return buildPageObj(path);
		},
	};

	const dvPlugin =
		options.dataviewInstalled === false
			? undefined
			: {
					api: dvApi,
					index: {
						initialized: options.dataviewInitialized ?? true,
					},
				};

	const enabledPlugins = new Set<string>();
	if (options.dataviewInstalled !== false && options.dataviewEnabled !== false) {
		enabledPlugins.add('dataview');
	}

	const app = {
		plugins: {
			plugins: dvPlugin ? { dataview: dvPlugin } : {},
			enabledPlugins,
		},
		vault: {
			getMarkdownFiles: () => Array.from(tfiles.values()),
			getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
			read: async (f: { path: string }) => files[f.path] ?? '',
			on: () => ({}),
			offref: () => {},
		},
		metadataCache: {
			getFileCache: (f: { path: string }) => {
				const content = files[f.path];
				if (content === undefined) return null;
				const lines = content.split('\n');
				return {
					listItems: lines.map((l, i) => ({
						position: {
							start: { line: i, col: 0, offset: 0 },
							end: { line: i, col: l.length, offset: 0 },
						},
					})),
				};
			},
			on: (name: string, cb: EventCallback) => {
				let set = metadataListeners.get(name);
				if (!set) {
					set = new Set();
					metadataListeners.set(name, set);
				}
				set.add(cb);
				return { name, cb };
			},
			offref: (ref: { name?: string; cb?: EventCallback }) => {
				if (ref?.name && ref?.cb) {
					metadataListeners.get(ref.name)?.delete(ref.cb);
				}
			},
			trigger: (name: string, ...args: unknown[]) => {
				metadataListeners.get(name)?.forEach((cb) => cb(...args));
			},
		},
	} as unknown as App;

	return {
		app,
		files,
		tfiles,
		dvTasks,
		dvPlugin,
		enabledPlugins,
		triggerMetadata: (name: string, ...args: unknown[]) => {
			metadataListeners.get(name)?.forEach((cb) => cb(...args));
		},
		setFileContent: (path: string, content: string) => {
			files[path] = content;
			const tf = tfiles.get(path) as unknown as { stat: { mtime: number } } | undefined;
			if (tf) tf.stat.mtime = mtime++;
			else makeTFile(path);
		},
		deleteFile: (path: string) => {
			delete files[path];
			tfiles.delete(path);
		},
		renameFile: (oldPath: string, newPath: string) => {
			files[newPath] = files[oldPath];
			delete files[oldPath];
			tfiles.delete(oldPath);
			makeTFile(newPath);
			for (const t of dvTasks) {
				if (t.path === oldPath) t.path = newPath;
			}
		},
	};
}

function normalizeForParity(task: GCTask) {
	return {
		filePath: task.filePath,
		fileName: task.fileName,
		lineNumber: task.lineNumber,
		content: task.content,
		description: task.description,
		completed: task.completed,
		cancelled: !!task.cancelled,
		status: task.status,
		format: task.format,
		priority: task.priority,
		tags: task.tags || [],
		repeat: task.repeat || null,
		plannerTime: task.plannerTime || null,
		datePrecision: task.datePrecision || {},
		createdDate: task.createdDate?.getTime() ?? null,
		startDate: task.startDate?.getTime() ?? null,
		scheduledDate: task.scheduledDate?.getTime() ?? null,
		dueDate: task.dueDate?.getTime() ?? null,
		completionDate: task.completionDate?.getTime() ?? null,
		cancelledDate: task.cancelledDate?.getTime() ?? null,
		metadataFields: task.metadataFields || [],
		feishuGuid: task.feishuGuid || null,
	};
}

describe('isDataviewIndexingAvailable / isDataviewPluginEnabled', () => {
	it('未安装、未启用、未初始化时正确返回 false，就绪时返回 true', () => {
		const missing = makeMockObsidianEnv({ files: {}, dataviewInstalled: false });
		expect(isDataviewPluginEnabled(missing.app)).toBe(false);
		expect(isDataviewIndexingAvailable(missing.app)).toBe(false);

		const disabled = makeMockObsidianEnv({ files: {}, dataviewEnabled: false });
		expect(isDataviewPluginEnabled(disabled.app)).toBe(false);
		expect(isDataviewIndexingAvailable(disabled.app)).toBe(false);

		const unready = makeMockObsidianEnv({ files: {}, dataviewInitialized: false });
		expect(isDataviewPluginEnabled(unready.app)).toBe(true);
		expect(isDataviewIndexingAvailable(unready.app)).toBe(false);

		const ready = makeMockObsidianEnv({ files: {}, dataviewInitialized: true });
		expect(isDataviewPluginEnabled(ready.app)).toBe(true);
		expect(isDataviewIndexingAvailable(ready.app)).toBe(true);
	});
});

describe('DataviewDataSource 解析一致性与增量更新', () => {
	it('与 MarkdownDataSource 在 globalTaskFilter / plannerTime / datePrecision / repeat / 自定义状态 / cancelledDate / 多行任务上 100% 一致', async () => {
		const noteContent = [
			'- [ ] #task 08:00 - 11:00 晨会 scheduled planner ⏳ 2026-10-19',
			'- [ ] 应被 globalFilter 过滤的任务 📅 2026-10-20',
			'- [/] #task 阅读 [[Alpha#目标]] 与 [[Design|设计稿]] #read ⏫ 🔁 every week 🛫 2026-10-20 09:00 📅 2026-10-22 %%[guid:: g-123]%%',
			'- [-] #task 已取消任务 ❌ 2026-10-21 ➕ 2026-10-01',
			'- [x] #task 已完成任务 ✅ 2026-10-25',
			'- [ ] #task [priority:: high] [due:: 2026-10-28] [repeat:: every month]',
		].join('\n');

		// 真实 Dataview 特性：多行任务会把续行拼在 text 的 \n 后，且 tags 含链接锚点；边界转换后均应与 MarkdownDataSource 一致
		const dvTasks: DataviewTaskLike[] = [
			{
				path: 'GC QA/Parity.md',
				line: 0,
				symbol: '-',
				status: ' ',
				completed: false,
				text: '#task 08:00 - 11:00 晨会 scheduled planner ⏳ 2026-10-19\n续行备注不应干扰解析',
			},
			{
				path: 'GC QA/Parity.md',
				line: 1,
				symbol: '-',
				status: ' ',
				completed: false,
				text: '应被 globalFilter 过滤的任务 📅 2026-10-20',
			},
			{
				path: 'GC QA/Parity.md',
				line: 2,
				symbol: '-',
				status: '/',
				completed: false,
				text: '#task 阅读 [[Alpha#目标]] 与 [[Design|设计稿]] #read ⏫ 🔁 every week 🛫 2026-10-20 09:00 📅 2026-10-22 %%[guid:: g-123]%%',
			},
			{
				path: 'GC QA/Parity.md',
				line: 3,
				symbol: '-',
				status: '-',
				completed: false,
				text: '#task 已取消任务 ❌ 2026-10-21 ➕ 2026-10-01',
			},
			{
				path: 'GC QA/Parity.md',
				line: 4,
				symbol: '-',
				status: 'x',
				completed: true,
				text: '#task 已完成任务 ✅ 2026-10-25',
			},
			{
				path: 'GC QA/Parity.md',
				line: 5,
				symbol: '-',
				status: ' ',
				completed: false,
				text: '#task [priority:: high] [due:: 2026-10-28] [repeat:: every month]',
			},
		];

		const env = makeMockObsidianEnv({
			files: { 'GC QA/Parity.md': noteContent },
			dataviewTasks: dvTasks,
		});

		const config = {
			enabled: true,
			syncDirection: 'import-only' as const,
			autoSync: true,
			conflictResolution: 'local-win' as const,
			globalFilter: '#task',
			enabledFormats: ['tasks', 'dataview'],
		};

		const mdRepo = new TaskRepository(new EventBus());
		const mdSource = new MarkdownDataSource(env.app, new EventBus(), config);
		mdRepo.registerDataSource(mdSource);
		await mdSource.initialize(config);

		const dvRepo = new TaskRepository(new EventBus());
		const dvSource = new DataviewDataSource(env.app, new EventBus(), config);
		dvRepo.registerDataSource(dvSource);
		await dvSource.initialize(config);

		const mdTasks = mdRepo.getAllTasks().map(normalizeForParity);
		const dvConverted = dvRepo.getAllTasks().map(normalizeForParity);

		expect(dvConverted).toHaveLength(5);
		expect(dvConverted).toEqual(mdTasks);

		mdSource.destroy();
		dvSource.destroy();
	});

	it('支持 dataview:metadata-change 增量更新、删除、重命名与 refreshFile 立即刷新（不重复）', async () => {
		const env = makeMockObsidianEnv({
			files: {
				'a.md': '- [ ] #task A1 📅 2026-10-10\n- [ ] #task A2 📅 2026-10-11',
			},
			dataviewTasks: [
				{ path: 'a.md', line: 0, symbol: '-', status: ' ', text: '#task A1 📅 2026-10-10' },
				{ path: 'a.md', line: 1, symbol: '-', status: ' ', text: '#task A2 📅 2026-10-11' },
			],
		});

		const bus = new EventBus();
		const repo = new TaskRepository(bus);
		const config = {
			enabled: true,
			syncDirection: 'import-only' as const,
			autoSync: true,
			conflictResolution: 'local-win' as const,
			globalFilter: '#task',
			enabledFormats: ['tasks', 'dataview'],
		};
		const ds = new DataviewDataSource(env.app, bus, config);
		repo.registerDataSource(ds);
		await ds.initialize(config);
		expect(repo.getAllTasks()).toHaveLength(2);

		// 写回后立即 refreshFile（此时 Dataview 索引尚未更新）
		env.setFileContent('a.md', '# 新增首行\n- [ ] #task A1 📅 2026-10-15\n- [ ] #task A2 📅 2026-10-11');
		await ds.refreshFile('a.md');
		const afterRefresh = repo.getAllTasks();
		expect(afterRefresh).toHaveLength(2);
		expect(afterRefresh.map((t) => [t.lineNumber, t.dueDate?.getDate()])).toEqual([
			[2, 15],
			[3, 11],
		]);

		// 随后 Dataview 后台完成索引并触发 dataview:metadata-change：指纹一致，不应产生重复或多余事件
		const updatedEvents: unknown[] = [];
		bus.on('task:updated', (d) => {
			updatedEvents.push(d);
		});
		env.dvTasks.splice(
			0,
			env.dvTasks.length,
			{ path: 'a.md', line: 1, symbol: '-', status: ' ', text: '#task A1 📅 2026-10-15' },
			{ path: 'a.md', line: 2, symbol: '-', status: ' ', text: '#task A2 📅 2026-10-11' }
		);
		env.triggerMetadata('dataview:metadata-change', 'update', { path: 'a.md' });
		await new Promise((r) => setTimeout(r, 10));
		expect(repo.getAllTasks()).toHaveLength(2);
		expect(updatedEvents).toHaveLength(0);

		// 重命名文件
		env.renameFile('a.md', 'b.md');
		env.triggerMetadata('dataview:metadata-change', 'rename', { path: 'b.md' }, 'a.md');
		await new Promise((r) => setTimeout(r, 10));
		expect(repo.getAllTasks().map((t) => `${t.filePath}:${t.lineNumber}`)).toEqual(['b.md:2', 'b.md:3']);

		// 删除文件
		env.deleteFile('b.md');
		env.dvTasks.length = 0;
		env.triggerMetadata('dataview:metadata-change', 'delete', { path: 'b.md' });
		await new Promise((r) => setTimeout(r, 10));
		expect(repo.getAllTasks()).toEqual([]);

		ds.destroy();
	});

	it('写回或直读刷新后，即使延迟到达的 Dataview 事件携带更大 mtime（时区偏移）与旧行号任务，也不会回滚或产生重复任务', async () => {
		const env = makeMockObsidianEnv({
			files: {
				'a.md': '- [/] #task 20:00 - 23:00 Update gantt calendar plugin ⏳ 2026-11-12',
			},
			dataviewTasks: [
				{
					path: 'a.md',
					line: 0,
					symbol: '-',
					status: '/',
					text: '#task 20:00 - 23:00 Update gantt calendar plugin ⏳ 2026-11-12',
				},
			],
		});

		const bus = new EventBus();
		const repo = new TaskRepository(bus);
		const config = {
			enabled: true,
			syncDirection: 'import-only' as const,
			autoSync: true,
			conflictResolution: 'local-win' as const,
			globalFilter: '#task',
			enabledFormats: ['tasks', 'dataview'],
		};
		const ds = new DataviewDataSource(env.app, bus, config);
		repo.registerDataSource(ds);
		await ds.initialize(config);
		expect(repo.getAllTasks()).toHaveLength(1);

		// 用户插行并修改任务后触发 refreshFile
		env.setFileContent(
			'a.md',
			'# 标题\n\n- [/] #task 19:00 - 23:00 Update **gantt calendar plugin** ⏳ 2026-11-12'
		);
		await ds.refreshFile('a.md');
		expect(repo.getAllTasks().map((t) => `${t.filePath}:${t.lineNumber}:${t.description}`)).toEqual([
			'a.md:3:19:00 - 23:00 Update **gantt calendar plugin**',
		]);

		// 模拟 Dataview IndexedDB 时区偏移导致 page.file.mtime 比磁盘 stat.mtime 大 18 小时，且仍携带旧行号 0 的旧任务
		const tf = env.tfiles.get('a.md') as unknown as { stat: { mtime: number } };
		tf.stat.mtime = 999999999;
		env.triggerMetadata('dataview:metadata-change', 'update', { path: 'a.md' });
		await new Promise((r) => setTimeout(r, 15));

		const finalTasks = repo.getAllTasks();
		expect(finalTasks).toHaveLength(1);
		expect(finalTasks[0].lineNumber).toBe(3);
		expect(finalTasks[0].description).toBe('19:00 - 23:00 Update **gantt calendar plugin**');

		ds.destroy();
	});

	it('TaskStore.reloadAll 强制冲刷未保存编辑器并清空重建缓存，彻底消除残留重复项', async () => {
		const env = makeMockObsidianEnv({
			files: {
				'a.md': '- [ ] #task OldTask 📅 2026-11-12',
			},
			dataviewTasks: [
				{ path: 'a.md', line: 0, symbol: '-', status: ' ', text: '#task OldTask 📅 2026-11-12' },
			],
		});

		let savedByReload = false;
		const dirtyView = {
			file: { path: 'a.md', extension: 'md' },
			dirty: true,
			editor: {
				getValue: () => '# Header\n- [ ] #task EditedInDirtyEditor 📅 2026-11-12',
			},
			save: async () => {
				savedByReload = true;
				dirtyView.dirty = false;
				env.setFileContent('a.md', '# Header\n- [ ] #task EditedInDirtyEditor 📅 2026-11-12');
			},
		};
		(env.app as unknown as { workspace: unknown }).workspace = {
			getActiveFile: () => ({ path: 'a.md', extension: 'md' }),
			getLeavesOfType: (type: string) => (type === 'markdown' ? [{ view: dirtyView }] : []),
		};

		const store = new TaskStore(env.app);
		await store.initialize('#task', ['tasks']);
		expect(store.getAllTasks().map((t) => `${t.filePath}:${t.lineNumber}:${t.description}`)).toEqual([
			'a.md:1:OldTask',
		]);

		// 手动全量刷新：即使 Dataview 内存索引里仍是旧行号 0 的 OldTask，reloadAll 也会先落盘脏编辑器并直读打开的笔记
		await store.reloadAll();
		expect(savedByReload).toBe(true);
		expect(store.getAllTasks().map((t) => `${t.filePath}:${t.lineNumber}:${t.description}`)).toEqual([
			'a.md:2:EditedInDirtyEditor',
		]);

		store.clear();
	});
});

describe('TaskStore Dataview 优先与自动回退机制', () => {
	it('Dataview 可用且就绪时优先使用 DataviewDataSource，且初始化过程不读取全库磁盘文件', async () => {
		const env = makeMockObsidianEnv({
			files: { 'note.md': '- [ ] #task FromDisk 📅 2026-10-19' },
			dataviewTasks: [
				{ path: 'note.md', line: 0, symbol: '-', status: ' ', text: '#task FromDataview 📅 2026-10-19' },
			],
		});
		const readSpy = jest.spyOn(env.app.vault, 'read');

		const store = new TaskStore(env.app);
		await store.initialize('#task', ['tasks']);

		expect(store.getActiveDataSourceId()).toBe('dataview');
		expect(store.getAllTasks().map((t) => t.description)).toEqual(['FromDataview']);
		expect(readSpy).not.toHaveBeenCalled();

		// 写回单文件后 refreshFile 只读该文件并更新范围缓存
		env.setFileContent('note.md', '- [ ] #task UpdatedDirect 📅 2026-10-20');
		await store.refreshFile('note.md');
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(store.getTasksByDateRange(new Date(2026, 9, 20), new Date(2026, 9, 20)).map((t) => t.description)).toEqual([
			'UpdatedDirect',
		]);

		store.clear();
	});

	it('Dataview 缺失、禁用或初始化抛错时自动回退到 MarkdownDataSource', async () => {
		// 1. 缺失
		const missing = makeMockObsidianEnv({
			files: { 'n.md': '- [ ] #task MD1 📅 2026-10-19' },
			dataviewInstalled: false,
		});
		const s1 = new TaskStore(missing.app);
		await s1.initialize('#task');
		expect(s1.getActiveDataSourceId()).toBe('markdown');
		expect(s1.getAllTasks().map((t) => t.description)).toEqual(['MD1']);
		s1.clear();

		// 2. 禁用
		const disabled = makeMockObsidianEnv({
			files: { 'n.md': '- [ ] #task MD2 📅 2026-10-19' },
			dataviewEnabled: false,
		});
		const s2 = new TaskStore(disabled.app);
		await s2.initialize('#task');
		expect(s2.getActiveDataSourceId()).toBe('markdown');
		expect(s2.getAllTasks().map((t) => t.description)).toEqual(['MD2']);
		s2.clear();

		// 3. 初始化抛错
		const throwing = makeMockObsidianEnv({
			files: { 'n.md': '- [ ] #task MD3 📅 2026-10-19' },
			dataviewThrows: true,
		});
		const s3 = new TaskStore(throwing.app);
		await s3.initialize('#task');
		expect(s3.getActiveDataSourceId()).toBe('markdown');
		expect(s3.getAllTasks().map((t) => t.description)).toEqual(['MD3']);
		s3.clear();
	});

	it('Dataview 未就绪时先由 MarkdownDataSource 立即就绪，收到 dataview:index-ready 后无感切换为 DataviewDataSource', async () => {
		const env = makeMockObsidianEnv({
			files: { 'n.md': '- [ ] #task InitialMD 📅 2026-10-19' },
			dataviewInitialized: false,
			dataviewTasks: [
				{ path: 'n.md', line: 0, symbol: '-', status: ' ', text: '#task ReadyDV 📅 2026-10-19' },
			],
		});

		const store = new TaskStore(env.app);
		await store.initialize('#task');
		expect(store.getActiveDataSourceId()).toBe('markdown');
		expect(store.getAllTasks().map((t) => t.description)).toEqual(['InitialMD']);

		// 模拟 Dataview 完成索引并广播 dataview:index-ready
		env.dvPlugin!.index.initialized = true;
		env.triggerMetadata('dataview:index-ready');
		await new Promise((r) => setTimeout(r, 20));

		expect(store.getActiveDataSourceId()).toBe('dataview');
		expect(store.getAllTasks().map((t) => t.description)).toEqual(['ReadyDV']);

		store.clear();
	});

	it('Dataview 运行期更新抛错时自动回退到 MarkdownDataSource', async () => {
		let shouldThrowOnPage = false;
		const env = makeMockObsidianEnv({
			files: { 'n.md': '- [ ] #task InitialDisk 📅 2026-10-19' },
			dataviewTasks: [
				{ path: 'n.md', line: 0, symbol: '-', status: ' ', text: '#task InitialDV 📅 2026-10-19' },
			],
		});
		const origPage = env.dvPlugin!.api.page;
		env.dvPlugin!.api.page = (p: string) => {
			if (shouldThrowOnPage) throw new Error('runtime boom');
			return origPage(p);
		};

		const store = new TaskStore(env.app);
		await store.initialize('#task');
		expect(store.getActiveDataSourceId()).toBe('dataview');

		shouldThrowOnPage = true;
		env.setFileContent('n.md', '- [ ] #task RecoveredDisk 📅 2026-10-20');
		env.triggerMetadata('dataview:metadata-change', 'update', { path: 'n.md' });
		await new Promise((r) => setTimeout(r, 25));

		expect(store.getActiveDataSourceId()).toBe('markdown');
		expect(store.getAllTasks().map((t) => t.description)).toEqual(['RecoveredDisk']);

		store.clear();
	});
});
