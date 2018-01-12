import {
  CancellationToken,
  commands,
  Disposable,
  DocumentFilter,
  Hover,
  HoverProvider,
  languages,
  OutputChannel,
  Position,
  Range,
  Selection,
  TextDocument,
  TextEditor,
  window,
  workspace
} from 'vscode';
import {
  LanguageClient,
  Range as VLCRange,
} from 'vscode-languageclient';

import {CommandNames} from './constants';

const formatExpressionType = (document: TextDocument, r: Range, typ: string): string =>
  `${document.getText(r)} :: ${typ}`;

const HASKELL_MODE: DocumentFilter = {
  language: 'haskell',
  scheme: 'file',
};

// Cache same selections...
const blankRange = new Range(0, 0, 0, 0);
let lastRange = blankRange;
let lastType = '';

async function getTypes({client, editor}): Promise<[Range, string]> {
  try {
    const hints = await client.sendRequest('workspace/executeCommand', getCmd(editor));
    const arr = hints as Array<[VLCRange, string]>;
    if (arr.length === 0) {
      // lastRange = blankRange;
      return null;
    }
    const ranges = arr.map(x =>
      [client.protocol2CodeConverter.asRange(x[0]), x[1]]) as Array<[Range, string]>;
    const [rng, typ] = chooseRange(editor.selection, ranges);
    lastRange = rng;
    lastType = typ;
    return [rng, typ];
  } catch (e) {
    console.error(e);
  }
}

/**
 * Choose The range in the editor and coresponding type that best matches the selection
 * @param  {Selection} sel - selected text in editor
 * @param  {Array<[Range, string]>} rngs - the type analysis from the server
 * @returns {[Range, string]}
 */
const chooseRange = (sel: Selection, rngs: Array<[Range, string]>): [Range, string] => {
    const curr = rngs.findIndex(([rng, typ]) => rng.contains(sel));

    // If we dont find selection start/end in ranges then
    // return the type matching the smallest selection range
    if (curr === -1) {
      // NOTE: not sure this should happen...
      return rngs[0];
    } else {
      return rngs[curr];
    }
};

const getCmd = editor => ({
  command: 'ghcmod:type',
  arguments: [{
    file: editor.document.uri.toString(),
    pos: editor.selections[0].start,
    include_constraints: true,
  }],
});

// const typeFormatter = (typeString: string): MarkedString => {
//   // const ms = new MarkedString();
//   const ms = [];
//   // definition?
//   let def = typeString.split('::').map(s => s.trim());
//   if (def.length > 1) {
//     ms.push(`**${def[0]}** :: `);
//     def.shift();
//   }
//   // context?
//   def = typeString.split('=>').map(s => s.trim());
//   if (def.length > 1) {
//     ms.push(`*${def[0]}* => `);
//     def.shift();
//   }
//   // Process rest...
//   def = typeString.split('->').map(s => s.trim());
//   if (def.length === 1 && def[0] === '') {
//     return;
//   }
//   if (def.length >= 1) {
//     ms.push(def.map(s => `**${s}**`).join(' -> '));
//   }
//   return ms.join();
//   // while def.length >= 1 {
//   //   if (def === '') {
//   //     return;
//   //   }
//   //   ms.push(def.map(s => `*${s}*`).join(' -> '))
//   // }
// };

export namespace ShowTypeCommand {
  'use strict';

  const displayType = (chan: OutputChannel, typ: string) => {
    chan.clear();
    chan.appendLine(typ);
    chan.show(true);
  };

  export function registerCommand(client: LanguageClient): [Disposable] {
    const showTypeChannel = window.createOutputChannel('Haskell Show Type');
    const document = window.activeTextEditor.document;

    const cmd = commands.registerCommand(CommandNames.ShowTypeCommandName, x => {
      const editor = window.activeTextEditor;

      getTypes({client, editor}).then(([r, typ]) => {
        switch (workspace.getConfiguration('languageServerHaskell').showTypeForSelection.command.location) {
          case 'dropdown':
            window.showInformationMessage(formatExpressionType(document, r, typ));
            break;
          case 'channel':
            displayType(showTypeChannel, formatExpressionType(document, r, typ));
            break;
          default:
            break;
        }
      }).catch(e => console.error(e));

    });

    return [cmd, showTypeChannel];
  }
}

export namespace ShowTypeHover {
  /**
   * Determine if type information should be included in Hover Popup
   * @param  {TextEditor} editor
   * @param  {Position} position
   * @returns boolean
   */
  const showTypeNow = (editor: TextEditor, position: Position): boolean => {
    // NOTE: This seems to happen sometimes ¯\_(ツ)_/¯
    if (!editor) {
      return false;
    }
    // NOTE: This means cursor is not over selected text
    if (!editor.selection.contains(position)) {
      return false;
    }
    if (editor.selection.isEmpty) {
      return false;
    }
    // document.
    // NOTE: If cursor is not over highlight then dont show type
    if ((editor.selection.active < editor.selection.start) || (editor.selection.active > editor.selection.end)) {
      return false;
    }
    // NOTE: Not sure if we want this - maybe we can get multiline to work?
    if (!editor.selection.isSingleLine) {
      return false;
    }
    return true;
  };

  class TypeHover implements HoverProvider {
    public client: LanguageClient;

    constructor(client) {
      this.client = client;
    }

    public provideHover(document: TextDocument, position: Position, token: CancellationToken): Thenable<Hover> {
      const editor = window.activeTextEditor;

      if (!showTypeNow(editor, position)) {
        return null;
      }

      // NOTE: No need for server call
      if (lastType && editor.selection.isEqual(lastRange)) {
        return Promise.resolve(this.makeHover(document, lastRange, lastType));
      }

      return getTypes({client: this.client, editor}).then(([r, typ]) => {
        if (typ) {
          return this.makeHover(document, r, lastType);
        } else {
          return null;
        }
      });
    }

    private makeHover(document: TextDocument, r: Range, typ: string): Hover {
      return new Hover({
        language: 'haskell',
        value: formatExpressionType(document, r, typ),
      });
    }
  }

  export const registerTypeHover = (client) => languages
      .registerHoverProvider(HASKELL_MODE, new TypeHover(client));
}
