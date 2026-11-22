import { TFile } from 'obsidian';
import { TaskDataAdapter } from '../src/gantt/adapters/taskDataAdapter';
import { TaskUpdateHandler } from '../src/gantt/handlers/taskUpdateHandler';
import type { GanttChartTask } from '../src/gantt/types';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';
import { applyScheduledFallback, expandTimeSlots } from '../src/tasks/scheduledFallback';
import type { GCTask, IPluginContext } from '../src/types';

function makeApp(files: Record<string, string>) {
	const fileOf = (path: string) => {
		const f = new TFile();
		f.path = path;
		return f;
	};
	return {
		vault: {
			getAbstractFileByPath: (path: string) => fileOf(path),
			read: async (file: TFile) => files[file.path],
			modify: async (file: TFile, content: string) => {
				files[file.path] = content;
			},
		},
		plugins: { getPlugin: () => null },
	} as unknown as ConstructorParameters<typeof TaskUpdateHandler>[0];
}

function makePlugin(app: ConstructorParameters<typeof TaskUpdateHandler>[0], enabledTaskFormats = ['tasks', 'dataview']): IPluginContext {
	return {
		app,
		settings: {
			enabledTaskFormats,
		},
	} as unknown as IPluginContext;
}

function parse(line: string, lineNumber = 1): GCTask {
	const task = parseSingleTaskLine(line, 'note.md', 'note.md', lineNumber, ['tasks', 'dataview'], '');
	if (!task) throw new Error(`Failed to parse task line: ${line}`);
	return task;
}

describe('Gantt ⏳-only single-day bar', () => {
	it('renders scheduledProxy without plannerTime as a single-day bar with no leadStart', () => {
		const raw = parse('- [ ] 只计划任务 ➕ 2026-10-01 ⏳ 2026-10-19');
		const proxied = applyScheduledFallback(raw, 'startDate', 'dueDate', 'dueDate');

		const gantt = TaskDataAdapter.toGanttChartTask(proxied, 'startDate', 'dueDate');
		expect(gantt).not.toBeNull();
		expect(gantt!.start).toBe('2026-10-19');
		expect(gantt!.end).toBe('2026-10-19');
		expect(gantt!.leadStart).toBeUndefined();
		expect(gantt!.startSourceField).toBe('scheduledDate');
		expect(gantt!.scheduledProxy).toBe(proxied.scheduledProxy);
	});

	it('renders raw un-proxied ⏳-only task (neither startField nor endField set) as a single-day bar', () => {
		const raw = parse('- [ ] 原始计划任务 ➕ 2026-10-02 ⏳ 2026-10-20');
		const gantt = TaskDataAdapter.toGanttChartTask(raw, 'startDate', 'dueDate');

		expect(gantt).not.toBeNull();
		expect(gantt!.start).toBe('2026-10-20');
		expect(gantt!.end).toBe('2026-10-20');
		expect(gantt!.leadStart).toBeUndefined();
		expect(gantt!.startSourceField).toBe('scheduledDate');
		expect(gantt!.scheduledProxy).toBeDefined();
		expect(gantt!.scheduledProxy?.source).toBe(raw);
	});

	it('does not treat plannerTime, slot, or legacy proxies as plain ⏳-only single-day bars', () => {
		const timed = parse('- [ ] 09:00 - 10:30 晨会 ⏳ 2026-10-19');
		const timedProxy = applyScheduledFallback(timed, 'startDate', 'dueDate', 'dueDate');
		const timedGantt = TaskDataAdapter.toGanttChartTask(timedProxy, 'startDate', 'dueDate');
		expect(timedGantt?.timeLabel).toBe('09:00 → 10:30');
		expect(timedGantt?.startSourceField).toBe('startDate');

		const dual = parse('- [ ] 09:00 - 10:00 会议 🛫 2026-10-18 ⏳ 2026-10-19 📅 2026-10-21');
		const expanded = expandTimeSlots([dual], 'startDate', 'dueDate', 'dueDate');
		const slotProxy = expanded.find((t) => t.scheduledProxy?.slot);
		expect(slotProxy).toBeDefined();
		const slotGantt = TaskDataAdapter.toGanttChartTask(slotProxy!, 'startDate', 'dueDate');
		expect(slotGantt?.timeLabel).toBe('09:00 → 10:00');
		expect(slotGantt?.startSourceField).toBe('startDate');

		const legacy = parse('- [ ] 旧时刻 🛫 2026-10-19 09:00 📅 2026-10-19 11:00');
		const [legacyProxy] = expandTimeSlots([legacy], 'startDate', 'dueDate', 'dueDate');
		expect(legacyProxy.scheduledProxy?.legacy).toBe(true);
		const legacyGantt = TaskDataAdapter.toGanttChartTask(legacyProxy, 'startDate', 'dueDate');
		expect(legacyGantt?.timeLabel).toBe('09:00 → 11:00');
		expect(legacyGantt?.startSourceField).toBe('startDate');
	});

	it('dragging a proxied ⏳-only single-day bar updates ONLY ⏳ and never writes 🛫 or 📅', async () => {
		const files: Record<string, string> = {
			'note.md': '- [ ] 只计划 #work ➕ 2026-10-01 ⏳ 2026-10-19',
		};
		const app = makeApp(files);
		const handler = new TaskUpdateHandler(app, makePlugin(app));

		const raw = parse(files['note.md']);
		const proxied = applyScheduledFallback(raw, 'startDate', 'dueDate', 'dueDate');
		const gantt = TaskDataAdapter.toGanttChartTask(proxied, 'startDate', 'dueDate')!;

		const newDate = new Date(2026, 9, 23);
		await handler.handleDateChange(gantt, newDate, new Date(newDate), 'startDate', 'dueDate', [raw]);

		expect(files['note.md']).toBe('- [ ] #work 只计划 ➕ 2026-10-01 ⏳ 2026-10-23');
		expect(files['note.md']).not.toContain('🛫');
		expect(files['note.md']).not.toContain('📅');
	});

	it('dragging a raw un-proxied ⏳-only single-day bar updates ONLY ⏳ (tasks & dataview) without writing start/due', async () => {
		const files: Record<string, string> = {
			'note.md': [
				'- [ ] 任务A ⏳ 2026-10-19',
				'- [ ] 任务B [scheduled:: 2026-10-19]',
			].join('\n'),
		};
		const app = makeApp(files);
		const handler = new TaskUpdateHandler(app, makePlugin(app));

		const rawTasks = parseSingleTaskLine(files['note.md'].split('\n')[0], 'note.md', 'note.md', 1, ['tasks', 'dataview'], '')!;
		const ganttTasks = TaskDataAdapter.toGanttChartTask(rawTasks, 'startDate', 'dueDate')!;
		await handler.handleDateChange(ganttTasks, new Date(2026, 9, 25), new Date(2026, 9, 25), 'startDate', 'dueDate', [rawTasks]);

		const rawDv = parseSingleTaskLine(files['note.md'].split('\n')[1], 'note.md', 'note.md', 2, ['tasks', 'dataview'], '')!;
		const ganttDv = TaskDataAdapter.toGanttChartTask(rawDv, 'startDate', 'dueDate')!;
		await handler.handleDateChange(ganttDv, new Date(2026, 9, 26), new Date(2026, 9, 26), 'startDate', 'dueDate', [rawDv]);

		const lines = files['note.md'].split('\n');
		expect(lines[0]).toBe('- [ ] 任务A ⏳ 2026-10-25');
		expect(lines[1]).toBe('- [ ] 任务B [scheduled:: 2026-10-26]');
	});

	it('handles un-proxied GanttChartTask with startSourceField="scheduledDate" on same-day drag', async () => {
		const files: Record<string, string> = {
			'note.md': '- [ ] 手动单日 ⏳ 2026-10-19',
		};
		const app = makeApp(files);
		const handler = new TaskUpdateHandler(app, makePlugin(app));

		const raw = parse(files['note.md']);
		const manualGantt: GanttChartTask = {
			...raw,
			id: 'note-1',
			name: raw.description,
			start: '2026-10-19',
			end: '2026-10-19',
			progress: 0,
			startSourceField: 'scheduledDate',
			scheduledProxy: undefined,
		};

		await handler.handleDateChange(manualGantt, new Date(2026, 9, 21), new Date(2026, 9, 21), 'startDate', 'dueDate', [raw]);
		expect(files['note.md']).toBe('- [ ] 手动单日 ⏳ 2026-10-21');
	});

	it('resizing a ⏳-only bar to multi-day still promotes to startDate + dueDate via resolveScheduledProxyUpdates', async () => {
		const files: Record<string, string> = {
			'note.md': '- [ ] 拉长任务 ⏳ 2026-10-19',
		};
		const app = makeApp(files);
		const handler = new TaskUpdateHandler(app, makePlugin(app));

		const raw = parse(files['note.md']);
		const gantt = TaskDataAdapter.toGanttChartTask(raw, 'startDate', 'dueDate')!;
		await handler.handleDateChange(gantt, new Date(2026, 9, 19), new Date(2026, 9, 22), 'startDate', 'dueDate', [raw]);

		expect(files['note.md']).toBe('- [ ] 拉长任务 🛫 2026-10-19 ⏳ 2026-10-19 📅 2026-10-22');
	});
});
