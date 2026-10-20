/**
 * 第二步：筛选任务行
 *
 * 负责根据全局过滤器（globalTaskFilter）筛选插件所关注的任务行。
 * 全局过滤器是用户配置的任务前缀，用于区分需要管理的任务和普通任务。
 *
 * @fileoverview 任务行筛选逻辑
 * @module tasks/taskParser/step2
 */

import { RegularExpressions } from '../../utils/RegularExpressions';

// ==================== 类型定义 ====================

/**
 * 筛选结果
 * 包含是否通过筛选和移除过滤器后的内容
 */
export interface FilterResult {
    /** 是否通过全局过滤器 */
    passes: boolean;

    /** 移除全局过滤器前缀后的内容 */
    contentWithoutFilter: string;
}

// ==================== 内部工具 ====================

/**
 * 把内容拆成「前导时间前缀」与其后的正文。
 * Day Planner 写法 "09:00 - 10:30 #task 任务" 中，时间区间在全局筛选符之前，
 * 筛选符的判断/移除要越过它；lead 含前导空白与时间前缀（保留给后续的时间前缀解析）。
 */
function splitLeadingTime(content: string): { lead: string; rest: string } {
    const trimmed = content.replace(/^\s+/, '');
    const m = trimmed.match(RegularExpressions.DayPlanner.timePrefix);
    if (!m) return { lead: '', rest: trimmed };
    return { lead: m[0], rest: trimmed.slice(m[0].length) };
}

/**
 * 在正文里定位全局筛选符，返回起点下标（找不到为 -1）。
 * 与 Tasks 插件一致：筛选符可以出现在行内任意位置（行首、行尾、时间前缀之后…）。
 * 标签形式（#task）要求落在标签边界上：前面不是标签字符，后面是结尾 / 空白 / "/"（子标签），
 * 避免 "#tasks"、"a#task" 误命中。
 */
function locateFilter(text: string, filter: string): number {
    const isTag = filter.startsWith('#');
    let from = 0;
    for (;;) {
        const idx = text.indexOf(filter, from);
        if (idx < 0) return -1;
        if (!isTag) return idx;
        const before = idx > 0 ? text.charAt(idx - 1) : '';
        const after = text.charAt(idx + filter.length);
        const startsTag = !before || !RegularExpressions.DescriptionExtraction.tagPrecedingChar.test(before);
        const endsTag = !after || after === '/' || after.trim() === '';
        if (startsTag && endsTag) return idx;
        from = idx + 1;
    }
}

// ==================== 主要函数 ====================

/**
 * 判断任务是否通过全局过滤器
 *
 * 全局过滤器是用户配置的任务标记（如 "🎯 " / "#task"），只有包含它的任务才会被插件管理（位置不限）。
 * 如果未配置全局过滤器，则所有任务都通过筛选。
 *
 * @param content - 任务内容（复选框后的部分）
 * @param globalTaskFilter - 全局任务过滤器前缀（可选）
 * @returns 是否通过筛选
 *
 * @example
 * ```ts
 * // 配置了全局过滤器 "🎯 "
 * passesGlobalFilter("🎯 重要任务", "🎯 ")           // true
 * passesGlobalFilter("  🎯 重要任务", "🎯 ")         // true（忽略前导空格）
 * passesGlobalFilter("普通任务", "🎯 ")             // false
 *
 * // 未配置全局过滤器
 * passesGlobalFilter("任何任务")                    // true
 * passesGlobalFilter("", undefined)                 // true
 * ```
 */
export function passesGlobalFilter(content: string, globalTaskFilter?: string): boolean {
    if (!globalTaskFilter) return true;

    const trimmedFilter = globalTaskFilter.trim();  // 【修复】添加 trim，防御性处理
    // 筛选符可以在行内任意位置（含紧跟在 Day Planner 时间前缀之后）
    return locateFilter(splitLeadingTime(content).rest, trimmedFilter) >= 0;
}

/**
 * 从任务内容中移除全局过滤器前缀
 *
 * 提取纯任务内容，移除全局过滤器前缀。
 *
 * @param content - 原始任务内容
 * @param globalTaskFilter - 全局任务过滤器前缀（可选）
 * @returns 移除过滤器后的内容
 *
 * @example
 * ```ts
 * removeGlobalFilter("🎯 完成项目 ⏫", "🎯 ")
 * // 返回: "完成项目 ⏫"
 *
 * removeGlobalFilter("🎯🎯 任务", "🎯 ")
 * // 返回: "🎯 任务"（只移除一次）
 *
 * removeGlobalFilter("普通任务", "🎯 ")
 * // 返回: "普通任务"（无变化）
 * ```
 */
export function removeGlobalFilter(content: string, globalTaskFilter?: string): string {
    if (!globalTaskFilter) return content;

    const trimmedFilter = globalTaskFilter.trim();  // 【修复】添加 trim，与 passesGlobalFilter 保持一致
    const { lead, rest } = splitLeadingTime(content);
    const idx = locateFilter(rest, trimmedFilter);
    if (idx < 0) return content;

    // 标签形式的筛选符后紧跟 "/" 时是子标签（#task/work）：整枚标签保留在内容里，
    // 否则会残留 "/work" 污染描述
    if (trimmedFilter.startsWith('#') && rest.charAt(idx + trimmedFilter.length) === '/') return content;

    // 去掉筛选符及其后的空白；位于行内/行尾时，前后文字之间只留一个空格
    const before = rest.slice(0, idx);
    const after = rest.slice(idx + trimmedFilter.length).trimStart();
    const joiner = before.trim() && after ? ' ' : '';
    return lead + (idx === 0 ? '' : before.trimEnd()) + joiner + after;
}

/**
 * 组合筛选和移除过滤器操作
 *
 * 一次性完成筛选判断和内容提取，避免重复计算。
 *
 * @param content - 原始任务内容
 * @param globalTaskFilter - 全局任务过滤器前缀（可选）
 * @returns 筛选结果对象
 *
 * @example
 * ```ts
 * applyFilter("🎯 重要任务 📅 2024-01-15", "🎯 ")
 * // 返回: { passes: true, contentWithoutFilter: "重要任务 📅 2024-01-15" }
 *
 * applyFilter("普通任务", "🎯 ")
 * // 返回: { passes: false, contentWithoutFilter: "普通任务" }
 * ```
 */
export function applyFilter(content: string, globalTaskFilter?: string): FilterResult {
    if (!globalTaskFilter) {
        return { passes: true, contentWithoutFilter: content };
    }

    const passes = passesGlobalFilter(content, globalTaskFilter);
    const contentWithoutFilter = removeGlobalFilter(content, globalTaskFilter);

    return { passes, contentWithoutFilter };
}

/**
 * 批量筛选任务
 *
 * 对多个任务内容进行批量筛选。
 *
 * @param contents - 任务内容数组
 * @param globalTaskFilter - 全局任务过滤器前缀（可选）
 * @returns 通过筛选的任务内容数组
 *
 * @example
 * ```ts
 * const tasks = [
 *   "🎯 任务1",
 *   "普通任务",
 *   "🎯 任务2"
 * ];
 * filterTasks(tasks, "🎯 ")
 * // 返回: ["任务1", "任务2"]
 * ```
 */
export function filterTasks(contents: string[], globalTaskFilter?: string): string[] {
    if (!globalTaskFilter) return contents;

    return contents
        .filter(content => passesGlobalFilter(content, globalTaskFilter))
        .map(content => removeGlobalFilter(content, globalTaskFilter));
}
