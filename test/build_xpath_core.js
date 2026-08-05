#!/usr/bin/env node
/* build_xpath_core.js
   MTAdev Action Recorder — 從 content_recorder.js 抽取「純 xpath 生成函數」成獨立 xpath_core.js
   （供測試頁載入執行真實演算法，避免手抄造成與主檔邏輯漂移）
   用法: node build_xpath_core.js <content_recorder.js路徑> <輸出xpath_core.js路徑>
*/
const fs = require('fs');

const SRC = process.argv[2] || require('path').join(__dirname, '..', 'content_recorder.js');
const OUT = process.argv[3] || require('path').join(__dirname, 'xpath_core.js');

const src = fs.readFileSync(SRC, 'utf8');

/* 需要抽取的函數/常數（皆在 content_recorder.js 頂層 IIFE 內、縮排 2 空格的純邏輯） */
const FUNCS = [
  'esc', 'hasAttrName', 'usableAttrVal', 'attrLocator', 'attrTest',
  'stripAttrSuffix', 'bestAttrLocator', 'xpathMatchCount', 'isUniqueTo',
  'indexedVariant', 'tagSegment', 'buildStructural', 'buildIndexedTail',
  'generateXPath', 'resolveClickTarget', 'stateClassOnParent', 'isTextInput',
  'optionLabel', 'optionValue',
];
const CONSTS = ['DATA_TEST_ATTRS', 'EVENT_ATTRS'];

/* 從 src 中找出「縮排 2 空格」的頂層定義區段：
   - 函數:   '  function NAME(' ... 以配對大括號結束
   - 常數:   '  var NAME = ...;'    以分號結束 */
function extractDef(headerRe) {
  const m = src.search(headerRe);
  if (m < 0) return null;  const start = m;
  // 找到這段第一個 ' { ' 位置（函數）或直接 ';'（常數）
  if (headerRe.source.includes('function')) {
    const brace = src.indexOf('{', m);
    if (brace < 0) return null;
    let depth = 0;
    for (let i = brace; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  }
  const semi = src.indexOf(';', m);
  if (semi < 0) return null;
  return src.slice(start, semi + 1);
}

const parts = [];
parts.push('/* ===================================================');
parts.push('   xpath_core.js — MTAdev Action Recorder xpath 生成核心');
parts.push('   由 build_xpath_core.js 自動從 content_recorder.js 抽出，請勿手改');
parts.push('   原始碼: content_recorder.js');
parts.push('   =================================================== */');
parts.push('(function (global) {');

for (const c of CONSTS) {
  const def = extractDef(new RegExp('^  var ' + c + ' = ', 'm'));
  if (!def) throw new Error('找不到常數: ' + c);
  parts.push(def);
}

for (const f of FUNCS) {
  const def = extractDef(new RegExp('^  function ' + f + '\\(', 'm'));
  if (!def) throw new Error('找不到函數: ' + f);
  parts.push(def);
}

parts.push('  global.XPathCore = {');
for (const c of CONSTS) parts.push('    ' + c + ': ' + c + ',');
for (const f of FUNCS) parts.push('    ' + f + ': ' + f + ',');
parts.push('  };');
parts.push('})(typeof window !== "undefined" ? window : this);');

const out = parts.join('\n') + '\n';
fs.writeFileSync(OUT, out, 'utf8');
console.log('xpath_core.js 已生成:', OUT, '(' + out.length + ' bytes)');
console.log('函數數目:', FUNCS.length, '| 常數數目:', CONSTS.length);
