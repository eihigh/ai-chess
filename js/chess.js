/*
 * chess.js — チェスのルール実装 (0x88 盤表現)
 *
 * ブラウザでは window.Chess、Node では module.exports として公開する。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const WHITE = 1, BLACK = -1;
  const F_CAPTURE = 1, F_PAWN2 = 2, F_EP = 4, F_CASTLE = 8, F_PROMO = 16;
  const C_WK = 1, C_WQ = 2, C_BK = 4, C_BQ = 8;
  const PIECE_LETTERS = ' PNBRQK';
  const PIECE_FROM_CHAR = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
  const KNIGHT_OFFS = [-33, -31, -18, -14, 14, 18, 31, 33];
  const BISHOP_OFFS = [-17, -15, 15, 17];
  const ROOK_OFFS = [-16, -1, 1, 16];
  const KING_OFFS = [-17, -16, -15, -1, 1, 15, 16, 17];
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const VALUES = [0, 100, 320, 330, 500, 900, 20000];

  // 駒が動いたときに失われるキャスリング権のマスク
  const CASTLE_MASK = new Uint8Array(128).fill(15);
  CASTLE_MASK[0] &= ~C_WQ; CASTLE_MASK[4] &= ~(C_WK | C_WQ); CASTLE_MASK[7] &= ~C_WK;
  CASTLE_MASK[112] &= ~C_BQ; CASTLE_MASK[116] &= ~(C_BK | C_BQ); CASTLE_MASK[119] &= ~C_BK;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) | 0;
    };
  }

  // Zobrist ハッシュ (32bit を 2 本使う)
  const Z = (function () {
    const r1 = mulberry32(0x9E3779B9), r2 = mulberry32(0x7F4A7C15);
    const p1 = [], p2 = [];
    for (let p = 0; p < 14; p++) {
      p1.push(new Int32Array(128)); p2.push(new Int32Array(128));
      for (let s = 0; s < 128; s++) { p1[p][s] = r1(); p2[p][s] = r2(); }
    }
    const c1 = new Int32Array(16), c2 = new Int32Array(16);
    for (let i = 0; i < 16; i++) { c1[i] = r1(); c2[i] = r2(); }
    const e1 = new Int32Array(8), e2 = new Int32Array(8);
    for (let i = 0; i < 8; i++) { e1[i] = r1(); e2[i] = r2(); }
    return { p1, p2, c1, c2, e1, e2, s1: r1(), s2: r2() };
  })();

  const sqName = (s) => 'abcdefgh'[s & 7] + (1 + (s >> 4));
  const parseSq = (str) => ((str.charCodeAt(1) - 49) << 4) | (str.charCodeAt(0) - 97);
  const fileOf = (s) => s & 7;
  const rankOf = (s) => s >> 4;
  const onBoard = (s) => (s & 0x88) === 0;
  const encodeMove = (from, to, promo) => from | (to << 7) | (promo << 14);

  class Position {
    constructor(fen) {
      this.board = new Int8Array(128);
      this.side = WHITE;
      this.castling = 0;
      this.ep = -1;
      this.halfmove = 0;
      this.fullmove = 1;
      this.kingSq = [4, 116]; // [white, black]
      this.history = [];
      this.h1 = 0; this.h2 = 0;
      this.setFen(fen || START_FEN);
    }

    clone() {
      const p = Object.create(Position.prototype);
      p.board = new Int8Array(this.board);
      p.side = this.side; p.castling = this.castling; p.ep = this.ep;
      p.halfmove = this.halfmove; p.fullmove = this.fullmove;
      p.kingSq = this.kingSq.slice();
      p.history = this.history.slice();
      p.h1 = this.h1; p.h2 = this.h2;
      return p;
    }

    setFen(fen) {
      const parts = fen.trim().split(/\s+/);
      this.board.fill(0);
      let rank = 7, file = 0;
      for (const ch of parts[0]) {
        if (ch === '/') { rank--; file = 0; }
        else if (ch >= '1' && ch <= '8') file += +ch;
        else {
          const p = PIECE_FROM_CHAR[ch.toLowerCase()];
          const color = ch === ch.toUpperCase() ? WHITE : BLACK;
          this.board[(rank << 4) | file] = p * color;
          file++;
        }
      }
      this.side = parts[1] === 'b' ? BLACK : WHITE;
      this.castling = 0;
      if (parts[2] && parts[2] !== '-') {
        for (const c of parts[2]) {
          if (c === 'K') this.castling |= C_WK;
          else if (c === 'Q') this.castling |= C_WQ;
          else if (c === 'k') this.castling |= C_BK;
          else if (c === 'q') this.castling |= C_BQ;
        }
      }
      this.ep = parts[3] && parts[3] !== '-' ? parseSq(parts[3]) : -1;
      this.halfmove = parts[4] ? +parts[4] : 0;
      this.fullmove = parts[5] ? +parts[5] : 1;
      this.history = [];
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        if (this.board[s] === KING) this.kingSq[0] = s;
        else if (this.board[s] === -KING) this.kingSq[1] = s;
      }
      this.computeHash();
    }

    fen() {
      let out = '';
      for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[(r << 4) | f];
          if (p === 0) { empty++; continue; }
          if (empty) { out += empty; empty = 0; }
          const ch = PIECE_LETTERS[Math.abs(p)];
          out += p > 0 ? ch : ch.toLowerCase();
        }
        if (empty) out += empty;
        if (r) out += '/';
      }
      out += this.side === WHITE ? ' w ' : ' b ';
      let c = '';
      if (this.castling & C_WK) c += 'K';
      if (this.castling & C_WQ) c += 'Q';
      if (this.castling & C_BK) c += 'k';
      if (this.castling & C_BQ) c += 'q';
      out += (c || '-') + ' ' + (this.ep >= 0 ? sqName(this.ep) : '-');
      out += ' ' + this.halfmove + ' ' + this.fullmove;
      return out;
    }

    computeHash() {
      let h1 = 0, h2 = 0;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = this.board[s];
        if (p) { h1 ^= Z.p1[p + 7][s]; h2 ^= Z.p2[p + 7][s]; }
      }
      h1 ^= Z.c1[this.castling]; h2 ^= Z.c2[this.castling];
      if (this.ep >= 0) { h1 ^= Z.e1[this.ep & 7]; h2 ^= Z.e2[this.ep & 7]; }
      if (this.side === BLACK) { h1 ^= Z.s1; h2 ^= Z.s2; }
      this.h1 = h1; this.h2 = h2;
    }

    // sq が color 側の駒に攻撃されているか
    isAttacked(sq, color) {
      const b = this.board;
      // ポーン
      if (color === WHITE) {
        if (onBoard(sq - 15) && b[sq - 15] === PAWN) return true;
        if (onBoard(sq - 17) && b[sq - 17] === PAWN) return true;
      } else {
        if (onBoard(sq + 15) && b[sq + 15] === -PAWN) return true;
        if (onBoard(sq + 17) && b[sq + 17] === -PAWN) return true;
      }
      const n = KNIGHT * color, k = KING * color, bi = BISHOP * color, ro = ROOK * color, q = QUEEN * color;
      for (let i = 0; i < 8; i++) {
        const t = sq + KNIGHT_OFFS[i];
        if (onBoard(t) && b[t] === n) return true;
      }
      for (let i = 0; i < 8; i++) {
        const t = sq + KING_OFFS[i];
        if (onBoard(t) && b[t] === k) return true;
      }
      for (let i = 0; i < 4; i++) {
        const d = BISHOP_OFFS[i];
        for (let t = sq + d; onBoard(t); t += d) {
          const p = b[t];
          if (p) { if (p === bi || p === q) return true; break; }
        }
      }
      for (let i = 0; i < 4; i++) {
        const d = ROOK_OFFS[i];
        for (let t = sq + d; onBoard(t); t += d) {
          const p = b[t];
          if (p) { if (p === ro || p === q) return true; break; }
        }
      }
      return false;
    }

    kingAttacked(color) {
      return this.isAttacked(this.kingSq[color === WHITE ? 0 : 1], -color);
    }

    inCheck() { return this.kingAttacked(this.side); }

    /** 疑似合法手を生成する。capturesOnly なら駒取りと昇格のみ。 */
    generatePseudo(capturesOnly) {
      const b = this.board, us = this.side, them = -us;
      const moves = [];
      const add = (from, to, piece, captured, promo, flags) => {
        moves.push({ from, to, piece, captured, promo, flags, enc: encodeMove(from, to, promo) });
      };
      const fwd = 16 * us;
      const startRank = us === WHITE ? 1 : 6;
      const promoRank = us === WHITE ? 7 : 0;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = b[s];
        if (p === 0 || (p > 0) !== (us > 0)) continue;
        const pt = p * us;
        if (pt === PAWN) {
          const t = s + fwd;
          if (b[t] === 0) {
            if (rankOf(t) === promoRank) {
              for (let pr = QUEEN; pr >= KNIGHT; pr--) add(s, t, p, 0, pr, F_PROMO);
            } else if (!capturesOnly) {
              add(s, t, p, 0, 0, 0);
              if (rankOf(s) === startRank && b[t + fwd] === 0) add(s, t + fwd, p, 0, 0, F_PAWN2);
            }
          }
          for (const d of [fwd - 1, fwd + 1]) {
            const c = s + d;
            if (!onBoard(c)) continue;
            const cp = b[c];
            if (cp !== 0 && (cp > 0) !== (us > 0)) {
              if (rankOf(c) === promoRank) {
                for (let pr = QUEEN; pr >= KNIGHT; pr--) add(s, c, p, cp, pr, F_CAPTURE | F_PROMO);
              } else add(s, c, p, cp, 0, F_CAPTURE);
            } else if (c === this.ep && cp === 0) {
              add(s, c, p, -p, 0, F_CAPTURE | F_EP);
            }
          }
        } else if (pt === KNIGHT || pt === KING) {
          const offs = pt === KNIGHT ? KNIGHT_OFFS : KING_OFFS;
          for (let i = 0; i < 8; i++) {
            const t = s + offs[i];
            if (!onBoard(t)) continue;
            const tp = b[t];
            if (tp === 0) { if (!capturesOnly) add(s, t, p, 0, 0, 0); }
            else if ((tp > 0) !== (us > 0)) add(s, t, p, tp, 0, F_CAPTURE);
          }
        } else {
          const offs = pt === BISHOP ? BISHOP_OFFS : pt === ROOK ? ROOK_OFFS : KING_OFFS;
          for (let i = 0; i < offs.length; i++) {
            const d = offs[i];
            for (let t = s + d; onBoard(t); t += d) {
              const tp = b[t];
              if (tp === 0) { if (!capturesOnly) add(s, t, p, 0, 0, 0); continue; }
              if ((tp > 0) !== (us > 0)) add(s, t, p, tp, 0, F_CAPTURE);
              break;
            }
          }
        }
      }
      if (!capturesOnly) {
        // キャスリング
        if (us === WHITE) {
          if ((this.castling & C_WK) && b[5] === 0 && b[6] === 0 && b[7] === ROOK &&
              !this.isAttacked(4, them) && !this.isAttacked(5, them) && !this.isAttacked(6, them))
            add(4, 6, KING, 0, 0, F_CASTLE);
          if ((this.castling & C_WQ) && b[3] === 0 && b[2] === 0 && b[1] === 0 && b[0] === ROOK &&
              !this.isAttacked(4, them) && !this.isAttacked(3, them) && !this.isAttacked(2, them))
            add(4, 2, KING, 0, 0, F_CASTLE);
        } else {
          if ((this.castling & C_BK) && b[117] === 0 && b[118] === 0 && b[119] === -ROOK &&
              !this.isAttacked(116, them) && !this.isAttacked(117, them) && !this.isAttacked(118, them))
            add(116, 118, -KING, 0, 0, F_CASTLE);
          if ((this.castling & C_BQ) && b[115] === 0 && b[114] === 0 && b[113] === 0 && b[112] === -ROOK &&
              !this.isAttacked(116, them) && !this.isAttacked(115, them) && !this.isAttacked(114, them))
            add(116, 114, -KING, 0, 0, F_CASTLE);
        }
      }
      return moves;
    }

    legalMoves() {
      const pseudo = this.generatePseudo(false);
      const legal = [];
      const us = this.side;
      for (const m of pseudo) {
        this.make(m);
        if (!this.kingAttacked(us)) legal.push(m);
        this.unmake();
      }
      return legal;
    }

    make(m) {
      const b = this.board, us = this.side, them = -us;
      this.history.push({
        m, castling: this.castling, ep: this.ep, halfmove: this.halfmove, h1: this.h1, h2: this.h2,
      });
      let h1 = this.h1, h2 = this.h2;
      if (this.ep >= 0) { h1 ^= Z.e1[this.ep & 7]; h2 ^= Z.e2[this.ep & 7]; }
      h1 ^= Z.c1[this.castling]; h2 ^= Z.c2[this.castling];

      const piece = b[m.from];
      b[m.from] = 0;
      h1 ^= Z.p1[piece + 7][m.from]; h2 ^= Z.p2[piece + 7][m.from];
      if (m.flags & F_EP) {
        const capSq = m.to - 16 * us;
        h1 ^= Z.p1[b[capSq] + 7][capSq]; h2 ^= Z.p2[b[capSq] + 7][capSq];
        b[capSq] = 0;
      } else if (m.captured) {
        h1 ^= Z.p1[m.captured + 7][m.to]; h2 ^= Z.p2[m.captured + 7][m.to];
      }
      const placed = m.promo ? m.promo * us : piece;
      b[m.to] = placed;
      h1 ^= Z.p1[placed + 7][m.to]; h2 ^= Z.p2[placed + 7][m.to];
      if (m.flags & F_CASTLE) {
        let rf, rt;
        if (m.to > m.from) { rf = m.to + 1; rt = m.to - 1; } else { rf = m.to - 2; rt = m.to + 1; }
        const rook = b[rf];
        b[rt] = rook; b[rf] = 0;
        h1 ^= Z.p1[rook + 7][rf] ^ Z.p1[rook + 7][rt];
        h2 ^= Z.p2[rook + 7][rf] ^ Z.p2[rook + 7][rt];
      }
      if (piece === KING * us) this.kingSq[us === WHITE ? 0 : 1] = m.to;

      this.castling &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
      h1 ^= Z.c1[this.castling]; h2 ^= Z.c2[this.castling];
      this.ep = (m.flags & F_PAWN2) ? m.from + 16 * us : -1;
      if (this.ep >= 0) { h1 ^= Z.e1[this.ep & 7]; h2 ^= Z.e2[this.ep & 7]; }
      if (piece === PAWN * us || m.captured) this.halfmove = 0; else this.halfmove++;
      if (us === BLACK) this.fullmove++;
      this.side = them;
      h1 ^= Z.s1; h2 ^= Z.s2;
      this.h1 = h1; this.h2 = h2;
    }

    unmake() {
      const h = this.history.pop();
      const m = h.m;
      const b = this.board;
      const us = -this.side; // 指した側
      const piece = m.promo ? PAWN * us : b[m.to];
      b[m.from] = piece;
      b[m.to] = 0;
      if (m.flags & F_EP) b[m.to - 16 * us] = m.captured;
      else if (m.captured) b[m.to] = m.captured;
      if (m.flags & F_CASTLE) {
        if (m.to > m.from) { b[m.to + 1] = b[m.to - 1]; b[m.to - 1] = 0; }
        else { b[m.to - 2] = b[m.to + 1]; b[m.to + 1] = 0; }
      }
      if (piece === KING * us) this.kingSq[us === WHITE ? 0 : 1] = m.from;
      this.castling = h.castling; this.ep = h.ep; this.halfmove = h.halfmove;
      this.h1 = h.h1; this.h2 = h.h2;
      if (us === BLACK) this.fullmove--;
      this.side = us;
    }

    /** 現局面が過去に count 回以上現れているか (現局面を含む) */
    repetitionCount() {
      let n = 1;
      const hist = this.history;
      const limit = Math.max(0, hist.length - this.halfmove);
      for (let i = hist.length - 2; i >= limit; i -= 2) {
        if (hist[i].h1 === this.h1 && hist[i].h2 === this.h2) n++;
      }
      return n;
    }

    isRepetition() { return this.repetitionCount() >= 2; }

    insufficientMaterial() {
      let minors = 0, bishopsColor = -1, sameColorBishops = true;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = Math.abs(this.board[s]);
        if (p === 0 || p === KING) continue;
        if (p === PAWN || p === ROOK || p === QUEEN) return false;
        minors++;
        if (p === BISHOP) {
          const c = (fileOf(s) + rankOf(s)) & 1;
          if (bishopsColor === -1) bishopsColor = c; else if (bishopsColor !== c) sameColorBishops = false;
        } else sameColorBishops = false;
      }
      if (minors <= 1) return true;
      return sameColorBishops; // 同色ビショップのみ
    }

    /** 対局の状態 */
    status() {
      const legal = this.legalMoves();
      if (legal.length === 0) {
        if (this.inCheck()) return { over: true, result: this.side === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
        return { over: true, result: '1/2-1/2', reason: 'stalemate' };
      }
      if (this.repetitionCount() >= 3) return { over: true, result: '1/2-1/2', reason: 'repetition' };
      if (this.halfmove >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty' };
      if (this.insufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient' };
      return { over: false, result: null, reason: null, check: this.inCheck() };
    }

    san(m, legal) {
      legal = legal || this.legalMoves();
      let s = '';
      const pt = Math.abs(m.piece);
      if (m.flags & F_CASTLE) s = m.to > m.from ? 'O-O' : 'O-O-O';
      else {
        if (pt !== PAWN) {
          s += PIECE_LETTERS[pt];
          const others = legal.filter((o) => o.to === m.to && o.piece === m.piece && o.from !== m.from);
          if (others.length) {
            const sameFile = others.some((o) => fileOf(o.from) === fileOf(m.from));
            const sameRank = others.some((o) => rankOf(o.from) === rankOf(m.from));
            if (!sameFile) s += 'abcdefgh'[fileOf(m.from)];
            else if (!sameRank) s += (rankOf(m.from) + 1);
            else s += sqName(m.from);
          }
        } else if (m.flags & F_CAPTURE) s += 'abcdefgh'[fileOf(m.from)];
        if (m.flags & F_CAPTURE) s += 'x';
        s += sqName(m.to);
        if (m.promo) s += '=' + PIECE_LETTERS[m.promo];
      }
      this.make(m);
      if (this.inCheck()) s += this.legalMoves().length ? '+' : '#';
      this.unmake();
      return s;
    }

    uci(m) { return sqName(m.from) + sqName(m.to) + (m.promo ? PIECE_LETTERS[m.promo].toLowerCase() : ''); }

    moveFromUci(str) {
      const from = parseSq(str.slice(0, 2)), to = parseSq(str.slice(2, 4));
      const promo = str.length > 4 ? PIECE_FROM_CHAR[str[4]] : 0;
      return this.legalMoves().find((m) => m.from === from && m.to === to && (m.promo || 0) === promo) || null;
    }

    perft(depth) {
      if (depth === 0) return 1;
      const moves = this.legalMoves();
      if (depth === 1) return moves.length;
      let n = 0;
      for (const m of moves) { this.make(m); n += this.perft(depth - 1); this.unmake(); }
      return n;
    }
  }

  return {
    Position, START_FEN, VALUES,
    EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK,
    F_CAPTURE, F_PAWN2, F_EP, F_CASTLE, F_PROMO,
    C_WK, C_WQ, C_BK, C_BQ,
    KNIGHT_OFFS, BISHOP_OFFS, ROOK_OFFS, KING_OFFS,
    sqName, parseSq, fileOf, rankOf, onBoard, encodeMove, PIECE_LETTERS,
  };
});
