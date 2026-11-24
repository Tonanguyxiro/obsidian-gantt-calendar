/** @jest-environment jsdom */
import { TFile, type App } from 'obsidian';
import { TaskRepository } from '../src/data-layer/TaskRepository';
import { EventBus } from '../src/data-layer/EventBus';
import { DataviewDataSource, type DataviewTaskLike } from '../src/data-layer/DataviewDataSource';
import { TaskStore } from '../src/TaskStore';
import type { GCTask } from '../src/types';
import { getFileFrequentTags } from '../src/ui/modals/tagSelectorModel';
import { isFormattingToolbarElement, shouldKeepActiveEditorOnBlur } from '../src/ui/components/DescriptionEditor';

function mkTask(filePath: string, lineNumber: number, description: string): GCTask {
	return {
		filePath,
		fileName: filePath.split('/').pop() || '',
		lineNumber,
		content: description,
		description,
		completed: false,
		priority: 'normal',
		scheduledDate: new Date(2026, 10, 24),
	};
}

describe('Key 残留根治回归测试', () => {
	it('TaskRepository 链式行号漂移更新（10→12 与 12→14 同批到达）不误删新 key 且无残留旧 key', async () => {
		const bus = new EventBus();
		const repo = new TaskRepository(bus);
		const handle = (changes: unknown) =>
			(repo as unknown as { handleSourceChanges: (s: string, c: unknown) => Promise<void> })
				.handleSourceChanges('dataview', changes);

		await handle({
			sourceId: 'dataview',
			created: [mkTask('a.md', 10, 'Task A'), mkTask('a.md', 12, 'Task B')],
			updated: [],
			deleted: [],
		});
		expect(repo.getAllTasks().map((t) => `${t.filePath}:${t.lineNumber}:${t.description}`)).toEqual([
			'a.md:10:Task A',
			'a.md:12:Task B',
		]);

		// 模拟批量链式漂移：a.md:10 移到 a.md:12，同时 a.md:12 移到 a.md:14
		await handle({
			sourceId: 'dataview',
			created: [],
			updated: [
				{ id: 'a.md:10', changes: {}, task: mkTask('a.md', 12, 'Task A') },
				{ id: 'a.md:12', changes: {}, task: mkTask('a.md', 14, 'Task B') },
			],
			deleted: [],
			fileSnapshots: [{ filePath: 'a.md', taskIds: ['a.md:12', 'a.md:14'] }],
		});

		const tasks = repo.getAllTasks().sort((a, b) => a.lineNumber - b.lineNumber);
		expect(tasks.map((t) => `${t.filePath}:${t.lineNumber}:${t.description}`)).toEqual([
			'a.md:12:Task A',
			'a.md:14:Task B',
		]);
		expect(repo.getStats().totalTasks).toBe(2);
	});

	it('DataviewDataSource 在文件已从 vault 删除但 Dataview 仍保留旧 page 时不再复活旧 key', async () => {
		const files: Record<string, string> = { 'note.md': '- [ ] #task 23:00 - 24:00 Fix key ⏳ 2026-11-24' };
		const tfiles = new Map<string, TFile>();
		const tf = new TFile() as TFile & { basename: string; extension: string; stat: { mtime: number } };
		tf.path = 'note.md';
		tf.basename = 'note';
		tf.extension = 'md';
		tf.stat = { mtime: 100, ctime: 100, size: 100 };
		tfiles.set('note.md', tf);

		const dvTasks: DataviewTaskLike[] = [
			{ path: 'note.md', line: 0, symbol: '-', status: ' ', text: '#task 23:00 - 24:00 Fix key ⏳ 2026-11-24' },
		];
		const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

		const app = {
			plugins: {
				enabledPlugins: new Set(['dataview']),
				plugins: {
					dataview: {
						index: { initialized: true },
						api: {
							pages: () => ({ file: { tasks: { array: () => [...dvTasks] } } }),
							// 故意模拟 Dataview 延迟未清理旧 page
							page: (p: string) => ({
								file: { path: p, name: 'note.md', mtime: 200, tasks: { array: () => [...dvTasks] } },
							}),
						},
					},
				},
			},
			vault: {
				getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
				getMarkdownFiles: () => Array.from(tfiles.values()),
				read: async (f: { path: string }) => files[f.path] ?? '',
				on: () => ({}),
				offref: () => {},
			},
			metadataCache: {
				on: (name: string, cb: (...args: unknown[]) => void) => {
					const set = listeners.get(name) ?? new Set();
					set.add(cb);
					listeners.set(name, set);
					return { name, cb };
				},
				offref: () => {},
			},
		} as unknown as App;

		const bus = new EventBus();
		const repo = new TaskRepository(bus);
		const config = {
			enabled: true,
			syncDirection: 'import-only' as const,
			autoSync: true,
			conflictResolution: 'local-win' as const,
			globalFilter: '#task',
			enabledFormats: ['tasks'],
		};
		const ds = new DataviewDataSource(app, bus, config);
		repo.registerDataSource(ds);
		await ds.initialize(config);
		expect(repo.getAllTasks()).toHaveLength(1);

		// 文件已从 vault 删除，但 Dataview 延迟事件仍带旧 page
		tfiles.delete('note.md');
		delete files['note.md'];
		listeners.get('dataview:metadata-change')?.forEach((cb) => cb('update', { path: 'note.md' }));
		await new Promise((r) => setTimeout(r, 15));

		expect(repo.getAllTasks()).toEqual([]);
		ds.destroy();
	});

	it('TaskStore.refreshFile 即使 L3 无变化也能自愈仓库残留的旧 key', async () => {
		const files: Record<string, string> = { 'a.md': '- [ ] #task Current ⏳ 2026-11-24' };
		const tf = new TFile() as TFile & { basename: string; extension: string; stat: { mtime: number } };
		tf.path = 'a.md';
		tf.basename = 'a';
		tf.extension = 'md';
		tf.stat = { mtime: 100, ctime: 100, size: 100 };

		const app = {
			plugins: { plugins: {}, enabledPlugins: new Set<string>() },
			vault: {
				getAbstractFileByPath: (p: string) => (p === 'a.md' ? tf : null),
				getMarkdownFiles: () => [tf],
				read: async (f: { path: string }) => files[f.path],
				on: () => ({}),
				offref: () => {},
			},
			metadataCache: {
				getFileCache: () => ({
					listItems: [{ position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 30, offset: 0 } } }],
				}),
				on: () => ({}),
				offref: () => {},
			},
		} as unknown as App;

		const store = new TaskStore(app);
		await store.initialize('#task', ['tasks']);
		expect(store.getAllTasks()).toHaveLength(1);

		// 注入一条 L3 不知道的历史残留 key
		const repo = (store as unknown as { repository: TaskRepository }).repository;
		await (repo as unknown as { handleSourceChanges: (s: string, c: unknown) => Promise<void> })
			.handleSourceChanges('markdown', {
				sourceId: 'markdown',
				created: [mkTask('a.md', 99, 'Ghost stale key')],
				updated: [],
				deleted: [],
			});
		expect(repo.getStats().totalTasks).toBe(2);

		// refreshFile 时文件内容未变（L3 diff 为空），仓库仍通过 reconcileFileSnapshot 清掉残留 key
		await store.refreshFile('a.md');
		expect(store.getAllTasks().map((t) => `${t.filePath}:${t.lineNumber}`)).toEqual(['a.md:1']);
		expect(repo.getStats().totalTasks).toBe(1);
		store.clear();
	});

	it('clearCache 代际防护：在途慢读取在 clearCache 后结束不会写回旧 key', async () => {
		let releaseRead!: () => void;
		const readGate = new Promise<void>((r) => {
			releaseRead = r;
		});
		const tf = new TFile() as TFile & { basename: string; extension: string; stat: { mtime: number } };
		tf.path = 'a.md';
		tf.basename = 'a';
		tf.extension = 'md';
		tf.stat = { mtime: 100, ctime: 100, size: 100 };

		const app = {
			plugins: {
				enabledPlugins: new Set(['dataview']),
				plugins: {
					dataview: {
						index: { initialized: true },
						api: {
							pages: () => ({ file: { tasks: { array: () => [] } } }),
							page: () => undefined,
						},
					},
				},
			},
			vault: {
				getAbstractFileByPath: (p: string) => (p === 'a.md' ? tf : null),
				getMarkdownFiles: () => [tf],
				read: async () => {
					await readGate;
					return '- [ ] #task Stale from slow read ⏳ 2026-11-24';
				},
				on: () => ({}),
				offref: () => {},
			},
			metadataCache: { on: () => ({}), offref: () => {} },
		} as unknown as App;

		const bus = new EventBus();
		const repo = new TaskRepository(bus);
		const config = {
			enabled: true,
			syncDirection: 'import-only' as const,
			autoSync: true,
			conflictResolution: 'local-win' as const,
			globalFilter: '#task',
			enabledFormats: ['tasks'],
		};
		const ds = new DataviewDataSource(app, bus, config);
		repo.registerDataSource(ds);
		await ds.initialize(config);

		const inflight = ds.refreshFile('a.md');
		ds.clearCache();
		releaseRead();
		await inflight;

		expect(repo.getAllTasks()).toEqual([]);
		ds.destroy();
	});

	it('直读刷新遇到并发删文件 ENOENT 时自动按删除清理且不阻塞后续队列、不残留 key', async () => {
		const tf = new TFile() as TFile & { basename: string; extension: string; stat: { mtime: number; ctime: number; size: number } };
		tf.path = 'gone.md';
		tf.basename = 'gone';
		tf.extension = 'md';
		tf.stat = { mtime: 100, ctime: 100, size: 100 };
		let exists = true;
		let rejectRead!: (e: Error) => void;
		const readPromise = new Promise<string>((_res, rej) => {
			rejectRead = rej;
		});

		const dvTasks: DataviewTaskLike[] = [
			{ path: 'gone.md', line: 0, symbol: '-', status: ' ', text: '#task Will be deleted ⏳ 2026-11-24' },
		];
		const vaultHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
		const app = {
			plugins: {
				enabledPlugins: new Set(['dataview']),
				plugins: {
					dataview: {
						index: { initialized: true },
						api: {
							pages: () => ({ file: { tasks: { array: () => [...dvTasks] } } }),
							page: () => undefined,
						},
					},
				},
			},
			vault: {
				getAbstractFileByPath: (p: string) => (exists && p === 'gone.md' ? tf : null),
				getMarkdownFiles: () => (exists ? [tf] : []),
				read: async () => readPromise,
				on: (name: string, cb: (...args: unknown[]) => void) => {
					(vaultHandlers[name] ??= []).push(cb);
					return { name, cb };
				},
				offref: () => {},
			},
			metadataCache: { on: () => ({}), offref: () => {} },
		} as unknown as App;

		const bus = new EventBus();
		const repo = new TaskRepository(bus);
		const config = {
			enabled: true,
			syncDirection: 'import-only' as const,
			autoSync: true,
			conflictResolution: 'local-win' as const,
			globalFilter: '#task',
			enabledFormats: ['tasks'],
		};
		const ds = new DataviewDataSource(app, bus, config);
		repo.registerDataSource(ds);
		await ds.initialize(config);
		expect(repo.getAllTasks()).toHaveLength(1);

		// 并发：refreshFile 正在读盘时文件被删除并触发 delete 事件 + 读盘抛出 ENOENT
		const inflight = ds.refreshFile('gone.md');
		exists = false;
		(vaultHandlers['delete'] || []).forEach((cb) => cb(tf));
		rejectRead(new Error('ENOENT: no such file or directory, open gone.md'));
		await inflight;
		await new Promise((r) => setTimeout(r, 15));

		expect(repo.getAllTasks()).toEqual([]);
		ds.destroy();
	});
});

describe('本文件常用标签推荐 (getFileFrequentTags)', () => {
	const tasks: Array<Pick<GCTask, 'filePath' | 'tags'>> = [
		{ filePath: 'a.md', tags: ['task', 'task/geek/obsidian', 'release/v1-9-0', 'bug'] },
		{ filePath: 'a.md', tags: ['task', 'task/geek/obsidian', 'release/v1-9-0', 'ui'] },
		{ filePath: 'a.md', tags: ['task', 'task/geek/obsidian', 'release/v1-9-0', 'perf'] },
		{ filePath: 'a.md', tags: ['task', 'task/geek/obsidian', 'ui', 'docs'] },
		{ filePath: 'a.md', tags: ['task', 'bug', 'extra-6th'] },
		{ filePath: 'other.md', tags: ['other/tag', 'other/tag2'] },
	];

	it('仅统计当前文件的具体标签，按频次降序返回前 5 个并排除裸全局筛选符', () => {
		const res = getFileFrequentTags(tasks, 'a.md', 5, ['#task']);
		expect(res).toEqual([
			['task/geek/obsidian', 4],
			['release/v1-9-0', 3],
			['bug', 2],
			['ui', 2],
			['docs', 1],
		]);
	});

	it('不排除子标签，仅精确排除传入的 excludeTags；无路径或无任务时返回空数组', () => {
		expect(getFileFrequentTags(tasks, undefined, 5, ['#task'])).toEqual([]);
		expect(getFileFrequentTags(tasks, 'missing.md', 5, ['#task'])).toEqual([]);
	});
});

describe('悬浮格式编辑条焦点保护', () => {
	it('识别 Editing Toolbar / cMenu / 菜单元素并在失焦至其上时保留 activeEditor', () => {
		const bar = document.createElement('div');
		bar.id = 'editingToolbarModalBar';
		const btn = document.createElement('button');
		bar.appendChild(btn);
		document.body.appendChild(bar);

		const normalInput = document.createElement('input');
		document.body.appendChild(normalInput);

		expect(isFormattingToolbarElement(btn)).toBe(true);
		expect(isFormattingToolbarElement(normalInput)).toBe(false);
		expect(shouldKeepActiveEditorOnBlur(btn, false)).toBe(true);
		expect(shouldKeepActiveEditorOnBlur(null, true)).toBe(true);
		expect(shouldKeepActiveEditorOnBlur(normalInput, false)).toBe(false);

		bar.remove();
		normalInput.remove();
	});
});
