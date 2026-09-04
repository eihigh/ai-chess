/*
 * eval.js — 評価関数と「性格」定義
 *
 * 評価は「性格の持ち主 (me)」から見たスコアを計算し、
 * 手番が me でなければ符号を反転して返す (negamax 用)。
 * 性格ごとの重みで、同じ局面でも違う手が好まれるようになる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'));
  else root.Eval = factory(root.Chess);
})(typeof self !== 'undefined' ? self : this, function (Chess) {
  'use strict';

  const { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, BLACK, VALUES,
    KNIGHT_OFFS, BISHOP_OFFS, ROOK_OFFS, KING_OFFS, onBoard, fileOf, rankOf } = Chess;

  // Piece-Square Tables (a8 から h1 の順、白視点)
  const PST = {
    [PAWN]: [
      0, 0, 0, 0, 0, 0, 0, 0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, -5, -10, 0, 0, -10, -5, 5,
      5, 10, 10, -20, -20, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0],
    [KNIGHT]: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50],
    [BISHOP]: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -20, -10, -10, -10, -10, -10, -10, -20],
    [ROOK]: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, 10, 10, 10, 10, 5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      0, 0, 0, 5, 5, 0, 0, 0],
    [QUEEN]: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20],
  };
  const KING_MG = [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20];
  const KING_EG = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50];

  // 0x88 マス → PST インデックス (白: 8 段目が先頭、黒: 鏡像)
  const IDX_W = new Uint8Array(128), IDX_B = new Uint8Array(128);
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) continue;
    IDX_W[s] = (7 - rankOf(s)) * 8 + fileOf(s);
    IDX_B[s] = rankOf(s) * 8 + fileOf(s);
  }
  const PASSED_BONUS = [0, 10, 15, 25, 40, 65, 100, 0]; // 相対段ごと
  const CENTER = [51, 52, 67, 68]; // d4 e4 d5 e5
  const MINOR_START = { [WHITE]: [1, 2, 5, 6], [BLACK]: [113, 114, 117, 118] };

  const attW = new Uint8Array(128), attB = new Uint8Array(128);

  /**
   * 局面の特徴量を両陣営分まとめて計算する。
   * 各項目は [white, black] の配列。
   */
  function features(pos) {
    const b = pos.board;
    attW.fill(0); attB.fill(0);
    const mat = [0, 0], pst = [0, 0], mob = [0, 0], npm = [0, 0];
    const pawnFiles = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];
    const pawns = [[], []];
    const pieces = [[], []];
    let kingPstMg = [0, 0], kingPstEg = [0, 0];

    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = b[s];
      if (!p) continue;
      const c = p > 0 ? 0 : 1;
      const pt = p > 0 ? p : -p;
      const att = c === 0 ? attW : attB;
      const idx = c === 0 ? IDX_W[s] : IDX_B[s];
      mat[c] += VALUES[pt];
      if (pt === KING) { kingPstMg[c] = KING_MG[idx]; kingPstEg[c] = KING_EG[idx]; }
      else pst[c] += PST[pt][idx];
      if (pt !== PAWN && pt !== KING) { npm[c] += VALUES[pt]; pieces[c].push(s); }
      if (pt === PAWN) {
        pawnFiles[c][fileOf(s)]++;
        pawns[c].push(s);
        const fwd = c === 0 ? 16 : -16;
        if (onBoard(s + fwd - 1)) att[s + fwd - 1]++;
        if (onBoard(s + fwd + 1)) att[s + fwd + 1]++;
      } else if (pt === KNIGHT || pt === KING) {
        const offs = pt === KNIGHT ? KNIGHT_OFFS : KING_OFFS;
        for (let i = 0; i < 8; i++) {
          const t = s + offs[i];
          if (!onBoard(t)) continue;
          att[t]++;
          if (pt === KNIGHT && (b[t] === 0 || (b[t] > 0) !== (p > 0))) mob[c]++;
        }
      } else {
        const offs = pt === BISHOP ? BISHOP_OFFS : pt === ROOK ? ROOK_OFFS : KING_OFFS;
        for (let i = 0; i < offs.length; i++) {
          const d = offs[i];
          for (let t = s + d; onBoard(t); t += d) {
            att[t]++;
            const tp = b[t];
            if (tp === 0) { mob[c]++; continue; }
            if ((tp > 0) !== (p > 0)) mob[c]++;
            break;
          }
        }
      }
    }

    // フェーズ: 1 = 序盤, 0 = 終盤
    const totalNpm = npm[0] + npm[1];
    const phase = Math.max(0, Math.min(1, (totalNpm - 1600) / 3400));
    for (let c = 0; c < 2; c++) pst[c] += kingPstMg[c] * phase + kingPstEg[c] * (1 - phase);

    // 王周辺への攻撃、王の盾
    const kingAtt = [0, 0], shield = [0, 0];
    for (let c = 0; c < 2; c++) {
      const ks = pos.kingSq[c];
      const enemyAtt = c === 0 ? attB : attW;
      const ownAtt = c === 0 ? attW : attB;
      let a = enemyAtt[ks] * 2;
      for (let i = 0; i < 8; i++) {
        const t = ks + KING_OFFS[i];
        if (!onBoard(t)) continue;
        a += enemyAtt[t];
        if (ownAtt[t] === 0 && enemyAtt[t] > 0) a += 1; // 守られていない隣接マス
      }
      kingAtt[1 - c] = a; // 相手が c の王を攻撃している量
      // 盾: 王の前方 2 段 x 3 列のポーン、隣接列にポーンがないと減点
      const fwd = c === 0 ? 16 : -16;
      const ownPawn = c === 0 ? PAWN : -PAWN;
      let sh = 0;
      const kf = fileOf(ks);
      for (let df = -1; df <= 1; df++) {
        const f = kf + df;
        if (f < 0 || f > 7) continue;
        const t1 = ks + fwd + df, t2 = ks + 2 * fwd + df;
        if (onBoard(t1) && b[t1] === ownPawn) sh += 2;
        else if (onBoard(t2) && b[t2] === ownPawn) sh += 1;
        if (pawnFiles[c][f] === 0) sh -= 2;
      }
      shield[c] = sh * phase;
    }

    // 浮き駒 (hanging) と脅威
    const hanging = [0, 0], threats = [0, 0];
    for (let c = 0; c < 2; c++) {
      const enemyAtt = c === 0 ? attB : attW;
      const ownAtt = c === 0 ? attW : attB;
      const enemyPawn = c === 0 ? -PAWN : PAWN;
      const fwd = c === 0 ? 16 : -16;
      const list = pieces[c].concat(pawns[c]);
      for (const s of list) {
        const v = VALUES[Math.abs(b[s])];
        if (enemyAtt[s] === 0) continue;
        let h = 0;
        if (ownAtt[s] === 0) h = v;
        else if (v > 100) {
          // 敵ポーンに当たっている駒は守られていても損
          const a1 = s + fwd - 1, a2 = s + fwd + 1;
          if ((onBoard(a1) && b[a1] === enemyPawn) || (onBoard(a2) && b[a2] === enemyPawn)) h = v - 100;
        }
        if (h > 0) {
          hanging[c] += h;
          threats[1 - c] += 1 + h / 100;
        } else if (v > 100) threats[1 - c] += 0.5;
      }
    }

    // ポーン構造
    const pawnScore = [0, 0];
    for (let c = 0; c < 2; c++) {
      const own = pawnFiles[c], opp = pawnFiles[1 - c];
      for (let f = 0; f < 8; f++) {
        if (own[f] > 1) pawnScore[c] -= 12 * (own[f] - 1);
        if (own[f] && !(f > 0 && own[f - 1]) && !(f < 7 && own[f + 1])) pawnScore[c] -= 15;
      }
      for (const s of pawns[c]) {
        const f = fileOf(s), r = rankOf(s);
        const rel = c === 0 ? r : 7 - r;
        let passed = true;
        for (let df = -1; df <= 1 && passed; df++) {
          const ff = f + df;
          if (ff < 0 || ff > 7 || !opp[ff]) continue;
          for (const os of pawns[1 - c]) {
            if (fileOf(os) !== ff) continue;
            if (c === 0 ? rankOf(os) > r : rankOf(os) < r) { passed = false; break; }
          }
        }
        if (passed) pawnScore[c] += PASSED_BONUS[rel] * (1.5 - phase * 0.5);
      }
    }

    // 中央支配・展開
    const center = [0, 0], dev = [0, 0];
    for (const s of CENTER) { center[0] += attW[s]; center[1] += attB[s]; }
    for (let c = 0; c < 2; c++) {
      const starts = MINOR_START[c === 0 ? WHITE : BLACK];
      const sign = c === 0 ? 1 : -1;
      let d = 0;
      for (const s of starts) {
        const p = b[s] * sign;
        if (p !== KNIGHT && p !== BISHOP) d += 1;
      }
      const ks = pos.kingSq[c];
      const kf = fileOf(ks), kr = rankOf(ks);
      const homeRank = c === 0 ? 0 : 7;
      if (kr === homeRank && (kf <= 2 || kf >= 6)) d += 2; // キャスリング済み相当
      else if (kr !== homeRank) d -= 1; // 序盤に王が出歩く
      dev[c] = d * phase;
    }

    return { mat, pst, mob, kingAtt, shield, hanging, threats, pawnScore, center, dev, phase, npm };
  }

  const DEFAULT_WEIGHTS = {
    material: 1, pst: 1, mobility: 2, oppMobility: 2, attack: 4, defense: 4,
    shield: 6, oppShield: 6, hanging: 0.3, oppHanging: 0.3, threats: 3, oppThreats: 3,
    pawns: 1, center: 3, development: 12, random: 0,
  };

  /** 性格の重みと視点 (me) から評価関数を作る。返す関数は手番側から見たスコアを返す。 */
  function makeEvaluator(weights, me) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const m = me === WHITE ? 0 : 1, t = 1 - m;
    return function evaluate(pos) {
      const f = features(pos);
      const stmIsMe = pos.side === me;
      // 手番側の浮き駒は逃げられるので半分に
      const hangMe = f.hanging[m] * (stmIsMe ? 0.5 : 1);
      const hangThem = f.hanging[t] * (stmIsMe ? 1 : 0.5);
      let s = w.material * (f.mat[m] - f.mat[t])
        + w.pst * (f.pst[m] - f.pst[t])
        + w.mobility * f.mob[m] - w.oppMobility * f.mob[t]
        + w.attack * f.kingAtt[m] - w.defense * f.kingAtt[t]
        + w.shield * f.shield[m] - w.oppShield * f.shield[t]
        - w.hanging * hangMe + w.oppHanging * hangThem
        + w.threats * f.threats[m] - w.oppThreats * f.threats[t]
        + w.pawns * (f.pawnScore[m] - f.pawnScore[t])
        + w.center * (f.center[m] - f.center[t])
        + w.development * (f.dev[m] - f.dev[t]);
      if (w.random) {
        const r = ((pos.h1 >>> 5) % 2001) / 1000 - 1; // -1..1 (局面ごとに固定)
        s += r * w.random;
      }
      s = Math.round(s);
      return stmIsMe ? s : -s;
    };
  }

  /**
   * 性格一覧。margin は「総合評価の最善手から何 cp までなら妥協して自分の好みを通すか」。
   */
  const PERSONALITIES = [
    {
      id: 'balanced', name: '参謀', trait: '均衡型', icon: '📐', mark: '参', color: '#3E6E9E',
      motto: '計算上、これが最善です。',
      desc: '総合的な評価関数で最善手を選ぶ。迷ったらこれ。',
      margin: 0,
      weights: {},
    },
    {
      id: 'aggressive', name: '猛将', trait: '攻撃型', icon: '🔥', mark: '猛', color: '#C24B3A',
      motto: '敵王の首を取りに行く！',
      desc: '敵王への圧力・駒の活動力を重視し、多少の損は気にしない。',
      margin: 130,
      weights: {
        material: 0.85, pst: 0.9, mobility: 3, oppMobility: 1, attack: 14, defense: 1,
        shield: 1, oppShield: 12, hanging: 0.15, oppHanging: 0.4, threats: 8, oppThreats: 1,
        pawns: 0.5, center: 3, development: 14,
      },
    },
    {
      id: 'defensive', name: '守将', trait: '防御型', icon: '🛡️', mark: '守', color: '#3C8A5A',
      motto: 'まずは守りを固めるのが肝要。',
      desc: '自王の安全と駒の連携を最優先。相手の攻め筋を先に潰す。',
      margin: 45,
      weights: {
        material: 1.1, pst: 1, mobility: 1, oppMobility: 3, attack: 1, defense: 14,
        shield: 16, oppShield: 2, hanging: 0.8, oppHanging: 0.2, threats: 1, oppThreats: 7,
        pawns: 1.5, center: 2, development: 10,
      },
    },
    {
      id: 'tricky', name: '策士', trait: '撹乱型', icon: '🌀', mark: '策', color: '#8557B3',
      motto: 'ふふ、相手を惑わせてやりましょう。',
      desc: '相手の選択肢を奪い、脅しを重ねて混乱を誘う。読みにくい手を好む。',
      margin: 150,
      weights: {
        material: 0.9, pst: 0.6, mobility: 4, oppMobility: 7, attack: 6, defense: 2,
        shield: 3, oppShield: 4, hanging: 0.2, oppHanging: 0.5, threats: 7, oppThreats: 2,
        pawns: 0.3, center: 1, development: 8, random: 30,
      },
    },
    {
      id: 'positional', name: '名将', trait: '大局型', icon: '🏔️', mark: '名', color: '#A8842A',
      motto: '大局を見よ。形が良ければ勝ちは後からついてくる。',
      desc: '駒の配置・ポーン構造・中央支配といった長期的な優位を積み上げる。',
      margin: 60,
      weights: {
        material: 1, pst: 1.6, mobility: 3, oppMobility: 2, attack: 2, defense: 3,
        shield: 8, oppShield: 4, hanging: 0.3, oppHanging: 0.3, threats: 1, oppThreats: 1,
        pawns: 2.5, center: 7, development: 18,
      },
    },
    {
      id: 'material', name: '商人', trait: '実利型', icon: '💰', mark: '商', color: '#C27A2C',
      motto: '駒は取れるときに取る。損はしない。',
      desc: '駒得を何より重視。堅実に取って、堅実に守る。',
      margin: 80,
      weights: {
        material: 1.5, pst: 0.5, mobility: 1, oppMobility: 1, attack: 1, defense: 3,
        shield: 5, oppShield: 1, hanging: 0.6, oppHanging: 0.8, threats: 2, oppThreats: 1,
        pawns: 0.8, center: 1, development: 6,
      },
    },
  ];

  const personalityById = (id) => PERSONALITIES.find((p) => p.id === id);

  return { features, makeEvaluator, PERSONALITIES, personalityById, DEFAULT_WEIGHTS, VALUES };
});
