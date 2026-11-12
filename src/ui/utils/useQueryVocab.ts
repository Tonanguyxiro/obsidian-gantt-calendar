import { useCallback, useRef } from 'react';
import { TFolder, type App } from 'obsidian';
import type { SuggestVocab } from '../../filters/querySuggest';

/** metadataCache 上未写进类型声明的方法（能力检测后使用） */
interface MetadataCacheExtras {
	getTags?: () => Record<string, number>;
	getAllPropertyInfos?: () => Record<string, { name?: string }>;
	getFrontmatterPropertyValuesForKey?: (key: string) => unknown[];
}

const VALUE_LIMIT = 200;

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function buildVocab(app: App): SuggestVocab {
	const mc = app.metadataCache as unknown as MetadataCacheExtras;

	// 标签：按使用次数降序
	const tagCounts = mc.getTags?.() ?? {};
	const tags = Object.keys(tagCounts)
		.sort((a, b) => (tagCounts[b] ?? 0) - (tagCounts[a] ?? 0) || a.localeCompare(b))
		.map((t) => (t.startsWith('#') ? t.slice(1) : t));

	const folders = app.vault.getAllLoadedFiles()
		.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
		.map((f) => f.path)
		.sort((a, b) => a.localeCompare(b));

	let properties: string[];
	// 新版用 metadataTypeManager.getAllProperties（getAllPropertyInfos 已弃用，调用会打警告）
	const typeManager = (app as unknown as { metadataTypeManager?: { getAllProperties?: () => Record<string, { name?: string }> } }).metadataTypeManager;
	const infos = typeManager?.getAllProperties?.() ?? mc.getAllPropertyInfos?.();
	if (infos) {
		properties = Object.entries(infos).map(([key, info]) => info?.name || key);
	} else {
		const set = new Set<string>();
		for (const f of app.vault.getMarkdownFiles()) {
			for (const k of Object.keys(app.metadataCache.getFileCache(f)?.frontmatter ?? {})) set.add(k);
		}
		properties = Array.from(set);
	}
	properties.sort((a, b) => a.localeCompare(b));

	const valueCache = new Map<string, string[]>();
	const propertyValues = (key: string): string[] => {
		const hit = valueCache.get(key);
		if (hit) return hit;
		const raw = mc.getFrontmatterPropertyValuesForKey?.(key) ?? [];
		const values = Array.from(new Set(raw.flatMap((v): unknown[] => (Array.isArray(v) ? (v as unknown[]) : [v]))
			.filter((v) => v !== null && v !== undefined && typeof v !== 'object')
			.map((v) => String(v))))
			.slice(0, VALUE_LIMIT);
		valueCache.set(key, values);
		return values;
	};

	const now = new Date();
	const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return { tags, folders, properties, propertyValues, today };
}

/**
 * 查询补全用的库内词汇（标签 / 文件夹 / 属性名 / 属性值）
 * 惰性构建；refresh() 在查询框获得焦点时调用，使新建的标签/文件夹及时出现
 */
export function useQueryVocab(app: App): { get: () => SuggestVocab; refresh: () => void } {
	const ref = useRef<SuggestVocab | null>(null);
	const get = useCallback(() => {
		if (!ref.current) ref.current = buildVocab(app);
		return ref.current;
	}, [app]);
	const refresh = useCallback(() => { ref.current = null; }, []);
	return { get, refresh };
}
