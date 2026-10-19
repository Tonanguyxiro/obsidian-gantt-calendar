/**
 * 计划日期回退 + Day Planner 时间前缀 + 标签/双链显示 回归测试
 */
import { TFile } from 'obsidian';
import { updateTaskProperties } from '../src/tasks/taskUpdater';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';
import { applyScheduledFallback, unwrapTask } from '../src/tasks/scheduledFallback';
import { getTaskInterval, buildMonthTimelineModel } from '../src/ui/views/week/timelineModel';
import { taskDisplayText, wikilinkDisplayText, linksToPlainText } from '../src/utils/linkText';
import type { GCTask } from '../src/types';

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
	} as unknown as Parameters<typeof updateTaskProperties>[0];
}

function parse(line: string, lineNumber = 1): GCTask {
	const t = parseSingleTaskLine(line, 'note.md', 'note', lineNumber, ['tasks', 'dataview'], '');
	if (!t) throw new Error('not a task');
	return t;
}

describe('Day Planner 时间前缀解析', () => {
	it('解析 "09:00 - 10:00" 区间', () => {
		const t = parse('- [ ] 09:00 - 10:00 开会 ⏳ 2026-10-19');
		expect(t.plannerTime).toEqual({ startMin: 540, endMin: 600 });
		expect(t.description).toBe('09:00 - 10:00 开会');
	});
	it('解析单时刻 "9:30"', () => {
		expect(parse('- [ ] 9:30 写周报 ⏳ 2026-10-19').plannerTime).toEqual({ startMin: 570 });
	});
	it('非法时间与非前缀不解析', () => {
		expect(parse('- [ ] 25:00 无效 ⏳ 2026-10-19').plannerTime).toBeUndefined();
		expect(parse('- [ ] 会议 09:00 ⏳ 2026-10-19').plannerTime).toBeUndefined();
	});
	it('显示文本隐藏时间前缀', () => {
		expect(taskDisplayText('09:00 - 10:00 开会')).toBe('开会');
		expect(taskDisplayText('开会')).toBe('开会');
	});
});

describe('计划日期回退代理', () => {
	it('仅有 ⏳ 的全天任务映射到日期字段（day 精度）', () => {
		const t = parse('- [ ] 只计划 ⏳ 2026-10-19');
		const p = applyScheduledFallback(t, 'startDate', 'dueDate', 'dueDate');
		expect(p).not.toBe(t);
		expect(p.dueDate?.getDate()).toBe(19);
		expect(p.datePrecision?.dueDate).toBe('day');
		expect(p.startDate).toBeUndefined();
		expect(unwrapTask(p)).toBe(t);
		// 月视图：落在 19 日格内
		const week = { days: Array.from({ length: 7 }, (_, i) => ({ date: new Date(2026, 9, 19 + i) })) };
		const [model] = buildMonthTimelineModel([p], [week], 'startDate', 'dueDate', 'dueDate');
		expect(model.cells.get('2026-10-19')).toEqual([p]);
	});

	it('Day Planner 前缀映射为当日时段区间', () => {
		const t = parse('- [ ] 09:00 - 10:30 开会 ⏳ 2026-10-19');
		const p = applyScheduledFallback(t, 'startDate', 'dueDate', 'dueDate');
		const interval = getTaskInterval(p, 'startDate', 'dueDate', 'dueDate');
		expect(interval?.kind).toBe('interval');
		expect(interval?.start.getHours()).toBe(9);
		expect(interval?.end.getHours()).toBe(10);
		expect(interval?.end.getMinutes()).toBe(30);
	});

	it('单时刻前缀按默认 60 分钟成块', () => {
		const p = applyScheduledFallback(parse('- [ ] 14:00 评审 ⏳ 2026-10-19'), 'startDate', 'dueDate', 'dueDate');
		const interval = getTaskInterval(p, 'startDate', 'dueDate', 'dueDate');
		expect(interval?.start.getHours()).toBe(14);
		expect(interval?.end.getHours()).toBe(15);
	});

	it('已有 📅 / 🛫 的任务不代理（计划日期只作第二顺位）', () => {
		const t1 = parse('- [ ] 有截止 ⏳ 2026-10-19 📅 2026-10-25');
		expect(applyScheduledFallback(t1, 'startDate', 'dueDate', 'dueDate')).toBe(t1);
		const t2 = parse('- [ ] 有开始 🛫 2026-10-18 ⏳ 2026-10-19');
		expect(applyScheduledFallback(t2, 'startDate', 'dueDate', 'dueDate')).toBe(t2);
	});

	it('有 🛫/📅 带时刻时按起止定位，⏳ 与行首时间前缀都被忽略', () => {
		const t = parse('- [ ] 14:00 - 15:00 会议 🛫 2026-10-20 09:00 ⏳ 2026-10-21 📅 2026-10-20 11:00');
		expect(t.datePrecision?.startDate).toBe('time');
		const p = applyScheduledFallback(t, 'startDate', 'dueDate', 'dueDate');
		expect(p).toBe(t);
		const interval = getTaskInterval(p, 'startDate', 'dueDate', 'dueDate');
		expect(interval?.kind).toBe('interval');
		expect(interval?.start.getDate()).toBe(20);
		expect(interval?.start.getHours()).toBe(9);
		expect(interval?.end.getHours()).toBe(11);
	});

	it('有 🛫/📅（仅日期）时为跨日横跨条，⏳ 与前缀被忽略', () => {
		const t = parse('- [ ] 08:00 跨天任务 🛫 2026-10-19 ⏳ 2026-10-25 📅 2026-10-21');
		const p = applyScheduledFallback(t, 'startDate', 'dueDate', 'dueDate');
		expect(p).toBe(t);
		expect(getTaskInterval(p, 'startDate', 'dueDate', 'dueDate')).toBeNull();
		const week = { days: Array.from({ length: 7 }, (_, i) => ({ date: new Date(2026, 9, 19 + i) })) };
		const [model] = buildMonthTimelineModel([p], [week], 'startDate', 'dueDate', 'dueDate');
		expect(model.spanBars).toHaveLength(1);
		expect(model.spanBars[0]).toMatchObject({ startCol: 0, endCol: 2 });
	});

	it('日期字段本就是计划日期时：前缀仍生效，无前缀则原样', () => {
		const plain = parse('- [ ] 计划 ⏳ 2026-10-19');
		expect(applyScheduledFallback(plain, 'startDate', 'dueDate', 'scheduledDate')).toBe(plain);
		const timed = applyScheduledFallback(parse('- [ ] 08:00 - 09:00 晨会 ⏳ 2026-10-19'), 'startDate', 'dueDate', 'scheduledDate');
		expect(timed.datePrecision?.startDate).toBe('time');
	});
});

describe('代理写回：还原为 ⏳ + 时间前缀', () => {
	const line = '- [ ] 09:00 - 10:00 开会 ⏳ 2026-10-19';

	it('时间块平移：改写前缀与计划日期，不写 🛫/📅', async () => {
		const files: Record<string, string> = { 'note.md': line };
		const app = makeApp(files);
		const p = applyScheduledFallback(parse(line), 'startDate', 'dueDate', 'dueDate');
		const taskToUpdate = { ...p, datePrecision: { ...p.datePrecision, startDate: 'time' as const, dueDate: 'time' as const } };
		await updateTaskProperties(app, taskToUpdate, {
			startDate: new Date(2026, 9, 21, 14, 0),
			dueDate: new Date(2026, 9, 21, 15, 30),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 14:00 - 15:30 开会 ⏳ 2026-10-21');
	});

	it('单时刻前缀平移后仍为单时刻写法', async () => {
		const src = '- [ ] 14:00 评审 ⏳ 2026-10-20';
		const files: Record<string, string> = { 'note.md': src };
		const app = makeApp(files);
		const p = applyScheduledFallback(parse(src), 'startDate', 'dueDate', 'dueDate');
		await updateTaskProperties(app, p, {
			startDate: new Date(2026, 9, 21, 14, 0),
			dueDate: new Date(2026, 9, 21, 15, 0),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 14:00 评审 ⏳ 2026-10-21');
	});

	it('拖到全天：移除前缀', async () => {
		const files: Record<string, string> = { 'note.md': line };
		const app = makeApp(files);
		const p = applyScheduledFallback(parse(line), 'startDate', 'dueDate', 'dueDate');
		const taskToUpdate = { ...p, datePrecision: { ...p.datePrecision, startDate: 'day' as const, dueDate: 'day' as const } };
		await updateTaskProperties(app, taskToUpdate, {
			startDate: new Date(2026, 9, 22),
			dueDate: new Date(2026, 9, 22),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 开会 ⏳ 2026-10-22');
	});

	it('跨日拉长（甘特）：写入真实起止字段', async () => {
		const files: Record<string, string> = { 'note.md': '- [ ] 只计划 ⏳ 2026-10-19' };
		const app = makeApp(files);
		const p = applyScheduledFallback(parse(files['note.md']), 'startDate', 'dueDate', 'dueDate');
		await updateTaskProperties(app, p, {
			startDate: new Date(2026, 9, 19),
			dueDate: new Date(2026, 9, 23),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 只计划 🛫 2026-10-19 ⏳ 2026-10-19 📅 2026-10-23');
	});

	it('勾选完成：不写入代理字段', async () => {
		const files: Record<string, string> = { 'note.md': line };
		const app = makeApp(files);
		const p = applyScheduledFallback(parse(line), 'startDate', 'dueDate', 'dueDate');
		await updateTaskProperties(app, p, { completed: true, status: 'done' }, ['tasks']);
		expect(files['note.md']).toBe('- [x] 09:00 - 10:00 开会 ⏳ 2026-10-19');
	});
});

describe('标签过滤与双链显示', () => {
	it('含连字符/emoji 的标签从描述中移除', () => {
		const t = parse('- [ ] 跟进 #project-x 进度 #📌 #a/b-c 📅 2026-10-19');
		expect(t.description).toBe('跟进 进度');
		expect(t.tags).toEqual(['project-x', '📌', 'a/b-c']);
	});
	it('双链标题锚点里的 # 不当作标签', () => {
		const t = parse('- [ ] 阅读 [[Note#Heading]] 与 [[Doc|别名]] #read 📅 2026-10-19');
		expect(t.description).toBe('阅读 [[Note#Heading]] 与 [[Doc|别名]]');
		expect(t.tags).toEqual(['read']);
	});
	it('纯数字不是标签', () => {
		expect(parse('- [ ] 第 #1 项 📅 2026-10-19').tags).toBeUndefined();
	});
	it('双链显示文本与 Obsidian 一致', () => {
		expect(wikilinkDisplayText('Note#Heading')).toBe('Note > Heading');
		expect(wikilinkDisplayText('Doc', '别名')).toBe('别名');
		expect(wikilinkDisplayText('#Heading')).toBe('Heading');
		expect(linksToPlainText('读 [[Doc|别名]] 和 [[A#B]]')).toBe('读 别名 和 A > B');
	});
});
