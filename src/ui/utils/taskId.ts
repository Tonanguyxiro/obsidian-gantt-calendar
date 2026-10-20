import type { GCTask } from '../../types';
import { isSlotItem } from '../../tasks/scheduledFallback';

const SLOT_SUFFIX = '#slot';

/**
 * 拖拽载荷里的任务 id：`路径:行号`；同一任务的「时间片」代理（⏳ + 时间前缀）与它的日期区间条并存，
 * 用后缀区分被拖的是哪一个
 */
export function dragTaskId(task: GCTask): string {
	return `${task.filePath}:${task.lineNumber}${isSlotItem(task) ? SLOT_SUFFIX : ''}`;
}

/** 按拖拽 id 在视图任务集里找回被拖的项（各视图共用，别再各写一份） */
export function findTaskById(tasks: GCTask[], taskId: string): GCTask | null {
	const slot = taskId.endsWith(SLOT_SUFFIX);
	const base = slot ? taskId.slice(0, -SLOT_SUFFIX.length) : taskId;
	const idx = base.lastIndexOf(':');
	if (idx < 0) return null;
	const filePath = base.slice(0, idx);
	const lineNumber = parseInt(base.slice(idx + 1), 10);
	return tasks.find((t) => t.filePath === filePath && t.lineNumber === lineNumber && isSlotItem(t) === slot) ?? null;
}
