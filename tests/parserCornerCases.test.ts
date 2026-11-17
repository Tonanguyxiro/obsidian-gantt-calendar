/**
 * 解析 corner case：12h 时间前缀、stripPlannerTime、enabledFormats=[] 兜底。
 */
import { App } from 'obsidian';
import { parseSingleTaskLine, parseTasksFromListItems } from '../src/tasks/taskParser/main';
import { parsePlannerTime, stripPlannerTime } from '../src/tasks/taskParser/utils';
import { serializeTask } from '../src/tasks/taskSerializer';
import { RegularExpressions } from '../src/utils/RegularExpressions';

const app = { plugins: { getPlugin: () => ({ settings: { globalTaskFilter: '' } }) } } as unknown as App;

describe('Day Planner 时间前缀 - 12h AM/PM', () => {
	it('parsePlannerTime 识别 12h 区间', () => {
		expect(parsePlannerTime('1:00 PM - 2:00 PM Review')).toEqual({ startMin: 780, endMin: 840 });
		expect(parsePlannerTime('09:00 AM - 10:00 AM Standup')).toEqual({ startMin: 540, endMin: 600 });
		expect(parsePlannerTime('12:00 AM - 12:00 PM Midnight shift')).toEqual({ startMin: 0, endMin: 720 });
	});

	it('parseSingleTaskLine 解析 12h 行', () => {
		const t = parseSingleTaskLine('- [ ] 1:00 PM - 2:00 PM Review ⏳ 2026-11-16', 'n.md', 'n', 1, ['tasks']);
		expect(t?.plannerTime).toEqual({ startMin: 780, endMin: 840 });
		expect(t?.description).toContain('1:00 PM - 2:00 PM Review');
	});

	it('stripPlannerTime 完整剥掉 AM/PM 前缀', () => {
		expect(stripPlannerTime('1:00 PM - 2:00 PM Review')).toBe('Review');
		expect(stripPlannerTime('09:00 AM - 10:00 AM Standup')).toBe('Standup');
		expect(stripPlannerTime('21:00 - 24:00 ICLR')).toBe('ICLR');
	});

	it('既有 24h 写法不受影响', () => {
		expect(parsePlannerTime('21:00 - 24:00 ICLR')).toEqual({ startMin: 1260, endMin: 1440 });
		expect(parsePlannerTime('00:00 - 24:00 All day')).toEqual({ startMin: 0, endMin: 1440 });
		expect(parsePlannerTime('21:00-24:00 No spaces')).toEqual({ startMin: 1260, endMin: 1440 });
		expect(parsePlannerTime('9:00 - 10:00 No leading zero')).toEqual({ startMin: 540, endMin: 600 });
		expect(parsePlannerTime('21:00 Single start')).toEqual({ startMin: 1260 });
		expect(parsePlannerTime('24:00 - 24:00 Zero')).toEqual({ startMin: 1440 });
	});

	it('非法时间仍不被识别为 plannerTime', () => {
		expect(parsePlannerTime('25:00 - 26:00 Invalid')).toBeUndefined();
		expect(parsePlannerTime('12:99 Bad minute')).toBeUndefined();
		expect(parsePlannerTime('13:00 PM Bad hour')).toBeUndefined();
		// 正则本身仍可切分（用于 strip），但数值校验在 hmToMin 拒绝
		expect(RegularExpressions.DayPlanner.timePrefix.test('25:00 - 26:00 Invalid')).toBe(true);
	});
});

describe('enabledFormats=[] 兜底', () => {
	it('parseSingleTaskLine 仍解析 dataview 字段', () => {
		const t = parseSingleTaskLine('- [ ] Review [due:: 2026-11-20]', 'n.md', 'n', 1, [], '');
		expect(t?.format).toBe('dataview');
		expect(t?.dueDate).toBeInstanceOf(Date);
		expect(t?.dueDate?.getDate()).toBe(20);
	});

	it('serializeTask 不丢 [due:: ...] 字段', () => {
		const t = parseSingleTaskLine('- [ ] Review [due:: 2026-11-20]', 'n.md', 'n', 1, [], '')!;
		const out = serializeTask(app, t, {}, 'dataview');
		expect(out).toContain('[due:: 2026-11-20]');
	});

	it('parseTasksFromListItems 空数组也兜底', () => {
		const tasks = parseTasksFromListItems(
			{ path: 'n.md', basename: 'n' },
			['- [ ] Review [due:: 2026-11-20]'],
			[{ position: { start: { line: 0 } } }] as never,
			[],
			''
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].format).toBe('dataview');
		expect(tasks[0].dueDate).toBeInstanceOf(Date);
	});

	it('显式只启用 tasks 时行为不变', () => {
		const line = '- [ ] Review [due:: 2026-11-20]';
		const tasksOnly = parseSingleTaskLine(line, 'n.md', 'n', 1, ['tasks'], '');
		expect(tasksOnly?.format).toBeUndefined();
		expect(tasksOnly?.dueDate).toBeUndefined();
	});
});
