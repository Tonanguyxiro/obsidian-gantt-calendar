/**
 * Daily Note Settings Bridge
 *
 * 统一桥接层：在插件手动设置和 Obsidian 生态系统（核心日记插件 / Periodic Notes /
 * Notebook Navigator 日历）之间提供一致的接口。
 * - 格式转换：Moment.js (YYYY-MM-DD) ↔ 插件自定义 (yyyy-MM-dd)
 * - 统一配置解析
 * - 日记索引缓存（懒加载 + vault 事件自动失效）
 * - 按日期查找/创建日记
 */

import { App, EventRef, TFile, normalizePath } from 'obsidian';
import type { GanttCalendarSettings, DailyNoteSource } from '../settings/types';
import { formatDate } from '../dateUtils/dateUtilsIndex';
import { Logger } from './logger';
import { findDailyNoteRecursive } from './dailyNoteHelper';

import {
	getDailyNoteSettings,
	getAllDailyNotes,
	getDailyNote,
	appHasDailyNotesPluginLoaded,
} from 'obsidian-daily-notes-interface';

// ========== 格式转换 ==========

/** Moment.js 格式 → 插件自定义格式 (MM 两边一致，无需转换) */
function momentToPluginFormat(momentFormat: string): string {
	return momentFormat
		.replace(/YYYY/g, 'yyyy')
		.replace(/DD/g, 'dd');
}

/** 插件自定义格式 → Moment.js 格式 */
function pluginToMomentFormat(pluginFormat: string): string {
	return pluginFormat
		.replace(/yyyy/g, 'YYYY')
		.replace(/dd/g, 'DD');
}

// ========== Notebook Navigator ==========

/** Notebook Navigator 插件 ID */
export const NOTEBOOK_NAVIGATOR_PLUGIN_ID = 'notebook-navigator';

/** 读取自 Notebook Navigator 设置的日记配置 */
export interface NotebookNavigatorDailyNoteSettings {
	/** 'notebook-navigator' = NN 自定义日记路径；'daily-notes' = NN 委托给核心日记插件 */
	integrationMode: 'notebook-navigator' | 'daily-notes';
	/** 周期笔记根文件夹（当前 vault profile 的 periodicNotesFolder） */
	rootFolder: string;
	/** Moment.js 日记路径模式，可含子文件夹（如 "[Daily]/YYYY/YYYY-MM-DD"） */
	pattern: string;
	/** 新建日记使用的模板路径 */
	template: string;
}

interface NotebookNavigatorRawSettings {
	calendarIntegrationMode?: string;
	calendarCustomFilePattern?: string;
	calendarCustomFileTemplate?: string | null;
	vaultProfile?: string;
	vaultProfiles?: Array<{ id?: string; periodicNotesFolder?: string }>;
}

/** 文件夹设置归一化：空值/根目录 → ''，其余去掉首尾斜杠 */
function normalizeFolder(folder: string | undefined): string {
	if (!folder) return '';
	const normalized = normalizePath(folder);
	return normalized === '/' ? '' : normalized;
}

/** Notebook Navigator 默认日记路径模式（与其内置默认值一致） */
const NN_DEFAULT_DAILY_PATTERN = 'YYYY/YYYYMMDD';

/**
 * 读取 Notebook Navigator 的日历/日记设置；插件未启用时返回 null。
 * 字段来自 NN 3.x 的 data.json（calendarIntegrationMode / calendarCustomFilePattern /
 * calendarCustomFileTemplate / vaultProfiles[].periodicNotesFolder）。
 */
export function getNotebookNavigatorDailyNoteSettings(app: App): NotebookNavigatorDailyNoteSettings | null {
	const plugins = (app as App & {
		plugins?: { getPlugin?: (id: string) => { settings?: NotebookNavigatorRawSettings } | null };
	}).plugins;
	const raw = plugins?.getPlugin?.(NOTEBOOK_NAVIGATOR_PLUGIN_ID)?.settings;
	if (!raw) return null;
	const profiles = Array.isArray(raw.vaultProfiles) ? raw.vaultProfiles : [];
	const profile = profiles.find((p) => p.id === raw.vaultProfile) ?? profiles[0];
	return {
		integrationMode: raw.calendarIntegrationMode === 'daily-notes' ? 'daily-notes' : 'notebook-navigator',
		rootFolder: normalizeFolder(profile?.periodicNotesFolder),
		pattern: (raw.calendarCustomFilePattern || NN_DEFAULT_DAILY_PATTERN).trim(),
		template: raw.calendarCustomFileTemplate || '',
	};
}

/** 按 Notebook Navigator 设置计算某日的日记文件路径 */
export function getNotebookNavigatorDailyNotePath(nn: NotebookNavigatorDailyNoteSettings, date: Date): string {
	const relative = window.moment(date).format(nn.pattern);
	return normalizePath(`${nn.rootFolder ? `${nn.rootFolder}/` : ''}${relative}.md`);
}

/**
 * 实际生效的日记来源：
 * - 选了 Notebook Navigator 但它委托给核心日记 → 按核心日记处理
 * - 选了 Notebook Navigator 但插件未启用 → 回退手动配置
 */
export function getEffectiveDailyNoteSource(app: App, settings: GanttCalendarSettings): DailyNoteSource {
	if (settings.dailyNoteSource !== 'notebook-navigator') return settings.dailyNoteSource;
	const nn = getNotebookNavigatorDailyNoteSettings(app);
	if (!nn) return 'manual';
	return nn.integrationMode === 'daily-notes' ? 'obsidian' : 'notebook-navigator';
}

// ========== 解析配置 ==========

export interface ResolvedDailyNoteSettings {
	folder: string;
	format: string;       // 插件自定义格式 (yyyy-MM-dd)
	momentFormat: string;  // Moment.js 格式 (YYYY-MM-DD)
	template: string;
}

export function getResolvedDailyNoteSettings(
	app: App,
	_settings: GanttCalendarSettings
): ResolvedDailyNoteSettings {
	const source = getEffectiveDailyNoteSource(app, _settings);
	if (source === 'notebook-navigator') {
		const nn = getNotebookNavigatorDailyNoteSettings(app)!;
		return {
			folder: nn.rootFolder,
			format: momentToPluginFormat(nn.pattern),
			momentFormat: nn.pattern,
			template: nn.template,
		};
	}
	if (source === 'obsidian') {
		const obsidianSettings = getDailyNoteSettings();
		return {
			folder: obsidianSettings.folder || '',
			format: momentToPluginFormat(obsidianSettings.format || 'YYYY-MM-DD'),
			momentFormat: obsidianSettings.format || 'YYYY-MM-DD',
			template: obsidianSettings.template || '',
		};
	}
	return {
		folder: _settings.dailyNotePath || 'DailyNotes',
		format: _settings.dailyNoteNameFormat || 'yyyy-MM-dd',
		momentFormat: pluginToMomentFormat(_settings.dailyNoteNameFormat || 'yyyy-MM-dd'),
		template: _settings.dailyNoteTemplatePath || '',
	};
}

/** 获取核心/Periodic Notes 插件的原始设置（供设置 UI 展示用） */
export function getObsidianDailyNoteSettings() {
	return getDailyNoteSettings();
}

/** 检查核心日记或 Periodic Notes 插件是否可用 */
export function isObsidianDailyNoteAvailable(): boolean {
	return appHasDailyNotesPluginLoaded();
}

/**
 * 文件是否为每日笔记：位于日记根文件夹下，且文件名能按日记格式（最后一段）严格解析为日期。
 * 用于 file-based task「含任务的文件」来源排除日记；根文件夹为库根时只看文件名。
 */
export function isDailyNoteFile(
	app: App,
	settings: GanttCalendarSettings,
	file: { path: string; basename: string },
): boolean {
	let resolved: ResolvedDailyNoteSettings;
	try {
		resolved = getResolvedDailyNoteSettings(app, settings);
	} catch {
		return false;
	}
	const folder = resolved.folder ? normalizeFolder(resolved.folder) : '';
	if (folder && !file.path.startsWith(`${folder}/`)) return false;
	const nameFormat = resolved.momentFormat.split('/').pop() || resolved.momentFormat;
	return window.moment(file.basename, nameFormat, true).isValid();
}

// ========== 日记索引缓存 ==========

/**
 * 日记索引缓存
 * 包装 obsidian-daily-notes-interface 的 getAllDailyNotes()
 * 监听 vault 事件自动失效，懒加载
 */
export class DailyNoteIndex {
	private app: App;
	private cache: Record<string, TFile> | null = null;
	private eventRefs: EventRef[] = [];

	constructor(app: App) {
		this.app = app;
	}

	initialize(): void {
		this.eventRefs.push(
			this.app.vault.on('create', () => this.invalidate()),
			this.app.vault.on('delete', () => this.invalidate()),
			this.app.vault.on('rename', () => this.invalidate()),
		);
	}

	destroy(): void {
		this.eventRefs.forEach(ref => this.app.vault.offref(ref));
		this.eventRefs = [];
		this.cache = null;
	}

	/** 获取日记索引，懒加载 */
	getIndex(): Record<string, TFile> {
		if (!this.cache) {
			try {
				this.cache = getAllDailyNotes();
			} catch (err) {
				// 文件夹不存在等情况
				Logger.debug('DailyNoteIndex', 'Failed to build index:', err);
				this.cache = {};
			}
		}
			return this.cache;
	}

	invalidate(): void {
		this.cache = null;
	}
}

// ========== 查找日记 ==========

/**
 * 按日期查找日记文件
 *
 * Obsidian 模式：通过 obsidian-daily-notes-interface 索引查找（支持嵌套文件夹格式）
 * Notebook Navigator 模式：按其根文件夹 + 路径模式直接定位
 * 手动模式：通过递归搜索（已修复嵌套格式 bug）
 */
export function findDailyNoteForDate(
	date: Date,
	index: DailyNoteIndex,
	app: App,
	settings: GanttCalendarSettings
): TFile | null {
	const source = getEffectiveDailyNoteSource(app, settings);
	if (source === 'notebook-navigator') {
		const nn = getNotebookNavigatorDailyNoteSettings(app)!;
		return app.vault.getFileByPath(getNotebookNavigatorDailyNotePath(nn, date));
	}
	if (source === 'obsidian') {
		const dailyNotes = index.getIndex();
		const momentDate = window.moment(date);
			return getDailyNote(momentDate, dailyNotes);
	}

	// 手动模式：提取纯文件名（修复嵌套文件夹格式 bug）
	const resolved = getResolvedDailyNoteSettings(app, settings);
	const fullFormatResult = formatDate(date, resolved.format);
	const fileName = fullFormatResult.split('/').pop()! + '.md';
	const result = findDailyNoteRecursive(app, resolved.folder, fileName);
	return result?.file ?? null;
}
