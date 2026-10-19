/**
 * 甘特图 Grid 网格 + Today 线渲染
 *
 * 职责：绘制垂直/水平网格线、行背景、今天指示线。
 */

import type { TimeGranularity } from '../types';
import { GRANULARITY_CONFIGS } from '../types';
import { isMajorGridLine } from './dateGeometry';
import { getTodayInTimezone } from '../../dateUtils/timezone';
import { GanttClasses } from '../../utils/bem';

function addSvgClass(element: Element, className: string): void {
	const existing = element.getAttribute('class');
	if (existing) {
		if (!existing.split(' ').includes(className)) {
			element.setAttribute('class', `${existing} ${className}`);
		}
	} else {
		element.setAttribute('class', className);
	}
}

export interface GridRenderOptions {
	svg: SVGSVGElement | null;
	minDate: Date;
	totalUnits: number;
	granularity: TimeGranularity;
	columnWidth: number;
	/** 各行顶部 y 与行高（行高可变：标题行/归类任务行更紧凑） */
	rowTops: number[];
	rowHeights: number[];
	width: number;
	height: number;
	padding: number;
}

/**
 * 渲染网格（垂直线 + 行背景 + 水平线）
 * 返回行背景元素数组，供后续拖拽高亮使用
 */
export function renderGrid(
	ns: string,
	opts: GridRenderOptions,
	rowBgStorage: SVGRectElement[]
): void {
	const { svg, totalUnits, granularity, columnWidth, rowTops, rowHeights, width, height } = opts;
	const tasksLength = rowTops.length;
	if (!svg) return;

	const gridGroup = activeDocument.createElementNS(ns, 'g');
	addSvgClass(gridGroup, GanttClasses.elements.grid);

	// 垂直线（时间单元分隔）
	for (let i = 0; i <= totalUnits; i++) {
		const x = i * columnWidth;
		const line = activeDocument.createElementNS(ns, 'line');
		line.setAttribute('x1', String(x));
		line.setAttribute('y1', '0');
		line.setAttribute('x2', String(x));
		line.setAttribute('y2', String(height));
		line.setAttribute('stroke', 'var(--background-modifier-border)');
		line.setAttribute('stroke-width', '0.5');
		line.setAttribute('stroke-dasharray', isMajorGridLine(i, granularity) ? 'none' : '2 2');
		gridGroup.appendChild(line);
	}

	// 行背景（斑马纹）
	for (let i = 0; i < tasksLength; i++) {
		const y = rowTops[i];
		const rowBg = activeDocument.createElementNS(ns, 'rect') as SVGRectElement;
		rowBg.setAttribute('x', '0');
		rowBg.setAttribute('y', String(y));
		rowBg.setAttribute('width', String(width));
		rowBg.setAttribute('height', String(rowHeights[i]));
		rowBg.setAttribute('data-row-index', String(i));
		addSvgClass(rowBg, GanttClasses.elements.rowBg);
		rowBg.setAttribute('fill', i % 2 === 0 ? 'var(--background-secondary)' : 'transparent');
		if (i % 2 === 0) rowBg.setAttribute('opacity', '0.3');
		gridGroup.appendChild(rowBg);
		rowBgStorage.push(rowBg);
	}

	// 水平线（任务行分隔）
	for (let i = 0; i <= tasksLength; i++) {
		const y = i < tasksLength ? rowTops[i] : (tasksLength > 0 ? rowTops[tasksLength - 1] + rowHeights[tasksLength - 1] : 0);
		const line = activeDocument.createElementNS(ns, 'line');
		line.setAttribute('x1', '0');
		line.setAttribute('y1', String(y));
		line.setAttribute('x2', String(width));
		line.setAttribute('y2', String(y));
		line.setAttribute('stroke', 'var(--background-modifier-border)');
		line.setAttribute('stroke-width', '0.5');
		gridGroup.appendChild(line);
	}

	svg.appendChild(gridGroup);
}

/**
 * 今天所在单元的色带：水平渐变（两侧透明、中心 accent），表现为一道柔和的阴影
 * 色带与中心线共用此渐变 id，避免重复 defs
 */
export const TODAY_GRADIENT_ID = 'gc-gantt-today-gradient';

export function appendTodayGradient(ns: string, svg: SVGSVGElement): void {
	if (svg.querySelector(`#${TODAY_GRADIENT_ID}`)) return;
	const defs = activeDocument.createElementNS(ns, 'defs');
	const gradient = activeDocument.createElementNS(ns, 'linearGradient');
	gradient.setAttribute('id', TODAY_GRADIENT_ID);
	gradient.setAttribute('x1', '0');
	gradient.setAttribute('x2', '1');
	gradient.setAttribute('y1', '0');
	gradient.setAttribute('y2', '0');
	const stops: Array<[string, string]> = [['0', '0'], ['0.5', '0.22'], ['1', '0']];
	for (const [offset, opacity] of stops) {
		const stop = activeDocument.createElementNS(ns, 'stop');
		stop.setAttribute('offset', offset);
		stop.setAttribute('stop-color', 'var(--interactive-accent)');
		stop.setAttribute('stop-opacity', opacity);
		gradient.appendChild(stop);
	}
	defs.appendChild(gradient);
	svg.insertBefore(defs, svg.firstChild);
}

/** 今天所在单元的下标（起点为单元左边界）；今天不在范围内返回 -1 */
export function getTodayUnitIndex(minDate: Date, totalUnits: number, granularity: TimeGranularity): number {
	const config = GRANULARITY_CONFIGS[granularity];
	const unitsDiff = (getTodayInTimezone().getTime() - minDate.getTime()) / config.milliseconds;
	// +0.1：夏令时切换导致的不足一个单元的偏移不应落入前一单元
	const index = Math.floor(unitsDiff + 0.1);
	return index >= 0 && index < totalUnits ? index : -1;
}

/**
 * 渲染今天：单元色带（阴影）+ 位于单元中心的虚线
 */
export function renderTodayLine(
	ns: string,
	svg: SVGSVGElement | null,
	minDate: Date,
	totalUnits: number,
	height: number,
	granularity: TimeGranularity,
	columnWidth: number
): void {
	if (!svg) return;

	const index = getTodayUnitIndex(minDate, totalUnits, granularity);
	if (index < 0) return;

	appendTodayGradient(ns, svg);
	const left = index * columnWidth;
	const centerX = left + columnWidth / 2;

	const band = activeDocument.createElementNS(ns, 'rect');
	band.setAttribute('x', String(left));
	band.setAttribute('y', '0');
	band.setAttribute('width', String(columnWidth));
	band.setAttribute('height', String(height));
	band.setAttribute('fill', `url(#${TODAY_GRADIENT_ID})`);
	band.setAttribute('pointer-events', 'none');
	addSvgClass(band, GanttClasses.elements.todayBand);
	svg.appendChild(band);

	const line = activeDocument.createElementNS(ns, 'line');
	line.setAttribute('x1', String(centerX));
	line.setAttribute('y1', '0');
	line.setAttribute('x2', String(centerX));
	line.setAttribute('y2', String(height));
	line.setAttribute('stroke', 'var(--interactive-accent)');
	line.setAttribute('stroke-width', '1');
	line.setAttribute('stroke-dasharray', '4 4');
	line.setAttribute('pointer-events', 'none');
	addSvgClass(line, GanttClasses.elements.todayLine);
	svg.appendChild(line);
}
