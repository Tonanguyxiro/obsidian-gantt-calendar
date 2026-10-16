/**
 * deleteTask 安全性回归测试：
 * - 删除前必须通过破坏性确认
 * - 写回必须持有文件锁并重新定位任务行
 */
import { TFile } from 'obsidian';
import { deleteTask } from '../src/contextMenu/commands/deleteTask';
import { showConfirmDialog } from '../src/ui/modals/ConfirmDialog';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';
import type { GCTask } from '../src/types';

jest.mock('../src/ui/modals/ConfirmDialog', () => ({
	showConfirmDialog: jest.fn(),
}));

const mockedConfirm = showConfirmDialog as jest.Mock;

function makeApp(files: Record<string, string>) {
	const writes: string[] = [];
	const fileOf = (path: string) => {
		const file = new TFile();
		file.path = path;
		return file;
	};
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => fileOf(path),
			read: async (file: TFile) => files[file.path],
			modify: async (file: TFile, content: string) => {
				files[file.path] = content;
				writes.push(content);
			},
		},
		plugins: { getPlugin: () => null },
	};

	return { app: app as unknown as Parameters<typeof deleteTask>[0], writes };
}

function makeTask(line: string, lineNumber = 1): GCTask {
	const task = parseSingleTaskLine(line, 'notes/p.md', 'p.md', lineNumber);
	if (!task) throw new Error(`fixture line is not a task: ${line}`);
	return task;
}

describe('deleteTask safety', () => {
	beforeEach(() => {
		mockedConfirm.mockReset();
	});

	it('未确认时不读取锁定后的内容，更不修改文件', async () => {
		const original = '- [ ] 目标任务 📅 2026-08-25';
		const files = { 'notes/p.md': original };
		const { app, writes } = makeApp(files);
		mockedConfirm.mockResolvedValue(false);
		const task = makeTask(original);
		const onRefresh = jest.fn();

		await deleteTask(app, task, onRefresh);

		expect(mockedConfirm).toHaveBeenCalledTimes(1);
		expect(mockedConfirm).toHaveBeenCalledWith(
			app,
			expect.stringContaining('Delete Task'),
			expect.stringContaining(task.description),
			expect.objectContaining({ isDestructive: true }),
		);
		expect(writes).toHaveLength(0);
		expect(files['notes/p.md']).toBe(original);
		expect(onRefresh).not.toHaveBeenCalled();
	});

	it('确认后删除目标行并触发刷新', async () => {
		const original = '- [ ] 目标任务 📅 2026-08-25';
		const files = {
			'notes/p.md': `# 标题\n${original}\n- [ ] 另一个任务 📅 2026-08-30`,
		};
		const { app, writes } = makeApp(files);
		mockedConfirm.mockResolvedValue(true);
		const task = makeTask(original, 2);
		const onRefresh = jest.fn();

		await deleteTask(app, task, onRefresh);

		expect(files['notes/p.md']).toBe('# 标题\n- [ ] 另一个任务 📅 2026-08-30');
		expect(writes).toHaveLength(1);
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('行号漂移时重定位目标行，不误删其他任务', async () => {
		const original = '- [ ] 目标任务 📅 2026-08-25';
		const files = {
			'notes/p.md': `# 标题\n- [ ] 别的任务 📅 2026-08-30\n${original}`,
		};
		const { app, writes } = makeApp(files);
		mockedConfirm.mockResolvedValue(true);
		// 解析时目标在第 1 行；并发插入后实际在第 3 行
		const task = makeTask(original, 1);
		const onRefresh = jest.fn();

		await deleteTask(app, task, onRefresh);

		expect(files['notes/p.md']).toBe('# 标题\n- [ ] 别的任务 📅 2026-08-30');
		expect(writes).toHaveLength(1);
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('目标行不存在时报错提示并保持文件不变', async () => {
		const original = '- [ ] 完全不同的任务 📅 2026-08-30';
		const files = { 'notes/p.md': original };
		const { app, writes } = makeApp(files);
		mockedConfirm.mockResolvedValue(true);
		const task = makeTask('- [ ] 已被外部删除的任务 📅 2026-08-25');

		await deleteTask(app, task, jest.fn());

		expect(writes).toHaveLength(0);
		expect(files['notes/p.md']).toBe(original);
	});
});