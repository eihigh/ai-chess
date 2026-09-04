// 単一 HTML (dist/gunshi-chess.html) を生成する。Claude Artifact 等、1 ファイルで配布したいとき用。
const fs = require('fs');
const path = require('path');
const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const index = read('index.html');
const fonts = (index.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/) || [''])[0];
const body = index.match(/<body>([\s\S]*?)<script/)[1].trim();
const css = read('css/style.css');
const js = ['js/chess.js', 'js/eval.js', 'js/search.js', 'js/advisor.js', 'js/ui.js'].map(read).join('\n');
const out = `<title>軍師チェス</title>\n${fonts}\n<style>\n${css}\n</style>\n${body}\n<script>\n${js}\n</script>\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/gunshi-chess.html'), out);
console.log('wrote dist/gunshi-chess.html', (out.length / 1024).toFixed(0), 'KB');
