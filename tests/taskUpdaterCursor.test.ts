/**
 * taskUpdater 写回后光标 / 滚动位置保持，以及陈旧任务报错可读性。
 */
import { TFile } from 'obsidian';
import { updateTaskProperties } from '../src/tasks/taskUpdater';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';

type AppType = Parameters<typeof updateTaskProperties>[0];

interface FakeEditor {
	getCursor: () => { line: number; ch: number };
	setCursor: jest.Mock;
	getScrollInfo: () => { top: number; left: number };
	scrollTo: jest.Mock;
	lineCount: () => number;
}

function makeApp(
	files: Record<string, string>,
	cursor = { line: 0, ch: 5 },
	scroll = { top: 120, left: 0 },
	lineCount = 10
) {
	const editor: FakeEditor = {
		getCursor: () => ({ ...cursor }),
		setCursor: jest.fn(),
		getScrollInfo: () => ({ ...scroll }),
		scrollTo: jest.fn(),
		lineCount: () => lineCount,
	};
	const view = { file: { path: 'notes/p.md' }, editor };
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => {
				const f = new TFile(); f.path = path; return f;
			},
			read: async (file: TFile) => files[file.path],
			modify: async (file: TFile, content: string) => { files[file.path] = content; },
		},
		workspace: { getActiveView: () => view },
		plugins: { getPlugin: () => null },
	} as unknown as AppType;
	return { app, editor, view, files };
}

function makeTask(line: string) {
	const t = parseSingleTaskLine(line, 'notes/p.md', 'p.md', 1, ['tasks']);
	if (!t) throw new Error('fixture line is not a task');
	return t;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 10));

describe('updateTaskProperties - 写回后恢复光标与滚动', () => {
	it('活动编辑器是目标文件时恢复原光标 / 滚动', async () => {
		const { app, editor, files } = makeApp({ 'notes/p.md': '- [ ] 任务 📅 2026-08-25' });
		const task = makeTask('- [ ] 任务 📅 2026-08-25');

		await updateTaskProperties(app, task, { completed: true, status: 'done', completionDate: new Date(2026, 7, 27) }, ['tasks']);
		await flush();

		expect(files['notes/p.md']).toContain('✅ 2026-08-27');
		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 5 });
		expect(editor.scrollTo).toHaveBeenCalledWith(0, 120);
	});

	it('真实 Obsidian API（getActiveViewOfType）也能恢复光标', async () => {
		const files: Record<string, string> = { 'notes/p.md': '- [ ] 任务 📅 2026-08-25' };
		const editor: FakeEditor = {
			getCursor: () => ({ line: 0, ch: 5 }),
			setCursor: jest.fn(),
			getScrollInfo: () => ({ top: 120, left: 0 }),
			scrollTo: jest.fn(),
			lineCount: () => 10,
		};
		const view = { file: { path: 'notes/p.md' }, editor };
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => { const f = new TFile(); f.path = path; return f; },
				read: async (file: TFile) => files[file.path],
				modify: async (file: TFile, content: string) => { files[file.path] = content; },
			},
			// 真实 Obsidian Workspace 只有 getActiveViewOfType，没有 getActiveView
			workspace: { getActiveViewOfType: () => view },
			plugins: { getPlugin: () => null },
		} as unknown as AppType;
		const task = makeTask('- [ ] 任务 📅 2026-08-25');

		await updateTaskProperties(app, task, { completed: true }, ['tasks']);
		await flush();

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 5 });
		expect(editor.scrollTo).toHaveBeenCalledWith(0, 120);
	});

	it('编辑器写回过程中被关闭时静默跳过', async () => {
		const { app, editor, view } = makeApp({ 'notes/p.md': '- [ ] 任务 📅 2026-08-25' });
		(view as { file: unknown }).file = null;
		const task = makeTask('- [ ] 任务 📅 2026-08-25');

		await updateTaskProperties(app, task, { completed: true }, ['tasks']);
		await flush();

		expect(editor.setCursor).not.toHaveBeenCalled();
		expect(editor.scrollTo).not.toHaveBeenCalled();
	});

	it('活动编辑器不是目标文件时不做快照 / 恢复', async () => {
		const { app, editor, view } = makeApp({ 'notes/p.md': '- [ ] 任务 📅 2026-08-25' });
		view.file.path = 'notes/other.md';
		const task = makeTask('- [ ] 任务 📅 2026-08-25');

		await updateTaskProperties(app, task, { completed: true }, ['tasks']);
		await flush();

		expect(editor.setCursor).not.toHaveBeenCalled();
	});

	it('光标行超出行数时 clamp', async () => {
		const { app, editor } = makeApp(
			{ 'notes/p.md': '- [ ] 任务 📅 2026-08-25' },
			{ line: 99, ch: 3 },
			{ top: 0, left: 0 },
			1
		);
		const task = makeTask('- [ ] 任务 📅 2026-08-25');

		await updateTaskProperties(app, task, { completed: true }, ['tasks']);
		await flush();

		expect(editor.setCursor).toHaveBeenCalledWith({ line: 0, ch: 3 });
	});

	it('mock App 没有 workspace 时不崩溃', async () => {
		const files: Record<string, string> = { 'notes/p.md': '- [ ] 任务 📅 2026-08-25' };
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => { const f = new TFile(); f.path = path; return f; },
				read: async (file: TFile) => files[file.path],
				modify: async (file: TFile, content: string) => { files[file.path] = content; },
			},
			plugins: { getPlugin: () => null },
		} as unknown as AppType;
		const task = makeTask('- [ ] 任务 📅 2026-08-25');

		await expect(
			updateTaskProperties(app, task, { completed: true, status: 'done', completionDate: new Date(2026, 7, 27) }, ['tasks'])
		).resolves.toBeUndefined();
		await flush();
		expect(files['notes/p.md']).toContain('✅ 2026-08-27');
	});
});

describe('updateTaskProperties - 陈旧任务报错', () => {
	it('任务已被删除时抛出可读的英文 message', async () => {
		const files: Record<string, string> = { 'notes/p.md': '- [ ] 完全不同的任务 📅 2026-08-30' };
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) => { const f = new TFile(); f.path = path; return f; },
				read: async (file: TFile) => files[file.path],
				modify: async () => {},
			},
			plugins: { getPlugin: () => null },
		} as unknown as AppType;
		const task = makeTask('- [ ] 已被删除的任务 📅 2026-08-25');

		await expect(
			updateTaskProperties(app, task, { dueDate: new Date(2026, 8, 1) }, ['tasks'])
		).rejects.toThrow('Task not found in file notes/p.md:1. File changed externally; task cache will refresh.');
	});
});
