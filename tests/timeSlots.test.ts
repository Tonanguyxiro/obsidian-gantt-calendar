/**
 * 起止只管日期区间，具体时刻由 ⏳ + 行首时间前缀（时间片）决定，二者互不干扰
 */
import { TFile } from 'obsidian';
import { updateTaskProperties } from '../src/tasks/taskUpdater';
import { parseSingleTaskLine } from '../src/tasks/taskParser/main';
import { expandTimeSlots, asSlotTarget, isSlotItem } from '../src/tasks/scheduledFallback';
import { migrateLegacyTimes } from '../src/tasks/legacyTimes';
import { dragTaskId, findTaskById } from '../src/ui/utils/taskId';
import { taskKey } from '../src/ui/utils/taskKey';
import type { GCTask } from '../src/types';

function makeApp(files: Record<string, string>) {
	const fileOf = (path: string) => { const f = new TFile(); f.path = path; return f; };
	return {
		vault: {
			getAbstractFileByPath: (path: string) => fileOf(path),
			read: async (file: TFile) => files[file.path],
			modify: async (file: TFile, content: string) => { files[file.path] = content; },
		},
		plugins: { getPlugin: () => null },
	} as unknown as Parameters<typeof updateTaskProperties>[0];
}
const parse = (line: string, n = 1): GCTask => parseSingleTaskLine(line, 'note.md', 'note', n, ['tasks'], '')!;
const expand = (t: GCTask) => expandTimeSlots([t], 'startDate', 'dueDate', 'dueDate');
const hm = (d?: Date) => d && `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('expandTimeSlots：区间条与时间片并存', () => {
	it('起止 + ⏳ + 前缀：日期精度的区间条 + 一个 slot 时间片代理', () => {
		const items = expand(parse('- [ ] 14:00 - 16:00 评审 🛫 2026-10-20 📅 2026-10-22 ⏳ 2026-10-21'));
		expect(items).toHaveLength(2);
		const [bar, slot] = items;
		expect(bar.scheduledProxy).toBeUndefined();
		expect(bar.datePrecision).toMatchObject({ startDate: 'day', dueDate: 'day' });
		expect(isSlotItem(slot)).toBe(true);
		expect(slot.datePrecision).toMatchObject({ startDate: 'time', dueDate: 'time' });
		expect([hm(slot.startDate), hm(slot.dueDate)]).toEqual(['14:00', '16:00']);
		expect(slot.startDate?.getDate()).toBe(21);
	});

	it('只有 ⏳ + 前缀：仅时间片（原有回退代理）；只有起止：仅区间条', () => {
		expect(expand(parse('- [ ] 09:00 - 10:00 评审 ⏳ 2026-10-22'))).toHaveLength(1);
		const plain = expand(parse('- [ ] 纯区间 🛫 2026-10-20 📅 2026-10-23'));
		expect(plain).toHaveLength(1);
		expect(plain[0].scheduledProxy).toBeUndefined();
	});

	it('旧写法（起止带时刻的同日任务）按时间片显示，legacy 标记，不另出区间条', () => {
		const items = expand(parse('- [ ] 旧写法 🛫 2026-10-21 14:00 📅 2026-10-21 15:30'));
		expect(items).toHaveLength(1);
		expect(items[0].scheduledProxy?.legacy).toBe(true);
		expect([hm(items[0].startDate), hm(items[0].dueDate)]).toEqual(['14:00', '15:30']);
	});

	it('时间片与区间条的拖拽 id / key 不同，findTaskById 各自找回', () => {
		const items = expand(parse('- [ ] 14:00 评审 🛫 2026-10-20 📅 2026-10-22 ⏳ 2026-10-21'));
		const [bar, slot] = items;
		expect(dragTaskId(bar)).toBe('note.md:1');
		expect(dragTaskId(slot)).toBe('note.md:1#slot');
		expect(taskKey(bar)).not.toBe(taskKey(slot));
		expect(findTaskById(items, 'note.md:1')).toBe(bar);
		expect(findTaskById(items, 'note.md:1#slot')).toBe(slot);
	});
});

describe('写回：时间片只改 ⏳ + 前缀，起止日期区间不动', () => {
	it('拖动时间片到另一天：⏳ 与前缀改变，🛫/📅 原样', async () => {
		const files = { 'note.md': '- [ ] 14:00 - 16:00 评审 🛫 2026-10-20 📅 2026-10-22 ⏳ 2026-10-21' };
		const slot = expand(parse(files['note.md']))[1];
		await updateTaskProperties(makeApp(files), { ...slot, datePrecision: { ...slot.datePrecision } }, {
			startDate: new Date(2026, 9, 22, 10, 0), dueDate: new Date(2026, 9, 22, 12, 0),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 10:00 - 12:00 评审 🛫 2026-10-20 ⏳ 2026-10-22 📅 2026-10-22');
	});

	it('区间条 / 全天任务拖进时间轴：新建时间片（⏳ + 前缀），起止不动', async () => {
		const files = { 'note.md': '- [ ] 纯区间 🛫 2026-10-20 📅 2026-10-23' };
		const bar = parse(files['note.md']);
		const target = asSlotTarget(bar, 'startDate', 'dueDate', 'dueDate');
		await updateTaskProperties(makeApp(files), { ...target, datePrecision: { ...target.datePrecision, startDate: 'time', dueDate: 'time' } }, {
			startDate: new Date(2026, 9, 24, 15, 0), dueDate: new Date(2026, 9, 24, 16, 0),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 15:00 纯区间 🛫 2026-10-20 ⏳ 2026-10-24 📅 2026-10-23');
	});

	it('时间片限制在一天内：终点越过午夜被钳到当日 24:00', async () => {
		const files = { 'note.md': '- [ ] 22:00 - 23:00 夜 🛫 2026-10-20 📅 2026-10-22 ⏳ 2026-10-21' };
		const slot = expand(parse(files['note.md']))[1];
		await updateTaskProperties(makeApp(files), { ...slot, datePrecision: { ...slot.datePrecision } }, {
			startDate: new Date(2026, 9, 21, 22, 0), dueDate: new Date(2026, 9, 22, 2, 0),
		}, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 22:00 - 24:00 夜 🛫 2026-10-20 ⏳ 2026-10-21 📅 2026-10-22');
	});
});

describe('旧写法迁移（任何一次写回）', () => {
	it('同日带时刻的起止 → ⏳ 当日 + 前缀，起止只留日期', async () => {
		const files = { 'note.md': '- [ ] 旧写法 🛫 2026-10-21 14:00 📅 2026-10-21 15:30' };
		await updateTaskProperties(makeApp(files), parse(files['note.md']), { priority: 'high' }, ['tasks']);
		expect(files['note.md']).toBe('- [ ] 14:00 - 15:30 旧写法 ⏫ 🛫 2026-10-21 ⏳ 2026-10-21 📅 2026-10-21');
	});

	it('已有时间片时不覆盖，只去掉起止上的时刻；跨日带时刻的只丢时刻', () => {
		const t = parse('- [ ] 09:00 - 10:00 评审 🛫 2026-10-20 14:00 📅 2026-10-22 16:00 ⏳ 2026-10-21');
		const out = migrateLegacyTimes(t, {});
		expect(out.content).toBeUndefined();
		expect(out.datePrecision).toMatchObject({ startDate: 'day', dueDate: 'day' });
		const cross = migrateLegacyTimes(parse('- [ ] 跨日 🛫 2026-10-20 14:00 📅 2026-10-22 16:00'), {});
		expect(cross.scheduledDate).toBeUndefined();
		expect(cross.content).toBeUndefined();
	});

	it('没有时刻的任务不动', () => {
		const t = parse('- [ ] 评审 🛫 2026-10-20 📅 2026-10-22');
		expect(migrateLegacyTimes(t, { priority: 'high' })).toEqual({ priority: 'high' });
	});
});
