import { tokenizeInlineRich } from '../src/utils/inlineMarkdown';

interface L { id: string }
const link = (id: string): L => ({ id });

describe('tokenizeInlineRich', () => {
	it('粗体包裹链接：**[[x]]**', () => {
		const a = link('a');
		expect(tokenizeInlineRich<L>(['**', a, '**'])).toEqual([{ kind: 'bold', parts: [a] }]);
	});

	it('标记内文字与链接混排，两侧保留纯文字', () => {
		const a = link('a');
		expect(tokenizeInlineRich<L>(['见 ~~旧 ', a, ' 版~~ 完'])).toEqual([
			{ kind: 'text', parts: ['见 '] },
			{ kind: 'strike', parts: ['旧 ', a, ' 版'] },
			{ kind: 'text', parts: [' 完'] },
		]);
	});

	it('链接内部的标记符不参与分词；无标记时原样返回', () => {
		const a = link('a');
		expect(tokenizeInlineRich<L>(['2 * ', a, ' * 3'])).toEqual([{ kind: 'text', parts: ['2 * ', a, ' * 3'] }]);
		expect(tokenizeInlineRich<L>(['plain'])).toEqual([{ kind: 'text', parts: ['plain'] }]);
	});

	it('两个链接分别被不同标记包裹', () => {
		const a = link('a'); const b = link('b');
		expect(tokenizeInlineRich<L>(['**', a, '** 和 *', b, '*'])).toEqual([
			{ kind: 'bold', parts: [a] },
			{ kind: 'text', parts: [' 和 '] },
			{ kind: 'italic', parts: [b] },
		]);
	});
});
