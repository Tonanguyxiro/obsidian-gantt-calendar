/**
 * 状态切换对应的字段更新（右键菜单与任务弹窗共用，保证两处一致）
 *
 * 与复选框 / 取消 / 恢复命令的约定一致：
 * - done：completed = true，补完成日期（已有则保留），清取消状态
 * - canceled：cancelled = true，补取消日期，清完成状态
 * - 其余（todo / important / 自定义…）：清完成与取消状态及对应日期
 */

import type { App } from 'obsidian';
import type { GCTask } from '../types';
import { DEFAULT_TASK_STATUSES, type TaskStatus } from './taskStatus';
import type { TaskUpdates } from './taskSerializer';

type StatusFields = Pick<GCTask, 'completed' | 'cancelled' | 'completionDate' | 'cancelledDate'>;

export function statusTransitionUpdates(task: StatusFields, key: string, now: Date = new Date()): TaskUpdates {
	const updates: TaskUpdates = { status: key };
	if (key === 'done') {
		updates.completed = true;
		updates.completionDate = task.completionDate ?? now;
		updates.cancelled = false;
		if (task.cancelled || task.cancelledDate) updates.cancelledDate = null;
	} else if (key === 'canceled') {
		updates.cancelled = true;
		updates.cancelledDate = task.cancelledDate ?? now;
		updates.completed = false;
		if (task.completed || task.completionDate) updates.completionDate = null;
	} else {
		updates.completed = false;
		updates.cancelled = false;
		if (task.completed || task.completionDate) updates.completionDate = null;
		if (task.cancelled || task.cancelledDate) updates.cancelledDate = null;
	}
	return updates;
}

/** 设置里配置的状态列表（含用户自定义），缺省为内置状态；右键菜单、任务弹窗、写回都从这里取，保证一致 */
export function getConfiguredStatuses(app: App): TaskStatus[] {
	const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: { taskStatuses?: TaskStatus[] } } | undefined> } }).plugins?.plugins?.['gantt-calendar'];
	const configured = plugin?.settings?.taskStatuses;
	return configured && configured.length > 0 ? configured : DEFAULT_TASK_STATUSES;
}

/** 右键菜单里可直接切换到的状态：完成 / 取消有各自的命令（复选框、取消 / 恢复），不在此列 */
export function isMenuStatus(key: string): boolean {
	return key !== 'done' && key !== 'canceled';
}

/** 状态是否显示在选择中（缺省显示） */
export function isStatusInPicker(status: TaskStatus): boolean {
	return status.showInPicker !== false;
}

/**
 * 选择器（任务弹窗 / 右键菜单）里要列出的状态：设置里勾选「显示在状态选择中」的；
 * 任务当前正在用的状态即使没勾选也保留，避免打开弹窗时看不到现状
 */
export function getPickerStatuses(app: App, currentKey?: string): TaskStatus[] {
	return getConfiguredStatuses(app).filter((st) => isStatusInPicker(st) || st.key === currentKey);
}
