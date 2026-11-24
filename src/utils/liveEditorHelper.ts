import { App, MarkdownView, TFile } from 'obsidian';
import { isDescriptionEditorOwner } from '../ui/components/DescriptionEditor';

interface MarkdownViewCandidate {
	file?: { path?: string } | null;
	editor?: { getValue?: () => string } | null;
	getViewData?: () => string;
	dirty?: boolean;
	save?: () => Promise<void> | void;
}

interface WorkspaceWithViews {
	getLeavesOfType?: (type: string) => Array<{ view?: unknown }>;
	getActiveViewOfType?: <T>(type: new (...args: never[]) => T) => T | null;
	getActiveView?: () => unknown;
}

/**
 * 收集当前工作区中打开的所有真实 MarkdownView（排除弹窗内嵌 DescriptionEditor 伪宿主）
 */
function collectOpenMarkdownViews(app: App, filePath?: string): MarkdownViewCandidate[] {
	const ws = (app as App & { workspace?: WorkspaceWithViews }).workspace;
	if (!ws) return [];

	const seen = new Set<MarkdownViewCandidate>();
	const result: MarkdownViewCandidate[] = [];

	const addCandidate = (raw: unknown): void => {
		if (!raw || typeof raw !== 'object' || isDescriptionEditorOwner(raw)) return;
		const view = raw as MarkdownViewCandidate;
		if (!view.file?.path) return;
		if (filePath !== undefined && view.file.path !== filePath) return;
		if (seen.has(view)) return;
		seen.add(view);
		result.push(view);
	};

	if (typeof ws.getLeavesOfType === 'function') {
		const leaves = ws.getLeavesOfType('markdown') || [];
		for (const leaf of leaves) {
			addCandidate(leaf?.view);
		}
	}

	if (typeof ws.getActiveViewOfType === 'function') {
		addCandidate(ws.getActiveViewOfType(MarkdownView));
	} else if (typeof ws.getActiveView === 'function') {
		addCandidate(ws.getActiveView());
	}

	return result;
}

/**
 * 若目标文件当前在某个具有未落盘改动（dirty === true）的 Markdown 编辑器中打开，
 * 直接返回该编辑器的内存文本；否则返回 null（由调用方读取磁盘 vault.read）。
 *
 * 作用：用户在笔记编辑器中修改任务（尚未触发 Obsidian 2s 自动落盘）时，
 * 侧边栏与日历视图可立即读取最新内存文本，消除 2s+ 的刷新延迟与新旧行号脱节。
 */
export function getDirtyEditorContent(app: App, filePath: string): string | null {
	const views = collectOpenMarkdownViews(app, filePath);
	for (const view of views) {
		if (view.dirty !== true) continue;
		if (typeof view.editor?.getValue === 'function') {
			return view.editor.getValue();
		}
		if (typeof view.getViewData === 'function') {
			return view.getViewData();
		}
	}
	return null;
}

/**
 * 读取文件的最新内容：若该文件在未落盘（dirty）的 MarkdownView 中打开则优先读取编辑器内存文本，
 * 否则回落到 app.vault.read(file)。
 */
export async function readLiveOrVaultContent(app: App, file: TFile): Promise<string> {
	const live = getDirtyEditorContent(app, file.path);
	if (live !== null) return live;
	return app.vault.read(file);
}

/**
 * 将打开且存在未保存改动（dirty === true）的 Markdown 编辑器立即冲刷落盘。
 *
 * 在插件写回磁盘（updateTaskProperties / deleteTask / createTaskInFile 等）或手动全量刷新前调用，
 * 防止磁盘上的旧版本与编辑器内存中的插行/改字竞态合并产生重复任务行。
 */
export async function flushDirtyMarkdownViews(app: App, filePath?: string): Promise<void> {
	const views = collectOpenMarkdownViews(app, filePath);
	for (const view of views) {
		if (view.dirty === true && typeof view.save === 'function') {
			try {
				await view.save();
			} catch {
				// 忽略已卸载视图的保存异常
			}
		}
	}
}
