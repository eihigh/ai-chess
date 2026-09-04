/*
 * search.js — αβ探索 (反復深化・静止探索・置換表・キラー/ヒストリー)
 *
 * think()     : 相手 AI 用。最善手を 1 つ返す。
 * rankMoves() : 軍師用。候補手すべてに正確なスコアを付けて返す。
 * どちらも非同期で、区切りごとに UI に制御を戻す。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.Search = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  'use strict';

  const { VALUES, F_CAPTURE, F_PROMO, KING } = Chess;
  const MATE = 100000, INF = 1000000, MATE_BOUND = MATE - 1000;
  const TT_SIZE = 1 << 18, TT_MASK = TT_SIZE - 1;
  const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
  const tt = {
    k1: new Int32Array(TT_SIZE), k2: new Int32Array(TT_SIZE), depth: new Int8Array(TT_SIZE),
    flag: new Int8Array(TT_SIZE), score: new Int32Array(TT_SIZE), move: new Int32Array(TT_SIZE),
  };
  const MAX_PLY = 64;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  function ttClear() { tt.k1.fill(0); tt.k2.fill(0); tt.depth.fill(-1); tt.flag.fill(0); }
  function scoreToTT(s, ply) { return s > MATE_BOUND ? s + ply : s < -MATE_BOUND ? s - ply : s; }
  function scoreFromTT(s, ply) { return s > MATE_BOUND ? s - ply : s < -MATE_BOUND ? s + ply : s; }

  class Searcher {
    constructor(pos, evalFn, opts) {
      this.pos = pos;
      this.eval = evalFn;
      this.nodes = 0;
      this.deadline = opts && opts.timeMs ? now() + opts.timeMs : Infinity;
      this.stopped = false;
      this.killers = [];
      for (let i = 0; i < MAX_PLY; i++) this.killers.push([0, 0]);
      this.hist = new Int32Array(128 * 128);
    }

    checkTime() {
      if ((this.nodes & 2047) === 0 && now() > this.deadline) this.stopped = true;
    }

    orderMoves(moves, ttMove, ply) {
      const k = this.killers[ply];
      for (const m of moves) {
        let s;
        if (m.enc === ttMove) s = 10000000;
        else if (m.flags & F_CAPTURE) s = 1000000 + VALUES[Math.abs(m.captured)] * 10 - VALUES[Math.abs(m.piece)];
        else if (m.flags & F_PROMO) s = 900000 + VALUES[m.promo];
        else if (m.enc === k[0]) s = 800000;
        else if (m.enc === k[1]) s = 790000;
        else s = this.hist[(m.from << 7) | m.to];
        if (m.flags & F_PROMO) s += VALUES[m.promo];
        m.score = s;
      }
      moves.sort((a, b) => b.score - a.score);
    }

    negamax(depth, alpha, beta, ply) {
      this.nodes++;
      this.checkTime();
      if (this.stopped) return 0;
      const pos = this.pos;
      if (ply > 0 && (pos.isRepetition() || pos.halfmove >= 100)) return 0;
      const inCheck = pos.inCheck();
      if (inCheck) depth++;
      if (depth <= 0 || ply >= MAX_PLY - 1) return this.quiesce(alpha, beta, ply, 0);

      // 詰み距離枝刈り
      const mateAlpha = -MATE + ply, mateBeta = MATE - ply - 1;
      if (alpha < mateAlpha) alpha = mateAlpha;
      if (beta > mateBeta) beta = mateBeta;
      if (alpha >= beta) return alpha;

      const idx = pos.h1 & TT_MASK;
      let ttMove = 0;
      if (tt.k1[idx] === pos.h1 && tt.k2[idx] === pos.h2) {
        ttMove = tt.move[idx];
        if (tt.depth[idx] >= depth && ply > 0) {
          const s = scoreFromTT(tt.score[idx], ply), f = tt.flag[idx];
          if (f === TT_EXACT) return s;
          if (f === TT_LOWER && s >= beta) return s;
          if (f === TT_UPPER && s <= alpha) return s;
        }
      }

      const moves = pos.generatePseudo(false);
      this.orderMoves(moves, ttMove, ply);
      const us = pos.side;
      let best = -INF, bestMove = 0, legal = 0, flag = TT_UPPER;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        pos.make(m);
        if (pos.kingAttacked(us)) { pos.unmake(); continue; }
        legal++;
        let score;
        if (legal > 1 && depth >= 3 && !inCheck && !(m.flags & (F_CAPTURE | F_PROMO)) && i >= 4) {
          // Late Move Reduction
          score = -this.negamax(depth - 2, -alpha - 1, -alpha, ply + 1);
          if (score > alpha) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
        } else {
          score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
        }
        pos.unmake();
        if (this.stopped) return 0;
        if (score > best) {
          best = score; bestMove = m.enc;
          if (score > alpha) {
            alpha = score; flag = TT_EXACT;
            if (alpha >= beta) {
              flag = TT_LOWER;
              if (!(m.flags & F_CAPTURE)) {
                const k = this.killers[ply];
                if (k[0] !== m.enc) { k[1] = k[0]; k[0] = m.enc; }
                this.hist[(m.from << 7) | m.to] += depth * depth;
              }
              break;
            }
          }
        }
      }
      if (legal === 0) return inCheck ? -MATE + ply : 0;
      tt.k1[idx] = pos.h1; tt.k2[idx] = pos.h2; tt.depth[idx] = depth; tt.flag[idx] = flag;
      tt.score[idx] = scoreToTT(best, ply); tt.move[idx] = bestMove;
      return best;
    }

    quiesce(alpha, beta, ply, qdepth) {
      this.nodes++;
      this.checkTime();
      if (this.stopped) return 0;
      const pos = this.pos;
      const inCheck = qdepth < 3 && pos.inCheck();
      let stand = -INF;
      if (!inCheck) {
        stand = this.eval(pos);
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
      }
      if (ply >= MAX_PLY - 1) return inCheck ? this.eval(pos) : stand;
      const moves = pos.generatePseudo(!inCheck);
      this.orderMoves(moves, 0, ply);
      const us = pos.side;
      let best = stand, legal = 0;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (!inCheck && (m.flags & F_CAPTURE) && !(m.flags & F_PROMO) &&
            stand + VALUES[Math.abs(m.captured)] + 200 < alpha) continue; // delta pruning
        pos.make(m);
        if (pos.kingAttacked(us)) { pos.unmake(); continue; }
        legal++;
        const score = -this.quiesce(-beta, -alpha, ply + 1, qdepth + 1);
        pos.unmake();
        if (this.stopped) return 0;
        if (score > best) {
          best = score;
          if (score > alpha) { alpha = score; if (alpha >= beta) break; }
        }
      }
      if (inCheck && legal === 0) return -MATE + ply;
      return best;
    }
  }

  /** 置換表から読み筋を復元する */
  function extractPV(pos, maxLen) {
    const pv = [];
    let made = 0;
    for (let i = 0; i < maxLen; i++) {
      const idx = pos.h1 & TT_MASK;
      if (tt.k1[idx] !== pos.h1 || tt.k2[idx] !== pos.h2) break;
      const enc = tt.move[idx];
      const m = pos.legalMoves().find((x) => x.enc === enc);
      if (!m) break;
      pv.push(m);
      pos.make(m); made++;
      if (pos.isRepetition()) break;
    }
    while (made--) pos.unmake();
    return pv;
  }

  /**
   * 最善手探索 (相手 AI 用)。
   * opts: { maxDepth, timeMs, onDepth }
   */
  async function think(pos0, evalFn, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 4;
    const pos = pos0.clone();
    ttClear();
    const S = new Searcher(pos, evalFn, { timeMs: opts.timeMs });
    let moves = pos.legalMoves();
    if (moves.length === 0) return null;
    let best = { move: moves[0], score: 0, depth: 0, pv: [moves[0]], nodes: 0 };
    const t0 = now();
    await yieldToUI();
    for (let d = 1; d <= maxDepth; d++) {
      let alpha = -INF, bestThis = null, bestScore = -INF;
      moves = [best.move].concat(moves.filter((m) => m !== best.move));
      for (const m of moves) {
        pos.make(m);
        let score = -S.negamax(d - 1, -INF, -alpha, 1);
        pos.unmake();
        if (S.stopped) break;
        if (score > bestScore) { bestScore = score; bestThis = m; if (score > alpha) alpha = score; }
      }
      if (S.stopped) break;
      pos.make(bestThis);
      const pv = [bestThis].concat(extractPV(pos, d));
      pos.unmake();
      best = { move: bestThis, score: bestScore, depth: d, pv, nodes: S.nodes, timeMs: now() - t0 };
      if (opts.onDepth) opts.onDepth(best);
      if (Math.abs(bestScore) > MATE_BOUND) break;
      await yieldToUI();
      if (opts.shouldAbort && opts.shouldAbort()) return null;
    }
    best.timeMs = now() - t0;
    return best;
  }

  /**
   * 全候補手 (または opts.moves で限定) に正確な評価値を付けて降順に返す (軍師用)。
   * opts: { moves: [enc...], timeMs, shouldAbort, onProgress }
   * 中断時は null を返す。
   */
  async function rankMoves(pos0, evalFn, depth, opts) {
    opts = opts || {};
    const pos = pos0.clone();
    ttClear();
    const S = new Searcher(pos, evalFn, { timeMs: opts.timeMs });
    let list = pos.legalMoves();
    if (opts.moves) {
      const set = new Set(opts.moves);
      list = list.filter((m) => set.has(m.enc));
    }
    let results = list.map((m) => ({ move: m, score: 0, pv: [m] }));
    const t0 = now();
    for (let d = 1; d <= depth; d++) {
      let count = 0;
      for (const r of results) {
        pos.make(r.move);
        const score = -S.negamax(d - 1, -INF, INF, 1);
        if (!S.stopped) {
          r.score = score;
          r.pv = [r.move].concat(extractPV(pos, d));
        }
        pos.unmake();
        if (S.stopped) break;
        if ((++count & 7) === 0) {
          await yieldToUI();
          if (opts.shouldAbort && opts.shouldAbort()) return null;
        }
      }
      if (S.stopped) break;
      results.sort((a, b) => b.score - a.score);
      if (opts.onProgress) opts.onProgress(d, results);
      await yieldToUI();
      if (opts.shouldAbort && opts.shouldAbort()) return null;
    }
    results.sort((a, b) => b.score - a.score);
    results.nodes = S.nodes;
    results.timeMs = now() - t0;
    return results;
  }

  const isMateScore = (s) => Math.abs(s) > MATE_BOUND;
  const mateIn = (s) => (s > 0 ? Math.ceil((MATE - s) / 2) : -Math.ceil((MATE + s) / 2));

  return { think, rankMoves, Searcher, MATE, INF, MATE_BOUND, isMateScore, mateIn, ttClear, yieldToUI };
});
