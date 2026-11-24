/** @jest-environment jsdom */
import {
	extractTaskChildrenFromLines,
	extractTaskChildrenFromDataview,
	formatBulletItemsForEditor,
	serializeBulletTextToLines,
	applyTaskChildrenUpdates,
} from '../src/tasks/taskParser/children';
import { parseTasksFromListItems } from '../src/tasks/taskParser/main';
import type { ListItemCache } from 'obsidian';

describe('子任务与任务下方 bullet items 识别', () => {
	it('只提取直接一级子任务（忽略二级子任务与备注下嵌套子任务），支持不带全局筛选符的子任务', () => {
		const lines = [
			'- [ ] #task 实现新功能 📅 2026-11-24',
			'\t- [ ] 一级子任务 A',
			'\t\t- [ ] 二级子任务 A1（不应显示）',
			'\t\t- 一级子任务 A 的备注（不应进入父任务 bullet）',
			'\t- [x] #task 一级子任务 B ⏫ ✅ 2026-11-23',
			'\t- 普通备注',
			'\t\t- [ ] 备注下的嵌套子任务（既不是一级子任务也不进 bullet）',
			'\t\t\t- 嵌套子任务下的备注（不应进入父任务 bullet）',
			'- [ ] #task 下一个同级任务',
		];

		const { subtasks, bulletItems } = extractTaskChildrenFromLines(lines, 0, '#task');

		expect(subtasks).toHaveLength(2);
		expect(subtasks[0]).toMatchObject({
			lineNumber: 2,
			checkboxSymbol: ' ',
			completed: false,
			description: '一级子任务 A',
		});
		expect(subtasks[1]).toMatchObject({
			lineNumber: 5,
			checkboxSymbol: 'x',
			completed: true,
			description: '一级子任务 B',
		});

		expect(bulletItems).toEqual([
			{ lineNumber: 6, level: 0, marker: '-', text: '普通备注' },
		]);
	});

	it('bullet items 支持多级纯文字/列表缩进，过滤子任务及其下级内容', () => {
		const lines = [
			'- [ ] #task 父任务',
			'    - 第一条说明',
			'        - 二级说明 A',
			'            - 三级说明 A1',
			'        - 二级说明 B',
			'    - [ ] 子任务 1',
			'        - 子任务 1 下的 bullet（排除）',
			'            - 子任务 1 下的更深 bullet（排除）',
			'    * 第二条说明（星号）',
			'        1. 有序二级说明',
		];

		const { subtasks, bulletItems } = extractTaskChildrenFromLines(lines, 0, '#task');

		expect(subtasks).toHaveLength(1);
		expect(subtasks[0].description).toBe('子任务 1');
		expect(bulletItems).toEqual([
			{ lineNumber: 2, level: 0, marker: '-', text: '第一条说明' },
			{ lineNumber: 3, level: 1, marker: '-', text: '二级说明 A' },
			{ lineNumber: 4, level: 2, marker: '-', text: '三级说明 A1' },
			{ lineNumber: 5, level: 1, marker: '-', text: '二级说明 B' },
			{ lineNumber: 9, level: 0, marker: '*', text: '第二条说明（星号）' },
			{ lineNumber: 10, level: 1, marker: '1.', text: '有序二级说明' },
		]);
	});

	it('Dataview children 树与 Markdown 行解析结果完全一致', () => {
		const lines = [
			'- [ ] #task 父任务',
			'  - 备注 1',
			'    - 备注 1.1',
			'      - 备注 1.1.1',
			'    - [ ] 备注下嵌套子任务',
			'      - 嵌套子任务备注',
			'  - [ ] 直接子任务 1',
			'    - 子任务 1 备注',
			'    - [x] 二级子任务',
			'  - [x] 直接子任务 2',
			'  - 备注 2',
		];
		const fromMd = extractTaskChildrenFromLines(lines, 0, '#task');

		const dvChildren = [
			{
				line: 1,
				task: false,
				symbol: '-',
				text: '备注 1',
				children: [
					{
						line: 2,
						task: false,
						symbol: '-',
						text: '备注 1.1',
						children: [
							{ line: 3, task: false, symbol: '-', text: '备注 1.1.1', children: [] },
						],
					},
					{
						line: 4,
						task: true,
						status: ' ',
						symbol: '-',
						text: '备注下嵌套子任务',
						children: [
							{ line: 5, task: false, symbol: '-', text: '嵌套子任务备注', children: [] },
						],
					},
				],
			},
			{
				line: 6,
				task: true,
				status: ' ',
				symbol: '-',
				text: '直接子任务 1',
				children: [
					{ line: 7, task: false, symbol: '-', text: '子任务 1 备注', children: [] },
					{ line: 8, task: true, status: 'x', symbol: '-', text: '二级子任务', children: [] },
				],
			},
			{ line: 9, task: true, status: 'x', symbol: '-', text: '直接子任务 2', children: [] },
			{ line: 10, task: false, symbol: '-', text: '备注 2', children: [] },
		];
		const fromDv = extractTaskChildrenFromDataview(dvChildren, '#task');

		expect(fromDv).toEqual(fromMd);
	});

	it('parseTasksFromListItems 自动填充 GCTask.subtasks 与 GCTask.bulletItems', () => {
		const lines = [
			'- [ ] #task 写文档 📅 2026-11-24',
			'  - 参考 [[Guide]]',
			'    - 第二节',
			'  - [ ] 校对英文版',
		];
		const listItems: ListItemCache[] = lines.map((l, i) => ({
			position: { start: { line: i, col: 0, offset: 0 }, end: { line: i, col: l.length, offset: 0 } },
		})) as ListItemCache[];

		const tasks = parseTasksFromListItems({ path: 'doc.md', basename: 'doc' }, lines, listItems, ['tasks'], '#task');
		expect(tasks).toHaveLength(1);
		expect(tasks[0].subtasks?.map((s) => s.description)).toEqual(['校对英文版']);
		expect(tasks[0].bulletItems?.map((b) => [b.level, b.text])).toEqual([
			[0, '参考 [[Guide]]'],
			[1, '第二节'],
		]);
	});

	it('支持引用块内的任务子项提取', () => {
		const lines = [
			'> - [ ] #task 引用任务',
			'>   - 引用备注 1',
			'>     - 引用备注 1.1',
			'>   - [ ] 引用子任务',
			'正文非引用',
		];
		const { subtasks, bulletItems } = extractTaskChildrenFromLines(lines, 0, '#task');
		expect(subtasks.map((s) => s.description)).toEqual(['引用子任务']);
		expect(bulletItems.map((b) => [b.level, b.text])).toEqual([
			[0, '引用备注 1'],
			[1, '引用备注 1.1'],
		]);
	});
});

describe('bullet items 编辑框格式转换与写回', () => {
	it('formatBulletItemsForEditor 与 serializeBulletTextToLines 兼容多级列表和纯文字', () => {
		const text = formatBulletItemsForEditor([
			{ lineNumber: 2, level: 0, marker: '-', text: '一级' },
			{ lineNumber: 3, level: 1, marker: '-', text: '二级' },
			{ lineNumber: 4, level: 2, marker: '-', text: '三级' },
		]);
		expect(text).toBe('- 一级\n  - 二级\n    - 三级');

		// 也兼容用户直接输入无 `- ` 的多级纯文字
		const serialized = serializeBulletTextToLines('纯文字一级\n  纯文字二级\n    纯文字三级', '', '\t');
		expect(serialized).toEqual([
			'\t- 纯文字一级',
			'\t\t- 纯文字二级',
			'\t\t\t- 纯文字三级',
		]);
	});

	it('applyTaskChildrenUpdates 仅勾选一级子任务时原地修改且不扰动其它行', () => {
		const lines = [
			'- [ ] #task 父任务',
			'\t- 备注 A',
			'\t- [ ] 子任务 1',
			'\t\t- 子任务 1 备注',
			'\t- [x] 子任务 2',
			'- [ ] #task 下一个任务',
		];
		applyTaskChildrenUpdates(lines, 0, {
			subtaskToggles: [
				{ lineNumber: 3, rawContent: '子任务 1', completed: true },
				{ lineNumber: 5, rawContent: '子任务 2', completed: false },
			],
		});
		expect(lines).toEqual([
			'- [ ] #task 父任务',
			'\t- 备注 A',
			'\t- [x] 子任务 1',
			'\t\t- 子任务 1 备注',
			'\t- [ ] 子任务 2',
			'- [ ] #task 下一个任务',
		]);
	});

	it('applyTaskChildrenUpdates 修改 bullet items 时完整保留子任务及其下级内容', () => {
		const lines = [
			'- [ ] #task 父任务',
			'\t- 旧备注',
			'\t- [ ] 子任务 1',
			'\t\t- 子任务 1 下的重要备注',
			'\t\t- [ ] 二级子任务',
			'- [ ] #task 后续任务',
		];
		applyTaskChildrenUpdates(lines, 0, {
			bulletText: '- 新备注一\n  - 新备注二',
			subtaskToggles: [{ lineNumber: 3, rawContent: '子任务 1', completed: true }],
		});
		expect(lines).toEqual([
			'- [ ] #task 父任务',
			'\t- 新备注一',
			'\t\t- 新备注二',
			'\t- [x] 子任务 1',
			'\t\t- 子任务 1 下的重要备注',
			'\t\t- [ ] 二级子任务',
			'- [ ] #task 后续任务',
		]);
	});
});
