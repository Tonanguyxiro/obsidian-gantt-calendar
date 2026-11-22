/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Platform } from 'obsidian';
import { WeekView } from '../src/ui/views/WeekView';
import { DayView } from '../src/ui/views/DayView';
import { WeekTimelineGrid } from '../src/ui/views/week/WeekTimelineGrid';
import { DayTimelineCanvas } from '../src/ui/views/week/DayTimelineCanvas';
import { buildWeekTimelineModel, buildDayTimelineModel, computeMaxLanesForWidth } from '../src/ui/views/week/timelineModel';
import { PluginContext } from '../src/ui/pluginContext';
import { TooltipProvider } from '../src/ui/components/TooltipProvider';
import { useCalendarStore } from '../src/ui/store/calendarStore';
import { DEFAULT_SETTINGS } from '../src/settings/constants';
import { WeekViewConfig, DayViewConfig } from '../src/components/TaskCard';
import { WeekViewClasses, DayCanvasClasses, TaskCardClasses } from '../src/utils/bem';
import type { GCTask, IPluginContext } from '../src/types';
import type { GanttCalendarSettings } from '../src/settings/types';

function cloneSettings(overrides?: Partial<GanttCalendarSettings>): GanttCalendarSettings {
	return {
		...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GanttCalendarSettings),
		...overrides,
	};
}

function makeTimedTask(id: number, day: Date, startHour: number, endHour: number, tags: string[] = []): GCTask {
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, 0);
	const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endHour, 0);
	return {
		filePath: `notes/t-${id}.md`,
		fileName: `t-${id}`,
		lineNumber: id,
		content: `- [ ] Very Long Overlapping Task Title Number ${id}`,
		description: `Very Long Overlapping Task Title Number ${id}`,
		completed: false,
		priority: 'high',
		status: 'todo',
		tags,
		startDate: start,
		dueDate: end,
		datePrecision: { startDate: 'time', dueDate: 'time' },
	};
}

function makePlugin(tasks: GCTask[], getTasksByDateRange?: (start: Date, end: Date) => GCTask[]): IPluginContext {
	return {
		app: {
			workspace: { rootSplit: {} },
			vault: { getAbstractFileByPath: () => null },
		} as unknown as IPluginContext['app'],
		settings: cloneSettings({ enableDailyNote: false }),
		dailyNoteIndex: {} as unknown as IPluginContext['dailyNoteIndex'],
		saveSettings: async () => {},
		refreshCalendarViews: () => {},
		taskCache: {
			getAllTasks: () => tasks,
			...(getTasksByDateRange ? { getTasksByDateRange } : {}),
			refreshFile: async () => {},
			onUpdate: () => {},
			offUpdate: () => {},
			initialize: async () => {},
			whenReady: async () => {},
		},
	};
}

describe('周/日视图铺满与超窄重叠列 CSS 规则检查', () => {
	let weekCss = '';
	let dayCanvasCss = '';
	let dayViewCss = '';
	let taskCardCss = '';
	let sidebarCss = '';

	beforeAll(async () => {
		if (!Platform.isDesktop) {
			throw new Error('CSS inspection requires desktop Node environment');
		}
		const fs = await import('node:fs');
		const path = await import('node:path');
		weekCss = fs.readFileSync(path.resolve('src/styles/views/week-view.css'), 'utf8');
		dayCanvasCss = fs.readFileSync(path.resolve('src/styles/components/day-canvas.css'), 'utf8');
		dayViewCss = fs.readFileSync(path.resolve('src/styles/views/day-view.css'), 'utf8');
		taskCardCss = fs.readFileSync(path.resolve('src/styles/components/task-card.css'), 'utf8');
		sidebarCss = fs.readFileSync(path.resolve('src/styles/components/sidebar.css'), 'utf8');
	});

	test('week-view.css 启用全高全宽铺满及 minmax(0, 1fr) 等宽列', () => {
		expect(weekCss).toMatch(/\.gc-view\.gc-view--week\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s);
		expect(weekCss).toMatch(/\.gc-week-view__grid\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s);
		expect(weekCss).toMatch(/\.gc-week-view__tasks-grid\s*\{[^}]*grid-template-columns:\s*48px repeat\(7,\s*minmax\(0,\s*1fr\)\);/s);
		expect(weekCss).toMatch(/\.gc-week-view__tasks-grid\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;/s);
	});

	test('day-view.css 为纯任务模式提供全高滚动容器', () => {
		expect(dayViewCss).toMatch(/\.gc-day-view--tasks-only\s*>\s*\.gc-day-canvas__body\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
	});

	test('时间块声明 gc-block 容器查询并支持 110px / 68px 窄列换行与悬停提层', () => {
		expect(weekCss).toMatch(/\.gc-week-view__time-block\s*\{[^}]*container:\s*gc-block\s+gc-time-block\s*\/\s*size;/s);
		expect(dayCanvasCss).toMatch(/\.gc-day-canvas__block\s*\{[^}]*container:\s*gc-block\s*\/\s*inline-size;/s);
		expect(dayCanvasCss).toMatch(/:is\(\.gc-day-canvas__block,\s*\.gc-week-view__time-block\)\s*\{[^}]*container:\s*gc-block\s+gc-time-block\s*\/\s*size;/s);

		// 110px 容器查询：缩减内边距/间距，隐藏标签与元数据，多行换行并按容器高限制行数防止末行纵切
		for (const css of [weekCss, dayCanvasCss]) {
			const block110Match = css.match(/@container\s+gc-block\s*\(max-width:\s*110px\)\s*\{([\s\S]*?)\n\}/);
			expect(block110Match).not.toBeNull();
			const block110 = block110Match![1];
			expect(block110).toContain('padding: 2px 2px 2px 3px');
			expect(block110).toContain('gap: 2px');
			expect(block110).toContain('.gc-task-card__tags');
			expect(block110).toContain('.gc-task-card__metadata');
			expect(block110).toContain('-webkit-line-clamp: var(--gc-narrow-lines');
			expect(block110).toContain('white-space: normal');
			expect(block110).toContain('word-break: break-word');
			expect(block110).toContain('overflow-wrap: anywhere');
			expect(block110).toContain('text-overflow: ellipsis');
			expect(block110).toContain('line-height: 1.2');

			// 68px 容器查询：隐藏复选框/优先级/时段，使用紧凑字号与多行换行
			const block68Match = css.match(/@container\s+gc-block\s*\(max-width:\s*68px\)\s*\{([\s\S]*?)\n\}/);
			expect(block68Match).not.toBeNull();
			const block68 = block68Match![1];
			expect(block68).toContain('.gc-task-card__checkbox');
			expect(block68).toContain('.gc-task-card__priority-badge');
			expect(block68).toContain('.gc-week-view__time-block-time');
			expect(block68).toContain('.gc-task-card__times');
			expect(block68).toContain('padding: 1px 2px 1px 3px');
			expect(block68).toContain('font-size: var(--gc-font-xxs)');
			expect(block68).toContain('line-height: 1.15');
			expect(block68).toContain('min-width: 0');
			expect(block68).toContain('width: 100%');
		}

		// ICS 标题在窄列中也启用多行换行
		expect(dayCanvasCss).toContain('.gc-ics-event__title');

		// 悬停/聚焦提层至 z-index: 20 + --gc-elev-3
		expect(weekCss).toMatch(/\.gc-week-view__time-block:hover,\s*\.gc-week-view__time-block:focus-within\s*\{[^}]*z-index:\s*20;[^}]*box-shadow:\s*var\(--gc-elev-3\);/s);
		expect(dayCanvasCss).toMatch(/\.gc-day-canvas__block:hover,\s*\.gc-day-canvas__block:focus-within\s*\{[^}]*z-index:\s*20;[^}]*box-shadow:\s*var\(--gc-elev-3\);/s);
	});

	test('窄分屏周表头隐藏农历并支持纵排自适应，且新增 CSS 无硬编码颜色或 px 字号', () => {
		expect(weekCss).toMatch(/@container\s+gc-app\s*\(max-width:\s*760px\)[\s\S]*?\.gc-week-view__lunar-text\s*\{\s*display:\s*none;/);
		expect(weekCss).toMatch(/@container\s+gc-app\s*\(max-width:\s*480px\)[\s\S]*?flex-direction:\s*column;/);
		expect(taskCardCss).toContain('.gc-task-card--sidebar .gc-task-card__text');
		expect(taskCardCss).toContain('.gc-task-card--sidebar:not(.gc-task-card--timeline)');
		expect(sidebarCss).toMatch(/\.gc-task-card--sidebar\s*\{[^}]*flex-wrap:\s*wrap;/s);
		expect(TaskCardClasses.modifiers.sidebarView).toBe('gc-task-card--sidebar');

		const colorRegex = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
		const fixedPxFontRegex = /\bfont-size\s*:\s*\d+(?:\.\d+)?px\b/g;
		for (const css of [weekCss, dayCanvasCss, dayViewCss]) {
			expect(css.match(colorRegex)).toBeNull();
			expect(css.match(fixedPxFontRegex)).toBeNull();
		}
	});
});

describe('WeekView / DayView / 窄重叠时间块 DOM 与 Store 集成', () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeAll(() => {
		const proto = HTMLElement.prototype as unknown as { hasClass?: (cls: string) => boolean };
		if (!proto.hasClass) {
			proto.hasClass = function hasClass(this: HTMLElement, cls: string) {
				return this.classList.contains(cls);
			};
		}
		if (!window.matchMedia) {
			window.matchMedia = (query: string) => ({
				matches: false,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			});
		}
	});

	beforeEach(() => {
		(window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		(window as unknown as { activeDocument?: Document }).activeDocument = document;
		useCalendarStore.getState().syncSettings(cloneSettings({ enableDailyNote: false }));
		useCalendarStore.setState({
			currentDate: new Date(2026, 9, 19),
			tasks: [],
			tasksReady: true,
		});
		container = document.createRange().createContextualFragment('<div></div>').firstElementChild as HTMLDivElement;
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test('WeekTimelineGrid 输出 minmax(0, 1fr) 网格列并在 4 重叠块时渲染 lane 与叠加偏移类', async () => {
		const weekStart = new Date(2026, 9, 19);
		const days = Array.from({ length: 7 }, (_, i) => {
			const d = new Date(weekStart);
			d.setDate(d.getDate() + i);
			return { date: d, isToday: i === 0, weekday: (i + 1) % 7, day: d.getDate() };
		});
		const overlapTasks = [
			makeTimedTask(1, weekStart, 9, 11, ['work']),
			makeTimedTask(2, weekStart, 9, 11, ['urgent']),
			makeTimedTask(3, weekStart, 9, 11),
			makeTimedTask(4, weekStart, 9, 11),
		];
		const model = buildWeekTimelineModel(overlapTasks, weekStart, 'startDate', 'dueDate', 'dueDate');
		const plugin = makePlugin(overlapTasks);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(WeekTimelineGrid, {
							days,
							dayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
							weekStart,
							model,
							tasks: overlapTasks,
							config: { ...WeekViewConfig, variant: 'timeline' },
							showLunar: false,
							refreshTasks: () => {},
							updateSeq: 0,
						}),
					),
				),
			);
		});

		const grid = container.querySelector(`.${WeekViewClasses.elements.tasksGrid}`) as HTMLElement;
		expect(grid.style.gridTemplateColumns).toBe('48px repeat(7, minmax(0, 1fr))');

		const blocks = Array.from(container.querySelectorAll<HTMLElement>(`.${WeekViewClasses.elements.timeBlock}`));
		expect(blocks).toHaveLength(4);
		expect(blocks.some((el) => el.classList.contains(WeekViewClasses.modifiers.timeBlockStacked))).toBe(true);
		// 3 列 lane + 第 4 个叠加偏移的宽度与 z-index 变量
		for (const blk of blocks) {
			expect(blk.style.width).toContain('33.333');
			expect(blk.style.getPropertyValue('--gc-block-z')).not.toBe('');
			expect(blk.querySelector(`.${TaskCardClasses.modifiers.timeline}`)).not.toBeNull();
		}

		// 3 日滑动窗口同样使用 minmax(0, 1fr)
		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(WeekTimelineGrid, {
							days,
							dayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
							weekStart,
							model,
							tasks: overlapTasks,
							config: { ...WeekViewConfig, variant: 'timeline' },
							showLunar: false,
							refreshTasks: () => {},
							updateSeq: 0,
							visibleDayIdxs: [0, 1, 2],
						}),
					),
				),
			);
		});
		expect(grid.style.gridTemplateColumns).toBe('48px repeat(3, minmax(0, 1fr))');
	});

	test('DayTimelineCanvas 在 4 重叠块时渲染 gc-day-canvas__block 与 --gc-block-z 变量', async () => {
		const day = new Date(2026, 9, 19);
		const overlapTasks = [
			makeTimedTask(1, day, 14, 16),
			makeTimedTask(2, day, 14, 16),
			makeTimedTask(3, day, 14, 16),
			makeTimedTask(4, day, 14, 16),
		];
		const model = buildDayTimelineModel(overlapTasks, day, 'startDate', 'dueDate', 'dueDate');
		const plugin = makePlugin(overlapTasks);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(DayTimelineCanvas, {
							day,
							model,
							config: { ...DayViewConfig, variant: 'timeline' },
							tasks: overlapTasks,
							refresh: () => {},
						}),
					),
				),
			);
		});

		const blocks = Array.from(container.querySelectorAll<HTMLElement>(`.${DayCanvasClasses.elements.block}`));
		expect(blocks).toHaveLength(4);
		expect(blocks.some((el) => el.classList.contains(DayCanvasClasses.modifiers.blockStacked))).toBe(true);
		for (const blk of blocks) {
			expect(blk.style.getPropertyValue('--gc-block-z')).not.toBe('');
		}
	});

	test('WeekView 与 DayView 传入 dateRange 调用 getTasksByDateRange 并响应 syncSettings', async () => {
		const day = new Date(2026, 9, 19);
		const task = makeTimedTask(1, day, 10, 11);
		const getRangeSpy = jest.fn<GCTask[], [Date, Date]>(() => [task]);
		const plugin = makePlugin([task], getRangeSpy);
		useCalendarStore.setState({ tasks: [task], updateSeq: 1, viewType: 'week' });

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(TooltipProvider, null, createElement(WeekView)),
				),
			);
		});

		expect(getRangeSpy).toHaveBeenCalledTimes(1);
		const [wStart, wEnd] = getRangeSpy.mock.calls[0];
		expect(wEnd.getTime() - wStart.getTime()).toBe(6 * 86400000);
		expect(container.querySelectorAll(`.${WeekViewClasses.elements.lunarText}`)).toHaveLength(7);

		// syncSettings 关闭农历后，WeekView 响应式隐藏农历（无需重载 plugin）
		await act(async () => {
			useCalendarStore.getState().syncSettings(cloneSettings({ enableDailyNote: false, showLunar: false }));
		});
		expect(container.querySelectorAll(`.${WeekViewClasses.elements.lunarText}`)).toHaveLength(0);

		// DayView 传入单日范围
		getRangeSpy.mockClear();
		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(TooltipProvider, null, createElement(DayView)),
				),
			);
		});
		expect(getRangeSpy).toHaveBeenCalledTimes(1);
		const [dStart, dEnd] = getRangeSpy.mock.calls[0];
		expect(dStart.getTime()).toBe(new Date(2026, 9, 19).getTime());
		expect(dEnd.getTime()).toBe(new Date(2026, 9, 19).getTime());
	});

	test('computeMaxLanesForWidth 按列宽限制并行 lane 数且侧边栏任务卡支持窄容器换行', async () => {
		expect(computeMaxLanesForWidth(0)).toBe(3);
		expect(computeMaxLanesForWidth(45)).toBe(1);
		expect(computeMaxLanesForWidth(95)).toBe(1);
		expect(computeMaxLanesForWidth(164)).toBe(2);
		expect(computeMaxLanesForWidth(260)).toBe(3);

		const day = new Date(2026, 9, 19);
		const overlapTasks = [
			makeTimedTask(1, day, 9, 11),
			makeTimedTask(2, day, 9, 11),
			makeTimedTask(3, day, 9, 11),
		];
		const narrowModel = buildWeekTimelineModel(overlapTasks, day, 'startDate', 'dueDate', 'dueDate', computeMaxLanesForWidth(45));
		expect(narrowModel.days[0].every(({ seg }) => seg.laneCount === 1)).toBe(true);
		expect(narrowModel.days[0].some(({ seg }) => seg.stackedIndex > 0)).toBe(true);
	});
});
