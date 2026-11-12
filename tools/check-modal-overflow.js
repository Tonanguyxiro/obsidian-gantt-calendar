(() => {
	// 检查任务弹窗与时间弹层里的横向溢出 / 被裁切：
	// 1) 元素内容比自身宽（scrollWidth > clientWidth + 1，且不是有意的省略号/滚动容器）
	// 2) 元素矩形超出所属容器（弹窗面板 / 弹层）的左右边界
	const roots = [
		...document.querySelectorAll('.gc-modal__panel'),
		...document.querySelectorAll('.gc-popover'),
	];
	const issues = [];
	const name = (e) => (e.className && e.className.toString().split(' ')[0]) || e.tagName.toLowerCase();
	for (const root of roots) {
		const rr = root.getBoundingClientRect();
		const rootCs = getComputedStyle(root);
		const innerLeft = rr.left + parseFloat(rootCs.borderLeftWidth);
		const innerRight = rr.right - parseFloat(rootCs.borderRightWidth);
		for (const el of root.querySelectorAll('*')) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const cs = getComputedStyle(el);
			if (cs.visibility === 'hidden' || cs.display === 'none') continue;
			const intentional = cs.textOverflow === 'ellipsis' || /auto|scroll/.test(cs.overflowX) || el.tagName === 'INPUT';
			if (!intentional && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.overflowX !== 'visible') {
				issues.push({ type: 'content-wider', root: name(root), el: name(el), sw: el.scrollWidth, cw: el.clientWidth, text: (el.textContent || '').trim().slice(0, 30) });
			}
			if (r.right > innerRight + 1 || r.left < innerLeft - 1) {
				issues.push({ type: 'outside-container', root: name(root), el: name(el), left: Math.round(r.left - innerLeft), right: Math.round(r.right - innerRight), text: (el.textContent || el.value || '').trim().slice(0, 30) });
			}
		}
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (rr.right > vw || rr.left < 0 || rr.bottom > vh + 1 || rr.top < 0) {
			issues.push({ type: 'outside-viewport', root: name(root), rect: [rr.left, rr.top, rr.right, rr.bottom].map(Math.round), vw, vh });
		}
	}
	// 去重：同一元素名只报一次
	const seen = new Set();
	const uniq = issues.filter((i) => {
		const k = `${i.type}|${i.root}|${i.el}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	return JSON.stringify({ roots: roots.length, issues: uniq.slice(0, 20) });
})()
