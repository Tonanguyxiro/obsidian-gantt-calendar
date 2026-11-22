/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VirtuosoMockContext } from 'react-virtuoso';
import { Platform } from 'obsidian';
import { TaskView } from '../src/ui/views/TaskView';
import { TaskListPanel } from '../src/ui/sidebar/TaskListPanel';
import { MonthView } from '../src/ui/views/MonthView';
import { TooltipProvider } from '../src/ui/components/TooltipProvider';
import { PluginContext } from '../src/ui/pluginContext';
import { useCalendarStore } from '../src/ui/store/calendarStore';
import { DEFAULT_SETTINGS } from '../src/settings/constants';
import { PRIORITY_ORDER, getPriorityMeta } from '../src/utils/priorityIcons';
import { DropdownMenuClasses, SidebarClasses, TaskCardClasses, TaskViewClasses } from '../src/utils/bem';
import type { GCTask, IPluginContext } from '../src/types';
import type { GanttCalendarSettings } from '../src/settings/types';

jest.mock('obsidian', () => {
	const actual = jest.requireActual<typeof import('./__mocks__/obsidian')>('./__mocks__/obsidian');
	return {
		...actual,
		setIcon: jest.fn((el: HTMLElement, icon: string) => {
			el.setAttribute('data-mock-lucide', icon);
		}),
	};
});

function makeDiv(cls?: string): HTMLDivElement {
	const frag = document.createRange().createContextualFragment('<div></div>');
	const el = frag.firstElementChild as HTMLDivElement;
	if (cls) el.className = cls;
	return el;
}

function cloneSettings(overrides?: Partial<GanttCalendarSettings>): GanttCalendarSettings {
	return {
		...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GanttCalendarSettings),
		...overrides,
	};
}

function makeTasks(count: number, dueDate: Date): GCTask[] {
	return Array.from({ length: count }, (_, i) => ({
		filePath: `folder/note-${i}.md`,
		fileName: `note-${i}.md`,
		lineNumber: i + 1,
		content: `- [ ] Task ${i + 1}`,
		description: `Task ${i + 1}`,
		completed: false,
		priority: i % 2 === 0 ? 'high' : 'normal',
		dueDate,
	}));
}

function makePlugin(
	settings: GanttCalendarSettings,
	getTasksByDateRange?: jest.Mock<GCTask[], [Date, Date]>
): IPluginContext {
	return {
		app: {
			vault: { getFileByPath: () => null },
			workspace: {},
		} as unknown as IPluginContext['app'],
		settings,
		saveSettings: async () => {},
		refreshCalendarViews: () => {},
		taskCache: {
			getAllTasks: () => [],
			getTasksByDateRange,
			refreshFile: async () => {},
			onUpdate: () => {},
			offUpdate: () => {},
			initialize: async () => {},
			whenReady: async () => {},
		} as unknown as IPluginContext['taskCache'],
	};
}

describe('TaskView / TaskListPanel 虚拟滚动与 MonthView 全铺设置集成', () => {
	let container: HTMLElement;
	let root: Root;
	let prevActiveDoc: unknown;
	let hadActiveDoc = false;
	let prevHasClass: unknown;

	beforeAll(() => {
		(window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const win = window as unknown as Record<string, unknown>;
		hadActiveDoc = 'activeDocument' in win;
		prevActiveDoc = win.activeDocument;
		win.activeDocument = document;
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		prevHasClass = proto.hasClass;
		if (!prevHasClass) {
			proto.hasClass = function (this: HTMLElement, cls: string) {
				return cls ? this.classList.contains(cls) : false;
			};
		}
	});

	afterAll(() => {
		const win = window as unknown as Record<string, unknown>;
		if (hadActiveDoc) win.activeDocument = prevActiveDoc;
		else delete win.activeDocument;
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		if (prevHasClass === undefined) delete proto.hasClass;
		else proto.hasClass = prevHasClass;
	});

	beforeEach(() => {
		Platform.isPhone = false;
		useCalendarStore.getState().syncSettings(cloneSettings({ taskViewDateRangeMode: 'all' }));
		useCalendarStore.setState({
			tasks: [],
			tasksReady: true,
			currentDate: new Date(2026, 10, 22),
			updateSeq: 0,
		});
		container = makeDiv();
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		document.body.replaceChildren();
		Platform.isPhone = false;
	});

	test('TaskView 使用 Virtuoso 仅挂载视口内行并保留行序号与 taskKey', async () => {
		const tasks = makeTasks(150, new Date(2026, 10, 22));
		useCalendarStore.setState({ tasks, tasksReady: true });
		const plugin = makePlugin(useCalendarStore.getState().settings);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(
							VirtuosoMockContext.Provider,
							{ value: { viewportHeight: 300, itemHeight: 50 } },
							createElement(TaskView)
						)
					)
				)
			);
		});

		const rows = container.querySelectorAll(`.${TaskViewClasses.elements.row}`);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThan(30);
		expect(rows[0].querySelector(`.${TaskViewClasses.elements.index}`)?.textContent).toBe('1');
		expect(rows[0].querySelector(`.${TaskCardClasses.elements.text}`)?.textContent).toContain('Task 1');
	});

	test('TaskView 在 dateRangeMode !== all 时向 useViewTasks 传递 taskRange 调用日期桶查询', async () => {
		const today = new Date();
		const tasks = makeTasks(3, today);
		const getTasksByDateRange = jest.fn<GCTask[], [Date, Date]>(() => tasks);
		useCalendarStore.getState().syncSettings(cloneSettings({ taskViewDateRangeMode: 'week' }));
		useCalendarStore.setState({ tasks, tasksReady: true, updateSeq: 1 });
		const plugin = makePlugin(useCalendarStore.getState().settings, getTasksByDateRange);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(
							VirtuosoMockContext.Provider,
							{ value: { viewportHeight: 300, itemHeight: 50 } },
							createElement(TaskView)
						)
					)
				)
			);
		});

		expect(getTasksByDateRange).toHaveBeenCalledTimes(1);
		const [start, end] = getTasksByDateRange.mock.calls[0];
		expect(start.getTime()).toBeLessThan(end.getTime());
	});

	test('TaskView 在手机端瀑布流模式优先绑定 .gantt-calendar-app 作为 customScrollParent（无 ResizeObserver 时安全回退）', async () => {
		Platform.isPhone = true;
		const appShell = makeDiv('gantt-calendar-app');
		container.appendChild(appShell);
		const appRoot = createRoot(appShell);
		const tasks = makeTasks(50, new Date(2026, 10, 22));
		useCalendarStore.setState({ tasks, tasksReady: true });
		const plugin = makePlugin(useCalendarStore.getState().settings);

		// 1) jsdom 无 ResizeObserver 时不崩溃并安全回退 useWindowScroll
		await act(async () => {
			appRoot.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(
							VirtuosoMockContext.Provider,
							{ value: { viewportHeight: 300, itemHeight: 50 } },
							createElement(TaskView)
						)
					)
				)
			);
		});

		const rowsFallback = appShell.querySelectorAll(`.${TaskViewClasses.elements.row}`);
		expect(rowsFallback.length).toBeGreaterThan(0);
		expect(rowsFallback.length).toBeLessThan(30);

		await act(async () => {
			appRoot.unmount();
		});

		// 2) 具备 ResizeObserver 时将 .gantt-calendar-app 作为 customScrollParent 挂载滚动监听
		const observeMock = jest.fn();
		const disconnectMock = jest.fn();
		const win = window as unknown as Record<string, unknown>;
		const prevRO = win.ResizeObserver;
		win.ResizeObserver = class {
			observe = observeMock;
			unobserve = jest.fn();
			disconnect = disconnectMock;
		};
		const addListenerSpy = jest.spyOn(appShell, 'addEventListener');
		const appRoot2 = createRoot(appShell);

		try {
			await act(async () => {
				appRoot2.render(
					createElement(
						PluginContext.Provider,
						{ value: plugin },
						createElement(
							TooltipProvider,
							null,
							createElement(
								VirtuosoMockContext.Provider,
								{ value: { viewportHeight: 300, itemHeight: 50 } },
								createElement(TaskView)
							)
						)
					)
				);
			});

			expect(addListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
			expect(observeMock).toHaveBeenCalledWith(appShell);
		} finally {
			addListenerSpy.mockRestore();
			await act(async () => {
				appRoot2.unmount();
			});
			if (prevRO === undefined) delete win.ResizeObserver;
			else win.ResizeObserver = prevRO;
		}
	});

	test('TaskListPanel 使用 Virtuoso 虚拟化任务、保持固定头部、使用 priorityIcons 并响应式读取设置', async () => {
		const tasks = makeTasks(150, new Date(2026, 10, 22));
		useCalendarStore.setState({ tasks, tasksReady: true });
		const plugin = makePlugin(useCalendarStore.getState().settings);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(
						TooltipProvider,
						null,
						createElement(
							VirtuosoMockContext.Provider,
							{ value: { viewportHeight: 300, itemHeight: 50 } },
							createElement(TaskListPanel)
						)
					)
				)
			);
		});

		// 头部在主体之前且保持固定结构
		expect(container.querySelector(`.${SidebarClasses.elements.panelHeader}`)).not.toBeNull();
		expect(container.querySelector(`.${SidebarClasses.elements.panelBody}`)).not.toBeNull();

		// Virtuoso 仅渲染视口子集而非全量 150 项
		const cards = container.querySelectorAll(`.${SidebarClasses.elements.taskRow}`);
		expect(cards.length).toBeGreaterThan(0);
		expect(cards.length).toBeLessThan(30);

		// 响应式读取 sidebarShowCheckbox 设置
		expect(container.querySelectorAll(`.${TaskCardClasses.elements.checkbox}`).length).toBeGreaterThan(0);
		await act(async () => {
			useCalendarStore.getState().syncSettings(
				cloneSettings({ taskViewDateRangeMode: 'all', sidebarShowCheckbox: false })
			);
		});
		expect(container.querySelectorAll(`.${TaskCardClasses.elements.checkbox}`).length).toBe(0);

		// 打开优先级筛选菜单，验证各项按 PRIORITY_ORDER + priorityIcons 渲染（且可正常筛选）
		const filterBtns = container.querySelectorAll(`.${SidebarClasses.elements.filterBar} button.clickable-icon`);
		const priorityBtn = filterBtns[1] as HTMLButtonElement;
		await act(async () => {
			priorityBtn.click();
		});

		const menuItems = document.body.querySelectorAll(`.${DropdownMenuClasses.item}`);
		expect(menuItems.length).toBe(1 + PRIORITY_ORDER.length);
		PRIORITY_ORDER.forEach((level, idx) => {
			const iconEl = menuItems[idx + 1].querySelector('[data-mock-lucide]');
			expect(iconEl?.getAttribute('data-mock-lucide')).toBe(getPriorityMeta(level).icon);
		});
		// 点击 'high'（索引 2：all=0, highest=1, high=2）后仅保留 high 优先级任务
		await act(async () => {
			(menuItems[2] as HTMLButtonElement).click();
		});
		expect(priorityBtn.classList.contains('has-active-filter')).toBe(true);
	});

	test('MonthView 注入 --gc-month-weeks、传递 monthRange 到日期桶查询并响应式读取设置', async () => {
		const getTasksByDateRange = jest.fn<GCTask[], [Date, Date]>(() => []);
		useCalendarStore.getState().syncSettings(cloneSettings({ showLunar: true, startOnMonday: true }));
		useCalendarStore.setState({ currentDate: new Date(2026, 10, 15), tasksReady: true, updateSeq: 1 });
		const plugin = makePlugin(useCalendarStore.getState().settings, getTasksByDateRange);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(TooltipProvider, null, createElement(MonthView))
				)
			);
		});

		const monthEl = container.querySelector('.gc-view--month') as HTMLElement;
		expect(monthEl).not.toBeNull();
		expect(monthEl.style.getPropertyValue('--gc-month-weeks')).toBe('6');
		expect(getTasksByDateRange).toHaveBeenCalledTimes(1);
		expect(container.querySelectorAll('.gc-month-view__lunar-text').length).toBeGreaterThan(0);

		// 通过 syncSettings 关闭 showLunar 时立即响应更新
		await act(async () => {
			useCalendarStore.getState().syncSettings(cloneSettings({ showLunar: false, startOnMonday: true }));
		});
		expect(container.querySelectorAll('.gc-month-view__lunar-text').length).toBe(0);
	});
});
