import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type JSX,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { FilterPanelClasses, NativeSuggestClasses, QueryEditorClasses } from '../../utils/bem';
import { i18n } from '../../i18n/i18n';
import {
	applySuggestion,
	getQuerySuggestions,
	type SuggestResult,
	type SuggestVocab,
} from '../../filters/querySuggest';
import { insertExample, type QueryExampleGroup } from '../../filters/queryExamples';
import type { QueryEngine } from '../../filters/queryEngines';

const COMMIT_DELAY = 400;
const POPUP_WIDTH = 280;

export interface QueryEditorProps {
	value: string;
	placeholder: string;
	onCommit: (value: string) => void;
	page: 'task' | 'file';
	/** 由内容识别引擎（随输入实时切换补全词表） */
	detect: (text: string) => QueryEngine;
	vocab: { get: () => SuggestVocab; refresh: () => void };
	examples: QueryExampleGroup<QueryEngine>[];
	isAvailable: (engine: QueryEngine) => boolean;
	/** 状态行（命中数 / 错误）；草稿尚未提交时显示"等待输入停顿" */
	status: ReactNode;
	/** 状态行下方的详细信息（错误列表） */
	messages?: ReactNode;
}

export function engineLabel(engine: QueryEngine): string {
	return i18n.t(`toolbar.filterPanel.engine.${engine}`);
}

/**
 * 筛选查询框：输入停顿后提交、按引擎的补全弹窗（原生 suggestion 外观，↑↓ / Enter / Tab / Esc，Ctrl+Space 手动触发）、
 * 可点击的示例与状态行
 */
export function QueryEditor({ value, placeholder, onCommit, page, detect, vocab, examples, isAvailable, status, messages }: QueryEditorProps): JSX.Element {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);

	// 切换标签页/关闭面板时卸载：把尚未提交的草稿立即写入，避免丢失
	const latest = useRef({ draft, value, onCommit });
	latest.current = { draft, value, onCommit };
	useEffect(() => () => {
		const { draft: d, value: v, onCommit: commit } = latest.current;
		if (d !== v) commit(d);
	}, []);
	useEffect(() => {
		if (draft === value) return;
		const timer = window.setTimeout(() => onCommit(draft), COMMIT_DELAY);
		return () => window.clearTimeout(timer);
	}, [draft, value, onCommit]);

	const engine = detect(draft);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const markerRef = useRef<HTMLSpanElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const [caret, setCaret] = useState(0);
	const [suggest, setSuggest] = useState<SuggestResult | null>(null);
	const [selected, setSelected] = useState(0);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const [scrollTick, setScrollTick] = useState(0);
	const pendingCaret = useRef<number | null>(null);

	const compute = useCallback((text: string, at: number, explicit: boolean) => {
		setCaret(at);
		const res = getQuerySuggestions(detect(text), text, at, vocab.get(), { explicit, page });
		setSuggest(res);
		setSelected(0);
	}, [detect, vocab, page]);

	const close = useCallback(() => setSuggest(null), []);

	// 应用候选后恢复光标，并继续给出后续候选（如 "tag includes " 之后的标签）
	useLayoutEffect(() => {
		const ta = textareaRef.current;
		if (pendingCaret.current === null || !ta) return;
		const at = pendingCaret.current;
		pendingCaret.current = null;
		ta.focus();
		ta.setSelectionRange(at, at);
		compute(draft, at, false);
	}, [draft, compute]);

	// 弹窗定位：镜像层里光标处标记的位置（扣除 textarea 的滚动）
	useLayoutEffect(() => {
		const ta = textareaRef.current;
		const marker = markerRef.current;
		if (!suggest || !ta || !marker) {
			setPos(null);
			return;
		}
		const m = marker.getBoundingClientRect();
		const t = ta.getBoundingClientRect();
		const view = ta.ownerDocument.defaultView;
		const vw = view?.innerWidth ?? 1200;
		const top = Math.min(m.bottom - ta.scrollTop + 2, t.bottom + 2);
		const left = Math.max(4, Math.min(m.left, vw - POPUP_WIDTH - 4));
		setPos({ top, left });
	}, [suggest, caret, draft, scrollTick]);

	useEffect(() => {
		const el = listRef.current?.children[selected] as HTMLElement | undefined;
		el?.scrollIntoView({ block: 'nearest' });
	}, [selected, suggest]);

	const accept = (index: number) => {
		if (!suggest) return;
		const item = suggest.items[index];
		if (!item) return;
		const next = applySuggestion(draft, suggest, item);
		setSuggest(null);
		if (next.text === draft) {
			textareaRef.current?.setSelectionRange(next.caret, next.caret);
			return;
		}
		pendingCaret.current = next.caret;
		setDraft(next.text);
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		const ta = e.currentTarget;
		if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			compute(ta.value, ta.selectionStart, true);
			return;
		}
		if (!suggest) return;
		const n = suggest.items.length;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				setSelected((s) => (s + 1) % n);
				return;
			case 'ArrowUp':
				e.preventDefault();
				setSelected((s) => (s - 1 + n) % n);
				return;
			case 'Enter':
			case 'Tab':
				if (e.shiftKey || e.altKey) return;
				e.preventDefault();
				accept(selected);
				return;
			case 'Escape':
				// 只关补全，不让外层下拉面板跟着关闭
				e.preventDefault();
				e.stopPropagation();
				close();
				return;
			case 'ArrowLeft':
			case 'ArrowRight':
			case 'Home':
			case 'End':
				close();
				return;
			default:
		}
	};

	const insertFromExample = (example: string, exampleEngine: QueryEngine) => {
		const next = insertExample(draft, engine, example, exampleEngine);
		setDraft(next);
		onCommit(next);
		close();
		pendingCaret.current = null;
		const ta = textareaRef.current;
		if (ta) {
			ta.focus();
			window.setTimeout(() => ta.setSelectionRange(next.length, next.length), 0);
		}
	};

	const doc = textareaRef.current?.ownerDocument;
	const popup = suggest && pos && doc ? createPortal(
		<div
			className={`${NativeSuggestClasses.container} ${QueryEditorClasses.suggest}`}
			style={{ position: 'fixed', top: pos.top, left: pos.left, width: POPUP_WIDTH }}
			// 保持 textarea 焦点；点击不冒泡到外层下拉的"点外部关闭"
			onMouseDown={(e) => e.preventDefault()}
			onClick={(e) => e.stopPropagation()}
		>
			<div className={NativeSuggestClasses.list} ref={listRef}>
				{suggest.items.map((item, i) => (
					<div
						key={`${item.kind}:${item.insert}`}
						className={`${NativeSuggestClasses.item}${i === selected ? ` ${NativeSuggestClasses.selected}` : ''}`}
						onMouseMove={() => { if (i !== selected) setSelected(i); }}
						onClick={() => accept(i)}
					>
						<div className={NativeSuggestClasses.content}>
							<div className={NativeSuggestClasses.title}>{item.label}</div>
						</div>
						<div className={`${NativeSuggestClasses.aux} ${QueryEditorClasses.suggestKind}`}>
							{i18n.t(`toolbar.filterPanel.suggestKind.${item.kind}`)}
						</div>
					</div>
				))}
			</div>
			<div className={QueryEditorClasses.suggestHint}>{i18n.t('toolbar.filterPanel.suggestHint')}</div>
		</div>,
		doc.body,
	) : null;

	const dirty = draft !== value;

	return (
		<>
			<div className={QueryEditorClasses.wrap}>
				<textarea
					ref={textareaRef}
					className={FilterPanelClasses.textarea}
					value={draft}
					placeholder={placeholder}
					spellCheck={false}
					aria-autocomplete="list"
					aria-expanded={!!suggest}
					onFocus={vocab.refresh}
					onChange={(e) => {
						setDraft(e.target.value);
						compute(e.target.value, e.target.selectionStart, false);
					}}
					onKeyDown={onKeyDown}
					onClick={close}
					onBlur={close}
					onScroll={() => { if (suggest) setScrollTick((n) => n + 1); }}
				/>
				<div className={QueryEditorClasses.mirror} aria-hidden="true">
					{draft.slice(0, caret)}
					<span ref={markerRef} className={QueryEditorClasses.caret}>{'​'}</span>
				</div>
			</div>
			{popup}
			<div className={QueryEditorClasses.status}>
				<span className={QueryEditorClasses.engine}>{engineLabel(engine)}</span>
				{dirty ? <span className={QueryEditorClasses.statusPending}>{i18n.t('toolbar.filterPanel.statusTyping')}</span> : status}
			</div>
			{messages}
			<details className={QueryEditorClasses.examples}>
				<summary className={QueryEditorClasses.examplesSummary}>{i18n.t('toolbar.filterPanel.examples')}</summary>
				{examples.map((group) => (
					<div key={group.engine} className={QueryEditorClasses.exampleGroup}>
						<div className={QueryEditorClasses.exampleGroupTitle}>
							{engineLabel(group.engine)}
							{isAvailable(group.engine) ? '' : ` — ${i18n.t('toolbar.filterPanel.engineMissing')}`}
						</div>
						{group.examples.map((ex) => (
							<button
								key={ex}
								type="button"
								className={QueryEditorClasses.example}
								title={i18n.t('toolbar.filterPanel.exampleInsert')}
								onClick={() => insertFromExample(ex, group.engine)}
							>
								{ex}
							</button>
						))}
					</div>
				))}
			</details>
		</>
	);
}
