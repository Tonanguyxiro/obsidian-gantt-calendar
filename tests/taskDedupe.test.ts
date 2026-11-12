/** @jest-environment jsdom */
/**
 * 日历里同一任务出现 2~3 份的剩余路径（行号漂移已由 taskRepositoryLineDrift 覆盖）：
 * 1. 写回后的 refreshFile 与正在进行的 modify 处理并发：两轮都拿同一份旧 L3 缓存做 diff，
 *    读到的文件版本不同（中间有插行）→ 仓库同时留下两个版本的 `路径:行号` key
 * 2. create 事件的解析不走 processingFiles 防护，与紧随其后的 modify 并发
 * 3. rename / delete 时该文件的处理正在进行：读完旧内容后把旧路径的任务写回仓库
 * 4. 删除占位按 `id.split(':')` 拆路径，路径含 ':' 时删不掉旧 key
 * 另：仓库按 L3 快照自愈残留 key；输出端按 `路径:行号` 去重兜底并告警
 */
import { MarkdownDataSource } from '../src/data-layer/MarkdownDataSource';
import { TaskRepository } from '../src/data-layer/TaskRepository';
import { EventBus } from '../src/data-layer/EventBus';
import { Logger } from '../src/utils/logger';
import { TFile } from 'obsidian';
import type { GCTask } from '../src/types';

type Handler = (...args: unknown[]) => unknown;

function setup(initial: Record<string, string>) {
	const files: Record<string, string> = { ...initial };
	const tfiles = new Map<string, TFile>();
	let mtime = 1;
	const mk = (path: string) => {
		const f = new TFile() as TFile & { extension: string; stat: { mtime: number; ctime: number; size: number } };
		f.path = path;
		f.extension = 'md';
		f.stat = { mtime: mtime++, ctime: 1, size: 1 };
		tfiles.set(path, f);
		return f;
	};
	Object.keys(files).forEach(mk);

	// 读文件：调用时取内容快照；若设置了闸门，等闸门放开才返回（模拟慢读）
	let gate: Promise<void> | null = null;
	let openGate: (() => void) | null = null;
	const holdReads = () => {
		gate = new Promise<void>(r => { openGate = r; });
	};
	/** 之后开始的读不再拦截，已被拦截的读继续等待 */
	const stopHolding = () => {
		const g = openGate;
		gate = null;
		openGate = null;
		return () => g?.();
	};
	const releaseReads = () => {
		const g = openGate;
		gate = null;
		openGate = null;
		g?.();
	};

	const vaultHandlers: Record<string, Handler[]> = {};
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
			getMarkdownFiles: () => Array.from(tfiles.values()),
			read: async (f: { path: string }) => {
				const snapshot = files[f.path];
				const g = gate; // 只拦截闸门关闭期间开始的读
				if (g) await g;
				return snapshot;
			},
			on: (name: string, cb: Handler) => {
				(vaultHandlers[name] ??= []).push(cb);
				return {};
			},
			offref: () => {},
		},
		metadataCache: {
			getFileCache: (f: { path: string }) => {
				const c = files[f.path];
				if (c === undefined) return null;
				const lines = c.split('\n');
				return { listItems: lines.map((l, i) => ({ position: { start: { line: i, col: 0, offset: 0 }, end: { line: i, col: l.length, offset: 0 } } })) };
			},
			on: () => ({}),
			offref: () => {},
		},
	};
	const fire = (name: string, ...args: unknown[]) => (vaultHandlers[name] ?? []).forEach(cb => cb(...args));

	const write = (path: string, content: string) => {
		files[path] = content;
		const f = tfiles.get(path) ?? mk(path);
		(f as unknown as { stat: { mtime: number } }).stat.mtime = mtime++;
		return f;
	};
	const create = (path: string, content: string) => {
		files[path] = content;
		const f = mk(path);
		fire('create', f);
		return f;
	};
	const modify = (path: string, content: string) => fire('modify', write(path, content));
	const rename = (oldPath: string, newPath: string) => {
		const f = tfiles.get(oldPath)!;
		tfiles.delete(oldPath);
		files[newPath] = files[oldPath];
		delete files[oldPath];
		f.path = newPath;
		tfiles.set(newPath, f);
		fire('rename', f, oldPath);
	};
	const remove = (path: string) => {
		const f = tfiles.get(path)!;
		tfiles.delete(path);
		delete files[path];
		fire('delete', f);
	};

	const repo = new TaskRepository(new EventBus());
	const ds = new MarkdownDataSource(app as never, { on: () => ({}), emit: () => {} } as never, {
		enabled: true,
		syncDirection: 'import-only',
		autoSync: false,
		conflictResolution: 'local-win',
		globalFilter: '',
		enabledFormats: ['tasks', 'dataview'],
	});
	repo.registerDataSource(ds);
	const refreshFile = (p: string) =>
		(ds as unknown as { processFileModification: (p: string) => Promise<void> }).processFileModification(p);
	const init = () => ds.initialize((ds as unknown as { config: never }).config);

	return { files, repo, ds, init, refreshFile, write, create, modify, rename, remove, holdReads, releaseReads, stopHolding };
}

const flush = async (ms = 600) => {
	for (let i = 0; i < 5; i++) {
		jest.advanceTimersByTime(ms);
		for (let j = 0; j < 30; j++) await Promise.resolve();
	}
};
const settle = async () => {
	for (let j = 0; j < 50; j++) await Promise.resolve();
};

const keysOf = (tasks: GCTask[]) => tasks.map(t => `${t.filePath}:${t.lineNumber}`).sort();
const descOf = (tasks: GCTask[]) => tasks.map(t => t.description).sort();

const PATH = 'daily/2026-11-12.md';
const TASK = '- [ ] 20:00 - 23:00 Update gantt calendar plugin ⏳ 2026-11-12';
const OTHER = '- [ ] 写周报 📅 2026-11-13';
const body = (pre: string[]) => [...pre, TASK, '正文', OTHER].join('\n');

describe('任务重复：剩余路径', () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('写回后的 refreshFile 与进行中的 modify 处理并发（中间有插行）：不重复', async () => {
		const env = setup({ [PATH]: body(['# 今天']) });
		await env.init();
		expect(env.repo.getAllTasks()).toHaveLength(2);

		// 用户在上方插一行 → modify 处理开始，读文件很慢
		env.holdReads();
		env.modify(PATH, body(['# 今天', '插入一行']));
		await flush(60);
		// 处理还没读完，插件写回（如新建任务插到上方）后立即 refreshFile
		env.write(PATH, body(['# 今天', '插入一行', '再插一行']));
		const refresh = env.refreshFile(PATH);
		env.releaseReads();
		await refresh;
		await flush();

		const tasks = env.repo.getAllTasks();
		expect(tasks).toHaveLength(2);
		expect(keysOf(tasks)).toEqual([`${PATH}:4`, `${PATH}:6`]);

		// 之后再编辑也不冒出旧 key
		env.modify(PATH, body(['# 今天', '插入一行', '再插一行', '第三行']));
		await flush();
		expect(keysOf(env.repo.getAllTasks())).toEqual([`${PATH}:5`, `${PATH}:7`]);
	});

	it('两个 refreshFile 并发（同一文件不同版本）：不重复', async () => {
		const env = setup({ [PATH]: body([]) });
		await env.init();

		env.holdReads();
		env.write(PATH, body(['a']));
		const r1 = env.refreshFile(PATH);
		await settle();
		env.write(PATH, body(['a', 'b']));
		const r2 = env.refreshFile(PATH);
		env.releaseReads();
		await Promise.all([r1, r2]);
		await flush();

		expect(keysOf(env.repo.getAllTasks())).toEqual([`${PATH}:3`, `${PATH}:5`]);
	});

	it('create 事件的解析与紧随的 modify 并发（模板插件写入）：不重复', async () => {
		const env = setup({});
		await env.init();

		env.holdReads();
		env.create(PATH, body([]));
		await flush(60); // create 防抖到期，开始慢读
		env.modify(PATH, body(['---', 'tags: daily', '---']));
		await flush(60); // modify 防抖到期
		env.releaseReads();
		await flush();

		const tasks = env.repo.getAllTasks();
		expect(keysOf(tasks)).toEqual([`${PATH}:4`, `${PATH}:6`]);
	});

	it('rename 时该文件处理正在进行：旧路径的任务不残留', async () => {
		const env = setup({ [PATH]: body([]) });
		await env.init();

		env.holdReads();
		env.modify(PATH, body(['x']));
		await flush(60);
		const release = env.stopHolding();
		env.rename(PATH, 'archive/old.md');
		await flush(); // rename 处理先完成
		env.modify('archive/old.md', body(['x', 'y'])); // 新路径上继续编辑（插行）
		await flush();
		release(); // 旧路径的处理这才读完
		await flush();

		const tasks = env.repo.getAllTasks();
		expect(keysOf(tasks)).toEqual(['archive/old.md:3', 'archive/old.md:5']);
	});

	it('delete 时该文件处理正在进行：任务不复活', async () => {
		const env = setup({ [PATH]: body([]) });
		await env.init();

		env.holdReads();
		env.modify(PATH, body(['x']));
		await flush(60);
		env.remove(PATH);
		env.releaseReads();
		await flush();

		expect(env.repo.getAllTasks()).toEqual([]);
	});

	it('路径含冒号时删行/漂移仍能删掉旧 key', async () => {
		const P = 'meetings/10:30 sync.md';
		const env = setup({ [P]: ['- [ ] A 📅 2026-11-12', '正文', '- [ ] B 📅 2026-11-13'].join('\n') });
		await env.init();
		env.modify(P, ['- [ ] B 📅 2026-11-13'].join('\n'));
		await flush();
		expect(descOf(env.repo.getAllTasks())).toEqual(['B']);
	});

	it('仓库残留了 L3 不知道的 key：下一次处理该文件时自愈', async () => {
		const env = setup({ [PATH]: body([]) });
		await env.init();
		// 模拟历史版本遗留：仓库里有一个文件中已不存在的行
		const stale = { ...env.repo.getAllTasks()[0], lineNumber: 9 };
		await (env.repo as unknown as { handleSourceChanges: (s: string, c: unknown) => Promise<void> })
			.handleSourceChanges('markdown', { sourceId: 'markdown', created: [stale], updated: [], deleted: [] });
		await settle();
		expect(env.repo.getAllTasks()).toHaveLength(3);

		// 该文件下一次真实变化（勾选完成）时对账，残留 key 被清掉
		env.write(PATH, body([]).replace('- [ ] 写周报', '- [x] 写周报'));
		await env.refreshFile(PATH);
		const internals = env.repo as unknown as { taskCache: Map<string, GCTask> };
		expect(Array.from(internals.taskCache.keys()).sort()).toEqual([`${PATH}:1`, `${PATH}:3`]);
	});
});

describe('输出端去重兜底', () => {
	it('同一 路径:行号 出现在两个缓存 key 下：只保留最新写入的一份，并告警', () => {
		const repo = new TaskRepository(new EventBus());
		const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => {});
		const base = { filePath: 'a.md', fileName: 'a.md', lineNumber: 3, content: '', description: 'old', completed: false, priority: 'normal' } as GCTask;
		const internals = repo as unknown as { taskCache: Map<string, GCTask> };
		// 历史 bug 形态：旧 key 下存着行号已漂到 3 的新对象
		internals.taskCache.set('a.md:3', base);
		internals.taskCache.set('a.md:7', { ...base, description: 'newest' });

		const tasks = repo.getAllTasks();
		expect(tasks.map(t => t.description)).toEqual(['newest']);
		expect(warn).toHaveBeenCalled();
		// 兜底同时修复缓存：再次读取不再告警
		warn.mockClear();
		expect(repo.getAllTasks()).toHaveLength(1);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
