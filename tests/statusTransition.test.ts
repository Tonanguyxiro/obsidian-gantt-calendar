import { statusTransitionUpdates, isMenuStatus } from '../src/tasks/statusTransition';
import { mergeGlobalFilterAndTags } from '../src/tasks/globalFilterTags';

const NOW = new Date(2026, 9, 20, 10, 0);
const plain = { completed: false, cancelled: false };

describe('statusTransitionUpdates', () => {
	it('done：完成 + 补完成日期（已有则保留）+ 清取消', () => {
		expect(statusTransitionUpdates(plain, 'done', NOW)).toEqual({ status: 'done', completed: true, completionDate: NOW, cancelled: false });
		const had = new Date(2026, 9, 1);
		expect(statusTransitionUpdates({ ...plain, completionDate: had }, 'done', NOW).completionDate).toBe(had);
		expect(statusTransitionUpdates({ completed: false, cancelled: true, cancelledDate: had }, 'done', NOW).cancelledDate).toBeNull();
	});
	it('canceled：取消 + 补取消日期 + 清完成', () => {
		expect(statusTransitionUpdates({ completed: true, cancelled: false, completionDate: NOW }, 'canceled', NOW)).toEqual({
			status: 'canceled', cancelled: true, cancelledDate: NOW, completed: false, completionDate: null,
		});
	});
	it('其他状态（含自定义）：清完成/取消及日期，无则不动日期字段', () => {
		expect(statusTransitionUpdates(plain, 'in_progress', NOW)).toEqual({ status: 'in_progress', completed: false, cancelled: false });
		expect(statusTransitionUpdates({ completed: true, cancelled: false, completionDate: NOW }, 'todo', NOW)).toEqual({
			status: 'todo', completed: false, cancelled: false, completionDate: null,
		});
	});
	it('右键菜单不列 done / canceled（有各自的命令）', () => {
		expect(['todo', 'important', 'in_progress', 'custom'].every(isMenuStatus)).toBe(true);
		expect(isMenuStatus('done') || isMenuStatus('canceled')).toBe(false);
	});
});

describe('mergeGlobalFilterAndTags', () => {
	it('标签形式的筛选符不重复；子标签在时不补写筛选符；非标签筛选符原样', () => {
		expect(mergeGlobalFilterAndTags('#task', ['task', 'paper'])).toEqual({ filter: '#task', tags: ['paper'] });
		expect(mergeGlobalFilterAndTags('#task', ['task/work', 'x'])).toEqual({ filter: null, tags: ['task/work', 'x'] });
		expect(mergeGlobalFilterAndTags('🎯', ['a'])).toEqual({ filter: '🎯', tags: ['a'] });
		expect(mergeGlobalFilterAndTags('', ['a', ' '])).toEqual({ filter: null, tags: ['a'] });
		expect(mergeGlobalFilterAndTags(' #task ', undefined)).toEqual({ filter: '#task', tags: [] });
	});
});

import { isStatusInPicker, getPickerStatuses } from '../src/tasks/statusTransition';
import type { App } from 'obsidian';

describe('状态选择器可见性（showInPicker）', () => {
	const mk = (statuses: Array<{ key: string; showInPicker?: boolean }>) =>
		({ plugins: { plugins: { 'gantt-calendar': { settings: { taskStatuses: statuses } } } } } as unknown as App);

	it('缺省显示，false 隐藏', () => {
		expect(isStatusInPicker({ showInPicker: undefined } as never)).toBe(true);
		expect(isStatusInPicker({ showInPicker: true } as never)).toBe(true);
		expect(isStatusInPicker({ showInPicker: false } as never)).toBe(false);
	});
	it('隐藏的状态不列出，但任务当前正在用的始终保留', () => {
		const app = mk([{ key: 'todo' }, { key: 'question', showInPicker: false }, { key: 'in_progress', showInPicker: false }]);
		expect(getPickerStatuses(app).map(s => s.key)).toEqual(['todo']);
		expect(getPickerStatuses(app, 'question').map(s => s.key)).toEqual(['todo', 'question']);
	});
});
