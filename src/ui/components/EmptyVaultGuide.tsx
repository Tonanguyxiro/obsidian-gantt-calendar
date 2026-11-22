import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { formatDate } from '../../dateUtils/dateUtilsIndex';
import { i18n } from '../../i18n/i18n';
import { EmptyGuideClasses } from '../../utils/bem';
import { openCreateTaskModal } from '../modals/TaskFormModal';
import { useApp, usePlugin } from '../pluginContext';
import { useCalendarStore } from '../store/calendarStore';
import { Icon } from './Icon';

export interface EmptyVaultGuideProps {
	/** 侧边栏窄容器紧凑样式 */
	compact?: boolean;
}

interface SyntaxExample {
	id: 'range' | 'slot' | 'dataview';
	label: string;
	code: string;
}

const COPY_FEEDBACK_MS = 1800;

async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * 首次安装 / 空任务库引导卡片
 * 展示当前全局过滤符、可复制的 Tasks Emoji 与 Dataview 示例，并提供新建任务主按钮。
 */
export function EmptyVaultGuide({ compact = false }: EmptyVaultGuideProps): JSX.Element {
	const plugin = usePlugin();
	const app = useApp();
	const globalTaskFilter = useCalendarStore((s) => s.settings.globalTaskFilter);
	const language = useCalendarStore((s) => s.settings.language);
	const currentDate = useCalendarStore((s) => s.currentDate);
	const refreshTasks = useCalendarStore((s) => s.refreshTasks);

	const [copiedId, setCopiedId] = useState<string | null>(null);
	const copyTimerRef = useRef<number | null>(null);

	useEffect(() => () => {
		if (copyTimerRef.current !== null) {
			window.clearTimeout(copyTimerRef.current);
		}
	}, []);

	const trimmedFilter = (globalTaskFilter || '').trim();

	const examples = useMemo<SyntaxExample[]>(() => {
		void language;
		const today = new Date();
		const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
		const todayStr = formatDate(today, 'yyyy-MM-dd');
		const dueStr = formatDate(due, 'yyyy-MM-dd');
		const prefix = trimmedFilter ? `${trimmedFilter} ` : '';

		return [
			{
				id: 'range',
				label: i18n.t('emptyGuide.examples.rangeLabel'),
				code: `- [ ] ${prefix}${i18n.t('emptyGuide.examples.rangeText')} ⏫ 🛫 ${todayStr} 📅 ${dueStr}`,
			},
			{
				id: 'slot',
				label: i18n.t('emptyGuide.examples.slotLabel'),
				code: `- [ ] 09:00 - 10:30 ${prefix}${i18n.t('emptyGuide.examples.slotText')} ⏳ ${todayStr}`,
			},
			{
				id: 'dataview',
				label: i18n.t('emptyGuide.examples.dataviewLabel'),
				code: `- [ ] ${prefix}${i18n.t('emptyGuide.examples.dataviewText')} [due:: ${dueStr}]`,
			},
		];
	}, [trimmedFilter, language]);

	const handleCopy = useCallback(async (id: string, code: string) => {
		const ok = await copyText(code);
		if (!ok) return;
		setCopiedId(id);
		if (copyTimerRef.current !== null) {
			window.clearTimeout(copyTimerRef.current);
		}
		copyTimerRef.current = window.setTimeout(() => {
			copyTimerRef.current = null;
			setCopiedId(null);
		}, COPY_FEEDBACK_MS);
	}, []);

	const handleCreateTask = useCallback(() => {
		openCreateTaskModal({
			app,
			plugin,
			targetDate: currentDate,
			onSuccess: refreshTasks,
		});
	}, [app, plugin, currentDate, refreshTasks]);

	const rootClass = compact
		? `${EmptyGuideClasses.block} ${EmptyGuideClasses.modifiers.compact}`
		: EmptyGuideClasses.block;

	return (
		<section className={rootClass} aria-label={i18n.t('emptyGuide.title')}>
			<div className={EmptyGuideClasses.elements.header}>
				<span className={EmptyGuideClasses.elements.icon} aria-hidden="true">
					<Icon icon="sparkles" />
				</span>
				<div>
					<h3 className={EmptyGuideClasses.elements.title}>{i18n.t('emptyGuide.title')}</h3>
					<p className={EmptyGuideClasses.elements.desc}>{i18n.t('emptyGuide.description')}</p>
				</div>
			</div>

			<div className={EmptyGuideClasses.elements.filterRow}>
				{trimmedFilter ? (
					<>
						<span className={EmptyGuideClasses.elements.filterLabel}>{i18n.t('emptyGuide.filterLabel')}</span>
						<code className={EmptyGuideClasses.elements.filterChip}>{trimmedFilter}</code>
					</>
				) : (
					<span className={EmptyGuideClasses.elements.filterLabel}>{i18n.t('emptyGuide.noFilterHint')}</span>
				)}
			</div>

			<div className={EmptyGuideClasses.elements.examples}>
				<div className={EmptyGuideClasses.elements.examplesTitle}>{i18n.t('emptyGuide.examplesTitle')}</div>
				{examples.map((ex) => {
					const isCopied = copiedId === ex.id;
					const copyBtnClass = isCopied
						? `${EmptyGuideClasses.elements.copyBtn} ${EmptyGuideClasses.modifiers.copied}`
						: EmptyGuideClasses.elements.copyBtn;
					return (
						<div key={ex.id} className={EmptyGuideClasses.elements.exampleItem} data-example-id={ex.id}>
							<div className={EmptyGuideClasses.elements.exampleMeta}>
								<span className={EmptyGuideClasses.elements.exampleLabel}>{ex.label}</span>
								<button
									type="button"
									className={copyBtnClass}
									onClick={() => void handleCopy(ex.id, ex.code)}
									aria-label={`${i18n.t('emptyGuide.copy')}: ${ex.label}`}
								>
									<Icon icon={isCopied ? 'check' : 'copy'} />
									<span>{isCopied ? i18n.t('emptyGuide.copied') : i18n.t('emptyGuide.copy')}</span>
								</button>
							</div>
							<code className={EmptyGuideClasses.elements.exampleCode}>{ex.code}</code>
						</div>
					);
				})}
			</div>

			<div className={EmptyGuideClasses.elements.actions}>
				<button
					type="button"
					className={EmptyGuideClasses.elements.ctaBtn}
					onClick={handleCreateTask}
				>
					<Icon icon="plus" />
					<span>{i18n.t('emptyGuide.createTaskCta')}</span>
				</button>
			</div>
		</section>
	);
}
