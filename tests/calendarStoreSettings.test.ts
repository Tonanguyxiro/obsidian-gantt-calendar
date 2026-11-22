/**
 * @jest-environment jsdom
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../src/ui/App';
import { PluginContext } from '../src/ui/pluginContext';
import { useCalendarStore } from '../src/ui/store/calendarStore';
import { DEFAULT_SETTINGS } from '../src/settings/constants';
import type { GanttCalendarSettings } from '../src/settings/types';
import type { GCTask, IPluginContext } from '../src/types';
import { YearViewClasses, ToolbarClasses } from '../src/utils/bem';
import { GCMainView } from '../src/GCMainView';
import { GCSidebarView } from '../src/GCSidebarView';
import { useFileTaskLayer } from '../src/ui/utils/useFileTaskLayer';

function cloneSettingsForTest(overrides?: Partial<GanttCalendarSettings>): GanttCalendarSettings {
	return {
		...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GanttCalendarSettings),
		...overrides,
	};
}

function makeHostDiv(): HTMLDivElement {
	const frag = document.createRange().createContextualFragment('<div></div>');
	const el = frag.firstElementChild as HTMLDivElement;
	document.body.appendChild(el);
	return el;
}

function makePlugin(settings: GanttCalendarSettings): IPluginContext {
	return {
		app: {} as IPluginContext['app'],
		settings,
		saveSettings: async () => {},
		refreshCalendarViews: () => {},
		taskCache: {
			getAllTasks: () => [] as GCTask[],
			refreshFile: async () => {},
			onUpdate: () => {},
			offUpdate: () => {},
			initialize: async () => {},
			whenReady: async () => {},
		},
	};
}

describe('calendarStore settings snapshot & syncSettings', () => {
	beforeEach(() => {
		useCalendarStore.getState().syncSettings(cloneSettingsForTest());
	});

	test('默认从 DEFAULT_SETTINGS 深拷贝初始化且不共享嵌套引用', () => {
		const state = useCalendarStore.getState();
		expect(state.settings.showLunar).toBe(DEFAULT_SETTINGS.showLunar);
		expect(state.settings.yearHeatmapPalette).toBe(DEFAULT_SETTINGS.yearHeatmapPalette);
		expect(state.settings.enabledTaskFormats).toEqual(DEFAULT_SETTINGS.enabledTaskFormats);
		expect(state.settings.enabledTaskFormats).not.toBe(DEFAULT_SETTINGS.enabledTaskFormats);
		expect(state.settings.fileTaskViews).not.toBe(DEFAULT_SETTINGS.fileTaskViews);
		expect(state.settings.taskStatuses).not.toBe(DEFAULT_SETTINGS.taskStatuses);
	});

	test('syncSettings 深拷贝隔离：外部原地修改 plugin.settings 不会静默污染 store', () => {
		const external = cloneSettingsForTest({
			syncConfiguration: {
				enabledSources: { api: true },
				syncDirection: 'bidirectional',
				syncInterval: 15,
				conflictResolution: 'newest-win',
				feishuSyncTargetFile: 'Tasks.md',
				api: { provider: 'feishu', userName: 'Alice' },
			},
		});

		useCalendarStore.getState().syncSettings(external);

		// 外部原地篡改所有嵌套对象与数组
		external.enabledTaskFormats.push('dataview');
		external.fileTaskViews.day.show = false;
		external.ganttCollapsedFileTasks.push('notes/a.md');
		external.taskStatuses[0].name = 'Mutated';
		if (external.syncConfiguration?.api) {
			external.syncConfiguration.api.userName = 'Mallory';
		}

		const stored = useCalendarStore.getState().settings;
		expect(stored.enabledTaskFormats).toEqual(['tasks']);
		expect(stored.fileTaskViews.day.show).toBe(true);
		expect(stored.ganttCollapsedFileTasks).toEqual([]);
		expect(stored.taskStatuses[0].name).toBe(DEFAULT_SETTINGS.taskStatuses[0].name);
		expect(stored.syncConfiguration?.api?.userName).toBe('Alice');

		// 再次 syncSettings 后同步新值，且仍保持隔离
		useCalendarStore.getState().syncSettings(external);
		expect(useCalendarStore.getState().settings.enabledTaskFormats).toEqual(['tasks', 'dataview']);
		external.enabledTaskFormats.push('extra');
		expect(useCalendarStore.getState().settings.enabledTaskFormats).toEqual(['tasks', 'dataview']);
	});

	test('引用稳定性：未变更的设置调用 syncSettings 为空操作，局部变更保留其他字段原引用', () => {
		const initial = cloneSettingsForTest({
			syncConfiguration: {
				enabledSources: { api: true },
				syncDirection: 'bidirectional',
				syncInterval: 10,
				conflictResolution: 'newest-win',
				feishuSyncTargetFile: 'Feishu.md',
				ics: { subscriptions: [], syncInterval: 30 },
			},
		});
		useCalendarStore.getState().syncSettings(initial);
		const snap1 = useCalendarStore.getState().settings;

		const listener = jest.fn();
		const unsub = useCalendarStore.subscribe(listener);

		// 传入等价的全新克隆对象 -> 完全跳过更新，不触发订阅
		useCalendarStore.getState().syncSettings(cloneSettingsForTest({
			syncConfiguration: {
				enabledSources: { api: true },
				syncDirection: 'bidirectional',
				syncInterval: 10,
				conflictResolution: 'newest-win',
				feishuSyncTargetFile: 'Feishu.md',
				ics: { subscriptions: [], syncInterval: 30 },
			},
		}));
		expect(useCalendarStore.getState().settings).toBe(snap1);
		expect(listener).not.toHaveBeenCalled();

		// 仅修改 showLunar -> 所有未改动的嵌套对象/数组保持原引用
		const changedLunar = cloneSettingsForTest({
			showLunar: false,
			syncConfiguration: {
				enabledSources: { api: true },
				syncDirection: 'bidirectional',
				syncInterval: 10,
				conflictResolution: 'newest-win',
				feishuSyncTargetFile: 'Feishu.md',
				ics: { subscriptions: [], syncInterval: 30 },
			},
		});
		useCalendarStore.getState().syncSettings(changedLunar);
		const snap2 = useCalendarStore.getState().settings;

		expect(snap2).not.toBe(snap1);
		expect(snap2.showLunar).toBe(false);
		expect(snap2.taskStatuses).toBe(snap1.taskStatuses);
		expect(snap2.enabledTaskFormats).toBe(snap1.enabledTaskFormats);
		expect(snap2.fileTaskViews).toBe(snap1.fileTaskViews);
		expect(snap2.ganttCollapsedFileTasks).toBe(snap1.ganttCollapsedFileTasks);
		expect(snap2.syncConfiguration).toBe(snap1.syncConfiguration);

		// 仅修改 fileTaskViews.day.show -> gantt/week/month 子配置保持原引用
		const changedDayFileView = cloneSettingsForTest({
			showLunar: false,
			syncConfiguration: {
				enabledSources: { api: true },
				syncDirection: 'bidirectional',
				syncInterval: 10,
				conflictResolution: 'newest-win',
				feishuSyncTargetFile: 'Feishu.md',
				ics: { subscriptions: [], syncInterval: 30 },
			},
		});
		changedDayFileView.fileTaskViews.day.show = false;
		useCalendarStore.getState().syncSettings(changedDayFileView);
		const snap3 = useCalendarStore.getState().settings;

		expect(snap3.fileTaskViews).not.toBe(snap2.fileTaskViews);
		expect(snap3.fileTaskViews.day).not.toBe(snap2.fileTaskViews.day);
		expect(snap3.fileTaskViews.day.show).toBe(false);
		expect(snap3.fileTaskViews.gantt).toBe(snap2.fileTaskViews.gantt);
		expect(snap3.fileTaskViews.month).toBe(snap2.fileTaskViews.month);
		expect(snap3.fileTaskViews.week).toBe(snap2.fileTaskViews.week);

		unsub();
	});
});

describe('字段级选择器与 App 增量更新（不重挂载）', () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeAll(() => {
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
		useCalendarStore.getState().syncSettings(cloneSettingsForTest());
		useCalendarStore.setState({ tasks: [], tasksReady: true, viewType: 'year' });
		container = makeHostDiv();
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test('字段级选择器仅在对应设置字段变更时触发组件重渲染', async () => {
		const counts = { lunar: 0, palette: 0, ganttFileView: 0 };

		function LunarProbe() {
			const val = useCalendarStore((s) => s.settings.showLunar);
			const c = useRef(0);
			c.current += 1;
			counts.lunar = c.current;
			return createElement('span', { 'data-probe': 'lunar' }, String(val));
		}

		function PaletteProbe() {
			const val = useCalendarStore((s) => s.settings.yearHeatmapPalette);
			const c = useRef(0);
			c.current += 1;
			counts.palette = c.current;
			return createElement('span', { 'data-probe': 'palette' }, val);
		}

		function GanttFileViewProbe() {
			const val = useCalendarStore((s) => s.settings.fileTaskViews?.gantt);
			const c = useRef(0);
			c.current += 1;
			counts.ganttFileView = c.current;
			return createElement('span', { 'data-probe': 'gantt-fv' }, String(val?.show));
		}

		await act(async () => {
			root.render(
				createElement(
					'div',
					null,
					createElement(LunarProbe),
					createElement(PaletteProbe),
					createElement(GanttFileViewProbe)
				)
			);
		});

		expect(counts).toEqual({ lunar: 1, palette: 1, ganttFileView: 1 });

		// 只改 showLunar
		await act(async () => {
			useCalendarStore.getState().syncSettings(cloneSettingsForTest({ showLunar: false }));
		});
		expect(counts).toEqual({ lunar: 2, palette: 1, ganttFileView: 1 });

		// 只改 fileTaskViews.day.show（不影响 fileTaskViews.gantt）
		const nextDay = cloneSettingsForTest({ showLunar: false });
		nextDay.fileTaskViews.day.show = false;
		await act(async () => {
			useCalendarStore.getState().syncSettings(nextDay);
		});
		expect(counts).toEqual({ lunar: 2, palette: 1, ganttFileView: 1 });

		// 改 yearHeatmapPalette
		const nextPalette = cloneSettingsForTest({ showLunar: false, yearHeatmapPalette: 'green' });
		nextPalette.fileTaskViews.day.show = false;
		await act(async () => {
			useCalendarStore.getState().syncSettings(nextPalette);
		});
		expect(counts).toEqual({ lunar: 2, palette: 2, ganttFileView: 1 });
	});

	test('App 在 syncSettings 更新设置时不卸载重挂子视图，仅做增量更新', async () => {
		const settings = cloneSettingsForTest({
			defaultView: 'year',
			showLunar: true,
			showViewNavButtonText: true,
		});
		const plugin = makePlugin(settings);
		useCalendarStore.getState().syncSettings(settings);

		await act(async () => {
			root.render(
				createElement(PluginContext.Provider, { value: plugin }, createElement(App))
			);
		});

		const contentBefore = container.querySelector('.calendar-content');
		const yearViewBefore = container.querySelector('.gc-view--year');
		const toolbarBefore = container.querySelector(`.${ToolbarClasses.block}`);
		expect(contentBefore).not.toBeNull();
		expect(yearViewBefore).not.toBeNull();
		expect(toolbarBefore).not.toBeNull();
		expect(
			container.getElementsByClassName(YearViewClasses.modifiers.monthCardShowLunar).length
		).toBe(12);
		expect(
			container.getElementsByClassName(ToolbarClasses.components.viewSelectorGroup.iconOnly).length
		).toBe(0);

		// 通过 syncSettings 更新设置
		const updated = cloneSettingsForTest({
			defaultView: 'year',
			showLunar: false,
			showViewNavButtonText: false,
		});
		await act(async () => {
			useCalendarStore.getState().syncSettings(updated);
		});

		const contentAfter = container.querySelector('.calendar-content');
		const yearViewAfter = container.querySelector('.gc-view--year');
		const toolbarAfter = container.querySelector(`.${ToolbarClasses.block}`);

		// 关键断言：DOM 根节点完全保持同一实例（未卸载重挂）
		expect(contentAfter).toBe(contentBefore);
		expect(yearViewAfter).toBe(yearViewBefore);
		expect(toolbarAfter).toBe(toolbarBefore);

		// 且视图与工具栏已响应式更新
		expect(
			container.getElementsByClassName(YearViewClasses.modifiers.monthCardShowLunar).length
		).toBe(0);
		expect(
			container.getElementsByClassName(ToolbarClasses.components.viewSelectorGroup.iconOnly).length
		).toBe(1);
	});

	test('App 在甘特图视图下更新设置时同样保持子树不重挂载', async () => {
		const settings = cloneSettingsForTest({ defaultView: 'gantt' });
		const plugin = makePlugin(settings);
		useCalendarStore.getState().syncSettings(settings);
		useCalendarStore.setState({ viewType: 'gantt', tasks: [], tasksReady: true });

		await act(async () => {
			root.render(
				createElement(PluginContext.Provider, { value: plugin }, createElement(App))
			);
		});

		const ganttContentBefore = container.querySelector('.calendar-content.gantt-mode');
		const ganttViewBefore = container.querySelector('.gc-view--gantt');
		expect(ganttContentBefore).not.toBeNull();
		expect(ganttViewBefore).not.toBeNull();

		await act(async () => {
			useCalendarStore.getState().syncSettings(
				cloneSettingsForTest({ defaultView: 'gantt', showViewNavButtonText: false })
			);
		});

		expect(container.querySelector('.calendar-content.gantt-mode')).toBe(ganttContentBefore);
		expect(container.querySelector('.gc-view--gantt')).toBe(ganttViewBefore);
		expect(
			container.getElementsByClassName(ToolbarClasses.components.viewSelectorGroup.iconOnly).length
		).toBe(1);
	});

	test('GCMainView.refreshSettings 与 GCSidebarView.refreshSettings 同步设置到 store', () => {
		const settings = cloneSettingsForTest({ showLunar: true });
		const plugin = makePlugin(settings);
		const mainView = new GCMainView({} as never, plugin);
		const sidebarView = new GCSidebarView({} as never, plugin);

		plugin.settings.showLunar = false;
		mainView.refreshSettings();
		expect(useCalendarStore.getState().settings.showLunar).toBe(false);

		plugin.settings.sidebarShowTags = false;
		sidebarView.refreshSettings();
		expect(useCalendarStore.getState().settings.sidebarShowTags).toBe(false);
	});

	test('useFileTaskLayer 响应式订阅 fileTaskIncludeDated 与 fileTaskViews', async () => {
		const settings = cloneSettingsForTest({ fileTaskIncludeDated: false });
		const plugin = makePlugin(settings);
		useCalendarStore.getState().syncSettings(settings);
		useCalendarStore.setState({
			fileTasks: [
				{
					filePath: 'proj/alpha.md',
					title: 'Alpha',
					start: new Date(2026, 0, 10),
					end: new Date(2026, 0, 12),
					dateSource: 'frontmatter',
				},
			],
		});

		let latestEnabled = false;
		function FileTaskProbe() {
			const layer = useFileTaskLayer('day', [], 'startDate', 'dueDate', 'dueDate');
			latestEnabled = layer.enabled;
			return createElement('span', null, String(layer.enabled));
		}

		await act(async () => {
			root.render(
				createElement(PluginContext.Provider, { value: plugin }, createElement(FileTaskProbe))
			);
		});
		expect(latestEnabled).toBe(false);

		await act(async () => {
			useCalendarStore.getState().syncSettings(
				cloneSettingsForTest({ fileTaskIncludeDated: true })
			);
		});
		expect(latestEnabled).toBe(true);

		const hiddenDay = cloneSettingsForTest({ fileTaskIncludeDated: true });
		hiddenDay.fileTaskViews.day.show = false;
		await act(async () => {
			useCalendarStore.getState().syncSettings(hiddenDay);
		});
		expect(latestEnabled).toBe(false);
	});
});
