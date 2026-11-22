/** @jest-environment jsdom */
import GanttCalendarPlugin from '../main';
import { useCalendarStore } from '../src/ui/store/calendarStore';
import { DEFAULT_SETTINGS } from '../src/settings/constants';
import type { GanttCalendarSettings } from '../src/settings/types';
import { Logger } from '../src/utils/logger';

// 截断与被测行为无关的重依赖子树（main.ts 仅在 onload 使用它们，
// 本测试只驱动 scheduleTaskCacheInit 的数据回调路径）
jest.mock('../src/settings', () => ({ GanttCalendarSettingTab: class {} }));
jest.mock('../src/commands/commandsIndex', () => ({ registerAllCommands: () => {} }));
jest.mock('../src/ui/modals/modalHost', () => ({ initModalHost: () => {}, destroyModalHost: () => {} }));
jest.mock('../src/ui/reactBridge', () => ({ mountReact: jest.fn(() => jest.fn()) }));

/**
 * P1：首扫完成后不得触发整视图重挂 / 全量视图刷新。
 *
 * 根因链：main.ts 曾在 taskCache.initialize() 成功回调里调用
 * refreshCalendarViews() → view.refreshSettings()，导致视图在数据刚填充时
 * 触发多余刷新与重排。
 *
 * 数据推送已由 TaskStore.notifyListeners()（onUpdate）与视图
 * whenReady().then(setTasks) 承担，首扫完成只应推数据，不应触发
 * refreshAllViews() 或变更 store settings 引用。
 */
describe('P1：首扫完成后不整视图重挂', () => {
	let initialSettings: ReturnType<typeof useCalendarStore.getState>['settings'];

	beforeEach(() => {
		jest.spyOn(Logger, 'stats').mockImplementation(() => {});
		jest.spyOn(Logger, 'error').mockImplementation(() => {});
		initialSettings = useCalendarStore.getState().settings;
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	test('taskCache.initialize 完成后不触发 refreshAllViews 且设置快照引用不变', async () => {
		const refreshAllViews = jest.fn();
		const layoutCallbacks: Array<() => void> = [];
		const plugin = new GanttCalendarPlugin({
			workspace: { onLayoutReady: (cb: () => void) => layoutCallbacks.push(cb) },
			vault: { adapter: { exists: async () => false } },
		} as never, {} as never);
		const asAny = plugin as unknown as Record<string, unknown>;
		asAny.viewManager = { refreshAllViews };
		asAny.settings = { globalTaskFilter: '', enabledTaskFormats: ['tasks'] };
		asAny.taskCache = { initialize: jest.fn(() => Promise.resolve()) };

		(asAny.scheduleTaskCacheInit as () => void)();
		layoutCallbacks.forEach(cb => cb());

		// 等 setTimeout(0) + initialize().then() 链结算
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(refreshAllViews).not.toHaveBeenCalled();
		expect(useCalendarStore.getState().settings).toBe(initialSettings);
	});

	test('saveSettings 与 refreshCalendarViews 同步设置快照到 calendarStore', async () => {
		const settings: GanttCalendarSettings = {
			...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GanttCalendarSettings),
			showLunar: true,
			yearHeatmapPalette: 'blue',
		};
		const saveSettings = jest.fn(async () => {});
		const refreshAllViews = jest.fn();
		const plugin = new GanttCalendarPlugin({
			workspace: {},
			vault: {},
		} as never, {} as never);
		const asAny = plugin as unknown as Record<string, unknown>;
		asAny.settings = settings;
		asAny.settingsManager = { saveSettings };
		asAny.viewManager = { refreshAllViews };

		settings.showLunar = false;
		await plugin.saveSettings();
		expect(saveSettings).toHaveBeenCalledWith(settings);
		expect(useCalendarStore.getState().settings.showLunar).toBe(false);

		settings.yearHeatmapPalette = 'green';
		plugin.refreshCalendarViews();
		expect(refreshAllViews).toHaveBeenCalledTimes(1);
		expect(useCalendarStore.getState().settings.yearHeatmapPalette).toBe('green');
	});
});


