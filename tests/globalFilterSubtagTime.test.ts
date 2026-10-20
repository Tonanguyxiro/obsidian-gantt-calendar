import { passesGlobalFilter, removeGlobalFilter } from '../src/tasks/taskParser/step2';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';
import { serializeTask } from '../src/tasks/taskSerializer';
import { App } from 'obsidian';

const parse = (line: string) => parseSingleTaskLine(line, 'n.md', 'n.md', 1, ['tasks'], '#task');

describe('全局筛选符 #task：子标签与时间前缀在前', () => {
	it('#task/XXX 子标签通过筛选，整枚标签保留，不残留 "/XXX"', () => {
		expect(passesGlobalFilter('#task/work 写报告', '#task')).toBe(true);
		expect(removeGlobalFilter('#task/work 写报告', '#task')).toBe('#task/work 写报告');
		const t = parse('- [ ] #task/work 写报告 📅 2026-10-21')!;
		expect(t).not.toBeNull();
		expect(t.description).toBe('写报告');
		expect(t.tags).toEqual(['task/work']);
		expect(t.dueDate).toBeInstanceOf(Date);
	});

	it('时间区间在 #task 之前：通过筛选并识别时间前缀', () => {
		expect(passesGlobalFilter('09:00 - 10:30 #task 评审', '#task')).toBe(true);
		expect(removeGlobalFilter('09:00 - 10:30 #task 评审', '#task')).toBe('09:00 - 10:30 评审');
		const t = parse('- [ ] 09:00 - 10:30 #task 评审 ⏳ 2026-10-21')!;
		expect(t).not.toBeNull();
		expect(t.description).toBe('09:00 - 10:30 评审');
		expect(t.plannerTime).toEqual({ startMin: 540, endMin: 630 });
		expect(t.tags).toEqual(['task']);
	});

	it('时间区间 + #task/XXX 同时出现', () => {
		const t = parse('- [ ] 14:00 #task/meeting 周会 ⏳ 2026-10-21')!;
		expect(t).not.toBeNull();
		expect(t.description).toBe('14:00 周会');
		expect(t.plannerTime).toEqual({ startMin: 840 });
		expect(t.tags).toEqual(['task/meeting']);
	});

	it('原有写法不受影响；没有筛选符的行仍被排除', () => {
		expect(removeGlobalFilter('#task 评审 ⏫', '#task')).toBe('评审 ⏫');
		expect(removeGlobalFilter('🎯🎯 任务', '🎯 ')).toBe('🎯 任务');
		expect(passesGlobalFilter('09:00 - 10:30 评审', '#task')).toBe(false);
		expect(parse('- [ ] 09:00 - 10:30 评审')).toBeNull();
	});

	it('筛选符在行内任意位置（行尾 / 行中）也识别，与 Tasks 插件一致', () => {
		expect(passesGlobalFilter('写报告 #task', '#task')).toBe(true);
		expect(removeGlobalFilter('写报告 #task', '#task')).toBe('写报告');
		expect(removeGlobalFilter('写报告 #task 明天 ⏫', '#task')).toBe('写报告 明天 ⏫');
		const t = parse('- [ ] 写报告 #work #task ⏳ 2026-10-21')!;
		expect(t).not.toBeNull();
		expect(t.description).toBe('写报告');
		expect(t.tags).toEqual(['work', 'task']);
	});

	it('标签边界：#tasks、a#task 不算筛选符；非标签筛选符可在任意位置', () => {
		expect(passesGlobalFilter('评审 #tasks', '#task')).toBe(false);
		expect(passesGlobalFilter('评审 a#task', '#task')).toBe(false);
		expect(passesGlobalFilter('评审 #tasks #task', '#task')).toBe(true);
		expect(passesGlobalFilter('评审 🎯', '🎯')).toBe(true);
		expect(removeGlobalFilter('评审 🎯 明天', '🎯')).toBe('评审 明天');
	});

	it('重新序列化后仍能被识别（不残留 "/XXX"）', () => {
		const app = { plugins: { getPlugin: () => ({ settings: { globalTaskFilter: '#task' } }) } } as unknown as App;
		for (const line of ['- [ ] #task/work 写报告 📅 2026-10-21', '- [ ] 09:00 - 10:30 #task 评审 ⏳ 2026-10-21']) {
			const t = parse(line)!;
			const out = `- ${serializeTask(app, t, {}, 'tasks')}`;
			const again = parse(out);
			expect(again).not.toBeNull();
			expect(again!.description).toBe(t.description);
			expect(out).not.toMatch(/ \/work/);
		}
	});

	it('序列化：不输出重复的 #task；子标签在行首时不再补写过滤器', () => {
		const app = { plugins: { getPlugin: () => ({ settings: { globalTaskFilter: '#task' } }) } } as unknown as App;
		const out = (line: string) => `- ${serializeTask(app, parse(line)!, {}, 'tasks')}`;
		expect(out('- [ ] #task 普通 📅 2026-10-21')).toBe('- [ ] #task 普通 📅 2026-10-21');
		expect(out('- [ ] #task/work 写报告 📅 2026-10-21')).toBe('- [ ] #task/work 写报告 📅 2026-10-21');
		expect(out('- [ ] 09:00 - 10:30 #task 评审 ⏳ 2026-10-21')).toBe('- [ ] #task 09:00 - 10:30 评审 ⏳ 2026-10-21');
	});
});
