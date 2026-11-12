import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { FilterPanelClasses, QueryEditorClasses } from '../../utils/bem';
import { usePlugin, useApp } from '../pluginContext';
import { useCalendarStore, selectViewFilter, type ViewScope } from '../store/calendarStore';
import { useAdvancedFilters } from '../utils/useAdvancedFilters';
import { i18n } from '../../i18n/i18n';
import { DEFAULT_FILE_FILTER_STATE, DEFAULT_TAG_FILTER_STATE } from '../../types';
import type { TaskStatus } from '../../tasks/taskStatus';
import { DEFAULT_TASK_STATUSES } from '../../tasks/taskStatus';
import { listBaseViews } from '../../filters/baseFilter';
import { readBaseText } from '../../filters/baseFilter';
import { TagTreeFilter } from './TagTreeFilter';
import { QueryEditor } from './QueryEditor';
import { useQueryVocab } from '../utils/useQueryVocab';
import { detectFileEngine, detectTaskEngine, isEngineAvailable, type QueryEngine } from '../../filters/queryEngines';
import { FILE_QUERY_EXAMPLES, TASK_QUERY_EXAMPLES } from '../../filters/queryExamples';

type Tab = 'file' | 'task';

/** 查询框下的状态行：进行中 / ✓ 命中数；错误逐条列出（Tasks 语法里有效行仍生效，故可与命中数并存） */
function QueryStatus({ pending, errors, count, unit }: {
	pending: boolean;
	errors: string[];
	count: number | null;
	unit: 'tasks' | 'notes';
}): JSX.Element | null {
	if (pending) return <span className={QueryEditorClasses.statusPending}>{i18n.t('toolbar.filterPanel.statusRunning')}</span>;
	return (
		<>
			{count !== null ? (
				<span className={QueryEditorClasses.statusOk}>
					{i18n.t(unit === 'tasks' ? 'toolbar.filterPanel.statusTaskMatches' : 'toolbar.filterPanel.statusNoteMatches', { count })}
				</span>
			) : null}
			{errors.length > 0 && count === null ? (
				<span className={QueryEditorClasses.statusError}>{i18n.t('toolbar.filterPanel.statusError')}</span>
			) : null}
		</>
	);
}

function Errors({ errors }: { errors: string[] }): JSX.Element | null {
	if (errors.length === 0) return null;
	return (
		<div className={FilterPanelClasses.error}>
			{errors.map((e, i) => <div key={i}>✗ {e}</div>)}
		</div>
	);
}

/**
 * 工具栏筛选面板：File（Bases 语法：.base 文件 + 表达式）与 Task（状态 / 标签 / Tasks 查询）两页
 */
export function FilterPanel({ scope }: { scope: ViewScope }): JSX.Element {
	const plugin = usePlugin();
	const app = useApp();
	const filter = useCalendarStore((s) => selectViewFilter(s, scope));
	const setStatusFilter = useCalendarStore((s) => s.setStatusFilter);
	const setTagFilter = useCalendarStore((s) => s.setTagFilter);
	const setFileFilter = useCalendarStore((s) => s.setFileFilter);
	const setTaskQuery = useCalendarStore((s) => s.setTaskQuery);
	const advanced = useAdvancedFilters(scope);
	const [tab, setTab] = useState<Tab>('task');

	const file = filter.file ?? DEFAULT_FILE_FILTER_STATE;
	const taskQuery = filter.taskQuery ?? '';

	const fileCount = (file.baseFile ? 1 : 0) + file.expression.split('\n').filter((l) => l.trim()).length;
	const taskCount = filter.status.selectedStatuses.length + filter.tag.selectedTags.length
		+ taskQuery.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;

	// ===== File：.base 文件列表与视图 =====
	const baseFiles = useMemo(
		() => app.vault.getFiles().filter((f) => f.extension === 'base').map((f) => f.path).sort(),
		[app],
	);
	const [baseViews, setBaseViews] = useState<string[]>([]);
	useEffect(() => {
		if (!file.baseFile) {
			setBaseViews([]);
			return;
		}
		let cancelled = false;
		void readBaseText(app, file.baseFile).then((text) => {
			if (!cancelled) setBaseViews(text ? listBaseViews(text) : []);
		});
		return () => { cancelled = true; };
	}, [app, file.baseFile]);

	// ===== Task：状态与标签 =====
	const statuses: TaskStatus[] = plugin.settings.taskStatuses || DEFAULT_TASK_STATUSES;
	const selectedStatuses = filter.status.selectedStatuses;
	const allTags = useMemo(() => {
		const set = new Set<string>();
		for (const t of plugin.taskCache.getAllTasks()) for (const tag of t.tags || []) set.add(tag);
		return Array.from(set).sort();
	}, [plugin]);

	// ===== 查询框：补全词汇、命中数 =====
	const vocab = useQueryVocab(app);
	const isAvailable = useCallback((engine: QueryEngine) => isEngineAvailable(app, engine), [app]);
	const tasksRef = useCalendarStore((s) => s.tasks);
	const { taskMatches, fileMatches } = advanced;
	const taskMatchCount = useMemo(
		() => (taskMatches ? plugin.taskCache.getAllTasks().filter(taskMatches).length : null),
		// tasksRef：任务集变化后重算
		[plugin, taskMatches, tasksRef],
	);
	const fileMatchCount = useMemo(
		() => (tab === 'file' && fileMatches ? app.vault.getMarkdownFiles().filter((f) => fileMatches(f.path)).length : null),
		[app, tab, fileMatches],
	);

	const reset = () => {
		setFileFilter(scope, { ...DEFAULT_FILE_FILTER_STATE });
		setTaskQuery(scope, '');
		setStatusFilter(scope, { selectedStatuses: [] });
		setTagFilter(scope, { ...DEFAULT_TAG_FILTER_STATE });
	};

	return (
		<div className={FilterPanelClasses.block}>
			<div className={FilterPanelClasses.tabs} role="tablist">
				{([['file', fileCount], ['task', taskCount]] as const).map(([key, count]) => (
					<button
						key={key}
						role="tab"
						aria-selected={tab === key}
						className={`${FilterPanelClasses.tab}${tab === key ? ` ${FilterPanelClasses.tabActive}` : ''}`}
						onClick={() => setTab(key)}
					>
						{i18n.t(key === 'file' ? 'toolbar.filterPanel.fileTab' : 'toolbar.filterPanel.taskTab')}
						{count > 0 ? <span className={FilterPanelClasses.badge}>{count}</span> : null}
					</button>
				))}
			</div>

			{tab === 'file' ? (
				<div className={FilterPanelClasses.body}>
					<div className={FilterPanelClasses.section}>
						<div className={FilterPanelClasses.label}>{i18n.t('toolbar.filterPanel.baseFile')}</div>
						<div className={FilterPanelClasses.row}>
							<select
								className={`dropdown ${FilterPanelClasses.select}`}
								value={file.baseFile}
								onChange={(e) => setFileFilter(scope, { ...file, baseFile: e.target.value, baseView: '' })}
							>
								<option value="">{i18n.t('toolbar.filterPanel.baseNone')}</option>
								{file.baseFile && !baseFiles.includes(file.baseFile) ? (
									<option value={file.baseFile}>{file.baseFile}</option>
								) : null}
								{baseFiles.map((p) => <option key={p} value={p}>{p}</option>)}
							</select>
						</div>
						{file.baseFile && baseViews.length > 0 ? (
							<select
								className={`dropdown ${FilterPanelClasses.select}`}
								value={file.baseView}
								aria-label={i18n.t('toolbar.filterPanel.baseView')}
								onChange={(e) => setFileFilter(scope, { ...file, baseView: e.target.value })}
							>
								<option value="">{i18n.t('toolbar.filterPanel.baseViewNone')}</option>
								{baseViews.map((v) => <option key={v} value={v}>{v}</option>)}
							</select>
						) : null}
					</div>
					<div className={FilterPanelClasses.section}>
						<div className={FilterPanelClasses.label}>{i18n.t('toolbar.filterPanel.expression')}</div>
						<QueryEditor
							value={file.expression}
							placeholder={i18n.t('toolbar.filterPanel.expressionPlaceholder')}
							onCommit={(expression) => setFileFilter(scope, { ...file, expression })}
							page="file"
							detect={detectFileEngine}
							vocab={vocab}
							examples={FILE_QUERY_EXAMPLES}
							isAvailable={isAvailable}
							status={<QueryStatus pending={advanced.filePending} errors={advanced.fileErrors} count={fileMatchCount} unit="notes" />}
							messages={<Errors errors={advanced.fileErrors} />}
						/>
						<div className={FilterPanelClasses.hint}>{i18n.t('toolbar.filterPanel.expressionHelp')}</div>
					</div>
				</div>
			) : (
				<div className={FilterPanelClasses.body}>
					<div className={FilterPanelClasses.section}>
						<div className={FilterPanelClasses.label}>{i18n.t('toolbar.filterPanel.status')}</div>
						<div className={FilterPanelClasses.statusList}>
							{statuses.map((st) => (
								<label key={st.key} className={FilterPanelClasses.statusItem}>
									<input
										type="checkbox"
										checked={selectedStatuses.includes(st.key)}
										onChange={() => setStatusFilter(scope, {
											selectedStatuses: selectedStatuses.includes(st.key)
												? selectedStatuses.filter((k) => k !== st.key)
												: [...selectedStatuses, st.key],
										})}
									/>
									{st.name}
								</label>
							))}
						</div>
					</div>
					<div className={FilterPanelClasses.section}>
						<div className={FilterPanelClasses.label}>{i18n.t('toolbar.filterPanel.tags')}</div>
						<TagTreeFilter
							allTags={allTags}
							selectedTags={filter.tag.selectedTags}
							onToggle={(fp) => {
								const selected = filter.tag.selectedTags;
								setTagFilter(scope, {
									selectedTags: selected.includes(fp) ? selected.filter((t) => t !== fp) : [...selected, fp],
									operator: filter.tag.operator,
								});
							}}
							operator={filter.tag.operator}
							onOperatorChange={(operator) => setTagFilter(scope, { selectedTags: filter.tag.selectedTags, operator })}
						/>
					</div>
					<div className={FilterPanelClasses.section}>
						<div className={FilterPanelClasses.label}>{i18n.t('toolbar.filterPanel.query')}</div>
						<QueryEditor
							value={taskQuery}
							placeholder={i18n.t('toolbar.filterPanel.queryPlaceholder')}
							onCommit={(q) => setTaskQuery(scope, q)}
							page="task"
							detect={detectTaskEngine}
							vocab={vocab}
							examples={TASK_QUERY_EXAMPLES}
							isAvailable={isAvailable}
							status={<QueryStatus pending={advanced.taskPending} errors={advanced.taskErrors} count={taskMatchCount} unit="tasks" />}
							messages={<Errors errors={advanced.taskErrors} />}
						/>
						<div className={FilterPanelClasses.hint}>{i18n.t('toolbar.filterPanel.queryHelp')}</div>
					</div>
				</div>
			)}

			<div className={FilterPanelClasses.footer}>
				<button className={FilterPanelClasses.resetBtn} onClick={reset}>
					{i18n.t('toolbar.filterPanel.reset')}
				</button>
			</div>
		</div>
	);
}
