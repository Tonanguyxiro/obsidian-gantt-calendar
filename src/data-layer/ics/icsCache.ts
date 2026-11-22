/**
 * ICS 订阅文本持久化缓存
 *
 * 将最近一次成功拉取的 ICS 原始文本落盘到插件目录（`ics-cache.json`），
 * 使离线或重启首屏时可立即恢复只读日历事件，待后台刷新成功后更新并裁剪失效订阅。
 */

import { Logger } from '../../utils/logger';

export const ICS_CACHE_VERSION = 1;
export const ICS_CACHE_FILENAME = 'ics-cache.json';

export interface IcsCacheEntry {
	text: string;
	fetchedAt: number;
}

export interface IcsCacheData {
	version: number;
	entries: Record<string, IcsCacheEntry>;
}

export interface IcsCacheAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir?(path: string): Promise<void>;
}

export interface IcsCachePluginContext {
	app: {
		vault: {
			configDir?: string;
			adapter: IcsCacheAdapter;
		};
	};
	manifest?: {
		id?: string;
		dir?: string;
	};
}

export function createEmptyIcsCache(): IcsCacheData {
	return {
		version: ICS_CACHE_VERSION,
		entries: {},
	};
}

/**
 * 解析缓存文件路径：优先 `${plugin.manifest.dir}/ics-cache.json`，
 * 缺失时回退 `${app.vault.configDir}/plugins/gantt-calendar/ics-cache.json`。
 */
export function resolveIcsCachePath(plugin: IcsCachePluginContext): string {
	const manifestDir = plugin.manifest?.dir?.trim();
	if (manifestDir) {
		return `${manifestDir.replace(/\/+$/, '')}/${ICS_CACHE_FILENAME}`;
	}
	const configDir = plugin.app?.vault?.configDir?.trim();
	const pluginId = plugin.manifest?.id?.trim() || 'gantt-calendar';
	if (configDir) {
		return `${configDir.replace(/\/+$/, '')}/plugins/${pluginId}/${ICS_CACHE_FILENAME}`;
	}
	return `plugins/${pluginId}/${ICS_CACHE_FILENAME}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析并校验磁盘缓存 JSON；损坏或版本不匹配时安全退回空缓存。
 */
export function parseIcsCache(raw: string): IcsCacheData {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainRecord(parsed) || parsed.version !== ICS_CACHE_VERSION || !isPlainRecord(parsed.entries)) {
			return createEmptyIcsCache();
		}
		const entries: Record<string, IcsCacheEntry> = {};
		for (const [url, entry] of Object.entries(parsed.entries)) {
			if (!url || !isPlainRecord(entry)) continue;
			if (typeof entry.text !== 'string') continue;
			if (typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)) continue;
			entries[url] = {
				text: entry.text,
				fetchedAt: entry.fetchedAt,
			};
		}
		return {
			version: ICS_CACHE_VERSION,
			entries,
		};
	} catch {
		return createEmptyIcsCache();
	}
}

export async function loadIcsCache(plugin: IcsCachePluginContext): Promise<IcsCacheData> {
	const adapter = plugin.app?.vault?.adapter;
	if (!adapter) return createEmptyIcsCache();
	const path = resolveIcsCachePath(plugin);
	try {
		if (!(await adapter.exists(path))) {
			return createEmptyIcsCache();
		}
		const raw = await adapter.read(path);
		return parseIcsCache(raw);
	} catch (error) {
		Logger.warn('IcsCache', `Failed to read ICS cache at ${path}`, error);
		return createEmptyIcsCache();
	}
}

export async function saveIcsCache(
	plugin: IcsCachePluginContext,
	entries: Record<string, IcsCacheEntry>,
): Promise<void> {
	const adapter = plugin.app?.vault?.adapter;
	if (!adapter) return;
	const path = resolveIcsCachePath(plugin);
	const slashIndex = path.lastIndexOf('/');
	if (slashIndex > 0 && typeof adapter.mkdir === 'function') {
		const dir = path.slice(0, slashIndex);
		try {
			if (!(await adapter.exists(dir))) {
				await adapter.mkdir(dir);
			}
		} catch {
			// Ignore if directory already exists or mkdir is unsupported
		}
	}
	const payload: IcsCacheData = {
		version: ICS_CACHE_VERSION,
		entries,
	};
	await adapter.write(path, JSON.stringify(payload));
}
