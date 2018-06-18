/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import { SignatureHelpProvider, SignatureHelp, SignatureInformation, ParameterInformation, TextDocument, Position, CancellationToken, WorkspaceConfiguration } from 'vscode';
import { definitionLocation } from './goDeclaration';
import { getParametersAndReturnType } from './util';

export class GoSignatureHelpProvider implements SignatureHelpProvider {
	private goConfig: WorkspaceConfiguration = null;

	constructor(goConfig?: WorkspaceConfiguration) {
		this.goConfig = goConfig;
	}

	public provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken): Promise<SignatureHelp> {
		if (!this.goConfig) {
			this.goConfig = vscode.workspace.getConfiguration('go', document.uri);
		}

		let theCall = this.walkBackwardsToBeginningOfCall(document, position);
		if (theCall == null) {
			return Promise.resolve(null);
		}
		let callerPos = this.previousTokenPosition(document, theCall.openParen);
		// Temporary fix to fall back to godoc if guru is the set docsTool
		let goConfig = this.goConfig;
		if (goConfig['docsTool'] === 'guru') {
			goConfig = Object.assign({}, goConfig, { 'docsTool': 'godoc' });
		}
		return definitionLocation(document, callerPos, goConfig, true, token).then(res => {
			if (!res) {
				// The definition was not found
				return null;
			}
			if (res.line === callerPos.line) {
				// This must be a function definition
				return null;
			}
			let declarationText: string = (res.declarationlines || []).join(' ').trim();
			if (!declarationText) {
				return null;
			}
			let result = new SignatureHelp();
			let sig: string;
			let si: SignatureInformation;
			if (res.toolUsed === 'godef') {
				// declaration is of the form "Add func(a int, b int) int"
				let nameEnd = declarationText.indexOf(' ');
				let sigStart = nameEnd + 5; // ' func'
				let funcName = declarationText.substring(0, nameEnd);
				sig = declarationText.substring(sigStart);
				si = new SignatureInformation(funcName + sig, res.doc);
			} else if (res.toolUsed === 'gogetdoc') {
				// declaration is of the form "func Add(a int, b int) int"
				declarationText = declarationText.substring(5);
				let funcNameStart = declarationText.indexOf(res.name + '('); // Find 'functionname(' to remove anything before it
				if (funcNameStart > 0) {
					declarationText = declarationText.substring(funcNameStart);
				}
				si = new SignatureInformation(declarationText, res.doc);
				sig = declarationText.substring(res.name.length);
			}

			si.parameters = getParametersAndReturnType(sig).params.map(paramText =>
				new ParameterInformation(paramText)
			);
			result.signatures = [si];
			result.activeSignature = 0;
			result.activeParameter = Math.min(theCall.commas.length, si.parameters.length - 1);
			return result;
		}, () => {
			return null;
		});
	}

	private previousTokenPosition(document: TextDocument, position: Position): Position {
		while (position.character > 0) {
			let word = document.getWordRangeAtPosition(position);
			if (word) {
				return word.start;
			}
			position = position.translate(0, -1);
		}
		return null;
	}

	private walkBackwardsToBeginningOfCall(document: TextDocument, position: Position): { openParen: Position, commas: Position[] } {
		let parenBalance = 0;
		let commas = [];
		let maxLookupLines = 30;

		for (let line = position.line; line >= 0 && maxLookupLines >= 0; line--, maxLookupLines--) {
			let currentLine = document.lineAt(line).text;
			let characterPosition = document.lineAt(line).text.length - 1;

			if (line === position.line) {
				characterPosition = position.character;
				currentLine = currentLine.substring(0, position.character);
			}

			// Walk foward to index quote positions
			// This is needed to detect string literals and ignore commas within them
			let doubleQuoteIndexes = new IndexRangeArray();
			let singleQuoteIndexes = new IndexRangeArray();
			let specialQuoteIndexes = new IndexRangeArray();
			for (let i = 0; i < currentLine.length; i++) {
				// Ignore escaped quotes, only count string literal boundaries
				if ((i > 0) && (currentLine[i - 1] !== '\\')) {
					switch (currentLine[i]) {
						case '\'':
							singleQuoteIndexes.PushIndex(i);
							break;
						case '"':
							doubleQuoteIndexes.PushIndex(i);
							break;
						case '`':
							specialQuoteIndexes.PushIndex(i);
							break;
					}
				}
			}

			for (let char = characterPosition - 1; char >= 0; char--) {
				switch (currentLine[char]) {
					case '(':
						parenBalance--;
						if (parenBalance < 0) {
							return {
								openParen: new Position(line, char),
								commas: commas
							};
						}
						break;
					case ')':
						parenBalance++;
						break;
					case ',':
						if ((parenBalance === 0)
							&& !doubleQuoteIndexes.IsWithinPairRange(char)
							&& !singleQuoteIndexes.IsWithinPairRange(char)
							&& !specialQuoteIndexes.IsWithinPairRange(char)) {
							commas.push(new Position(line, char));
						}
						break;
				}
			}
		}
		return null;
	}

}

class IndexRangeArray {
	LastIndex: number;
	Array: Array<number>;

	public constructor() {
		this.Array = new Array<number>();
		this.LastIndex = 0;
	}

	public PushIndex(index: number): void {
		this.Array.push(index);
		this.LastIndex = index;
	}

	public IsWithinPairRange(index: number): boolean {
		let isEven = (this.Array.length % 2) === 0;
		if (index > this.LastIndex) return !isEven;
		let limit = this.Array.length - (isEven ? 1 : 2);
		for (let i = 0; i < limit; i++) {
			if (i <= limit - 1) {
				if ((index > this.Array[i]) && (index < this.Array[i + 1])) {
					return true;
				}
			}
		}
		return false;
	}
}
