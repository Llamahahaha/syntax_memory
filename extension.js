const vscode = require('vscode');
const core = require('./core');

const STORE_KEY = 'syntaxMemory.entries';
const BASELINE_PROMPTED = 'syntaxMemory.baselinePrompted';
const SOURCE = 'Syntax Memory';
const MAX_FILE_BYTES = 300000;

const EXT_TO_LANG = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', tsx: 'typescriptreact', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cc: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'shellscript',
  bash: 'shellscript', lua: 'lua', kt: 'kotlin', swift: 'swift', dart: 'dart', scala: 'scala',
};

// store

/**
 * entries[key] = {
 *   language, token, context,        // context '*' means "any context"
 *   status: 'saved' | 'known',
 *   uri?, file?, line?, snippet?,    // where it was found (saved entries)
 *   at: timestamp
 * }
 */
class Store {
  constructor(context) {
    this.state = context.globalState;
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
  }
  all() {
    return this.state.get(STORE_KEY, {});
  }
  /** Any entry (saved or known), exact context or wildcard. */
  lookup(language, token, context) {
    const e = this.all();
    return e[core.keyOf(language, token, context)] || e[core.keyOf(language, token, '*')];
  }
  async put(entries) {
    await this.state.update(STORE_KEY, entries);
    this._emitter.fire();
  }
  async set(entry) {
    const entries = this.all();
    entries[core.keyOf(entry.language, entry.token, entry.context)] = { ...entry, at: Date.now() };
    await this.put(entries);
  }
  async setMany(list, { overwrite = false } = {}) {
    const entries = this.all();
    for (const entry of list) {
      const k = core.keyOf(entry.language, entry.token, entry.context);
      if (!overwrite && entries[k]) continue;
      entries[k] = { ...entry, at: Date.now() };
    }
    await this.put(entries);
  }
  async remove(keys) {
    const entries = this.all();
    for (const k of keys) delete entries[k];
    await this.put(entries);
  }
}

// helpers 

const prettyContext = (c) => (c === '*' ? 'any context' : c.replace(/_/g, ' '));
const entryLabel = (e) => (e.context === '*' ? e.token : `${e.token}  (${prettyContext(e.context)})`);

function snippetAt(doc, line) {
  const t = doc.lineAt(line).text.trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}

function locationFields(doc, line) {
  return {
    uri: doc.uri.toString(),
    file: vscode.workspace.asRelativePath(doc.uri),
    line,
    snippet: snippetAt(doc, line),
  };
}

// tree view

class SavedTree {
  constructor(store) {
    this.store = store;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    store.onDidChange(() => this._emitter.fire());
  }
  getTreeItem(i) {
    return i;
  }
  getChildren() {
    return Object.entries(this.store.all())
      .filter(([, e]) => e.status === 'saved')
      .sort(([, a], [, b]) => b.at - a.at)
      .map(([key, e]) => {
        const item = new vscode.TreeItem(entryLabel(e), vscode.TreeItemCollapsibleState.None);
        item.description = e.file ? `${e.file}:${e.line + 1}` : e.language;
        const tip = new vscode.MarkdownString();
        tip.appendMarkdown(`**${e.token}** · ${e.language}\n\n`);
        if (e.snippet) tip.appendCodeblock(e.snippet, e.language);
        item.tooltip = tip;
        item.iconPath = new vscode.ThemeIcon('symbol-keyword');
        item.contextValue = 'saved';
        item.entryKey = key;
        item.entry = e;
        if (e.uri) {
          item.command = { command: 'syntaxMemory.open', title: 'Open', arguments: [item] };
        }
        return item;
      });
  }
}

// activate 

function activate(context) {
  const store = new Store(context);
  const tree = new SavedTree(store);
  const diagnostics = vscode.languages.createDiagnosticCollection('syntaxMemory');
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = 'syntaxMemory.review';

  /** uri -> Set of line numbers the user recently typed on */
  const editedLines = new Map();
  /** uri -> [{ key, token, context, language, range }] pending suggestions */
  const pending = new Map();
  /** uri -> { version, tokens } */
  const tokenCache = new Map();
  const timers = new Map();

  // token lookup

  async function tokensFor(doc) {
    const k = doc.uri.toString();
    const cached = tokenCache.get(k);
    if (cached && cached.version === doc.version) return cached.tokens;
    const text = doc.getText();
    if (text.length > MAX_FILE_BYTES) return [];
    const t = await core.parse(doc.languageId, text);
    if (!t) return [];
    const tokens = core.extractTokens(t);
    t.delete();
    tokenCache.set(k, { version: doc.version, tokens });
    return tokens;
  }

  // diagnostics (the subtle "new syntax" dots) 

  async function refresh(doc) {
    if (!core.LANGUAGES[doc.languageId]) return;
    const k = doc.uri.toString();
    const lines = editedLines.get(k);
    if (!lines || !lines.size) {
      diagnostics.delete(doc.uri);
      pending.delete(k);
      updateStatus();
      return;
    }
    const version = doc.version;
    const tokens = await tokensFor(doc);
    if (doc.version !== version) return; // a newer edit will trigger another refresh

    const seen = new Set();
    const list = [];
    for (const t of tokens) {
      if (!lines.has(t.line)) continue;
      const key = core.keyOf(doc.languageId, t.token, t.context);
      if (seen.has(key) || store.lookup(doc.languageId, t.token, t.context)) continue;
      seen.add(key);
      list.push({
        key,
        token: t.token,
        context: t.context,
        language: doc.languageId,
        range: new vscode.Range(t.line, t.startCol, t.line, t.endCol),
      });
    }
    pending.set(k, list);
    diagnostics.set(
      doc.uri,
      list.map((p) => {
        const d = new vscode.Diagnostic(
          p.range,
          `New syntax: \`${p.token}\` (${prettyContext(p.context)}). Save to Syntax Memory?`,
          vscode.DiagnosticSeverity.Hint
        );
        d.source = SOURCE;
        return d;
      })
    );
    updateStatus();
  }

  function scheduleRefresh(doc) {
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => refresh(doc), 700));
  }

  function refreshAllOpen() {
    for (const doc of vscode.workspace.textDocuments) refresh(doc);
  }

  function updateStatus() {
    const ed = vscode.window.activeTextEditor;
    const list = ed ? pending.get(ed.document.uri.toString()) : null;
    if (list && list.length) {
      statusItem.text = `$(lightbulb) ${list.length} new syntax`;
      statusItem.tooltip = 'Syntax Memory: review new syntax in this file';
      statusItem.show();
    } else {
      statusItem.hide();
    }
  }

  // typed-line tracking 
  function trackChanges(e) {
    const doc = e.document;
    if (!core.LANGUAGES[doc.languageId] || e.contentChanges.length === 0) return;
    const k = doc.uri.toString();
    const threshold = vscode.workspace.getConfiguration('syntaxMemory').get('pasteThreshold', 200);
    let lines = editedLines.get(k) || new Set();

    // Process bottom-to-top so earlier ranges stay valid while we shift line numbers.
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
    for (const c of changes) {
      const s = c.range.start.line;
      const end = c.range.end.line;
      const added = c.text.split('\n').length - 1;
      const delta = added - (end - s);
      const next = new Set();
      for (const l of lines) {
        if (l < s) next.add(l);
        else if (l > end) next.add(l + delta);
        // lines inside the replaced range are dropped, then re-added below if typed
      }
      lines = next;
      const isTyping = c.text.length > 0 && c.text.length <= threshold;
      if (isTyping) for (let i = 0; i <= added; i++) lines.add(s + i);
    }
    editedLines.set(k, lines);
    scheduleRefresh(doc);
  }

  // actions

  const selector = Object.keys(core.LANGUAGES).flatMap((language) => [
    { language, scheme: 'file' },
    { language, scheme: 'untitled' },
  ]);

  const actionProvider = {
    async provideCodeActions(doc, range) {
      const actions = [];
      const k = doc.uri.toString();
      const list = pending.get(k) || [];

      const mk = (title, command, args, preferred) => {
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.command = { command, title, arguments: [args] };
        a.isPreferred = preferred;
        return a;
      };

      // 1. Pending suggestions touching the cursor/selection
      const handled = new Set();
      for (const p of list) {
        if (!p.range.intersection(range)) continue;
        handled.add(p.key);
        const args = { uri: k, key: p.key, line: p.range.start.line };
        actions.push(mk(`Save \`${p.token}\` to Syntax Memory`, 'syntaxMemory.save', args, true));
        actions.push(mk(`Mark \`${p.token}\` as known`, 'syntaxMemory.markKnown', args, false));
      }

      // 2. Any keyword/operator under the cursor, even if never prompted
      if (range.isEmpty || range.isSingleLine) {
        const tokens = await tokensFor(doc);
        const col = range.start.character;
        const hit = tokens.find(
          (t) => t.line === range.start.line && col >= t.startCol && col <= t.endCol
        );
        if (hit) {
          const key = core.keyOf(doc.languageId, hit.token, hit.context);
          const existing = store.lookup(doc.languageId, hit.token, hit.context);
          if (!handled.has(key) && !existing) {
            const args = { uri: k, key, line: hit.line };
            actions.push(mk(`Save \`${hit.token}\` to Syntax Memory`, 'syntaxMemory.save', args, false));
            actions.push(mk(`Mark \`${hit.token}\` as known`, 'syntaxMemory.markKnown', args, false));
          } else if (existing && existing.status === 'known' && !handled.has(key)) {
            const args = { uri: k, key, line: hit.line };
            actions.push(mk(`Save \`${hit.token}\` to Syntax Memory (currently "known")`, 'syntaxMemory.save', args, false));
          }
        }
      }
      return actions;
    },
  };

  async function docFor(uriString) {
    return vscode.workspace.openTextDocument(vscode.Uri.parse(uriString));
  }

  async function applyEntry(args, status) {
    const doc = await docFor(args.uri);
    const [language, token, ctx] = core.splitKey(args.key);
    const entry = { language, token, context: ctx, status };
    if (status === 'saved') Object.assign(entry, locationFields(doc, args.line));
    await store.set(entry);
    refreshAllOpen();
    if (status === 'saved') vscode.window.setStatusBarMessage(`Saved \`${token}\``, 2000);
  }

  // commands UWU

  async function pickLanguage(placeHolder) {
    const active = vscode.window.activeTextEditor?.document.languageId;
    const ids = Object.keys(core.LANGUAGES);
    if (active && ids.includes(active)) ids.unshift(...ids.splice(ids.indexOf(active), 1));
    const pick = await vscode.window.showQuickPick(ids, { placeHolder });
    return pick;
  }

  async function saveManual() {
    const token = (
      await vscode.window.showInputBox({ prompt: 'Syntax to save (e.g. :=, ?., lambda, match)' })
    )?.trim();
    if (!token) return;
    const language = await pickLanguage('Which language?');
    if (!language) return;
    const entry = { language, token, context: '*', status: 'saved' };
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === language) {
      Object.assign(entry, locationFields(ed.document, ed.selection.active.line));
    }
    await store.set(entry);
    refreshAllOpen();
  }

  async function markKnownBulk() {
    const language = await pickLanguage('Mark syntax as known for which language?');
    if (!language) return;
    const tokens = await core.grammarTokens(language);
    const entries = store.all();
    const items = tokens.map((t) => ({
      label: t,
      picked: false,
      description: entries[core.keyOf(language, t, '*')] ? 'already listed' : '',
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Tick everything you're already comfortable with in ${language}`,
    });
    if (!picked || !picked.length) return;
    await store.setMany(
      picked.map((p) => ({ language, token: p.label, context: '*', status: 'known' }))
    );
    refreshAllOpen();
    vscode.window.showInformationMessage(`Marked ${picked.length} ${language} tokens as known.`);
  }

  async function manageKnown() {
    const entries = Object.entries(store.all()).filter(([, e]) => e.status === 'known');
    if (!entries.length) {
      vscode.window.showInformationMessage('No "known" syntax yet.');
      return;
    }
    const items = entries
      .sort(([, a], [, b]) => a.language.localeCompare(b.language) || a.token.localeCompare(b.token))
      .map(([key, e]) => ({ label: e.token, description: `${e.language} · ${prettyContext(e.context)}`, key }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select syntax to un-know (you will be prompted about it again)',
    });
    if (!picked || !picked.length) return;
    await store.remove(picked.map((p) => p.key));
    refreshAllOpen();
  }

  async function scanWorkspace() {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showWarningMessage('Open a folder first.');
      return;
    }
    await context.globalState.update(BASELINE_PROMPTED, true);
    const found = new Map();
    let scanned = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Syntax Memory: scanning workspace', cancellable: true },
      async (progress, cancel) => {
        const uris = await vscode.workspace.findFiles(
          core.SCAN_GLOB,
          '**/{node_modules,.git,dist,build,out,venv,.venv,vendor,target,__pycache__}/**',
          2000
        );
        for (const uri of uris) {
          if (cancel.isCancellationRequested) break;
          const ext = uri.path.split('.').pop().toLowerCase();
          const language = EXT_TO_LANG[ext];
          if (!language) continue;
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.length > MAX_FILE_BYTES) continue;
            const t = await core.parse(language, Buffer.from(bytes).toString('utf8'));
            if (!t) continue;
            for (const tok of core.extractTokens(t)) {
              found.set(core.keyOf(language, tok.token, tok.context), {
                language, token: tok.token, context: tok.context, status: 'known',
              });
            }
            t.delete();
            scanned++;
            if (scanned % 25 === 0) progress.report({ message: `${scanned} files` });
          } catch (err) {
            console.warn('Syntax Memory: skipped', uri.fsPath, err);
          }
        }
      }
    );
    await store.setMany([...found.values()]); // never overwrites saved entries
    refreshAllOpen();
    vscode.window.showInformationMessage(
      `Syntax Memory: marked ${found.size} syntax patterns from ${scanned} files as known.`
    );
  }

  async function review() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const list = pending.get(ed.document.uri.toString()) || [];
    if (!list.length) return;
    const items = list.map((p) => ({
      label: p.token,
      description: prettyContext(p.context),
      detail: snippetAt(ed.document, p.range.start.line),
      p,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'New syntax in this file' });
    if (!pick) return;
    ed.selection = new vscode.Selection(pick.p.range.start, pick.p.range.end);
    ed.revealRange(pick.p.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    const choice = await vscode.window.showQuickPick(
      [`Save \`${pick.p.token}\``, `Mark \`${pick.p.token}\` as known`],
      { placeHolder: pick.p.token }
    );
    if (!choice) return;
    const args = { uri: ed.document.uri.toString(), key: pick.p.key, line: pick.p.range.start.line };
    await applyEntry(args, choice.startsWith('Save') ? 'saved' : 'known');
  }

  context.subscriptions.push(
    diagnostics,
    statusItem,
    vscode.languages.registerCodeActionsProvider(selector, actionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.window.registerTreeDataProvider('syntaxMemory.view', tree),
    vscode.workspace.onDidChangeTextDocument(trackChanges),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const k = doc.uri.toString();
      editedLines.delete(k);
      pending.delete(k);
      tokenCache.delete(k);
      diagnostics.delete(doc.uri);
    }),
    vscode.commands.registerCommand('syntaxMemory.save', (a) => applyEntry(a, 'saved')),
    vscode.commands.registerCommand('syntaxMemory.markKnown', (a) => applyEntry(a, 'known')),
    vscode.commands.registerCommand('syntaxMemory.saveManual', saveManual),
    vscode.commands.registerCommand('syntaxMemory.markKnownBulk', markKnownBulk),
    vscode.commands.registerCommand('syntaxMemory.manageKnown', manageKnown),
    vscode.commands.registerCommand('syntaxMemory.scanWorkspace', scanWorkspace),
    vscode.commands.registerCommand('syntaxMemory.review', review),
    vscode.commands.registerCommand('syntaxMemory.remove', (item) => item && store.remove([item.entryKey]).then(refreshAllOpen)),
    vscode.commands.registerCommand('syntaxMemory.open', async (item) => {
      const e = item && item.entry;
      if (!e || !e.uri) return;
      try {
        const doc = await docFor(e.uri);
        const ed = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(Math.min(e.line, doc.lineCount - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch {
        vscode.window.showWarningMessage(`Couldn't open ${e.file} (moved or deleted?). Snippet: ${e.snippet || ''}`);
      }
    })
  );

  // One-time offer to build the baseline.
  if (!context.globalState.get(BASELINE_PROMPTED) && vscode.workspace.workspaceFolders) {
    vscode.window
      .showInformationMessage(
        'Syntax Memory: mark all syntax already used in this workspace as "known", so you only get prompted about genuinely new things?',
        'Scan workspace',
        'Not now'
      )
      .then(async (choice) => {
        if (choice === 'Scan workspace') await scanWorkspace();
        else await context.globalState.update(BASELINE_PROMPTED, true);
      });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
