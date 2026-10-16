import { TFile } from 'obsidian';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';
import { updateTaskProperties } from '../src/tasks/taskUpdater';
import { TaskUndoService } from '../src/tasks/taskUndo';
import { i18n } from '../src/i18n/i18n';
import type { GCTask } from '../src/types';

interface FakeButton {
	textContent: string;
	onclick?: (event?: unknown) => void;
}

interface FakeNotice {
	noticeEl: HTMLElement;
	message: string;
	hide: jest.Mock;
	button?: FakeButton;
}

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

	return { app: app as unknown as Parameters<typeof updateTaskProperties>[0], writes };
}

function makeNoticeFactory() {
	const notices: FakeNotice[] = [];
	const factory = jest.fn((message: string) => {
		const notice: FakeNotice = {
		noticeEl: {} as unknown as HTMLElement,
			message,
			hide: jest.fn(),
		};
		notice.noticeEl = {
			appendChild: (child: FakeButton) => {
				notice.button = child;
			},
		} as unknown as HTMLElement;
		notices.push(notice);
		return notice;
	});
	const buttonFactory = jest.fn(() => ({}) as HTMLButtonElement);
	return { notices, factory, buttonFactory };
}

function makeService() {
	const notice = makeNoticeFactory();
	const service = new TaskUndoService(notice.factory, notice.buttonFactory);
	return { service, ...notice };
}

function makeTask(line: string, lineNumber = 1): GCTask {
	const task = parseSingleTaskLine(line, 'notes/p.md', 'p.md', lineNumber);
	if (!task) throw new Error(`fixture line is not a task: ${line}`);
	return task;
}

async function flushAsync(): Promise<void> {
	await new Promise(resolve => setImmediate(resolve));
}

describe('TaskUndoService', () => {
	it('撤销属性更新时恢复旧字段值并刷新视图', async () => {
		const original = '- [ ] 目标任务 📅 2026-08-01';
		const files = { 'notes/p.md': original };
		const { app } = makeApp(files);
		const task = makeTask(original);
		const onRefresh = jest.fn();
		const updates = { dueDate: new Date('2026-08-02T00:00:00') };
		const { service, notices, buttonFactory } = makeService();

		await updateTaskProperties(app, task, updates, ['tasks', 'dataview']);
		service.registerProperty({
			app,
			oldTask: task,
			updates,
			enabledFormats: ['tasks', 'dataview'],
			onRefresh,
		}, '操作完成');

		expect(notices).toHaveLength(1);
		expect(notices[0].message).toBe('操作完成');
		expect(buttonFactory).toHaveBeenCalledTimes(1);
		expect(notices[0].button?.textContent).toBe(i18n.t('contextMenu.commands.undoAction'));
		expect(files['notes/p.md']).toContain('2026-08-02');

		notices[0].button?.onclick?.();
		await flushAsync();

		expect(notices[0].hide).toHaveBeenCalledTimes(1);
		expect(files['notes/p.md']).toBe(original);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(notices).toHaveLength(2);
		expect(notices[1].message).toBe(i18n.t('contextMenu.commands.undoSuccess'));
	});

	it('撤销删除时按原 0-based 行索引插回原行', async () => {
		const original = '- [ ] 目标任务 📅 2026-08-25';
		const files = {
			'notes/p.md': `# 标题\n- [ ] 另一个任务 📅 2026-08-30`,
		};
		const { app } = makeApp(files);
		const onRefresh = jest.fn();
		const { service, notices } = makeService();

		service.registerDeletedLine({
			app,
			filePath: 'notes/p.md',
			lineIndex: 1,
			line: original,
			onRefresh,
		}, '任务已删除');

		notices[0].button?.onclick?.();
		await flushAsync();

		expect(files['notes/p.md']).toBe(`# 标题\n${original}\n- [ ] 另一个任务 📅 2026-08-30`);
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('删除撤销的行索引越界时钳制到文件末尾', async () => {
		const line = '- [ ] 被删除的任务 📅 2026-08-25';
		const files = { 'notes/p.md': '# 标题' };
		const { app } = makeApp(files);
		const onRefresh = jest.fn();
		const { service, notices } = makeService();

		service.registerDeletedLine({
			app,
			filePath: 'notes/p.md',
			lineIndex: 999,
			line,
			onRefresh,
		}, '任务已删除');

		notices[0].button?.onclick?.();
		await flushAsync();

		expect(files['notes/p.md']).toBe(`# 标题\n${line}`);
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('新操作覆盖旧快照，撤销只作用于最近一次操作', async () => {
		const original = '- [ ] 目标任务 📅 2026-08-01';
		const files = { 'notes/p.md': original };
		const { app, writes } = makeApp(files);
		const task = makeTask(original);
		const onRefresh = jest.fn();
		const updates = { dueDate: new Date('2026-08-02T00:00:00') };
		const { service, notices } = makeService();

		await updateTaskProperties(app, task, updates, ['tasks', 'dataview']);
		service.registerProperty({
			app,
			oldTask: task,
			updates,
			enabledFormats: ['tasks', 'dataview'],
			onRefresh,
		}, '延期完成');

		const deletedLine = files['notes/p.md'];
		files['notes/p.md'] = '# 标题';
		service.registerDeletedLine({
			app,
			filePath: 'notes/p.md',
			lineIndex: 1,
			line: deletedLine,
			onRefresh,
		}, '删除完成');

		notices[1].button?.onclick?.();
		await flushAsync();

		expect(files['notes/p.md']).toBe(`# 标题\n${deletedLine}`);
		expect(notices[1].hide).toHaveBeenCalledTimes(1);

		// 再次点击同一条旧 Notice 按钮时，快照已被 undo 清空或已失效，不会重复恢复。
		const writeCountAfterFirstUndo = writes.length;
		notices[1].button?.onclick?.();
		await flushAsync();
		expect(writes).toHaveLength(writeCountAfterFirstUndo);
	});
});
