# Syntax Memory

Notices new syntax as you type it and lets you save it to a personal list, so you can look it up later instead of forgetting it.

Learning a language means running into things like `:=`, `?.`, `match`, or `**kwargs` and thinking "I'll remember that." Syntax Memory catches those moments and keeps a record of what you saw, where you saw it, and the line of code it appeared on.

## How it works

1. **Type code** in a supported language.
2. **New syntax gets a faint dotted underline.** Put your cursor on it and press `Ctrl+.` (or `Cmd+.` on Mac) to open the quick-fix menu.
3. **Choose what to do:**
   - **Save** adds it to your list, along with the file, line number, and the line of code.
   - **Mark as known** tells the extension to stop asking about it.
4. **Review later** in the **Syntax Memory** section of the Explorer sidebar. Click an entry to jump back to where you found it.

A status bar item (**"N new syntax"**) appears when the current file has unreviewed items. Click it to go through them one by one.

You can also use the quick-fix menu on any keyword or operator under your cursor, even if you weren't prompted, to save it or mark it as known.

<img width="522" height="242" alt="image" src="https://github.com/user-attachments/assets/a19c940b-d6ec-4ba9-8ea3-a22e5f95c233" />

(The image shows options available on click)

## What counts as "syntax"?

Keywords and operators outside of strings and comments, such as `lambda`, `async`, `=>`, `??`, or `:=`. Plain names, numbers, and basic punctuation like brackets and commas are ignored.

The extension also looks at where a token appears, so the same symbol can count as different syntax in different places. For example, `if` in an if-statement, a ternary expression, and a list comprehension are three separate entries, and so are `*` as multiplication and `*` as unpacking.

Only code you actually **type** triggers prompts. Opening a file, pulling changes, or pasting a large block (over 200 characters by default) does not.

## Getting started without a flood of prompts

The first time you open a folder, the extension offers to scan it and mark everything already in your code as "known," so you only get prompted about genuinely new things. Keep in mind that this treats everything in your code as known, whether or not you fully understand it. You can skip the scan and start fresh instead.

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and type "Syntax Memory":

| Command | What it does |
| --- | --- |
| Save Syntax Manually | Add something to your list by typing it in, for syntax you saw but haven't used yet |
| Mark Syntax as Known (Pick from Language) | Tick off every keyword and operator you're already comfortable with in a language |
| Manage Known Syntax | See what you've marked as known, and un-know items so you're prompted about them again |
| Scan Workspace and Mark Existing Syntax as Known | Build the baseline from the folder you have open |
| Review New Syntax in This File | Step through the unreviewed items in the current file |

## Supported languages

Python, JavaScript, TypeScript (including JSX and TSX), Java, C, C++, C#, Go, Rust, Ruby, PHP, Bash, Lua, Kotlin, Swift, Dart, and Scala.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `syntaxMemory.pasteThreshold` | `200` | Edits that insert more than this many characters at once are treated as pastes and ignored |

## Privacy

Everything stays on your machine. The extension makes no network requests and sends nothing anywhere. Syntax is detected locally using [tree-sitter](https://tree-sitter.github.io/tree-sitter/) compiled to WebAssembly.

For each saved item it stores the token, language, file path, line number, and the text of that line (up to 200 characters) in your editor's local extension storage. If a line contains something sensitive, such as a hardcoded password, remove that entry from the list.

## Good to know

- **One shared list.** Your saved and known syntax are shared across all projects, not stored per folder.
- **Workspace scan limits.** It reads at most 2,000 files, skips files over 300 KB, and ignores `node_modules`, `.git`, `dist`, `build`, `out`, `venv`, `.venv`, `vendor`, `target`, and `__pycache__`.
- **Large files** (over 300 KB) are skipped for live detection too.
- **Language detection** uses the editor's language mode, so an unsaved file needs its language set (bottom-right of the window) or a recognized extension like `.py`.

## Install from a release

If you'd rather not build it yourself, download the latest `.vsix` file from the [Releases page](https://github.com/YOUR-USERNAME/syntax-memory/releases) and install it from a terminal:

```
codium --install-extension syntax-memory-0.0.1.vsix
```

Use `code` instead of `codium` if you're on VS Code. You can also install it from inside the editor: open the Extensions panel, click the `...` menu at the top, choose **Install from VSIX**, and pick the downloaded file. Restart the editor afterwards if the extension doesn't appear right away.

## Install from source

```
git clone https://github.com/YOUR-USERNAME/syntax-memory.git
cd syntax-memory
npm install
code --extensionDevelopmentPath=.
```

Use `codium` instead of `code` if you're on VSCodium.

## Contributing

Issues and pull requests are welcome. To add a language, add it to `LANGUAGES` and `SCAN_GLOB` in `core.js` and `EXT_TO_LANG` in `extension.js`. The language must have a grammar in the [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) package.

## License

[MIT](LICENSE)
