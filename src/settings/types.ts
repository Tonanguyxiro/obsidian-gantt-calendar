import type GanttCalendarPlugin from '../../main';
import type { SortField, SortOrder, TagFilterOperator } from '../types';
import type { TaskStatus } from '../tasks/taskStatus';
import type { FeishuTaskList } from '../data-layer/sources/api/providers/feishu/FeishuTypes';
import type { ViewFilterState, ViewScope } from '../ui/store/calendarStore';

/**
 * 日期字段类型
 */
export type DateFieldType = 'createdDate' | 'startDate' | 'scheduledDate' | 'dueDate' | 'completionDate' | 'cancelledDate';

/** Daily Note 设置来源 */
export type DailyNoteSource = 'manual' | 'obsidian' | 'notebook-navigator';

/** 支持 file-based task 的视图 */
export type FileTaskViewKey = 'day' | 'week' | 'month' | 'gantt';

/** 单个视图的 file-based task 选项 */
export interface FileTaskViewOptions {
	/** 是否显示 file-based task */
	show: boolean;
	/** 是否把文件内的任务归入该文件（日历视图收进文件的悬浮展开卡片，甘特图移到文件行下） */
	groupTasks: boolean;
}

/**
 * Gantt Calendar Plugin Settings Interface
 */
export interface GanttCalendarSettings {
	startOnMonday: boolean;
	showLunar: boolean;
	showFestivals: boolean;
	yearLunarFontSize: number;
	monthLunarFontSize: number;
	solarFestivalColor: string;
	lunarFestivalColor: string;
	solarTermColor: string;
	globalTaskFilter: string;
	enabledTaskFormats: string[];
	showGlobalFilterInTaskText: boolean; // 是否在任务列表文本中显示 global filter 前缀
	dateFilterField: 'createdDate' | 'startDate' | 'scheduledDate' | 'dueDate' | 'completionDate' | 'cancelledDate'; // 日历视图的筛选字段，任务视图的初始字段
	enableDailyNote: boolean; // 是否在日视图中显示 Daily Note
	dayViewLayout: 'horizontal' | 'vertical'; // 日视图布局：水平（左右分屏）或垂直（上下分屏）
	dailyNotePath: string; // Daily note 文件夹路径
	dailyNoteNameFormat: string; // Daily note 文件名格式 (如 yyyy-MM-dd)
	dailyNoteSource: DailyNoteSource; // Daily Note 设置来源：手动 / Obsidian 核心日记(Periodic Notes) / Notebook Navigator
	yearShowTaskCount: boolean; // 年视图是否显示每日任务数量
	yearHeatmapEnabled: boolean; // 年视图是否启用任务热力图
	yearHeatmapPalette: 'blue' | 'green' | 'red' | 'purple' | 'orange' | 'cyan' | 'pink' | 'yellow'; // 热力图色卡选择
	yearHeatmap3DEnabled: 0 | 1 | 2; // 年视图热力图3D效果：0=关闭，1=轻微突起，2=明显突起
	taskNotePath: string; // 任务笔记默认文件夹路径
	taskStatuses: TaskStatus[]; // 任务状态配置（包含颜色）
	taskSortField: SortField; // 任务排序字段
	taskSortOrder: SortOrder; // 任务排序顺序
	defaultView: 'day' | 'week' | 'month' | 'year' | 'task' | 'gantt'; // 默认视图
	newTaskHeading?: string; // 新任务插入的标题（留空则添加到文件末尾）
	dailyNoteTemplatePath: string;
	defaultTaskPriority: 'highest' | 'high' | 'medium' | 'low' | 'lowest' | 'normal'; // 默认任务优先级
	enableDebugMode: boolean; // 是否启用开发者模式（详细日志）
	showViewNavButtonText: boolean; // 是否显示视图导航按钮文本
	taskCardClickAction: 'openFile' | 'editModal'; // 点击任务卡片行为：跳转 Markdown 源文件 / 弹出编辑面板
	taskCardDoubleClickAction: 'editModal' | 'openFile' | 'none'; // 双击任务行为（默认弹出编辑面板）
	timezoneOffset: number | null; // 时区偏移量（分钟），null 表示跟随系统
	timeFormat: '24h' | '12h'; // 时间显示格式
	recurringTaskDisplayLimit: number; // 周期任务虚拟实例显示数量上限
	language: 'system' | 'en' | 'zh'; // 插件界面语言

	// ========== 持久化筛选和排序状态 ==========

	// TaskView 状态
	taskViewSortField: SortField;
	taskViewSortOrder: SortOrder;
	taskViewSelectedStatuses: string[];
	taskViewSelectedTags: string[];
	taskViewTagOperator: TagFilterOperator;
	taskViewTimeFieldFilter: DateFieldType;
	taskViewDateRangeMode: 'all' | 'day' | 'week' | 'month' | 'custom';

	// DayView 状态
	dayViewSortField: SortField;
	dayViewSortOrder: SortOrder;
	dayViewSelectedStatuses: string[];
	dayViewSelectedTags: string[];
	dayViewTagOperator: TagFilterOperator;
	// DayView 卡片显示控制（与其他时间线视图对齐）
	dayViewShowCheckbox: boolean;
	dayViewShowTags: boolean;
	dayViewShowPriority: boolean;
	dayViewShowTicktick: boolean;

	// WeekView 状态
	weekViewSortField: SortField;
	weekViewSortOrder: SortOrder;
	weekViewSelectedStatuses: string[];
	weekViewSelectedTags: string[];
	weekViewTagOperator: TagFilterOperator;
	// WeekView 卡片显示控制
	weekViewShowCheckbox: boolean;
	weekViewShowTags: boolean;
	weekViewShowPriority: boolean;
		weekViewShowTicktick: boolean;

	// MonthView 状态
	monthViewSortField: SortField;
	monthViewSortOrder: SortOrder;
	monthViewSelectedStatuses: string[];
	monthViewSelectedTags: string[];
	monthViewTagOperator: TagFilterOperator;
	// MonthView 卡片显示控制
	monthViewShowCheckbox: boolean;
	monthViewShowTags: boolean;
	monthViewShowPriority: boolean;
		monthViewShowTicktick: boolean;

	// YearView 状态
	yearViewSelectedTags: string[];
	yearViewTagOperator: TagFilterOperator;

	// ========== 侧边栏设置 ==========
	sidebarShowCheckbox: boolean;
	sidebarShowTags: boolean;
	sidebarShowPriority: boolean;
	sidebarShowTicktick: boolean;
	sidebarShowFileLocation: boolean;
	sidebarShowDueDate: boolean;

	// ========== 甘特图设置 ==========

	ganttStartField: DateFieldType;  // 甘特图开始时间字段
	ganttEndField: DateFieldType;    // 甘特图结束时间字段

	// ========== File-based task ==========
	fileTaskIncludeDated: boolean;      // 引入带日期属性的文件（Timeline for Bases 式，不要求有任务）
	fileTaskIncludeTaskFiles: boolean;  // 引入含任务的文件（无日期属性时用任务日期）
	fileTaskRequiredTags: string;       // 带日期属性来源的标签过滤（逗号/空格分隔，留空不限）
	fileTaskExcludeDailyNotes: boolean; // 含任务来源下排除每日笔记
	fileTaskStartProperty: string;      // 开始属性名
	fileTaskEndProperty: string;        // 结束属性名
	fileTaskProjectProperty: string;    // 项目属性名（通常是 folder note 的双链），留空不分组
	fileTaskFolder: string;             // 只在该文件夹内识别，留空为整个库
	fileTaskViews: Record<FileTaskViewKey, FileTaskViewOptions>; // 各视图的显示选项
	ganttCollapsedFileTasks: string[];  // 甘特图中已折叠（收起归类任务）的文件路径

	// ========== 同步设置 ==========
	syncConfiguration?: SyncConfiguration;

	// ========== 视图筛选/排序持久化 ==========
	// 各视图作用域的筛选与排序状态，随插件设置落 data.json（按 vault 隔离、随库同步）。
	// 运行时以 calendarStore 为准，main.ts 订阅写回；loadSettings 会按 scope 补全缺省
	viewFilters?: Record<ViewScope, ViewFilterState>;
}

/**
 * 同步配置
 */
export interface SyncConfiguration {
	enabledSources: {
		api?: boolean;
		caldav?: boolean;
	};
	syncDirection: 'bidirectional' | 'import-only' | 'export-only';
	syncInterval: number;
	conflictResolution: 'local-win' | 'remote-win' | 'newest-win' | 'manual';
	feishuSyncTargetFile: string;
	api?: {
		provider: 'feishu' | 'microsoft-todo' | 'custom';
		apiKey?: string;
		endpoint?: string;

		// OAuth 配置
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;

		// Token
		accessToken?: string;
		refreshToken?: string;
		tokenExpireAt?: number;
		refreshTokenExpireAt?: number;

		// 用户信息
		userId?: string;
		userOpenId?: string;
		userName?: string;

		// 旧字段保留兼容（飞书）
		appId?: string;
		appSecret?: string;
		tenantId?: string;

		// 飞书任务清单
		tasklistGuid?: string;
		taskLists?: FeishuTaskList[];
		taskListsFetchedAt?: number;
	};
	caldav?: {
		provider: 'google' | 'outlook' | 'apple' | 'custom';
		url?: string;
		username?: string;
		password?: string;
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		accessToken?: string;
		refreshToken?: string;
	};
	fieldMergeRules?: Array<{
		field: 'description' | 'completed' | 'dueDate' | 'startDate' | 'priority' | 'status' | 'tags';
		winner: 'local' | 'remote' | 'newest';
	}>;
	pushFilter?: {
		enabled: boolean;
		paths: string[];
		completionStatus: 'all' | 'incomplete-only';
		sinceDate: string;
	};
}

/**
 * 构建器配置接口
 */
export interface BuilderConfig {
	containerEl: HTMLElement;
	plugin: GanttCalendarPlugin;
	onRefreshSettings?: () => void; // 刷新设置面板的回调函数
}

/**
 * 颜色设置配置接口
 */
export interface ColorSettingConfig {
	name: string;
	description: string;
	settingKey: keyof GanttCalendarSettings;
}

/**
 * 热力图色卡配置接口
 */
export interface HeatmapPalette {
	key: 'blue' | 'green' | 'red' | 'purple' | 'orange' | 'cyan' | 'pink' | 'yellow';
	label: string;
	colors: string[];
}
