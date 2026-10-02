// Detection core. No dependency on the vscode module, so it can be tested with plain node.
const path = require('path');
const Parser = require('web-tree-sitter');

// VS Code languageId -> grammar file name in tree-sitter-wasms
const LANGUAGES = {
  python: 'python',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  typescript: 'typescript',
  typescriptreact: 'tsx',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'c_sharp',
  go: 'go',
  rust: 'rust',
  ruby: 'ruby',
  php: 'php',
  shellscript: 'bash',
  lua: 'lua',
  kotlin: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  scala: 'scala',
};

// Glob used for the workspace baseline scan.
const SCAN_GLOB =
  '**/*.{py,js,jsx,mjs,cjs,ts,tsx,java,c,h,cpp,hpp,cc,cs,go,rs,rb,php,sh,bash,lua,kt,swift,dart,scala}';

// Tokens that are just structure, never worth prompting about.
const BASIC_PUNCTUATION = new Set([
  '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '"', "'", '`', '\\',
]);

const STRING_OR_COMMENT = /(^|_)(string|comment|char|character|regex|regexp|heredoc|rune|raw)(_|$)/;
const INTERPOLATION = /interpolation|substitution/;

const wasmDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

let initPromise = null;
const parsers = new Map(); // grammar name -> Parser

function init() {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

async function getParser(languageId) {
  const grammar = LANGUAGES[languageId];
  if (!grammar) return null;
  await init();
  if (!parsers.has(grammar)) {
    const lang = await Parser.Language.load(path.join(wasmDir, `tree-sitter-${grammar}.wasm`));
    const p = new Parser();
    p.setLanguage(lang);
    parsers.set(grammar, p);
  }
  return parsers.get(grammar);
}

function isWorthTracking(type) {
  if (!type || BASIC_PUNCTUATION.has(type)) return false;
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(type)) return true; // keyword
  return /^[^\sA-Za-z0-9_]+$/.test(type); // operator / symbol
}

/**
 * Walk the tree and return every keyword/operator token that is outside
 * strings and comments. `context` is the parent node type, which lets us tell
 * apart e.g. `if` in an if_statement from `if` in a ternary/comprehension.
 */
function extractTokens(tree) {
  const out = [];
  (function walk(node, inString) {
    if (node.type === 'ERROR' || node.isMissing()) return;
    const named = node.isNamed();
    if (!named) {
      if (!inString && node.parent && isWorthTracking(node.type)) {
        out.push({
          token: node.type,
          context: node.parent.type,
          line: node.startPosition.row,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
        });
      }
      return;
    }
    let next = inString;
    if (INTERPOLATION.test(node.type)) next = false;
    else if (STRING_OR_COMMENT.test(node.type)) next = true;
    for (const child of node.children) walk(child, next);
  })(tree.rootNode, false);
  return out;
}

async function parse(languageId, text) {
  const parser = await getParser(languageId);
  if (!parser) return null;
  return parser.parse(text);
}

/** All distinct keyword/operator tokens a grammar defines (for the bulk "mark as known" picker). */
async function grammarTokens(languageId) {
  const parser = await getParser(languageId);
  if (!parser) return [];
  const lang = parser.getLanguage();
  const set = new Set();
  for (let i = 0; i < lang.nodeTypeCount; i++) {
    if (!lang.nodeTypeIsNamed(i)) {
      const t = lang.nodeTypeForId(i);
      if (isWorthTracking(t)) set.add(t);
    }
  }
  return [...set].sort();
}

const SEP = '\u001f';
const keyOf = (language, token, context) => [language, token, context].join(SEP);
const splitKey = (key) => key.split(SEP);

module.exports = { LANGUAGES, SCAN_GLOB, parse, extractTokens, grammarTokens, keyOf, splitKey, isWorthTracking };
