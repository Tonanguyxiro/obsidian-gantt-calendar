import { Fragment, useMemo, useState, type JSX } from 'react';
import type { GCTask } from '../../types';
import { i18n } from '../../i18n/i18n';
import { TagSelectorClasses, TagSelectorTreeClasses } from '../../utils/bem';
import { ColorDot, CountBadge } from '../components/TagTreeFilter';
import { Icon } from '../components/Icon';
import {
	buildTagSelectorModel,
	getDrillDownRows,
	normalizeTagInput,
	searchTags,
	toggleExpandedPath,
	addTagMerged,
	isImpliedTag,
	mergeTagSet,
} from './tagSelectorModel';

export interface TagSelectorProps {
	/** 所有任务（用于计算推荐标签） */
	allTasks: GCTask[];
	/** 初始已选标签 */
	initialTags?: string[];
	/** 标签变化回调 */
	onChange: (tags: string[]) => void;
}

/** 搜索结果展示上限 */
const MAX_SEARCH_RESULTS = 40;

/**
 * 标签选择器（React，Linear 风格，层级逐级展开）
 *
 * 布局：搜索/创建合一输入框 → 已选胶囊（常驻，可移除）→ 待选区。
 * - 待选区默认只列一级标签（计数为含子孙标签的任务数）；
 *   点击标签即选中并在下方展开其直接子标签一行，子标签同理逐级下钻；
 *   面包屑「全部标签 › #a › #a/b」可一键收起到任一层级。
 * - 输入关键词时改为扁平列出任意层级的匹配标签；回车按输入精确切换/创建标签。
 */
export function TagSelector({ allTasks, initialTags, onChange }: TagSelectorProps): JSX.Element {
	const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set(mergeTagSet(initialTags || [])));
	const [query, setQuery] = useState('');
	/** 当前展开路径：[一级, 二级, …]，每项为完整路径 */
	const [expandedPath, setExpandedPath] = useState<string[]>([]);

	const model = useMemo(() => buildTagSelectorModel(allTasks), [allTasks]);
	const rows = useMemo(() => getDrillDownRows(model, expandedPath), [model, expandedPath]);
	const searchResults = useMemo(
		() => searchTags(model, query, MAX_SEARCH_RESULTS),
		[model, query]
	);
	const normalizedQuery = normalizeTagInput(query);
	const searching = normalizedQuery.length > 0;

	const setSelection = (next: Set<string>) => {
		setSelectedTags(next);
		onChange(Array.from(next));
	};

	const toggleTag = (tag: string) => {
		if (selectedTags.has(tag)) {
			const next = new Set(selectedTags);
			next.delete(tag);
			setSelection(next);
			return;
		}
		// 子标签已包含父标签：选子标签时去掉已选的上级；上级已被涵盖时不重复加入
		const merged = addTagMerged(Array.from(selectedTags), tag);
		if (merged.length !== selectedTags.size || merged.some((t) => !selectedTags.has(t))) setSelection(new Set(merged));
	};

	const removeTag = (tag: string) => {
		if (!selectedTags.has(tag)) return;
		const next = new Set(selectedTags);
		next.delete(tag);
		setSelection(next);
	};

	/**
	 * 层级行中点击标签：
	 * - 未选中 → 选中，并展开到它（有子标签时出现下一行；无子标签则收起同级的展开）
	 * - 已选中 → 取消选中；若它正处于展开状态则一并收起
	 */
	const handleTreePillClick = (level: number, tag: string) => {
		const hasChildren = (model.nodes.get(tag)?.children.length ?? 0) > 0;
		// 已被选中的子标签涵盖：只展开 / 收起它的子级，不改变选择
		if (isImpliedTag(tag, selectedTags)) {
			setExpandedPath(toggleExpandedPath(expandedPath, level, tag));
			return;
		}
		if (selectedTags.has(tag)) {
			removeTag(tag);
			if (expandedPath[level] === tag) setExpandedPath(expandedPath.slice(0, level));
			return;
		}
		toggleTag(tag);
		setExpandedPath(hasChildren ? [...expandedPath.slice(0, level), tag] : expandedPath.slice(0, level));
	};

	/** 回车：精确切换输入的标签（存在则取消/选中，不存在则创建） */
	const handleSearchEnter = () => {
		if (!normalizedQuery) return;
		toggleTag(normalizedQuery);
		setQuery('');
	};

	const queryIsExisting = model.counts.has(normalizedQuery) || selectedTags.has(normalizedQuery);

	return (
		<div className={TagSelectorClasses.block}>
			{/* 搜索 / 创建合一输入框 */}
			<input
				type="text"
				className={TagSelectorClasses.elements.searchInput}
				placeholder={i18n.t('modals.createTask.tags.searchOrCreate')}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						handleSearchEnter();
					} else if (e.key === 'Escape' && query) {
						e.preventDefault();
						e.stopPropagation();
						setQuery('');
					}
				}}
			/>

			{/* 已选标签（置顶常驻，无论展开到哪一级都可见、可移除） */}
			<div className={TagSelectorClasses.elements.selectedSection}>
				<small className={TagSelectorClasses.elements.label}>
					{i18n.t('modals.createTask.tags.selectedLabel')}
					<CountBadge count={selectedTags.size} />
				</small>
				<div className={TagSelectorClasses.elements.pills}>
					{selectedTags.size === 0 ? (
						<small className={TagSelectorTreeClasses.elements.hint}>
							{i18n.t('modals.createTask.tags.noSelected')}
						</small>
					) : (
						Array.from(selectedTags).map(tag => (
							<TagPillChip
								key={tag}
								fullPath={tag}
								selected
								removable
								onToggle={() => removeTag(tag)}
							/>
						))
					)}
				</div>
			</div>

			{/* 待选区：搜索时扁平，否则逐级展开 */}
			<div className={TagSelectorClasses.elements.recommendedSection}>
				{searching ? (
					<div className={TagSelectorClasses.elements.pills}>
						{searchResults.map(([tag, count]) => (
							<TagPillChip
								key={tag}
								fullPath={tag}
								selected={selectedTags.has(tag)}
								implied={isImpliedTag(tag, selectedTags)}
								count={count}
								onToggle={() => toggleTag(tag)}
							/>
						))}
						{searchResults.length === 0 ? (
							<small className={TagSelectorTreeClasses.elements.hint}>
								{i18n.t('modals.createTask.tags.noMatches')}
							</small>
						) : null}
						{!queryIsExisting ? (
							<small className={TagSelectorTreeClasses.elements.hint}>
								{i18n.t('modals.createTask.tags.pressEnterToCreate', { tag: normalizedQuery })}
							</small>
						) : null}
					</div>
				) : model.roots.length === 0 ? (
					<small className={TagSelectorTreeClasses.elements.hint}>
						{i18n.t('modals.createTask.tags.noRecommended')}
					</small>
				) : (
					<>
						{expandedPath.length > 0 ? (
							<Breadcrumb
								path={expandedPath.slice(0, rows.length - 1)}
								onNavigate={(depth) => setExpandedPath(expandedPath.slice(0, depth))}
							/>
						) : null}
						<div className={TagSelectorTreeClasses.elements.rows}>
							{rows.map((row, level) => (
								<div
									key={level === 0 ? '' : expandedPath[level - 1]}
									className={[
										TagSelectorClasses.elements.pills,
										...(level > 0 ? [TagSelectorTreeClasses.modifiers.pillsNested] : []),
									].join(' ')}
								>
									{row.map(node => (
										<TagPillChip
											key={node.fullPath}
											fullPath={node.fullPath}
											selected={selectedTags.has(node.fullPath)}
											implied={isImpliedTag(node.fullPath, selectedTags)}
											count={model.counts.get(node.fullPath) ?? 0}
											childCount={node.children.length}
											expanded={expandedPath[level] === node.fullPath}
											onToggle={() => handleTreePillClick(level, node.fullPath)}
											onToggleExpand={() =>
												setExpandedPath(toggleExpandedPath(expandedPath, level, node.fullPath))
											}
										/>
									))}
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/** 展开路径面包屑：点「全部标签」收起全部，点某级收起到该级 */
function Breadcrumb({ path, onNavigate }: { path: string[]; onNavigate: (depth: number) => void }): JSX.Element {
	const crumbs = [i18n.t('modals.createTask.tags.allTags'), ...path.map(p => `#${p}`)];
	return (
		<div className={TagSelectorTreeClasses.elements.breadcrumb}>
			{crumbs.map((label, depth) => {
				const current = depth === crumbs.length - 1;
				return (
					<Fragment key={depth}>
						{depth > 0 ? <span className={TagSelectorTreeClasses.elements.crumbSeparator}>›</span> : null}
						<span
							className={[
								TagSelectorTreeClasses.elements.crumb,
								...(current ? [TagSelectorTreeClasses.modifiers.crumbCurrent] : []),
							].join(' ')}
							role="button"
							tabIndex={current ? -1 : 0}
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								if (!current) onNavigate(depth);
							}}
							onKeyDown={(e) => {
								if (!current && (e.key === 'Enter' || e.key === ' ')) {
									e.preventDefault();
									onNavigate(depth);
								}
							}}
						>
							{label}
						</span>
					</Fragment>
				);
			})}
		</div>
	);
}

interface TagPillChipProps {
	fullPath: string;
	selected: boolean;
	/** 已被选中的子标签涵盖（#task/project 已包含 #task） */
	implied?: boolean;
	/** 使用次数（已选区不显示） */
	count?: number;
	/** 直接子标签数（>0 时显示展开按钮） */
	childCount?: number;
	/** 是否为当前展开的标签 */
	expanded?: boolean;
	/** 已选区：显示移除按钮 */
	removable?: boolean;
	onToggle: () => void;
	onToggleExpand?: () => void;
}

/** 可切换的 Linear 风格标签胶囊：色点 + 路径 + 次数徽章 (+ 展开/移除按钮)，选中态仅以颜色区分 */
function TagPillChip({
	fullPath, selected, implied, count, childCount, expanded, removable, onToggle, onToggleExpand,
}: TagPillChipProps): JSX.Element {
	const classes = [
		TagSelectorClasses.elements.pill,
		...(selected ? [TagSelectorClasses.modifiers.pillSelected] : []),
		...(implied ? [TagSelectorTreeClasses.modifiers.pillImplied] : []),
		...(expanded ? [TagSelectorTreeClasses.modifiers.pillExpanded] : []),
	].join(' ');
	const canExpand = !!onToggleExpand && (childCount ?? 0) > 0;
	const expandLabel = i18n.t(expanded ? 'modals.createTask.tags.hideSubTags' : 'modals.createTask.tags.showSubTags');

	return (
		<span
			className={classes}
			role="option"
			aria-selected={selected}
			aria-expanded={canExpand ? !!expanded : undefined}
			tabIndex={0}
			data-tag={fullPath}
			title={implied ? i18n.t('modals.createTask.tags.impliedBy') : undefined}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onToggle();
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onToggle();
				} else if (canExpand && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
					e.preventDefault();
					if ((e.key === 'ArrowRight') !== !!expanded) onToggleExpand?.();
				}
			}}
		>
			<ColorDot fullPath={fullPath} />
			<span>{`#${fullPath}`}</span>
			{count !== undefined ? <span className={TagSelectorClasses.elements.pillCount}>{count}</span> : null}
			{canExpand ? (
				<span
					className={TagSelectorTreeClasses.elements.pillExpand}
					role="button"
					aria-label={expandLabel}
					title={expandLabel}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onToggleExpand?.();
					}}
				>
					<Icon icon={expanded ? 'chevron-down' : 'chevron-right'} />
				</span>
			) : null}
			{removable ? (
				<span
					className={TagSelectorTreeClasses.elements.pillRemove}
					role="button"
					aria-label={i18n.t('modals.createTask.tags.removeTag')}
					title={i18n.t('modals.createTask.tags.removeTag')}
				>
					<Icon icon="x" />
				</span>
			) : null}
		</span>
	);
}
