/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VirtuosoMockContext } from 'react-virtuoso';
import { EmptyVaultGuide } from '../src/ui/components/EmptyVaultGuide';
import { TooltipProvider } from '../src/ui/components/TooltipProvider';
import { TaskView } from '../src/ui/views/TaskView';
import { TaskListPanel } from '../src/ui/sidebar/TaskListPanel';
import { PluginContext } from '../src/ui/pluginContext';
import { useCalendarStore } from '../src/ui/store/calendarStore';
import { DEFAULT_SETTINGS } from '../src/settings/constants';
import { EmptyGuideClasses, SidebarClasses, TaskViewClasses } from '../src/utils/bem';
import { initializeI18n, setLanguage } from '../src/i18n/i18n';
import type { GCTask, IPluginContext } from '../src/types';
import type { GanttCalendarSettings } from '../src/settings/types';

const openCreateTaskModalMock = jest.fn<void, unknown[]>();

jest.mock('../src/ui/modals/TaskFormModal', () => ({
	openCreateTaskModal: (...args: unknown[]) => {
		openCreateTaskModalMock(...args);
	},
	openEditTaskModal: jest.fn(),
}));

function makeDiv(): HTMLDivElement {
	const frag = document.createRange().createContextualFragment('<div></div>');
	return frag.firstElementChild as HTMLDivElement;
}

function cloneSettings(overrides?: Partial<GanttCalendarSettings>): GanttCalendarSettings {
	return {
		...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GanttCalendarSettings),
		...overrides,
	};
}

function makePlugin(settings: GanttCalendarSettings): IPluginContext {
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
			refreshFile: async () => {},
			onUpdate: () => {},
			offUpdate: () => {},
			initialize: async () => {},
			whenReady: async () => {},
		},
	};
}

function makeTask(id: number, dueDate?: Date): GCTask {
	return {
		filePath: `note-${id}.md`,
		fileName: `note-${id}.md`,
		lineNumber: id,
		content: `- [ ] #task Task ${id}`,
		description: `Task ${id}`,
		completed: false,
		priority: 'normal',
		dueDate,
	};
}

describe('EmptyVaultGuide 空库引导卡片', () => {
	let container: HTMLElement;
	let root: Root;
	let writeTextMock: jest.Mock<Promise<void>, [string]>;
	let prevActiveDoc: unknown;
	let hadActiveDoc = false;
	let prevHasClass: unknown;

	beforeAll(async () => {
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
		await initializeI18n('en');
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
		jest.useFakeTimers();
		openCreateTaskModalMock.mockClear();
		writeTextMock = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: writeTextMock },
		});
		setLanguage('en');
		useCalendarStore.getState().syncSettings(cloneSettings({ globalTaskFilter: '#task', language: 'en' }));
		useCalendarStore.setState({ tasks: [], tasksReady: true, currentDate: new Date(2026, 10, 22) });
		container = makeDiv();
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		jest.useRealTimers();
		setLanguage('en');
	});

	test('渲染欢迎标题、globalTaskFilter 标签、Tasks/Dataview 示例、复制反馈及新建 CTA', async () => {
		const plugin = makePlugin(useCalendarStore.getState().settings);
		await act(async () => {
			root.render(
				createElement(PluginContext.Provider, { value: plugin }, createElement(EmptyVaultGuide))
			);
		});

		expect(container.querySelector(`.${EmptyGuideClasses.elements.title}`)?.textContent).toBe('Welcome to Gantt Calendar');
		expect(container.querySelector(`.${EmptyGuideClasses.elements.filterChip}`)?.textContent).toBe('#task');

		const codes = Array.from(container.querySelectorAll(`.${EmptyGuideClasses.elements.exampleCode}`)).map(
			(el) => el.textContent || ''
		);
		expect(codes).toHaveLength(3);
		expect(codes[0]).toContain('#task');
		expect(codes[0]).toContain('🛫');
		expect(codes[0]).toContain('📅');
		expect(codes[0]).toContain('⏫');
		expect(codes[1]).toContain('09:00 - 10:30');
		expect(codes[1]).toContain('⏳');
		expect(codes[2]).toContain('[due::');

		// 点击复制按钮显示已复制状态，超时后复原
		const copyBtns = container.querySelectorAll(`.${EmptyGuideClasses.elements.copyBtn}`);
		expect(copyBtns).toHaveLength(3);
		await act(async () => {
			(copyBtns[0] as HTMLButtonElement).click();
		});
		expect(writeTextMock).toHaveBeenCalledWith(codes[0]);
		expect(copyBtns[0].classList.contains(EmptyGuideClasses.modifiers.copied)).toBe(true);
		expect(copyBtns[0].textContent).toContain('Copied');

		await act(async () => {
			jest.advanceTimersByTime(2000);
		});
		expect(copyBtns[0].classList.contains(EmptyGuideClasses.modifiers.copied)).toBe(false);

		// 点击新建任务主按钮调用 openCreateTaskModal
		const ctaBtn = container.querySelector(`.${EmptyGuideClasses.elements.ctaBtn}`) as HTMLButtonElement;
		expect(ctaBtn).not.toBeNull();
		await act(async () => {
			ctaBtn.click();
		});
		expect(openCreateTaskModalMock).toHaveBeenCalledTimes(1);
		expect(openCreateTaskModalMock.mock.calls[0][0]).toMatchObject({
			app: plugin.app,
			plugin,
		});
	});

	test('未配置 globalTaskFilter 时展示全量索引提示，compact 与中文语言切换生效', async () => {
		setLanguage('zh');
		useCalendarStore.getState().syncSettings(cloneSettings({ globalTaskFilter: '', language: 'zh' }));
		const plugin = makePlugin(useCalendarStore.getState().settings);

		await act(async () => {
			root.render(
				createElement(
					PluginContext.Provider,
					{ value: plugin },
					createElement(EmptyVaultGuide, { compact: true })
				)
			);
		});

		const section = container.querySelector(`.${EmptyGuideClasses.block}`);
		expect(section?.classList.contains(EmptyGuideClasses.modifiers.compact)).toBe(true);
		expect(container.querySelector(`.${EmptyGuideClasses.elements.filterChip}`)).toBeNull();
		expect(container.querySelector(`.${EmptyGuideClasses.elements.title}`)?.textContent).toBe('欢迎使用甘特日历');
		expect(container.querySelector(`.${EmptyGuideClasses.elements.ctaBtn}`)?.textContent).toContain('创建第一个任务');
	});

	test('TaskView 与 TaskListPanel 仅在 tasksReady && tasks.length === 0 时显示 EmptyVaultGuide', async () => {
		const settings = cloneSettings({ taskViewDateRangeMode: 'day', globalTaskFilter: '#task' });
		useCalendarStore.getState().syncSettings(settings);
		const plugin = makePlugin(settings);

		// 1) 空库：两个视图均展示引导卡片（侧边栏传 compact）
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
							createElement(TaskView),
							createElement(TaskListPanel)
						)
					)
				)
			);
		});

		const guides = container.querySelectorAll(`.${EmptyGuideClasses.block}`);
		expect(guides).toHaveLength(2);
		expect(guides[0].classList.contains(EmptyGuideClasses.modifiers.compact)).toBe(false);
		expect(guides[1].classList.contains(EmptyGuideClasses.modifiers.compact)).toBe(true);

		// 2) 库内已有任务但被筛选/日期范围过滤为空时：回退常规空状态文案，不显示引导卡片
		// （Task 1 为 completed: true 且 dueDate 在 2000-01-01：TaskView 按当日过滤为空，TaskListPanel 默认未选 done 也过滤为空）
		await act(async () => {
			useCalendarStore.setState({
				tasks: [{ ...makeTask(1, new Date(2000, 0, 1)), completed: true }],
				tasksReady: true,
			});
		});

		expect(container.querySelectorAll(`.${EmptyGuideClasses.block}`)).toHaveLength(0);
		expect(container.querySelector(`.${TaskViewClasses.elements.empty}`)).not.toBeNull();
		expect(container.querySelector(`.${SidebarClasses.elements.emptyState}`)).not.toBeNull();
	});
});
