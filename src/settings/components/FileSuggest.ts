import { AbstractInputSuggest, App, TAbstractFile, TFile } from 'obsidian';

export class FileSuggest extends AbstractInputSuggest<TFile> {
	constructor(
		app: App,
		public inputEl: HTMLInputElement,
		/** 选中后的回调：React 受控输入框靠它同步状态（原生赋值 + input 事件不会触发 React onChange） */
		private onPick?: (file: TFile) => void,
	) {
		super(app, inputEl);
	}

	getSuggestions(inputStr: string): TFile[] {
		const abstractFiles = this.app.vault.getAllLoadedFiles();
		const files: TFile[] = [];
		const lowerCaseInputStr = inputStr.toLowerCase();

		abstractFiles.forEach((file: TAbstractFile) => {
			if (
				file instanceof TFile &&
				file.extension === 'md' &&
				file.path.toLowerCase().includes(lowerCaseInputStr)
			) {
				files.push(file);
			}
		});

		return files.slice(0, 1000);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.setValue(file.path);
		this.inputEl.trigger('input');
		this.onPick?.(file);
		this.close();
	}
}
