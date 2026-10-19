/** @jest-environment jsdom */
/**
 * 启动首扫竞态：Obsidian 关闭期间在磁盘上新建的笔记，首扫时 metadataCache
 * 尚未索引（无 listItems）被跳过，之后不会再有 vault create 事件。
 * 修复后：跳过的文件在 metadataCache 'changed' 时补扫，'resolved' 后不再跟踪。
 */
import { MarkdownDataSource } from '../src/data-layer/MarkdownDataSource';
import type { DataSourceChanges } from '../src/data-layer/types';
import { TFile } from 'obsidian';

type Handler = (...args: unknown[]) => void;

function setup(files: Record<string, string>) {
	const tfiles = new Map<string, TFile>();
	for (const path of Object.keys(files)) {
		const f = new TFile() as TFile & { extension: string; stat: { mtime: number; ctime: number; size: number } };
		f.path = path;
		f.extension = 'md';
		f.stat = { mtime: 1, ctime: 1, size: 1 };
		tfiles.set(path, f);
	}
	// 模拟未索引：getFileCache 返回 null，直到 index() 被调用
	const indexed = new Map<string, unknown>();
	const metaHandlers: Record<string, Handler[]> = {};
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
			getMarkdownFiles: () => Array.from(tfiles.values()),
			read: async (f: { path: string }) => files[f.path],
			on: () => ({}),
			offref: () => {},
		},
		metadataCache: {
			getFileCache: (f: { path: string }) => indexed.get(f.path) ?? null,
			on: (name: string, cb: Handler) => {
				(metaHandlers[name] ??= []).push(cb);
				return {};
			},
			offref: () => {},
		},
	};
	const index = (path: string) => {
		const lines = files[path].split('\n');
		indexed.set(path, {
			listItems: lines.map((l, i) => ({ position: { start: { line: i, col: 0, offset: 0 }, end: { line: i, col: l.length, offset: 0 } } })),
		});
	};
	const fire = (name: string, ...args: unknown[]) => (metaHandlers[name] ?? []).forEach(cb => cb(...args));

	const changes: DataSourceChanges[] = [];
	const ds = new MarkdownDataSource(app as never, { on: () => ({}), emit: () => {} } as never, {
		enabled: true,
		syncDirection: 'import-only',
		autoSync: false,
		conflictResolution: 'local-win',
		globalFilter: '',
		enabledFormats: ['tasks', 'dataview'],
	});
	ds.onChange(async (c) => { changes.push(c); });
	return { ds, changes, index, fire, tfiles };
}

const flush = async () => {
	jest.advanceTimersByTime(600);
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('启动首扫竞态', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('首扫时未索引的文件，在 metadataCache changed 后补扫出任务', async () => {
		const { ds, changes, index, fire, tfiles } = setup({ 'new.md': '- [ ] race task 📅 2026-10-20' });
		await ds.initialize((ds as unknown as { config: never }).config);

		const created = () => changes.flatMap(c => c.created).map(t => t.description);
		expect(created()).toEqual([]);

		index('new.md');
		fire('changed', tfiles.get('new.md'));
		await flush();

		expect(created()).toEqual(['race task']);
		ds.destroy();
	});

	it('扫描期间已完成索引（错过 changed）的跳过文件，初始化结束时补扫', async () => {
		const { ds, changes, index } = setup({ 'new.md': '- [ ] late task 📅 2026-10-20' });
		const anyDs = ds as unknown as { scanAllFiles: () => Promise<unknown>; config: never };
		const origScan = anyDs.scanAllFiles.bind(ds);
		anyDs.scanAllFiles = async () => {
			const r = await origScan();
			index('new.md'); // 扫描后、监听器注册前完成索引
			return r;
		};
		await ds.initialize(anyDs.config);
		await flush();

		expect(changes.flatMap(c => c.created).map(t => t.description)).toEqual(['late task']);
		ds.destroy();
	});

	it("'resolved' 后不再跟踪跳过文件（之后的 changed 由常规 modify 路径负责）", async () => {
		const { ds, changes, index, fire, tfiles } = setup({ 'new.md': '- [ ] x 📅 2026-10-20' });
		await ds.initialize((ds as unknown as { config: never }).config);

		fire('resolved');
		index('new.md');
		fire('changed', tfiles.get('new.md'));
		await flush();

		expect(changes.flatMap(c => c.created)).toEqual([]);
		ds.destroy();
	});
});
