/**
 * 行号漂移后仓库重复任务回归测试：
 * 稀疏任务（行号前后无交集）上方插入行时，diff 走指纹重配，以旧 ID 发 updated；
 * 仓库必须把任务换到新 `路径:行号` key 下，否则再编辑/再漂移会残留旧 key 造成重复
 */
import { MarkdownDataSource } from '../src/data-layer/MarkdownDataSource';
import { TaskRepository } from '../src/data-layer/TaskRepository';
import { EventBus } from '../src/data-layer/EventBus';
import { TFile } from 'obsidian';

function makeApp(files: Record<string, string>) {
	const fileOf = (path: string) => {
		const f = new TFile() as TFile & { extension: string; stat: { mtime: number; ctime: number; size: number } };
		f.path = path;
		f.extension = 'md';
		f.stat = { mtime: Date.now(), ctime: Date.now(), size: 100 };
		return f;
	};
	return {
		vault: {
			getAbstractFileByPath: (path: string) => fileOf(path),
			getMarkdownFiles: () => [],
			read: async (f: { path: string }) => files[f.path],
			on: () => ({}),
			offref: () => {},
		},
		metadataCache: { on: () => ({}) },
	} as never;
}

function setup(files: Record<string, string>) {
	const repo = new TaskRepository(new EventBus());
	const ds = new MarkdownDataSource(makeApp(files), { on: () => ({}), emit: () => {} } as never, {
		enabled: true,
		syncDirection: 'import-only',
		autoSync: false,
		conflictResolution: 'local-win',
		globalFilter: '',
		enabledFormats: ['tasks', 'dataview'],
	});
	repo.registerDataSource(ds);
	const modify = (p: string) =>
		(ds as unknown as { processFileModification: (p: string) => Promise<void> }).processFileModification(p);
	return { repo, modify };
}

const PATH = 'notes/review.md';
// 任务之间隔一行正文，插入一行后新旧行号无交集
const sparse = (a: string, b: string) => ['正文', a, '正文', b].join('\n');

describe('行号漂移后仓库不残留旧 key', () => {
	it('漂移后勾选完成：任务不重复', async () => {
		const files = { [PATH]: sparse('- [ ] 任务A 📅 2026-10-20', '- [ ] 任务B 📅 2026-10-21') };
		const { repo, modify } = setup(files);
		await modify(PATH);

		files[PATH] = '新增一行\n' + files[PATH];
		await modify(PATH);
		expect(repo.getTasksByFilePath(PATH).map(t => t.lineNumber).sort()).toEqual(
			repo.getAllTasks().map(t => t.lineNumber).sort()
		);

		files[PATH] = '新增一行\n' + sparse('- [x] 任务A 📅 2026-10-20 ✅ 2026-10-21', '- [ ] 任务B 📅 2026-10-21');
		await modify(PATH);

		const tasks = repo.getAllTasks();
		expect(tasks).toHaveLength(2);
		expect(tasks.find(t => t.description === '任务A')?.completed).toBe(true);
	});

	it('连续两次漂移：任务数与源文件一致，行号为最新', async () => {
		const files = { [PATH]: sparse('- [ ] 任务A 📅 2026-10-20', '- [ ] 任务B 📅 2026-10-21') };
		const { repo, modify } = setup(files);
		await modify(PATH);

		files[PATH] = '新增一行\n' + files[PATH];
		await modify(PATH);
		files[PATH] = '再加一行\n' + files[PATH];
		await modify(PATH);

		const tasks = repo.getAllTasks();
		expect(tasks).toHaveLength(2);
		expect(tasks.map(t => t.lineNumber).sort()).toEqual(
			repo.getTasksByFilePath(PATH).map(t => t.lineNumber).sort()
		);
		expect(repo.getStats().totalTasks).toBe(2);
	});

	it('漂移后删除文件：任务全部清掉', async () => {
		const files = { [PATH]: sparse('- [ ] 任务A 📅 2026-10-20', '- [ ] 任务B 📅 2026-10-21') };
		const { repo, modify } = setup(files);
		await modify(PATH);

		files[PATH] = '新增一行\n' + files[PATH];
		await modify(PATH);
		files[PATH] = '';
		await modify(PATH);

		expect(repo.getAllTasks()).toHaveLength(0);
	});
});
