import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { GCTask } from '../../types';
import type { TaskCardConfig } from '../../components/TaskCard/TaskCardConfig';
import { TaskViewConfig } from '../../components/TaskCard/presets/TaskView.config';
import { FileTaskClasses } from '../../utils/bem';
import { formatDate } from '../../dateUtils/dateUtilsIndex';
import { openFileInExistingLeaf } from '../../utils/fileOpener';
import { i18n } from '../../i18n/i18n';
import { useApp } from '../pluginContext';
import { taskKey } from '../utils/taskKey';
import { Icon } from './Icon';
import { TaskCard, type ReactTaskCardProps } from './TaskCard';
import { IcsEventCard } from './IcsEventCard';

/** 视图提供给文件卡片的上下文：各文件内的任务（已按视图筛选） */
export interface FileTaskLayerContextValue {
	tasksByFile: Map<string, GCTask[]>;
	onRefresh?: () => void;
}

const FileTaskLayerContext = createContext<FileTaskLayerContextValue>({ tasksByFile: new Map() });

export const FileTaskLayerProvider = FileTaskLayerContext.Provider;

/** 悬浮展开卡片内的任务卡配置：列表形态，显示起止/计划/截止 */
const POPOVER_CARD_CONFIG: TaskCardConfig = {
	...TaskViewConfig,
	showFileLocation: false,
	showTicktick: false,
	showGlobalFilter: false,
	compact: true,
	timeFields: {
		showCreated: false,
		showStart: true,
		showScheduled: true,
		showDue: true,
		showCancelled: false,
		showCompletion: false,
		showOverdueIndicator: true,
	},
};

const POPOVER_WIDTH = 320;
const POPOVER_GAP = 4;

/**
 * File-based task 日历卡片：
 * 单击展开悬浮卡片（列出文件内任务），双击打开文件
 */
export const FileTaskCard = memo(function FileTaskCard({ task }: { task: GCTask }): JSX.Element | null {
	const app = useApp();
	const { tasksByFile, onRefresh } = useContext(FileTaskLayerContext);
	const fileTask = task.fileTask;
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
	const items = fileTask ? tasksByFile.get(fileTask.filePath) ?? [] : [];

	const close = useCallback(() => setAnchorRect(null), []);
	const toggle = useCallback(() => {
		setAnchorRect((cur) => (cur ? null : anchorRef.current?.getBoundingClientRect() ?? null));
	}, []);
	const openFile = useCallback(() => {
		if (!fileTask) return;
		close();
		void openFileInExistingLeaf(app, fileTask.filePath, 0);
	}, [app, fileTask, close]);

	// 点击外部 / Esc 关闭（编辑弹窗等 modal 内的点击不算外部）
	useEffect(() => {
		if (!anchorRect) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
			if ((target as Element).closest?.('.modal-container, .menu, .gc-context-menu')) return;
			close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close();
		};
		activeDocument.addEventListener('pointerdown', onPointerDown, true);
		activeDocument.addEventListener('keydown', onKey);
		return () => {
			activeDocument.removeEventListener('pointerdown', onPointerDown, true);
			activeDocument.removeEventListener('keydown', onKey);
		};
	}, [anchorRect, close]);

	const style = useMemo<CSSProperties | undefined>(() => {
		if (!anchorRect) return undefined;
		const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - POPOVER_WIDTH - 8));
		const below = anchorRect.bottom + POPOVER_GAP;
		const roomBelow = window.innerHeight - below - 8;
		// 下方空间不足且上方更宽裕时向上展开
		if (roomBelow < 200 && anchorRect.top > roomBelow) {
			return { position: 'fixed', left, bottom: window.innerHeight - anchorRect.top + POPOVER_GAP, width: POPOVER_WIDTH, maxHeight: anchorRect.top - 16 };
		}
		return { position: 'fixed', left, top: below, width: POPOVER_WIDTH, maxHeight: roomBelow };
	}, [anchorRect]);

	if (!fileTask) return null;
	const sameDay = fileTask.start.toDateString() === fileTask.end.toDateString();
	const range = sameDay
		? formatDate(fileTask.start, 'yyyy-MM-dd')
		: `${formatDate(fileTask.start, 'yyyy-MM-dd')} → ${formatDate(fileTask.end, 'yyyy-MM-dd')}`;
	const pending = items.filter((t) => !t.completed).length;

	return (
		<>
			<div
				ref={anchorRef}
				className={`${FileTaskClasses.block}${anchorRect ? ` ${FileTaskClasses.modifiers.open}` : ''}`}
				data-file-task={fileTask.filePath}
				title={fileTask.project ? `${fileTask.project.label} · ${fileTask.title}` : fileTask.title}
				role="button"
				tabIndex={0}
				onClick={(e) => {
					e.stopPropagation();
					toggle();
				}}
				onDoubleClick={(e) => {
					e.stopPropagation();
					openFile();
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						toggle();
					}
				}}
			>
				<Icon icon="file-text" className={FileTaskClasses.elements.icon} />
				<span className={FileTaskClasses.elements.title}>{fileTask.title}</span>
				{items.length > 0 ? (
					<span className={FileTaskClasses.elements.count}>{pending > 0 ? pending : items.length}</span>
				) : null}
			</div>
			{anchorRect ? createPortal(
				<div
					ref={popoverRef}
					className={FileTaskClasses.elements.popover}
					style={style}
					onClick={(e) => e.stopPropagation()}
				>
					<div className={FileTaskClasses.elements.popoverHeader}>
						<a
							className={FileTaskClasses.elements.popoverTitle}
							href="javascript:void(0)"
							onClick={(e) => {
								e.preventDefault();
								openFile();
							}}
						>
							{fileTask.title}
						</a>
						<div className={FileTaskClasses.elements.popoverMeta}>
							{fileTask.project ? <span>{fileTask.project.label}</span> : null}
							<span>{range}</span>
							{fileTask.dateSource !== 'frontmatter' ? <span>{i18n.t('fileTasks.dateFromTasks')}</span> : null}
						</div>
					</div>
					<div className={FileTaskClasses.elements.popoverList}>
						{items.length === 0 ? (
							<div className={FileTaskClasses.elements.popoverEmpty}>{i18n.t('fileTasks.noTasks')}</div>
						) : items.map((t) => (
							<TaskCard key={taskKey(t)} task={t} config={POPOVER_CARD_CONFIG} onRefresh={onRefresh} />
						))}
					</div>
				</div>,
				activeDocument.body,
			) : null}
		</>
	);
});

/** 日历视图条目：file-based task 占位任务渲染为文件卡片，ICS 事件为只读事件卡片，其余为普通任务卡片 */
export function CalendarItemCard(props: ReactTaskCardProps): JSX.Element {
	if (props.task.fileTask) return <FileTaskCard task={props.task} />;
	if (props.task.icsEvent) return <IcsEventCard task={props.task} />;
	return <TaskCard {...props} />;
}
