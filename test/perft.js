// ルール実装の検証: 既知の perft 値と比較する
const Chess = require('../js/chess.js');
const cases = [
  [Chess.START_FEN, [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];
let ok = true;
for (const [fen, expected] of cases) {
  const pos = new Chess.Position(fen);
  if (pos.fen() !== fen) { console.log('FEN roundtrip mismatch', pos.fen(), fen); ok = false; }
  for (let d = 1; d <= expected.length; d++) {
    const t0 = Date.now();
    const n = pos.perft(d);
    const good = n === expected[d - 1];
    if (!good) ok = false;
    console.log(`${good ? 'ok  ' : 'FAIL'} perft(${d}) ${fen.split(' ')[0]} = ${n} (expected ${expected[d - 1]}) ${Date.now() - t0}ms`);
  }
  if (pos.h1 !== new Chess.Position(fen).h1) { console.log('hash drift'); ok = false; }
}
if (!ok) process.exit(1);
console.log('perft: all passed');
