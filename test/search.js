// 探索の健全性テスト: 詰み発見、駒得、性格による選択の違い
const Chess = require('../js/chess.js');
const Eval = require('../js/eval.js');
const Search = require('../js/search.js');

async function main() {
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) ok = false; };

  // メイト・イン・1 (白: Qh5xf7#)
  let pos = new Chess.Position('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  let r = await Search.think(pos, Eval.makeEvaluator({}, Chess.WHITE), { maxDepth: 3 });
  check(pos.uci(r.move) === 'h5f7' && Search.isMateScore(r.score), `mate in 1 found: ${pos.uci(r.move)} score=${r.score}`);

  // メイト・イン・2 (有名な問題: 1.Nf6+ gxf6 2.Bxf7#)
  pos = new Chess.Position('r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 0');
  r = await Search.think(pos, Eval.makeEvaluator({}, Chess.WHITE), { maxDepth: 4 });
  check(Search.isMateScore(r.score) && Search.mateIn(r.score) === 2, `mate in 2: ${pos.uci(r.move)} mateIn=${Search.mateIn(r.score)}`);

  // 駒得: フリーのクイーンを取る
  pos = new Chess.Position('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
  r = await Search.think(pos, Eval.makeEvaluator({}, Chess.WHITE), { maxDepth: 3 });
  check(pos.uci(r.move) === 'd1d5', `free queen captured: ${pos.uci(r.move)}`);

  // rankMoves: 全手にスコアが付く
  pos = new Chess.Position();
  const t0 = Date.now();
  const ranked = await Search.rankMoves(pos, Eval.makeEvaluator({}, Chess.WHITE), 4);
  check(ranked.length === 20 && ranked.every((x) => typeof x.score === 'number'), `rankMoves start pos depth4: ${ranked.length} moves, best ${pos.san(ranked[0].move)} ${ranked[0].score} in ${Date.now() - t0}ms, ${ranked.nodes} nodes`);

  // 性格の違い: 序盤の局面で各性格の最善手を表示
  pos = new Chess.Position('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  for (const p of Eval.PERSONALITIES) {
    const t1 = Date.now();
    const rr = await Search.rankMoves(pos, Eval.makeEvaluator(p.weights, Chess.WHITE), 3);
    console.log(`  ${p.name}(${p.trait}): ${rr.slice(0, 4).map((x) => pos.san(x.move) + '(' + x.score + ')').join(' ')}  ${Date.now() - t1}ms`);
  }

  // 速度: 中盤で depth 5
  pos = new Chess.Position('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQK2R w KQ - 0 8');
  const t2 = Date.now();
  r = await Search.think(pos, Eval.makeEvaluator({}, Chess.WHITE), { maxDepth: 5, timeMs: 20000 });
  console.log(`  depth ${r.depth}: ${pos.san(r.move)} ${r.score} pv=${r.pv.map((m) => pos.uci(m)).join(' ')} ${r.nodes} nodes ${Date.now() - t2}ms`);

  if (!ok) process.exit(1);
  console.log('search: all passed');
}
main();
