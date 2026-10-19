/**
 * File-based task：frontmatter 解析、项目双链渲染、日历归类与甘特行模型
 */
import { buildFileTask, matchesRequiredTags, parseFileTaskDate, parseFileTaskProject, parseRequiredTags, taskDateRange, type FileTaskFileContext, type FileTaskSources } from '../src/fileTasks/fileTaskParser';
import { buildGanttRows, excludeGroupedTasks, fileTaskToCalendarTask } from '../src/fileTasks/fileTaskLayer';
import type { FileTask, GCTask } from '../src/types';

const props = { start: 'start', end: 'end', project: 'project' };
const resolve = (linkpath: string) => (linkpath === 'Alpha' ? { path: 'Projects/Alpha/Alpha.md', basename: 'Alpha' } : null);

function ft(filePath: string, start: string, end: string, project?: FileTask['project']): FileTask {
	return { filePath, title: filePath.replace(/\.md$/, ''), start: parseFileTaskDate(start)!, end: parseFileTaskDate(end)!, project, dateSource: 'frontmatter' };
}

function task(filePath: string, description: string): GCTask {
	return { filePath, fileName: filePath, lineNumber: 1, content: description, description, completed: false, priority: 'normal' };
}

const file = { path: 'a.md', basename: 'a' };
const DATED: FileTaskSources = { includeDated: true, includeTaskFiles: false, requiredTags: [] };
const TASKS: FileTaskSources = { includeDated: false, includeTaskFiles: true, requiredTags: [] };
const BOTH: FileTaskSources = { includeDated: true, includeTaskFiles: true, requiredTags: [] };
const ctx = (over: Partial<FileTaskFileContext> = {}): FileTaskFileContext => ({
	tags: [], tasks: [], isDailyNote: false, excludeDailyNotes: true, ...over,
});
const build = (fm: Record<string, unknown> | undefined, sources = DATED, c = ctx()) => buildFileTask(file, fm, props, resolve, sources, c);
const d = (s: string) => parseFileTaskDate(s)!;
function dated(over: Partial<GCTask>): GCTask {
	return { ...task('a.md', 't'), ...over };
}

describe('frontmatter 解析', () => {
	it('日期与日期时间', () => {
		expect(parseFileTaskDate('2026-06-18')?.getDate()).toBe(18);
		expect(parseFileTaskDate('2026-06-18T09:30')?.getHours()).toBe(9);
		expect(parseFileTaskDate('not a date')).toBeUndefined();
		expect(parseFileTaskDate(42)).toBeUndefined();
	});

	it('只有一端按单日；结束早于开始钳到开始', () => {
		expect(build({ start: '2026-01-02' })?.end.getDate()).toBe(2);
		expect(build({ start: '2026-01-05', end: '2026-01-02' })?.end.getDate()).toBe(5);
		expect(build({ title: 'x' })).toBeNull();
	});

	it('项目双链：解析目标作分组键，显示别名/文件名而非 [[...]]', () => {
		expect(parseFileTaskProject('[[Alpha|Alpha 项目]]', resolve)).toEqual({ key: 'Projects/Alpha/Alpha.md', label: 'Alpha 项目', linkPath: 'Projects/Alpha/Alpha.md' });
		expect(parseFileTaskProject(['[[Alpha]]'], resolve)).toEqual({ key: 'Projects/Alpha/Alpha.md', label: 'Alpha', linkPath: 'Projects/Alpha/Alpha.md' });
		expect(parseFileTaskProject('[[Missing#Sec]]', resolve)).toEqual({ key: 'Missing#Sec', label: 'Missing > Sec' });
		expect(parseFileTaskProject('Plain Group', resolve)).toEqual({ key: 'Plain Group', label: 'Plain Group' });
		expect(parseFileTaskProject(undefined, resolve)).toBeUndefined();
	});
});

describe('日历归类', () => {
	const files = [ft('Design.md', '2026-10-19', '2026-10-23')];

	it('文件占位任务为 day 精度区间', () => {
		const t = fileTaskToCalendarTask(files[0], 'startDate', 'dueDate', 'dueDate');
		expect(t.fileTask).toBe(files[0]);
		expect(t.startDate?.getDate()).toBe(19);
		expect(t.dueDate?.getDate()).toBe(23);
		expect(t.datePrecision).toEqual({ startDate: 'day', dueDate: 'day' });
	});

	it('收起文件内任务，keep 判定的任务（定时任务）保留', () => {
		const a = task('Design.md', 'a');
		const timed = task('Design.md', 'timed');
		const other = task('Other.md', 'other');
		expect(excludeGroupedTasks([a, timed, other], files, (t) => t === timed)).toEqual([timed, other]);
	});
});

describe('甘特行模型', () => {
	const alpha = { key: 'Projects/Alpha/Alpha.md', label: 'Alpha', linkPath: 'Projects/Alpha/Alpha.md' };
	const files = [
		ft('Loose.md', '2026-10-20', '2026-10-21'),
		ft('Design.md', '2026-10-19', '2026-10-23', alpha),
		ft('Build.md', '2026-10-22', '2026-10-28', alpha),
	];
	const items = [task('Design.md', 'd1'), task('Inline.md', 'i1'), task('Build.md', 'b1')];
	const shape = (rows: ReturnType<typeof buildGanttRows<GCTask>>) => rows.map((r) => {
		switch (r.kind) {
			case 'section': return `#${r.section}`;
			case 'project': return `@${r.label}`;
			case 'file': return `F:${r.fileTask.filePath}`;
			case 'task': return `${r.nested ? '  ' : ''}T:${r.item.description}`;
		}
	});

	it('不归类：文件分区（项目 → 无项目在底部）+ 任务分区保留全部任务', () => {
		expect(shape(buildGanttRows(files, items, (t) => t.filePath, false))).toEqual([
			'#files', '@Alpha', 'F:Design.md', 'F:Build.md', '@', 'F:Loose.md',
			'#tasks', 'T:d1', 'T:i1', 'T:b1',
		]);
	});

	it('归类：任务移到所属文件行下，下方只剩不属于文件任务的任务', () => {
		expect(shape(buildGanttRows(files, items, (t) => t.filePath, true))).toEqual([
			'#files', '@Alpha', 'F:Design.md', '  T:d1', 'F:Build.md', '  T:b1', '@', 'F:Loose.md',
			'#tasks', 'T:i1',
		]);
	});

	it('折叠的文件行不展开归类任务，并记录收起数量', () => {
		const rows = buildGanttRows(files, items, (t) => t.filePath, true, new Set(['Design.md']));
		expect(shape(rows)).toEqual([
			'#files', '@Alpha', 'F:Design.md', 'F:Build.md', '  T:b1', '@', 'F:Loose.md',
			'#tasks', 'T:i1',
		]);
		const design = rows.find((r) => r.kind === 'file' && r.fileTask.filePath === 'Design.md');
		expect(design).toMatchObject({ childCount: 1, collapsed: true });
	});

	it('全部文件都无项目时不出现项目标题', () => {
		expect(shape(buildGanttRows([files[0]], items, (t) => t.filePath, false)).slice(0, 2)).toEqual(['#files', 'F:Loose.md']);
	});

	it('没有文件任务时与原甘特图一致', () => {
		expect(shape(buildGanttRows([], items, (t) => t.filePath, true))).toEqual(['T:d1', 'T:i1', 'T:b1']);
	});
});

describe('引入来源与边界情况', () => {
	it('标签设置解析与匹配（去 #、不区分大小写、父标签匹配子标签）', () => {
		expect(parseRequiredTags(' #Project, area/work，x  x ')).toEqual(['project', 'area/work', 'x']);
		expect(matchesRequiredTags(['#project/alpha'], ['project'])).toBe(true);
		expect(matchesRequiredTags(['projects'], ['project'])).toBe(false);
		expect(matchesRequiredTags(['#Work'], ['work'])).toBe(true);
		expect(matchesRequiredTags([], [])).toBe(true);
	});

	it('带日期属性来源：不要求有任务；标签过滤不命中则不引入', () => {
		expect(build({ start: '2026-10-19' })?.dateSource).toBe('frontmatter');
		const tagged: FileTaskSources = { ...DATED, requiredTags: ['project'] };
		expect(build({ start: '2026-10-19' }, tagged, ctx({ tags: ['#misc'] }))).toBeNull();
		expect(build({ start: '2026-10-19' }, tagged, ctx({ tags: ['#project/alpha'] }))).not.toBeNull();
	});

	it('只开含任务来源：有日期属性但没有任务的笔记不引入', () => {
		expect(build({ start: '2026-10-19', end: '2026-10-20' }, TASKS)).toBeNull();
	});

	it('含任务来源：无日期属性时取未取消任务的 🛫/⏳/📅 最早到最晚，创建/完成日期不参与', () => {
		const tasks = [
			dated({ dueDate: d('2026-10-22'), createdDate: d('2026-09-01') }),
			dated({ scheduledDate: d('2026-10-20') }),
			dated({ startDate: d('2026-10-18'), completionDate: d('2026-11-30') }),
			dated({ dueDate: d('2026-12-31'), cancelled: true }),
			dated({}),
		];
		const t = build(undefined, TASKS, ctx({ tasks }));
		expect(t?.start.getDate()).toBe(18);
		expect(t?.end.getMonth()).toBe(9);
		expect(t?.end.getDate()).toBe(22);
		expect(t?.dateSource).toBe('tasks');
	});

	it('含任务来源：任务都没有日期且无属性 → 不引入；没有任务 → 不引入', () => {
		expect(build(undefined, TASKS, ctx({ tasks: [dated({})] }))).toBeNull();
		expect(build({ title: 'x' }, TASKS, ctx())).toBeNull();
		expect(taskDateRange([])).toBeNull();
	});

	it('含任务来源：日期属性优先，缺的一端用任务补齐（mixed），结束早于开始钳到开始', () => {
		const tasks = [dated({ dueDate: d('2026-10-25') })];
		const mixed = build({ start: '2026-10-19' }, TASKS, ctx({ tasks }));
		expect(mixed?.end.getDate()).toBe(25);
		expect(mixed?.dateSource).toBe('mixed');
		const full = build({ start: '2026-10-19', end: '2026-10-20' }, TASKS, ctx({ tasks }));
		expect(full?.end.getDate()).toBe(20);
		expect(full?.dateSource).toBe('frontmatter');
		// 只有 end 属性且早于任务推导的开始：钳成单日
		const clamped = build({ end: '2026-10-10' }, TASKS, ctx({ tasks }));
		expect(clamped?.start.getDate()).toBe(25);
		expect(clamped?.end.getDate()).toBe(25);
	});

	it('每日笔记：含任务来源下被排除；关闭排除或日记自带日期属性（另一来源）时仍引入', () => {
		const tasks = [dated({ dueDate: d('2026-10-19') })];
		expect(build(undefined, TASKS, ctx({ tasks, isDailyNote: true }))).toBeNull();
		expect(build(undefined, TASKS, ctx({ tasks, isDailyNote: true, excludeDailyNotes: false }))).not.toBeNull();
		expect(build({ start: '2026-10-19' }, BOTH, ctx({ tasks, isDailyNote: true }))?.dateSource).toBe('frontmatter');
	});

	it('两个来源都开：取并集（标签不命中但有任务的带日期笔记仍经含任务来源引入）', () => {
		const tagged: FileTaskSources = { ...BOTH, requiredTags: ['project'] };
		const tasks = [dated({ dueDate: d('2026-10-21') })];
		expect(build({ start: '2026-10-19' }, tagged, ctx({ tasks }))?.end.getDate()).toBe(21);
		expect(build({ start: '2026-10-19' }, tagged, ctx())).toBeNull();
	});
});
