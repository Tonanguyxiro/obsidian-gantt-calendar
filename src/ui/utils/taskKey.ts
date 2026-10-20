import type { GCTask } from '../../types';
import { getVirtualMetadata } from '../../tasks/virtualTaskGenerator';
import { isSlotItem } from '../../tasks/scheduledFallback';

/**
 * 任务在列表渲染中的唯一 key。
 * 周期任务的虚拟实例与源任务共享 filePath:lineNumber——同一渲染区间内
 * 真实任务与虚拟实例（或多个虚拟实例）会同 key，导致 React 丢弃渲染。
 * 虚拟实例追加出现日期消歧。
 */
export function taskKey(t: GCTask): string {
	const occ = getVirtualMetadata(t)?.occurrenceDate;
	if (occ) {
		const y = occ.getFullYear();
		const m = String(occ.getMonth() + 1).padStart(2, '0');
		const d = String(occ.getDate()).padStart(2, '0');
		return `${t.filePath}:${t.lineNumber}@${y}-${m}-${d}`;
	}
	// 时间片代理与同任务的日期区间条并存，key 要区分
	return `${t.filePath}:${t.lineNumber}${isSlotItem(t) ? '#slot' : ''}`;
}
