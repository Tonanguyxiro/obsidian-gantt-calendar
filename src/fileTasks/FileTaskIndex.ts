/**
 * File-based task 索引
 *
 * 两种引入来源（设置中可分别开启，取并集）：
 * - 带日期属性的文件：frontmatter 起止属性 + 可选标签过滤（metadataCache，无需读文件）
 * - 含任务的文件：任务来自 calendarStore（已过全局筛选），无日期属性时用任务日期范围
 * 监听元数据变更/删除/重命名与任务集变化，防抖重建后推送到 calendarStore.fileTasks。
 */

import { TFile, debounce, getAllTags, normalizePath, type App, type EventRef } from 'obsidian';
import type { FileTask, GCTask } from '../types';
import type { GanttCalendarSettings } from '../settings/types';
import { buildFileTask, parseRequiredTags } from './fileTaskParser';
import { isFileTaskFeatureOn } from './fileTaskLayer';
import { useCalendarStore } from '../ui/store/calendarStore';
import { isDailyNoteFile } from '../utils/dailyNoteSettingsBridge';

const REBUILD_DEBOUNCE_MS = 150;

export class FileTaskIndex {
	private eventRefs: Array<{ ref: EventRef; source: 'vault' | 'metadataCache' }> = [];
	private readonly scheduleRebuild = debounce(() => this.rebuild(), REBUILD_DEBOUNCE_MS, true);
	private storeUnsubscribe: (() => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => GanttCalendarSettings,
	) {}

	initialize(): void {
		const mc = this.app.metadataCache;
		const vault = this.app.vault;
		this.eventRefs.push(
			{ ref: mc.on('changed', () => this.scheduleRebuild()), source: 'metadataCache' },
			{ ref: mc.on('resolved', () => this.scheduleRebuild()), source: 'metadataCache' },
			{ ref: vault.on('delete', () => this.scheduleRebuild()), source: 'vault' },
			{ ref: vault.on('rename', () => this.scheduleRebuild()), source: 'vault' },
		);
		// 「含任务的文件」来源依赖任务集：任务增删改后重算文件是否引入及其推导日期
		this.storeUnsubscribe = useCalendarStore.subscribe((state, prev) => {
			if (state.tasks !== prev.tasks && this.getSettings().fileTaskIncludeTaskFiles) this.scheduleRebuild();
		});
		this.rebuild();
	}

	destroy(): void {
		this.scheduleRebuild.cancel();
		this.storeUnsubscribe?.();
		this.storeUnsubscribe = null;
		for (const { ref, source } of this.eventRefs) {
			if (source === 'vault') this.app.vault.offref(ref);
			else this.app.metadataCache.offref(ref);
		}
		this.eventRefs = [];
	}

	/** 设置变更后立即重建（属性名/文件夹/开关） */
	rebuild(): void {
		useCalendarStore.getState().setFileTasks(this.collect());
	}

	collect(): FileTask[] {
		const settings = this.getSettings();
		if (!isFileTaskFeatureOn(settings)) return [];
		const folder = settings.fileTaskFolder ? normalizePath(settings.fileTaskFolder) : '';
		const props = {
			start: settings.fileTaskStartProperty || 'start',
			end: settings.fileTaskEndProperty || 'end',
			project: settings.fileTaskProjectProperty || '',
		};
		const sources = {
			includeDated: !!settings.fileTaskIncludeDated,
			includeTaskFiles: !!settings.fileTaskIncludeTaskFiles,
			requiredTags: parseRequiredTags(settings.fileTaskRequiredTags || ''),
		};

		// 含任务的文件：按文件分组 store 中的任务（全局筛选后的真实任务，不含周期虚拟实例）
		const tasksByFile = new Map<string, GCTask[]>();
		if (sources.includeTaskFiles) {
			for (const t of useCalendarStore.getState().tasks) {
				const list = tasksByFile.get(t.filePath);
				if (list) list.push(t);
				else tasksByFile.set(t.filePath, [t]);
			}
		}

		const result: FileTask[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (folder && !file.path.startsWith(`${folder}/`)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			const tasks = tasksByFile.get(file.path) ?? [];
			// 快速跳过：既无 frontmatter 又无任务的文件不可能引入
			if (!fm && tasks.length === 0) continue;
			const task = buildFileTask(file, fm, props, (linkpath) => {
				const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
				return dest instanceof TFile ? { path: dest.path, basename: dest.basename } : null;
			}, sources, {
				tags: cache ? getAllTags(cache) ?? [] : [],
				tasks,
				isDailyNote: tasks.length > 0 && settings.fileTaskExcludeDailyNotes && isDailyNoteFile(this.app, settings, file),
				excludeDailyNotes: !!settings.fileTaskExcludeDailyNotes,
			});
			if (task) result.push(task);
		}
		result.sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
		return result;
	}
}
