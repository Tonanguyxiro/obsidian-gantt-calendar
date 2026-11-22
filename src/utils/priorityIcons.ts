/**
 * 优先级 Lucide 图标与语义色令牌单一来源（Single Source of Truth）
 *
 * UI 层（TaskCard、TaskFormModal、Tooltip、TaskSorter 元数据）统一引用本模块；
 * 仅 Markdown 序列化/解析层（dailyNoteHelper、taskSerializer、RegularExpressions）保留 Tasks 表情符号。
 */

export type PriorityLevel = 'highest' | 'high' | 'medium' | 'normal' | 'low' | 'lowest';

export interface PriorityMeta {
	level: PriorityLevel;
	icon: string;
	colorVar: string;
}

export const PRIORITY_ORDER: readonly PriorityLevel[] = [
	'highest',
	'high',
	'medium',
	'normal',
	'low',
	'lowest',
] as const;

export const PRIORITY_ICON_MAP: Readonly<Record<PriorityLevel, PriorityMeta>> = {
	highest: { level: 'highest', icon: 'chevrons-up', colorVar: 'var(--gc-color-red)' },
	high: { level: 'high', icon: 'chevron-up', colorVar: 'var(--gc-color-orange)' },
	medium: { level: 'medium', icon: 'equal', colorVar: 'var(--gc-color-yellow)' },
	normal: { level: 'normal', icon: 'minus', colorVar: 'var(--text-faint)' },
	low: { level: 'low', icon: 'chevron-down', colorVar: 'var(--gc-color-blue)' },
	lowest: { level: 'lowest', icon: 'chevrons-down', colorVar: 'var(--text-muted)' },
};

/**
 * 获取优先级对应的 Lucide 图标与颜色令牌元数据。
 * 未知或空值安全回退到 'normal'。
 */
export function getPriorityMeta(priority?: string | null): PriorityMeta {
	if (!priority) return PRIORITY_ICON_MAP.normal;
	const key = priority.toLowerCase() as PriorityLevel;
	return Object.prototype.hasOwnProperty.call(PRIORITY_ICON_MAP, key)
		? PRIORITY_ICON_MAP[key]
		: PRIORITY_ICON_MAP.normal;
}
