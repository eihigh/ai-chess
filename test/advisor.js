// 軍師の進言テスト
const Chess = require('../js/chess.js');
const Eval = require('../js/eval.js');
const Search = require('../js/search.js');
const Advisor = require('../js/advisor.js');

async function main() {
  let ok = true;
  const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) ok = false; };
  const fens = [
    ['開始局面', Chess.START_FEN],
    ['イタリアン序盤', 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3'],
    ['中盤', 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQK2R w KQ - 0 8'],
    ['詰みあり', 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'],
    ['駒得あり', 'rnbqkbnr/ppp2ppp/8/3pp3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq d6 0 3'],
  ];
  for (const [name, fen] of fens) {
    const pos = new Chess.Position(fen);
    const t0 = Date.now();
    const res = await Advisor.advise(pos, { depth: 3 });
    console.log(`--- ${name} (${Date.now() - t0}ms) 総合最善 ${pos.san(res.neutral[0].move)} ${Advisor.formatScore(res.bestScore)}`);
    for (const c of res.cards) {
      console.log(`  [${c.personalities.map((p) => p.name).join('・')}] ${c.san} (${c.scoreText}, 総合${c.rank}位) tags=${c.tags.join(',')}`);
      console.log(`     「${c.comment}」 読み筋: ${c.pvText}`);
    }
    check(res.cards.length >= 1 && res.cards.every((c) => pos.legalMoves().some((m) => m.enc === c.enc)), `${name}: cards are legal`);
    check(res.cards.every((c) => c.score >= res.bestScore - 150 || Search.isMateScore(res.bestScore)), `${name}: no blunder cards`);
    if (name === '詰みあり') check(res.cards.length === 1 && res.cards[0].features.mate, 'mate: all advisors agree');
  }
  if (!ok) process.exit(1);
  console.log('advisor: all passed');
}
main();
