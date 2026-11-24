import { useEffect, useMemo, useRef, type JSX, type MutableRefObject } from 'react';
import type { App, TFile } from 'obsidian';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { DescEditorClasses, EditTaskModalClasses } from '../../utils/bem';
import { i18n } from '../../i18n/i18n';

/**
 * 任务描述编辑器：直接使用 Obsidian 原生的 Live Preview 编辑器（与笔记里的编辑体验一致：
 * Markdown 实时渲染、[[ 双链补全含标题/块/别名、快捷键与主题），不自己实现编辑效果。
 *
 * 原生编辑器类不在公开 API 里：经 embedRegistry 创建一个可编辑的嵌入视图，取其 editMode 的
 * 原型链上的构造器（同 Meta Bind 等插件的做法）。取不到或构造失败时退化为普通 textarea。
 */
interface NativeEditorInstance {
	editor: { cm: EditorView };
	/** 宿主对象（相当于笔记视图）：补全与快捷键命令经它找回编辑器 */
	owner: Record<string, unknown>;
	set: (value: string, clear?: boolean) => void;
	get: () => string;
	buildLocalExtensions(): Extension[];
	/** 原生的 [[ / # 等补全调度器；trigger 会让各个 EditorSuggest 按光标处文字自行判断是否弹出 */
	editorSuggest?: { trigger: (editor: unknown, file: TFile | null, explicit: boolean) => void; close: () => void };
	unload: () => void;
	destroy?: () => void;
}
type NativeEditorClass = new (app: App, el: HTMLElement, opts: unknown) => NativeEditorInstance;

interface EmbedWidget {
	editable: boolean;
	showEditor?: () => void;
	editMode?: object;
	unload?: () => void;
}

let cachedClass: NativeEditorClass | null | undefined;

function resolveNativeEditorClass(app: App): NativeEditorClass | null {
	if (cachedClass !== undefined) return cachedClass;
	try {
		const registry = (app as unknown as {
			embedRegistry?: { embedByExtension?: { md?: (ctx: unknown, file: null, path: string) => EmbedWidget } };
		}).embedRegistry;
		const create = registry?.embedByExtension?.md;
		if (!create) return (cachedClass = null);
		const widget = create({ app, containerEl: createDiv(), state: {} }, null, '');
		widget.editable = true;
		widget.showEditor?.();
		const proto: { constructor?: unknown } | null = widget.editMode
			? (Object.getPrototypeOf(Object.getPrototypeOf(widget.editMode)) as { constructor?: unknown })
			: null;
		widget.unload?.();
		cachedClass = typeof proto?.constructor === 'function' ? (proto.constructor as NativeEditorClass) : null;
	} catch {
		cachedClass = null;
	}
	return cachedClass;
}

/** 标记由 DescriptionEditor 创建的合成 owner，避免污染并方便识别 app.workspace.activeEditor */
const DESC_OWNER_FLAG = '__gcDescEditorOwner';

/** 第三方悬浮格式编辑条选择器（Editing Toolbar / cMenu / 格式菜单） */
const FORMATTING_TOOLBAR_SELECTOR = [
	'#editingToolbarModalBar',
	'#editingToolbarPopoverBar',
	'.editingToolbarModalBar',
	'.editingToolbarPopoverBar',
	'.editing-toolbar-ai-inline-prompt',
	'#cMenuModalBar',
	'#cMenuPopoverBar',
	'.menu',
].join(', ');

/** 判断节点是否位于悬浮格式编辑条或其菜单内 */
export function isFormattingToolbarElement(el: Element | null | undefined): boolean {
	if (!el || typeof el.closest !== 'function') return false;
	return Boolean(el.closest(FORMATTING_TOOLBAR_SELECTOR));
}

/** 失焦时是否应暂时保留 workspace.activeEditor（防止点击悬浮格式条按钮时改到后台笔记） */
export function shouldKeepActiveEditorOnBlur(
	relatedTarget: Element | null | undefined,
	hoveredToolbar: boolean
): boolean {
	return isFormattingToolbarElement(relatedTarget) || hoveredToolbar;
}

export function isDescriptionEditorOwner(target: unknown): boolean {
	return typeof target === 'object' && target !== null && (target as Record<string, unknown>)[DESC_OWNER_FLAG] === true;
}

/**
 * 捕获切换焦点前的真实笔记编辑器：
 * 原生编辑器自身的焦点回调可能先于 CodeMirror updateListener 把 ws.activeEditor 改成 ed.owner，
 * 此时绝不能把 ed.owner（或另一个合成 owner）记作 previousActive。
 */
export function capturePreviousActiveEditor(
	currentActive: unknown,
	owner: unknown,
	currentPrevious: unknown,
): unknown {
	if (currentActive && currentActive !== owner && !isDescriptionEditorOwner(currentActive)) {
		return currentActive;
	}
	return currentPrevious && !isDescriptionEditorOwner(currentPrevious) ? currentPrevious : null;
}

/** 仅当 activeEditor 仍指向当前合成 owner 时才还原为真实编辑器 */
export function restorePreviousActiveEditor(
	ws: { activeEditor: unknown },
	owner: unknown,
	previous: unknown,
): void {
	if (ws.activeEditor !== owner) return;
	// Obsidian 的 activeEditor setter 会忽略 MarkdownView 实例（e instanceof MarkdownView || (this._activeEditor = e)），
	// 必须先置 null 清空 _activeEditor，让 getter 回落到当前 MarkdownView；
	// 若 previous 是非 MarkdownView 的嵌入式编辑器（如 Canvas），再写回 previous。
	ws.activeEditor = null;
	if (previous && !isDescriptionEditorOwner(previous) && ws.activeEditor !== previous) {
		ws.activeEditor = previous;
	}
}

/** 任务描述是单行：换行一律折成空格 */
function singleLine(text: string): string {
	return text.split('\r\n').join(' ').split('\n').join(' ').split('\r').join(' ');
}

export interface DescriptionEditorProps {
	app: App;
	value: string;
	onChange: (value: string) => void;
	/** Enter 提交（单行模式）或 Ctrl/⌘+Enter 提交（多行模式） */
	onSubmit: () => void;
	/** 父组件用来聚焦 / 失焦编辑器 */
	focusRef?: MutableRefObject<{ focus: () => void; blur?: () => void } | null>;
	placeholder?: string;
	/** 任务所在文件（编辑模式）：链接补全据此生成最短且无歧义的链接文字；创建模式为空 */
	sourcePath?: string;
	/** 是否允许换行（用于多级 bullet items / 备注编辑框）：Enter 换行，Mod-Enter 提交 */
	multiline?: boolean;
	/** 隐藏默认的底部提示文字 */
	hideHint?: boolean;
	/** 附加到宿主容器的类名 */
	className?: string;
}

export function DescriptionEditor({
	app,
	value,
	onChange,
	onSubmit,
	focusRef,
	placeholder,
	sourcePath,
	multiline = false,
	hideHint = false,
	className,
}: DescriptionEditorProps): JSX.Element {
	const NativeClass = useMemo(() => resolveNativeEditorClass(app), [app]);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<NativeEditorInstance | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	// 编辑器只在挂载时创建一次：回调与初值经 ref 取最新，避免重建编辑器丢失光标
	const latest = useRef({ onChange, onSubmit, placeholder, sourcePath, multiline });
	latest.current = { onChange, onSubmit, placeholder, sourcePath, multiline };
	const initialValue = useRef(value);
	const previousActive = useRef<unknown>(null);
	// 创建失败（内部 API 变动）→ 退化为 textarea
	const failed = useRef(false);

	useEffect(() => {
		const hostEl = hostRef.current;
		if (!NativeClass || !hostEl) return;
		const host: HTMLElement = hostEl;
		let keepActiveOnToolbarBlur = false;
		try {
			const wsInit = app.workspace as unknown as { activeEditor: unknown };
			previousActive.current = capturePreviousActiveEditor(wsInit.activeEditor, null, previousActive.current);
			const Base = NativeClass;
			class EmbeddedLiveEditor extends Base {
				constructor() {
					// 第三个参数是编辑器的 owner（相当于宿主视图）：原生编辑器的选区/补全逻辑会经 owner.editor / owner.editMode 回访自己
					super(app, host, { app, onMarkdownScroll: () => {}, getMode: () => 'source' });
					this.owner.editMode = this;
					this.owner.editor = this.editor;
					this.owner[DESC_OWNER_FLAG] = true;
				}
				override buildLocalExtensions(): Extension[] {
					const submitKeymap = latest.current.multiline
						? keymap.of([{ key: 'Mod-Enter', run: () => { latest.current.onSubmit(); return true; } }])
						: Prec.highest(keymap.of([{ key: 'Enter', run: () => { latest.current.onSubmit(); return true; } }]));
					return [
						...super.buildLocalExtensions(),
						submitKeymap,
						EditorView.updateListener.of((u) => {
							if (u.docChanged) latest.current.onChange(u.state.doc.toString());
							if (u.focusChanged) {
								// 焦点在本编辑器时把它登记为「当前编辑器」：Ctrl/⌘+B、Ctrl/⌘+I 等编辑命令（editor:toggle-bold …）
								// 以及 Editing Toolbar 等悬浮格式条经 workspace.activeEditor 找到要操作的编辑器；失焦时还原并收起补全
								const ed = editorRef.current;
								const ws = app.workspace as unknown as { activeEditor: unknown };
								if (ed && u.view.hasFocus) {
									keepActiveOnToolbarBlur = false;
									previousActive.current = capturePreviousActiveEditor(ws.activeEditor, ed.owner, previousActive.current);
									ws.activeEditor = ed.owner;
								} else if (ed) {
									const doc = u.view.contentDOM.ownerDocument;
									const activeEl = doc.activeElement;
									const hovered = Boolean(doc.querySelector(`:is(${FORMATTING_TOOLBAR_SELECTOR}):hover`));
									const preserve =
										keepActiveOnToolbarBlur ||
										shouldKeepActiveEditorOnBlur(activeEl, hovered);
									keepActiveOnToolbarBlur = false;
									if (!preserve) {
										restorePreviousActiveEditor(ws, ed.owner, previousActive.current);
									}
									ed.editorSuggest?.close();
								}
							}
							// 原生编辑器只在「笔记视图」里自动触发补全；这里宿主不是笔记视图，由我们在输入/移动光标时触发，
							// 让原生的 EditorSuggest 自己判断光标处是否该弹 [[ 补全（弹出后的选择、Esc、方向键仍由原生接管）
							if ((u.docChanged || u.selectionSet) && u.view.contentDOM === u.view.contentDOM.ownerDocument.activeElement) {
								const ed = editorRef.current;
								const path = latest.current.sourcePath;
								const file = path ? app.vault.getFileByPath(path) : null;
								window.setTimeout(() => ed?.editorSuggest?.trigger(ed.editor, file, false), 0);
							}
						}),
						EditorView.domEventHandlers({
							focusin() {
								const ed = editorRef.current;
								if (ed) {
									keepActiveOnToolbarBlur = false;
									const ws = app.workspace as unknown as { activeEditor: unknown };
									previousActive.current = capturePreviousActiveEditor(ws.activeEditor, ed.owner, previousActive.current);
									ws.activeEditor = ed.owner;
								}
								return false;
							},
							focusout(e, view) {
								const related = e.relatedTarget instanceof Element ? e.relatedTarget : null;
								const hovered = Boolean(
									view.contentDOM.ownerDocument.querySelector(`:is(${FORMATTING_TOOLBAR_SELECTOR}):hover`)
								);
								keepActiveOnToolbarBlur = shouldKeepActiveEditorOnBlur(related, hovered);
								return false;
							},
							paste(e, view) {
								if (latest.current.multiline) return false;
								const text = e.clipboardData?.getData('text/plain') ?? '';
								if (!text.includes('\n') && !text.includes('\r')) return false;
								e.preventDefault();
								view.dispatch(view.state.replaceSelection(singleLine(text)));
								return true;
							},
						}),
						...(latest.current.placeholder ? [cmPlaceholder(latest.current.placeholder)] : []),
					];
				}
			}
			const ed = new EmbeddedLiveEditor();
			ed.set(initialValue.current, false);
			editorRef.current = ed;
			if (focusRef) {
				focusRef.current = {
					focus: () => ed.editor.cm.focus(),
					blur: () => ed.editor.cm.contentDOM.blur(),
				};
			}
			return () => {
				ed.editorSuggest?.close();
				if (ed.editor.cm.contentDOM === ed.editor.cm.contentDOM.ownerDocument.activeElement) {
					ed.editor.cm.contentDOM.blur();
				}
				if (focusRef) focusRef.current = null;
				editorRef.current = null;
				ed.unload();
				ed.destroy?.();
				host.empty();
				const ws = app.workspace as unknown as { activeEditor: unknown };
				restorePreviousActiveEditor(ws, ed.owner, previousActive.current);
			};
		} catch {
			failed.current = true;
			return;
		}
	}, [app, NativeClass, focusRef]);

	// 外部改值（非编辑器自己触发的变化）才回写，避免输入时回环
	useEffect(() => {
		const ed = editorRef.current;
		if (ed && ed.get() !== value) ed.set(value, false);
	}, [value]);

	if (!NativeClass || failed.current) {
		return (
			<textarea
				ref={(el) => {
					textareaRef.current = el;
					if (focusRef) {
						focusRef.current = el ? { focus: () => el.focus(), blur: () => el.blur() } : null;
					}
				}}
				className={[EditTaskModalClasses.elements.descTextarea, className].filter(Boolean).join(' ')}
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(multiline ? e.target.value : singleLine(e.target.value))}
				onKeyDown={(e) => {
					if (multiline) {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							onSubmit();
						}
					} else if (e.key === 'Enter') {
						e.preventDefault();
						onSubmit();
					}
				}}
			/>
		);
	}

	return (
		<>
			<div
				ref={hostRef}
				className={[DescEditorClasses.native, 'markdown-source-view mod-cm6 is-live-preview', className]
					.filter(Boolean)
					.join(' ')}
			/>
			{!hideHint ? (
				<div className={DescEditorClasses.hint}>{i18n.t('modals.common.descriptionEditorHint')}</div>
			) : null}
		</>
	);
}
