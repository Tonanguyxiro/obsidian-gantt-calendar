/**
 * @jest-environment jsdom
 */
/**
 * 新建任务默认无创建/安排日期，以及 DescriptionEditor 不污染 activeEditor / edit-task 兜底测试。
 */
import { TFile, TFolder, type App } from 'obsidian';
import type GanttCalendarPlugin from '../main';
import { createTaskAtLine, createTaskInDailyNote, createTaskInWeeklyNote, serializeNewTask } from '../src/utils/dailyNoteHelper';
import { formatDate } from '../src/dateUtils/format';
import { serializeTask } from '../src/tasks/taskSerializer';
import type { GCTask } from '../src/types';
import type { GanttCalendarSettings } from '../src/settings/types';

jest.mock('obsidian', () => {
	const actual = jest.requireActual<typeof import('./__mocks__/obsidian')>('./__mocks__/obsidian');
	return {
		...actual,
		TFolder: class TFolder {
			path = '';
			children: unknown[] = [];
		},
		normalizePath: (p: string) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
	};
});
import {
	capturePreviousActiveEditor,
	isDescriptionEditorOwner,
	restorePreviousActiveEditor,
} from '../src/ui/components/DescriptionEditor';
import { registerEditTaskCommand } from '../src/commands/editTaskCommand';

const openCreateTaskModalMock = jest.fn<void, unknown[]>();
const openEditTaskModalMock = jest.fn<void, unknown[]>();

jest.mock('../src/ui/modals/TaskFormModal', () => ({
	openCreateTaskModal: (...args: unknown[]) => {
		openCreateTaskModalMock(...args);
	},
	openEditTaskModal: (...args: unknown[]) => {
		openEditTaskModalMock(...args);
	},
}));

function makeApp(enabledTaskFormats: string[] = ['tasks'], globalTaskFilter = ''): App {
	return {
		plugins: {
			plugins: {
				'gantt-calendar': {
					settings: {
						enabledTaskFormats,
						globalTaskFilter,
					},
				},
			},
		},
	} as unknown as App;
}

describe('新建任务日期默认值序列化', () => {
	test('createdDate / dueDate / scheduledDate 为 null 时不输出 ➕ / 📅 / ⏳', () => {
		const line = serializeNewTask(
			{
				description: '写文档',
				createdDate: null,
				startDate: null,
				scheduledDate: null,
				dueDate: null,
			},
			makeApp(['tasks'])
		);
		expect(line).toBe('- [ ] 写文档');
		expect(line).not.toContain('➕');
		expect(line).not.toContain('📅');
		expect(line).not.toContain('⏳');
	});

	test('Dataview 格式下 createdDate 为 null 时不输出 [created::]', () => {
		const line = serializeNewTask(
			{
				description: 'Task A',
				createdDate: null,
			},
			makeApp(['dataview'])
		);
		expect(line).toBe('- [ ] Task A');
		expect(line).not.toContain('[created::');
	});

	test('显式提供 createdDate 时仍正常输出 ➕ / [created::]', () => {
		const created = new Date(2026, 10, 21);
		expect(serializeNewTask({ description: 'Tasks', createdDate: created }, makeApp(['tasks']))).toBe(
			'- [ ] Tasks ➕ 2026-11-21'
		);
		expect(serializeNewTask({ description: 'DV', createdDate: created }, makeApp(['dataview']))).toBe(
			'- [ ] DV [created:: 2026-11-21]'
		);
	});

	test('createTaskAtLine 写回无日期新任务不带 ➕', async () => {
		let stored = '# Heading\n\n';
		const app = {
			...makeApp(['tasks'], '#task'),
			vault: {
				getFileByPath: (p: string) => (p === 'note.md' ? { path: 'note.md' } : null),
				process: async (_f: unknown, fn: (data: string) => string) => {
					stored = fn(stored);
					return stored;
				},
			},
		} as unknown as App;

		const res = await createTaskAtLine(
			app,
			{ filePath: 'note.md', line: 1, original: '', indent: '' },
			{ description: 'New item', createdDate: null, dueDate: null, scheduledDate: null }
		);

		expect(res).toBe('note.md');
		expect(stored).toBe('# Heading\n- [ ] #task New item\n');
	});
});

describe('DescriptionEditor activeEditor 保护与恢复', () => {
	test('isDescriptionEditorOwner 仅识别带标记的合成 owner', () => {
		expect(isDescriptionEditorOwner(null)).toBe(false);
		expect(isDescriptionEditorOwner(undefined)).toBe(false);
		expect(isDescriptionEditorOwner({})).toBe(false);
		expect(isDescriptionEditorOwner({ file: { path: 'a.md' } })).toBe(false);
		expect(isDescriptionEditorOwner({ __gcDescEditorOwner: true })).toBe(true);
	});

	test('Obsidian 先将 ws.activeEditor 设为 ed.owner 时仍保留真实笔记编辑器', () => {
		const realNoteEditor = { file: { path: 'plan.md' } };
		const syntheticOwner = { __gcDescEditorOwner: true };
		const otherSyntheticOwner = { __gcDescEditorOwner: true };

		// 挂载前捕获真实编辑器
		const prev1 = capturePreviousActiveEditor(realNoteEditor, null, null);
		expect(prev1).toBe(realNoteEditor);

		// focusChanged 触发时 ws.activeEditor 已被原生焦点处理改为 syntheticOwner，不能覆盖 prev1
		const prev2 = capturePreviousActiveEditor(syntheticOwner, syntheticOwner, prev1);
		expect(prev2).toBe(realNoteEditor);

		// 即使碰到另一个弹窗的合成 owner，也不覆盖 realNoteEditor
		const prev3 = capturePreviousActiveEditor(otherSyntheticOwner, syntheticOwner, prev2);
		expect(prev3).toBe(realNoteEditor);
	});

	test('restorePreviousActiveEditor 仅在 activeEditor 仍为当前 owner 时恢复真实编辑器', () => {
		const realNoteEditor = { file: { path: 'plan.md' } };
		const otherNoteEditor = { file: { path: 'other.md' } };
		const syntheticOwner = { __gcDescEditorOwner: true };

		const ws = { activeEditor: syntheticOwner as unknown };
		restorePreviousActiveEditor(ws, syntheticOwner, realNoteEditor);
		expect(ws.activeEditor).toBe(realNoteEditor);

		// 若焦点已切到另一篇笔记，不覆写
		ws.activeEditor = otherNoteEditor;
		restorePreviousActiveEditor(ws, syntheticOwner, realNoteEditor);
		expect(ws.activeEditor).toBe(otherNoteEditor);

		// 若 previous 意外仍是合成 owner，兜底清成 null 而不是留脏引用
		ws.activeEditor = syntheticOwner;
		restorePreviousActiveEditor(ws, syntheticOwner, { __gcDescEditorOwner: true });
		expect(ws.activeEditor).toBeNull();
	});

	test('模拟 Obsidian 原生 activeEditor getter/setter 时能从合成 owner 恢复到 MarkdownView', () => {
		class FakeMarkdownView {
			file = { path: 'plan.md' };
		}
		const activeMdView = new FakeMarkdownView();
		const syntheticOwner = { __gcDescEditorOwner: true };

		let internalActive: unknown = null;
		const ws = {
			get activeEditor(): unknown {
				return internalActive ?? activeMdView;
			},
			set activeEditor(v: unknown) {
				// 复刻 Obsidian 1.15.1: e instanceof MarkdownView || (this._activeEditor = e)
				if (!(v instanceof FakeMarkdownView)) {
					internalActive = v;
				}
			},
		};

		const prev = capturePreviousActiveEditor(ws.activeEditor, null, null);
		expect(prev).toBe(activeMdView);

		ws.activeEditor = syntheticOwner;
		expect(ws.activeEditor).toBe(syntheticOwner);

		restorePreviousActiveEditor(ws, syntheticOwner, prev);
		expect(internalActive).toBeNull();
		expect(ws.activeEditor).toBe(activeMdView);
	});
});

describe('edit-task 命令在 ctx 为合成 owner 或无 file 时的兜底', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	function setupCommand(lineText: string, lineIndex = 2) {
		let capturedCallback: ((editor: unknown, ctx: unknown) => void) | null = null;
		const mdEditor = {
			getCursor: () => ({ line: lineIndex, ch: 0 }),
			getLine: (n: number) => (n === lineIndex ? lineText : ''),
			setLine: jest.fn(),
		};
		const mdView = {
			file: { path: 'v1.8.5 Update Plan.md', basename: 'v1.8.5 Update Plan' },
			editor: mdEditor,
		};
		const plugin = {
			addCommand: (cmd: { editorCallback?: (editor: unknown, ctx: unknown) => void }) => {
				capturedCallback = cmd.editorCallback ?? null;
			},
			settings: { enabledTaskFormats: ['tasks'], globalTaskFilter: '#task' },
			app: {
				workspace: {
					getActiveViewOfType: () => mdView,
				},
			},
			taskCache: { refreshFile: jest.fn().mockResolvedValue(undefined) },
			refreshCalendarViews: jest.fn(),
		} as unknown as GanttCalendarPlugin;

		registerEditTaskCommand(plugin);
		if (!capturedCallback) throw new Error('editorCallback not registered');
		return { callback: capturedCallback as (editor: unknown, ctx: unknown) => void, mdEditor };
	}

	test('ctx 为 DescriptionEditor 合成 owner 时回退到当前 MarkdownView 打开编辑弹窗', () => {
		const { callback } = setupCommand('- [x] #task/tool/obsidian/gantt_calendar 18:00 - 24:00 Update **gantt calendar plugin**', 7);
		const staleEditor = {
			getCursor: () => ({ line: 0, ch: 0 }),
			getLine: () => '',
		};
		callback(staleEditor, { __gcDescEditorOwner: true });

		expect(openEditTaskModalMock).toHaveBeenCalledTimes(1);
		expect(openEditTaskModalMock.mock.calls[0][1]).toMatchObject({
			filePath: 'v1.8.5 Update Plan.md',
			lineNumber: 8,
		});
	});

	test('ctx.file 缺失且光标在普通列表行时回退到 MarkdownView 打开新建弹窗', () => {
		const { callback } = setupCommand('\t- [ ] Support both Chinese and English', 10);
		// 有复选框但无 #task，edit-task 会补上 #task 再走 edit
		const staleEditor = {
			getCursor: () => ({ line: 0, ch: 0 }),
			getLine: () => '',
		};
		callback(staleEditor, { file: null });
		expect(openEditTaskModalMock).toHaveBeenCalledTimes(1);

		jest.clearAllMocks();
		const plain = setupCommand('\t- ![[Pasted image 20261102132245.png|400]]', 12);
		plain.callback(staleEditor, { file: null });
		expect(openCreateTaskModalMock).toHaveBeenCalledTimes(1);
		expect(openCreateTaskModalMock.mock.calls[0][0]).toMatchObject({
			createAt: { filePath: 'v1.8.5 Update Plan.md', line: 12 },
			initialDescription: '![[Pasted image 20261102132245.png|400]]',
		});
	});
});

describe('无日期任务与空/非法日期健壮性（防 getFullYear TypeError）', () => {
	test('formatDate 传入 null / undefined / Invalid Date 时安全返回空字符串', () => {
		expect(formatDate(null)).toBe('');
		expect(formatDate(undefined)).toBe('');
		expect(formatDate(new Date('invalid'))).toBe('');
		expect(formatDate(new Date(NaN), 'yyyy-MM-dd HH:mm')).toBe('');
		expect(formatDate(new Date(2026, 9, 19), 'yyyy-MM-dd')).toBe('2026-10-19');
	});

	test('serializeNewTask 在全部日期为 null 或 Invalid Date 时不抛错且不输出空日期标记', () => {
		const invalid = new Date('invalid');
		const lineTasks = serializeNewTask(
			{
				description: 'Dateless task',
				createdDate: null,
				startDate: null,
				scheduledDate: null,
				dueDate: null,
				completionDate: null,
				cancelledDate: null,
			},
			makeApp(['tasks'])
		);
		expect(lineTasks).toBe('- [ ] Dateless task');

		const lineInvalid = serializeNewTask(
			{
				description: 'Invalid date task',
				createdDate: invalid,
				startDate: invalid,
				scheduledDate: invalid,
				dueDate: invalid,
				completionDate: invalid,
				cancelledDate: invalid,
			},
			makeApp(['dataview'])
		);
		expect(lineInvalid).toBe('- [ ] Invalid date task');
	});

	test('serializeTask 在任务本身无日期且 updates 清空/传入 null/Invalid Date 时不抛错', () => {
		const task: GCTask = {
			filePath: 'note.md',
			fileName: 'note',
			lineNumber: 1,
			content: 'Plain task',
			description: 'Plain task',
			completed: false,
			priority: 'normal',
			status: 'todo',
		};
		const serialized = serializeTask(
			makeApp(['tasks']),
			task,
			{
				createdDate: null,
				startDate: null,
				scheduledDate: null,
				dueDate: null,
				completionDate: null,
				cancelledDate: null,
				priority: 'high',
			},
			'tasks'
		);
		expect(serialized).toBe('[ ] Plain task ⏫');

		const serializedInvalid = serializeTask(
			makeApp(['tasks']),
			{ ...task, dueDate: new Date('invalid') },
			{ content: 'Updated plain' },
			'tasks'
		);
		expect(serializedInvalid).toBe('[ ] Updated plain');
	});

	test('createTaskInDailyNote / createTaskInWeeklyNote 写入全 null 日期任务不触发 getFullYear 异常', async () => {
		const todayName = `${formatDate(new Date(), 'yyyy-MM-dd')}.md`;
		const todayFile = new TFile() as TFile & { name: string; basename: string };
		todayFile.path = `Journal/${todayName}`;
		todayFile.name = todayName;
		todayFile.basename = todayName.replace(/\.md$/, '');

		const dailyFile = new TFile() as TFile & { name: string; basename: string };
		dailyFile.path = 'Journal/2026-10-19.md';
		dailyFile.name = '2026-10-19.md';
		dailyFile.basename = '2026-10-19';

		const weeklyFile = new TFile() as TFile & { name: string; basename: string };
		weeklyFile.path = 'Journal/2026-W43.md';
		weeklyFile.name = '2026-W43.md';
		weeklyFile.basename = '2026-W43';

		const journalFolder = new TFolder() as TFolder & { path: string; children: unknown[] };
		journalFolder.path = 'Journal';
		journalFolder.children = [todayFile, dailyFile, weeklyFile];

		const files: Record<string, string> = {
			[todayFile.path]: '# Today',
			'Journal/2026-10-19.md': '# Daily',
			'Journal/2026-W43.md': '# Weekly',
		};

		const app = {
			plugins: {
				plugins: {
					'gantt-calendar': {
						settings: {
							enabledTaskFormats: ['tasks'],
							globalTaskFilter: '#task',
						},
					},
					'notebook-navigator': {
						settings: {
							calendarIntegrationMode: 'notebook-navigator',
							calendarCustomFilePattern: 'YYYY-MM-DD',
							calendarCustomWeekPattern: 'gggg-[W]ww',
							vaultProfiles: [{ id: 'default', periodicNotesFolder: 'Journal' }],
						},
					},
				},
				getPlugin: (id: string) =>
					id === 'notebook-navigator'
						? {
								settings: {
									calendarIntegrationMode: 'notebook-navigator',
									calendarCustomFilePattern: 'YYYY-MM-DD',
									calendarCustomWeekPattern: 'gggg-[W]ww',
									vaultProfiles: [{ id: 'default', periodicNotesFolder: 'Journal' }],
								},
							}
						: null,
			},
			vault: {
				getAbstractFileByPath: (p: string) => (p === 'Journal' ? journalFolder : null),
				getFileByPath: (p: string) =>
					p === todayFile.path
						? todayFile
						: p === dailyFile.path
							? dailyFile
							: p === weeklyFile.path
								? weeklyFile
								: null,
				read: async (f: { path: string }) => files[f.path],
				modify: async (f: { path: string }, content: string) => {
					files[f.path] = content;
				},
			},
		} as unknown as App;

		// 手动模式：传入 null date 时安全回退到当天，不触发 getFullYear 异常
		const manualSettings = {
			dailyNoteSource: 'manual',
			dailyNotePath: 'Journal',
			dailyNoteNameFormat: 'yyyy-MM-dd',
			newTaskHeading: '',
		} as unknown as GanttCalendarSettings;

		const manualPath = await createTaskInDailyNote(
			app,
			{ description: 'Daily dateless', createdDate: null, startDate: null, scheduledDate: null, dueDate: null },
			manualSettings,
			undefined,
			null as unknown as Date
		);
		expect(manualPath).toBe(todayFile.path);
		expect(files[todayFile.path]).toContain('- [ ] #task Daily dateless');
		expect(files[todayFile.path]).not.toContain('➕');
		expect(
			await createTaskInWeeklyNote(
				app,
				{ description: 'Weekly dateless', createdDate: null, startDate: null, scheduledDate: null, dueDate: null },
				manualSettings,
				null as unknown as Date
			)
		).toBeNull();

		// Notebook Navigator 模式：提供 window.moment，验证日期与周记写入全无日期任务行
		const win = window as unknown as { moment?: unknown };
		const prevMoment = win.moment;
		win.moment = () => ({
			format: (fmt: string) => (fmt.includes('W') ? '2026-W43' : '2026-10-19'),
		});
		try {
			const nnSettings = {
				dailyNoteSource: 'notebook-navigator',
				newTaskHeading: '',
			} as unknown as GanttCalendarSettings;

			const dPath = await createTaskInDailyNote(
				app,
				{ description: 'NN daily dateless', createdDate: null, startDate: null, scheduledDate: null, dueDate: null },
				nnSettings,
				undefined,
				new Date(2026, 9, 19)
			);
			expect(dPath).toBe('Journal/2026-10-19.md');
			expect(files['Journal/2026-10-19.md']).toContain('- [ ] #task NN daily dateless');
			expect(files['Journal/2026-10-19.md']).not.toContain('➕');

			const wPath = await createTaskInWeeklyNote(
				app,
				{ description: 'NN weekly dateless', createdDate: null, startDate: null, scheduledDate: null, dueDate: null },
				nnSettings,
				null as unknown as Date
			);
			expect(wPath).toBe('Journal/2026-W43.md');
			expect(files['Journal/2026-W43.md']).toContain('- [ ] #task NN weekly dateless');
			expect(files['Journal/2026-W43.md']).not.toContain('➕');
		} finally {
			win.moment = prevMoment;
		}
	});
});
