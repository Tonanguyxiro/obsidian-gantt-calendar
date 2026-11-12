import { useEffect, useState, type RefObject } from 'react';
import { Platform } from 'obsidian';

/**
 * 平台/输入方式探测（移动端适配的统一入口）
 *
 * 双信号原则（桌面窄窗口拍板，2026-09-05）：
 * - isPhone：仅认设备 Platform.isPhone —— 视图形态类判定
 *   （周视图 3 日窗/日视图竖屏/月视图色点/甘特列宽），桌面窄窗口不改变信息结构
 * - isNarrow：宽度断点（≤520px）—— 空间适配类判定
 *   （工具栏 ⋯ 收纳等纯布局收缩），窄桌面窗口同样受益
 * - isTouch：主输入为粗指针（无 hover）—— 触屏交互分支与 CSS `@media (hover: none)` 对齐
 */

const PHONE_WIDTH_QUERY = '(max-width: 520px)';
const TOUCH_QUERY = '(hover: none), (pointer: coarse)';

/** 当前是否为手机形态：仅认设备（Platform.isPhone），桌面窄窗口不算 */
export function isPhoneNow(): boolean {
	return Platform.isPhone;
}

/** 当前主输入是否为触屏（同步读取，非响应式） */
export function isTouchNow(): boolean {
	return window.matchMedia(TOUCH_QUERY).matches;
}

/** 手机形态（设备级常量语义；保留 hook 形态兼容既有调用点） */
export function useIsPhone(): boolean {
	return isPhoneNow();
}

/** 窄窗口（宽度断点响应式 hook）：空间适配类判定专用，不改变视图信息结构 */
export function useIsNarrow(): boolean {
	const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(PHONE_WIDTH_QUERY).matches);
	useEffect(() => {
		const mql = window.matchMedia(PHONE_WIDTH_QUERY);
		const onChange = () => setIsNarrow(mql.matches);
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	}, []);
	return isNarrow;
}

/**
 * 元素宽度是否不超过阈值（ResizeObserver）：分屏 / 窄侧栏按视图自身宽度收缩，
 * 窗口宽度断点在分屏时不生效
 */
export function useElementNarrow(ref: RefObject<HTMLElement | null>, maxWidth: number, observeParent = false): boolean {
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const el = observeParent ? ref.current?.parentElement : ref.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const update = (w: number) => setNarrow(w > 0 && w <= maxWidth);
		update(el.getBoundingClientRect().width);
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) update(entry.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref, maxWidth, observeParent]);
	return narrow;
}
