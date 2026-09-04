/*
 * advisor.js — 軍師の進言
 *
 * 1. 総合評価 (参謀) で全候補手を採点する
 * 2. 各性格ごとに「総合評価から margin 以内の手」を候補に絞り、その性格の評価で最良の手を選ぶ
 *    → 性格が出つつ、大悪手は提示されない
 * 3. 手の特徴 (チェック・駒取り・展開…) を抽出し、性格に合わせたセリフを付ける
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chess.js'), require('./eval.js'), require('./search.js'));
  else root.Advisor = factory(root.Chess, root.Eval, root.Search);
})(typeof self !== 'undefined' ? self : this, function (Chess, Eval, Search) {
  'use strict';

  const { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, VALUES, F_CAPTURE, F_CASTLE, F_PROMO, F_EP,
    KNIGHT_OFFS, BISHOP_OFFS, ROOK_OFFS, KING_OFFS, onBoard, fileOf, rankOf, sqName } = Chess;

  const PIECE_JA = ['', 'ポーン', 'ナイト', 'ビショップ', 'ルーク', 'クイーン', 'キング'];

  /** sq にある駒 (color 側) が攻撃しているマスの一覧 */
  function attacksFrom(pos, sq) {
    const b = pos.board, p = b[sq];
    const out = [];
    const pt = Math.abs(p), color = p > 0 ? 1 : -1;
    if (pt === PAWN) {
      const fwd = 16 * color;
      for (const d of [fwd - 1, fwd + 1]) if (onBoard(sq + d)) out.push(sq + d);
    } else if (pt === KNIGHT || pt === KING) {
      const offs = pt === KNIGHT ? KNIGHT_OFFS : KING_OFFS;
      for (const d of offs) if (onBoard(sq + d)) out.push(sq + d);
    } else {
      const offs = pt === BISHOP ? BISHOP_OFFS : pt === ROOK ? ROOK_OFFS : KING_OFFS;
      for (const d of offs) {
        for (let t = sq + d; onBoard(t); t += d) { out.push(t); if (b[t]) break; }
      }
    }
    return out;
  }

  /** 静的な「浮き駒」一覧: color 側の駒で、敵に攻撃され味方に守られていないもの */
  function hangingPieces(pos, color) {
    const out = [];
    const b = pos.board;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = b[s];
      if (!p || (p > 0 ? 1 : -1) !== color || Math.abs(p) === KING) continue;
      if (pos.isAttacked(s, -color) && !pos.isAttacked(s, color)) out.push(s);
    }
    return out;
  }

  /** sq を攻撃している color 側の駒のうち最も安い駒の価値 (攻撃されていなければ Infinity) */
  function lowestAttackerValue(pos, sq, color) {
    const b = pos.board;
    let best = Infinity;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = b[s];
      if (!p || (p > 0 ? 1 : -1) !== color) continue;
      const v = VALUES[Math.abs(p)];
      if (v >= best) continue;
      if (attacksFrom(pos, s).includes(sq)) best = v;
    }
    return best;
  }

  /**
   * 手の特徴を抽出する。pos は手を指す前の局面。
   */
  function moveFeatures(pos, m) {
    const us = pos.side, them = -us;
    const b = pos.board;
    const pt = Math.abs(m.piece);
    const f = { piece: pt, pieceName: PIECE_JA[pt], to: sqName(m.to), from: sqName(m.from), tags: [] };
    const capVal = m.captured ? VALUES[Math.abs(m.captured)] : 0;
    f.capture = !!(m.flags & F_CAPTURE);
    f.capturedName = m.captured ? PIECE_JA[Math.abs(m.captured)] : '';
    f.castle = !!(m.flags & F_CASTLE);
    f.promo = !!(m.flags & F_PROMO);
    f.enPassant = !!(m.flags & F_EP);
    f.kingMove = pt === KING && !f.castle;
    f.queenMove = pt === QUEEN;
    const homeRank = us === WHITE ? 0 : 7;
    f.develop = (pt === KNIGHT || pt === BISHOP) && rankOf(m.from) === homeRank && rankOf(m.to) !== homeRank;
    f.centerPawn = pt === PAWN && [51, 52, 67, 68].includes(m.to);
    const relTo = us === WHITE ? rankOf(m.to) : 7 - rankOf(m.to);
    f.pawnStorm = pt === PAWN && relTo >= 4 && !f.capture;
    const relFrom = us === WHITE ? rankOf(m.from) : 7 - rankOf(m.from);
    f.retreat = pt !== PAWN && pt !== KING && relTo < relFrom;
    f.rookOpenFile = false;
    if (pt === ROOK) {
      let open = true;
      for (let r = 0; r < 8; r++) if (Math.abs(b[(r << 4) | fileOf(m.to)]) === PAWN) { open = false; break; }
      f.rookOpenFile = open;
    }

    // 指す前: 自陣の浮き駒
    const hangBefore = hangingPieces(pos, us);
    const destAttackedBefore = pos.isAttacked(m.to, them);

    pos.make(m);
    f.check = pos.inCheck();
    const replies = pos.legalMoves();
    f.mate = f.check && replies.length === 0;
    f.stalemate = !f.check && replies.length === 0;
    f.replies = replies.length;
    // 動かした駒からの脅威
    const targets = attacksFrom(pos, m.to);
    const threatened = [];
    for (const t of targets) {
      const tp = b[t];
      if (!tp || (tp > 0 ? 1 : -1) !== them) continue;
      const tv = VALUES[Math.abs(tp)];
      if (Math.abs(tp) === KING) continue;
      const defended = pos.isAttacked(t, them);
      if (!defended || tv > VALUES[pt]) threatened.push({ sq: t, piece: Math.abs(tp), value: tv, defended });
    }
    threatened.sort((a, b2) => b2.value - a.value);
    f.threats = threatened;
    f.fork = threatened.length >= 2 || (threatened.length >= 1 && f.check);
    f.bigThreat = threatened.length >= 1 && threatened[0].value >= 300;
    // 指した後の自陣の浮き駒
    const hangAfter = hangingPieces(pos, us);
    f.defends = hangBefore.length > 0 && hangAfter.length < hangBefore.length;
    f.escapes = hangBefore.includes(m.from) && !hangAfter.includes(m.to);
    f.leavesHanging = hangAfter.includes(m.to);
    // 犠牲 (着地マスで取られると、取り返しても損する)
    const destDefended = pos.isAttacked(m.to, us);
    let loss = 0;
    if (destAttackedBefore && pt !== KING) {
      const attacker = lowestAttackerValue(pos, m.to, them);
      loss = (destDefended ? Math.max(0, VALUES[pt] - attacker) : VALUES[pt]) - capVal;
    }
    f.sacrifice = loss >= 200 && !f.mate;
    f.offersTrade = destAttackedBefore && destDefended && !f.capture && loss < 200 && loss > -200 && pt !== KING && pt !== PAWN;
    // 守り: 王周辺への敵の攻撃数の変化を簡易に
    const ks = pos.kingSq[us === WHITE ? 0 : 1];
    let enemyNearKing = 0;
    for (const d of KING_OFFS) if (onBoard(ks + d) && pos.isAttacked(ks + d, them)) enemyNearKing++;
    f.kingPressure = enemyNearKing;
    // 相手の王に迫る (着地マスが敵王に隣接 or 2 マス以内)
    const eks = pos.kingSq[them === WHITE ? 0 : 1];
    const dist = Math.max(Math.abs(fileOf(m.to) - fileOf(eks)), Math.abs(rankOf(m.to) - rankOf(eks)));
    f.nearEnemyKing = dist <= 2 && pt !== PAWN;
    pos.unmake();

    f.goodCapture = f.capture && (capVal >= VALUES[pt] || !destAttackedBefore);
    f.trade = f.capture && capVal === VALUES[pt] && destAttackedBefore;
    f.winsMaterial = f.capture && (capVal > VALUES[pt] || !destAttackedBefore) && capVal > 0;

    // タグ (UI 用チップ)
    if (f.mate) { f.tags.push('詰み'); return f; }
    if (f.check) f.tags.push('チェック');
    if (f.winsMaterial) f.tags.push('駒得');
    else if (f.trade) f.tags.push('交換');
    else if (f.capture) f.tags.push('駒取り');
    if (f.sacrifice) f.tags.push('犠牲');
    else if (f.offersTrade) f.tags.push('交換を打診');
    if (f.promo) f.tags.push('昇格');
    if (f.castle) f.tags.push('キャスリング');
    if (f.fork) f.tags.push('両取り');
    else if (f.bigThreat) f.tags.push('脅し');
    if (f.develop) f.tags.push('展開');
    if (f.centerPawn) f.tags.push('中央');
    if (f.rookOpenFile) f.tags.push('開いた筋');
    if (f.escapes) f.tags.push('退避');
    else if (f.defends) f.tags.push('守り');
    if (f.pawnStorm) f.tags.push('ポーン前進');
    if (f.nearEnemyKing && !f.check) f.tags.push('敵王に接近');
    if (f.leavesHanging) f.tags.push('取られる駒あり');
    return f;
  }

  /** 特徴から「主題」を 1 つ決める */
  function primaryFeature(f) {
    if (f.mate) return 'mate';
    if (f.check && f.fork) return 'fork';
    if (f.sacrifice) return 'sacrifice';
    if (f.winsMaterial) return 'win';
    if (f.check) return 'check';
    if (f.fork) return 'fork';
    if (f.promo) return 'promo';
    if (f.castle) return 'castle';
    if (f.trade) return 'trade';
    if (f.escapes) return 'escape';
    if (f.bigThreat) return 'threat';
    if (f.defends) return 'defend';
    if (f.develop) return 'develop';
    if (f.centerPawn) return 'center';
    if (f.rookOpenFile) return 'openfile';
    if (f.pawnStorm) return 'push';
    if (f.nearEnemyKing) return 'approach';
    if (f.kingMove) return 'king';
    if (f.retreat) return 'retreat';
    return 'quiet';
  }

  // {san} {piece} {to} {captured} {target} が置換される
  const LINES = {
    generic: {
      mate: ['{san} で詰みです。勝負あり！'],
      fork: ['{san}。複数の駒に当たっています。'],
      sacrifice: ['{san} は駒を捨てる手ですが、見返りはあります。'],
      win: ['{san} で{captured}を取れます。'],
      check: ['{san} でチェック。相手に手を選ばせません。'],
      promo: ['{san}。昇格して大駒を増やします。'],
      castle: ['{san}。王を安全な場所へ。'],
      trade: ['{san} で駒を交換します。'],
      escape: ['{san}。狙われている駒を逃がします。'],
      threat: ['{san}。{target}を狙います。'],
      defend: ['{san}。狙われていた駒を守ります。'],
      develop: ['{san}。{piece}を展開します。'],
      center: ['{san}。中央を押さえます。'],
      openfile: ['{san}。開いた筋にルークを据えます。'],
      push: ['{san}。ポーンを前進させて圧力をかけます。'],
      approach: ['{san}。敵王の近くに駒を送り込みます。'],
      king: ['{san}。王を動かします。'],
      retreat: ['{san}。一旦引いて態勢を整えます。'],
      quiet: ['{san}。地味ですが理にかなった手です。'],
    },
    balanced: {
      mate: ['{san}。詰みです。計算に狂いはありません。'],
      win: ['{san}。{captured}を安全に取れます。損得勘定で明らかに有利です。'],
      check: ['{san} でチェック。相手の応手を限定した上で、局面を有利に運べます。'],
      develop: ['{san}。{piece}の展開。序盤の基本に忠実な手です。'],
      quiet: ['{san}。派手さはありませんが、総合評価で最も点数の高い手です。'],
      trade: ['{san}。交換して局面を整理します。バランスは崩れません。'],
      center: ['{san}。中央を確保。教科書どおりです。'],
    },
    aggressive: {
      mate: ['{san}！！ 敵王、討ち取ったり！'],
      fork: ['{san}！ 二兎を追わせて両方いただく。逃げ場はないぞ！'],
      sacrifice: ['{san}！ 駒を捨ててでも攻める。臆病者に勝利はない！'],
      win: ['{san}！ {captured}を叩き斬れ！'],
      check: ['{san} で王手！ 追い立てろ、息をつかせるな！'],
      threat: ['{san}！ {target}に狙いを定めた。さあ、どう逃げる？'],
      approach: ['{san}！ 敵の本陣に斬り込むぞ！'],
      push: ['{san}！ ポーンで敵陣を蹂躙しろ！'],
      develop: ['{san}。まずは兵を前に出す。攻撃はそれからだ！'],
      castle: ['{san}。王を片付けて、あとは攻めるだけだ！'],
      quiet: ['{san}。地味だが、次の一撃への布石だ！'],
      center: ['{san}！ 中央を制する者が戦場を制する！'],
      trade: ['{san}！ 斬り合い上等！'],
      escape: ['{san}。一度下がるが、これは助走だ。'],
      defend: ['{san}。……守るのは癪だが、ここは仕方ない。'],
    },
    defensive: {
      mate: ['{san}。詰みです。守り切った甲斐がありました。'],
      escape: ['{san}。狙われた駒はまず逃がす。基本です。'],
      defend: ['{san}。浮いた駒を守っておきましょう。備えあれば憂いなし。'],
      castle: ['{san}。王の安全が第一。城壁を築きましょう。'],
      win: ['{san}。安全に{captured}を取れます。急がば回れ、ですが取れるものは取ります。'],
      trade: ['{san}。交換して相手の攻め駒を減らしましょう。'],
      check: ['{san}。王手で時間を稼ぎ、態勢を整えます。'],
      develop: ['{san}。{piece}を出して守りの網を張ります。'],
      retreat: ['{san}。無理はしません。陣形を固めるのが先です。'],
      quiet: ['{san}。堅実に。崩れなければ負けはしません。'],
      center: ['{san}。中央を固めておけば、相手の攻めは通りません。'],
      king: ['{san}。王を安全な場所へ。'],
      threat: ['{san}。{target}を牽制しつつ、守りも保てます。'],
      push: ['{san}。ポーンで壁を作ります。'],
      sacrifice: ['{san}。……私の趣味ではありませんが、この犠牲は計算済みです。'],
      fork: ['{san}。両取りの形。守りながら得を狙えます。'],
    },
    tricky: {
      mate: ['{san}……ふふ、気づいていましたか？ 詰みですよ。'],
      fork: ['{san}。二つ同時に狙う。どちらを守っても、もう片方が落ちる。'],
      sacrifice: ['{san}。餌を撒きましょう。食いついてきたら、こちらのものです。'],
      threat: ['{san}。{target}にちょっかいを出して、相手の手を狂わせましょう。'],
      check: ['{san} で王手。相手の予定を狂わせるのが私の仕事です。'],
      approach: ['{san}。敵王のそばに駒を置いて、嫌な予感を植え付けてやります。'],
      quiet: ['{san}。一見無意味な手。だからこそ相手は読めない。'],
      push: ['{san}。ポーンを突いて陣形を乱す。相手はきっと嫌がりますよ。'],
      develop: ['{san}。駒を出しつつ、相手の選択肢を狭めます。'],
      win: ['{san}。{captured}をいただきましょう。相手が気づく前に。'],
      trade: ['{san}。交換に見せかけて、相手の陣形を崩します。'],
      retreat: ['{san}。引くと見せかけて……ここからが本番です。'],
      escape: ['{san}。逃げるついでに、次の罠を仕掛けておきます。'],
      center: ['{san}。中央で相手の駒を窮屈にさせましょう。'],
      castle: ['{san}。まずは自陣を整えて、それから仕掛けましょう。'],
      defend: ['{san}。守りつつ、相手に見えない伏線を張ります。'],
    },
    positional: {
      mate: ['{san}。詰みです。積み重ねた形の勝利です。'],
      develop: ['{san}。{piece}を良い位置に。駒の配置こそ勝利の礎です。'],
      center: ['{san}。中央を制する。すべてはここから始まります。'],
      castle: ['{san}。王を収め、ルークを連結する。理想の形です。'],
      openfile: ['{san}。開いた筋にルークを据えます。長期的な優位です。'],
      push: ['{san}。ポーンで空間を稼ぎます。相手は窮屈になるでしょう。'],
      quiet: ['{san}。地味ですが、駒の配置が改善されます。形の良さは裏切りません。'],
      win: ['{san}。{captured}を取ります。形を崩さずに得ができるなら、断る理由はありません。'],
      trade: ['{san}。交換して、こちらの駒配置の良さを際立たせます。'],
      retreat: ['{san}。再配置です。良い駒はもっと良い場所へ。'],
      escape: ['{san}。駒を逃がしつつ、より良い位置に置き直します。'],
      defend: ['{san}。駒の連携を保ちます。孤立した駒は弱いものです。'],
      check: ['{san}。王手をかけて、相手の王を悪い位置に追いやります。'],
      threat: ['{san}。{target}を圧迫し、相手の形を崩します。'],
      sacrifice: ['{san}。駒を捨てても、形の優位がそれを補います。'],
      fork: ['{san}。良い配置は自然と戦術を生むものです。'],
      approach: ['{san}。駒を敵陣に据え、じわじわと締め上げます。'],
    },
    material: {
      mate: ['{san}。詰みだ。勝ちは何より高く売れる。'],
      win: ['{san}！ {captured}はタダ同然。取らない手はない！'],
      trade: ['{san}。等価交換だ。損はしていない。'],
      escape: ['{san}。大事な駒だ。取られてたまるか。'],
      defend: ['{san}。駒を守る。損失はゼロに抑えるのが商売の鉄則。'],
      promo: ['{san}。ポーンがクイーンに化ける。最高の投資だ！'],
      quiet: ['{san}。今は取れる駒がない。損をしない手を選ぶ。'],
      check: ['{san}。王手だが、狙いはその先の駒だ。'],
      threat: ['{san}。{target}を狙う。次で回収する。'],
      fork: ['{san}。両取り。どちらかは必ずいただく。'],
      develop: ['{san}。駒を働かせる。遊んでいる駒は損だ。'],
      castle: ['{san}。王が安全なら、安心して稼げる。'],
      center: ['{san}。中央は良い商売の場だ。'],
      push: ['{san}。ポーンを進めておけば、いずれ元が取れる。'],
      sacrifice: ['{san}。……先行投資だ。ちゃんと回収できる見込みがある。'],
      retreat: ['{san}。損切りも大事だ。'],
      approach: ['{san}。敵王の近くには稼ぎの種が転がっている。'],
    },
  };

  function fillTemplate(t, f, san) {
    return t.replace('{san}', san)
      .replace('{piece}', f.pieceName)
      .replace('{to}', f.to)
      .replace('{captured}', f.capturedName || '駒')
      .replace('{target}', f.threats && f.threats.length ? PIECE_JA[f.threats[0].piece] : '駒');
  }

  function comment(personality, f, san) {
    const key = primaryFeature(f);
    const table = LINES[personality.id] || {};
    const pool = table[key] || LINES.generic[key] || LINES.generic.quiet;
    const t = pool[Math.floor(Math.random() * pool.length)];
    return fillTemplate(t, f, san);
  }

  // ---------- 理論解説 ----------
  const FILES = 'abcdefgh';
  const CENTER_SQ = [51, 52, 67, 68];
  const at = (sq, piece) => `${sqName(sq)}の${PIECE_JA[Math.abs(piece)]}`;
  const sqIndexList = () => { const a = []; for (let s = 0; s < 128; s++) if (!(s & 0x88)) a.push(s); return a; };
  const ALL_SQ = sqIndexList();

  /** 移動後の駒によるピン: [{pinned, behind, absolute}] */
  function findPins(pos, sq) {
    const b = pos.board, p = b[sq], pt = Math.abs(p), color = p > 0 ? 1 : -1;
    if (pt !== BISHOP && pt !== ROOK && pt !== QUEEN) return [];
    const offs = pt === BISHOP ? BISHOP_OFFS : pt === ROOK ? ROOK_OFFS : KING_OFFS;
    const out = [];
    for (const d of offs) {
      let first = -1;
      for (let t = sq + d; onBoard(t); t += d) {
        const tp = b[t];
        if (!tp) continue;
        if ((tp > 0 ? 1 : -1) === color) break;
        if (first < 0) { first = t; if (Math.abs(tp) === KING) break; continue; }
        const fv = VALUES[Math.abs(b[first])], bv = VALUES[Math.abs(tp)];
        if (Math.abs(tp) === KING) out.push({ pinned: first, behind: t, absolute: true });
        else if (bv > fv) out.push({ pinned: first, behind: t, absolute: false });
        break;
      }
    }
    return out;
  }

  /** 移動によって開いた味方スライダーの攻撃 (ディスカバード) */
  function findDiscovered(pos, m) {
    const b = pos.board, us = -pos.side; // 指した後の局面で呼ぶ
    const out = [];
    for (const s of ALL_SQ) {
      const p = b[s];
      if (!p || (p > 0 ? 1 : -1) !== us || s === m.to) continue;
      const pt = Math.abs(p);
      if (pt !== BISHOP && pt !== ROOK && pt !== QUEEN) continue;
      const offs = pt === BISHOP ? BISHOP_OFFS : pt === ROOK ? ROOK_OFFS : KING_OFFS;
      for (const d of offs) {
        let passedFrom = false;
        for (let t = s + d; onBoard(t); t += d) {
          if (t === m.from) { passedFrom = true; continue; }
          const tp = b[t];
          if (!tp) continue;
          if (passedFrom && (tp > 0 ? 1 : -1) !== us && (VALUES[Math.abs(tp)] >= 300 || Math.abs(tp) === KING)) out.push({ from: s, target: t, check: Math.abs(tp) === KING });
          break;
        }
      }
    }
    return out;
  }

  function isOutpost(pos, sq, color) {
    const b = pos.board;
    const rel = color === WHITE ? rankOf(sq) : 7 - rankOf(sq);
    if (rel < 4) return false;
    const back = -16 * color, ownPawn = PAWN * color, enemyPawn = -PAWN * color;
    const guarded = (onBoard(sq + back - 1) && b[sq + back - 1] === ownPawn) || (onBoard(sq + back + 1) && b[sq + back + 1] === ownPawn);
    if (!guarded) return false;
    const f = fileOf(sq);
    for (const s of ALL_SQ) {
      if (b[s] !== enemyPawn || Math.abs(fileOf(s) - f) !== 1) continue;
      if (color === WHITE ? rankOf(s) > rankOf(sq) : rankOf(s) < rankOf(sq)) return false;
    }
    return true;
  }

  function scorePhrase(score) {
    if (Search.isMateScore(score)) return score > 0 ? '詰みまで読み切っています' : '相手に詰み筋があります';
    const a = Math.abs(score);
    if (a <= 30) return '互角';
    const w = a <= 100 ? 'やや' : a <= 300 ? '' : '大きく';
    return score > 0 ? `${w}有利` : `${w}不利`;
  }

  /**
   * チェス理論に基づく解説文を作る。pos は指す前の局面。
   * ctx: { pv, score, best, rank, bestSan, pvText }
   */
  function explain(pos, m, f, ctx) {
    const us = pos.side, them = -us;
    const b = pos.board;
    const pt = Math.abs(m.piece);
    const feat = Eval.features(pos);
    const mi = us === WHITE ? 0 : 1;
    const matDiff = feat.mat[mi] - feat.mat[1 - mi];
    const phase = feat.phase;
    const opening = phase > 0.8 && pos.fullmove <= 12;
    const endgame = phase < 0.35;
    const capVal = m.captured ? VALUES[Math.abs(m.captured)] : 0;
    const relTo = us === WHITE ? rankOf(m.to) : 7 - rankOf(m.to);
    const S = [], C = [];
    const targetName = (t) => at(t.sq, t.piece);
    const threatNames = f.threats.slice(0, 2).map(targetName).join('と');

    // --- 指した後の局面で分かること ---
    pos.make(m);
    const pins = findPins(pos, m.to).filter((x) => Math.abs(b[x.pinned]) !== PAWN || x.absolute);
    const disc = findDiscovered(pos, m);
    const outpost = (pt === KNIGHT || pt === BISHOP) && isOutpost(pos, m.to, us);
    const hangAfter = hangingPieces(pos, us).filter((s) => s !== m.to);
    const oppCastled = (() => { const k = pos.kingSq[them === WHITE ? 0 : 1]; const home = them === WHITE ? 0 : 7; return rankOf(k) === home && (fileOf(k) <= 2 || fileOf(k) >= 6); })();
    const knightEyes = pt === KNIGHT ? attacksFrom(pos, m.to).filter((s) => CENTER_SQ.includes(s) || (fileOf(s) >= 2 && fileOf(s) <= 5 && (us === WHITE ? rankOf(s) >= 3 : rankOf(s) <= 4))).slice(0, 3).map(sqName) : [];
    const pawnKicks = pt === PAWN ? attacksFrom(pos, m.to).filter((s) => b[s] && (b[s] > 0 ? 1 : -1) === them && Math.abs(b[s]) !== PAWN && Math.abs(b[s]) !== KING) : [];
    let passed = false;
    if (pt === PAWN) {
      passed = true;
      for (const s of ALL_SQ) {
        if (b[s] !== -PAWN * us || Math.abs(fileOf(s) - fileOf(m.to)) > 1) continue;
        if (us === WHITE ? rankOf(s) > rankOf(m.to) : rankOf(s) < rankOf(m.to)) { passed = false; break; }
      }
    }
    pos.unmake();

    // 直前に同じ駒を動かしたか
    const hist = pos.history;
    const samePieceAgain = hist.length >= 2 && hist[hist.length - 2].m.to === m.from;
    const kingFile = fileOf(pos.kingSq[mi]);
    const shieldPawn = pt === PAWN && Math.abs(fileOf(m.from) - kingFile) <= 1 && (kingFile <= 2 || kingFile >= 5) &&
      rankOf(m.from) === (us === WHITE ? 1 : 6) && !f.capture;
    const inCheckNow = pos.inCheck();
    const promoName = m.promo ? PIECE_JA[m.promo] : '';

    // --- 主題 ---
    if (f.mate) {
      S.push(`${ctx.san} はチェックメイトです。相手の王には逃げ場も合駒もありません。`);
    } else if (inCheckNow) {
      if (f.capture) S.push(`チェックをかけている${f.capturedName}を取り除いて王手を解消します。取れるなら取るのが最も手損のない対処です。`);
      else if (pt === KING) {
        S.push(`王を動かして王手を避けます。`);
        if (opening && !f.castle && rankOf(m.from) === (us === WHITE ? 0 : 7)) C.push(`王が動くとキャスリング権を失うので、後で王の安全を確保する手段が減ります。`);
      } else {
        S.push(`合駒でチェックを防ぎます。合駒は後でピンされやすいので、その駒が安全かどうかが要点です。`);
        if (f.threats.length) S.push(`しかも合駒が${targetName(f.threats[0])}に当たるので、相手に手を渡さずテンポを稼げます。`);
      }
    } else if (f.check && f.fork && f.threats.length) {
      S.push(`王手をかけつつ${threatNames}にも当てる両取りです。相手は王手を先に対処しなければならないので、次に${targetName(f.threats[0])}が取れます。`);
    } else if (f.fork && f.threats.length >= 2) {
      S.push(`${f.pieceName}が${threatNames}を同時に攻撃する両取りです。相手が片方を守ればもう片方を取れます。`);
    } else if (f.sacrifice) {
      const why = f.check ? '王を引きずり出し' : f.threats.length ? `${targetName(f.threats[0])}への攻撃を作り` : '敵陣を破って';
      S.push(`駒を捨てる手です。${f.pieceName}を犠牲にして${why}、相手の守りを崩します。`);
      S.push(ctx.score >= 0 ? `参謀の計算では犠牲に見合う見返りがあり、形勢は${ctx.scoreText}です。` : `見返りは限定的で、形勢は${ctx.scoreText}。実戦的な勝負手と考えてください。`);
    } else if (f.winsMaterial) {
      const free = !pos.isAttacked(m.to, them);
      if (free) S.push(`${f.capturedName}をただで取れます。取り返しはありません。`);
      else S.push(`${f.capturedName}を取ります。取り返されても${f.pieceName}と${f.capturedName}の交換で約${((capVal - VALUES[pt]) / 100).toFixed(0)}ポーン分の駒得です。`);
      if (matDiff + capVal >= 300) S.push(`駒得したあとは交換で局面を単純化し、終盤で数の優位を活かすのが定石です。`);
    } else if (f.check) {
      S.push(`チェックです。相手は王を守る手に限られるので、主導権（イニシアチブ）を保てます。`);
      if (f.develop) S.push(`展開しながらの王手なのでテンポも稼げます。`);
    } else if (f.promo) {
      S.push(`ポーンが${promoName}に昇格します。昇格はパスポーンを押し進めた最終目標で、局面の駒価値が一気に変わります。`);
    } else if (f.castle) {
      S.push(`キャスリングで王を隅の安全圏に移し、ルークを中央の筋に近づけます。序盤の三原則（展開・中央・王の安全）のうち、王の安全を確保する手です。`);
      if (!oppCastled) S.push(`相手はまだキャスリングしていないので、先に王を安全にしておく価値は大きいです。`);
    } else if (f.trade) {
      S.push(`${f.pieceName}と${f.capturedName}の等価交換です。`);
      if (matDiff >= 200) S.push(`駒得している側は交換で局面を単純化するのが定石で、優位を確実にします。`);
      else if (matDiff <= -200) C.push(`駒損している側の交換は相手の優位を固めやすいので、通常は避けたい選択です。`);
      else S.push(`攻めに使える相手の駒を減らし、局面を整理する意味があります。`);
    } else if (f.escapes) {
      S.push(`攻撃されている${f.pieceName}を安全な${f.to}へ逃がします。`);
      if (f.threats.length) S.push(`逃げながら${targetName(f.threats[0])}に当てるので、手損になりません。`);
    } else if (f.defends) {
      S.push(`浮いていた駒を守ります。守られていない駒は戦術の標的になるため、まず駒同士の連携を回復します。`);
    } else if (f.bigThreat && f.threats.length) {
      S.push(`${targetName(f.threats[0])}を狙います。相手は対応を迫られるので、テンポを稼ぎながら駒を良い位置に置けます。`);
    } else if (f.develop) {
      if (pt === KNIGHT) S.push(`ナイトを${f.to}に展開します。ナイトは縁より中央寄りが強く、${f.to}からは${knightEyes.length ? knightEyes.join('・') + 'など' : ''}中央のマスを睨みます。`);
      else if (['g2', 'b2', 'g7', 'b7'].includes(f.to)) S.push(`フィアンケットです。ビショップを長い対角線に据え、中央を遠くから支配します。`);
      else S.push(`ビショップを${f.to}に展開し、対角線を通します。`);
      if (opening) S.push(`序盤は中央ポーンを突いたらマイナーピースを早く展開し、キャスリングにつなげるのが原則です。`);
    } else if (f.centerPawn) {
      S.push(`${f.to}に中央ポーンを進めます。中央のポーンは空間を稼ぎ、ビショップやクイーンの通り道を開き、相手の駒の活動範囲を狭めます。`);
    } else if (f.rookOpenFile) {
      S.push(`開いた${FILES[fileOf(m.to)]}筋にルークを置きます。ルークは開いた筋で最大の力を発揮し、相手陣への侵入路になります。`);
    } else if (pt === ROOK && relTo === 6) {
      S.push(`7段目にルークを侵入させます。7段目のルークは相手のポーンを横から攻撃し、王を後ろの段に閉じ込める強力な配置です。`);
    } else if (f.pawnStorm) {
      if (pawnKicks.length) S.push(`ポーンを突いて${at(pawnKicks[0], b[pawnKicks[0]])}を追い払います。ポーンで駒を追うのは最も安上がりなテンポ稼ぎです。`);
      else if (passed) S.push(`パスポーン（前方と両隣の筋に相手のポーンがいないポーン）を押し進めます。パスポーンは進むほど価値が上がり、相手の駒を守りに縛りつけます。`);
      else S.push(`ポーンを進めて空間を稼ぎます。空間の優位は駒の機動力の差につながります。`);
    } else if (f.nearEnemyKing) {
      S.push(`敵王の近くに駒を送り込み、攻撃に参加する駒を増やします。王への攻撃は守りの駒より多い数で行うのが原則です。`);
    } else if (pt === KING) {
      if (endgame) S.push(`終盤では王も戦力です。王を中央へ向かわせ、自分のポーンの支援と相手ポーンの阻止に働かせます。`);
      else { S.push(`王を動かします。`); C.push(`中盤の王の移動は守りの陣形を崩しがちなので、必要最小限にとどめます。`); }
    } else if (pt === QUEEN && opening && !f.capture) {
      S.push(`クイーンを動かします。`);
      C.push(`序盤の早いクイーンの繰り出しは、相手の展開の手で追われてテンポを失いやすく、原則には反します。`);
    } else if (f.retreat) {
      S.push(`一度引いて${f.pieceName}を再配置します。働きの悪い駒を良いマスに置き直すのは中盤の重要な技術です。`);
    } else if (pt === PAWN) {
      S.push(`ポーンを${f.to}に進めます。ポーンは戻れないので、マスの弱体化と空間の獲得を天秤にかける手です。`);
    } else {
      S.push(`${f.pieceName}を${f.to}へ。駒の働きを高める静かな手です。`);
    }

    // --- 戦術的な補足 ---
    if (pins.length) {
      const x = pins[0];
      S.push(x.absolute
        ? `同時に${at(x.pinned, b[x.pinned])}を王にピン（釘付け）します。ピンされた駒は動けないため事実上働きが止まります。`
        : `同時に${at(x.pinned, b[x.pinned])}を${at(x.behind, b[x.behind])}にピンします。動けば後ろの駒を失うので、相手はその駒を使えません。`);
    }
    if (disc.length) {
      const x = disc[0];
      S.push(x.check
        ? `${f.from}から退くことで${at(x.from, b[x.from])}の利きが通り、ディスカバードチェックになります。`
        : `${f.from}から退くことで${at(x.from, b[x.from])}が${at(x.target, b[x.target])}に当たる、ディスカバードアタックでもあります。`);
    }
    if (outpost) S.push(`${f.to}はアウトポスト（相手のポーンで追い払えず、味方ポーンに守られた前進拠点）で、${f.pieceName}は長く居座れます。`);
    if (!f.develop && !f.mate && opening && pt !== PAWN && pt !== KING && samePieceAgain && !f.capture && !f.check) {
      C.push(`序盤で同じ駒を続けて動かしており、展開が遅れる点は理論上のマイナスです。`);
    }
    if (shieldPawn && !endgame) C.push(`王の前のポーンを動かすので、王の守りがやや薄くなります。`);
    if (f.leavesHanging) C.push(`指した後の${f.pieceName}は守られていないので、次の相手の手を確認しておく必要があります。`);
    else if (hangAfter.length) C.push(`なお${at(hangAfter[0], b[hangAfter[0]])}が浮いたままなので注意が必要です。`);

    // --- 評価と読み筋 ---
    const diff = ctx.best - ctx.score;
    let ev = `参謀の総合評価は${ctx.scoreText}（${scorePhrase(ctx.score)}）`;
    ev += ctx.rank === 1 ? 'で、候補の中で最善です。' : diff < 10 ? `で、最善の ${ctx.bestSan} とほぼ同評価です。` : `。最善の ${ctx.bestSan} との差は約${(diff / 100).toFixed(1)}ポーンです。`;
    S.push(ev);
    if (f.mate) C.length = 0;
    if (ctx.pvText && ctx.pvText.indexOf(' ') > 0) S.push(`予想手順は ${ctx.pvText}。`);

    return { main: S.join(''), cautions: C.join('') };
  }

  function formatScore(score) {
    if (Search.isMateScore(score)) {
      const n = Search.mateIn(score);
      return n > 0 ? `詰み ${n} 手` : `被詰み ${-n} 手`;
    }
    const p = score / 100;
    return (p > 0 ? '+' : '') + p.toFixed(1);
  }

  /**
   * 軍師の進言を作る。
   * opts: { depth, personalities, shouldAbort, onProgress }
   * 戻り値: { cards: [...], neutral: [...], bestScore }
   */
  async function advise(pos, opts) {
    opts = opts || {};
    const depth = opts.depth || 3;
    const personalities = opts.personalities || Eval.PERSONALITIES;
    const me = pos.side;
    const abort = opts.shouldAbort || (() => false);
    const progress = opts.onProgress || (() => {});
    const legal = pos.legalMoves();
    if (legal.length === 0) return { cards: [], neutral: [], bestScore: 0 };

    progress('参謀が全候補を採点中…');
    const balanced = Eval.personalityById('balanced');
    const neutral = await Search.rankMoves(pos, Eval.makeEvaluator(balanced.weights, me), depth, { shouldAbort: abort });
    if (!neutral) return null;
    const best = neutral[0].score;
    const neutralScore = new Map(neutral.map((r) => [r.move.enc, r]));

    const picks = [];
    const used = new Set();
    // 参謀 (総合最善) を先に確定させ、他の性格は重複時に別案を出せるようにする
    const ordered = personalities.slice().sort((a, b) => (a.id === 'balanced' ? -1 : b.id === 'balanced' ? 1 : 0));
    for (const p of ordered) {
      if (abort()) return null;
      let pick, alt = null;
      if (p.id === 'balanced' || legal.length === 1) {
        pick = neutral[0];
      } else {
        progress(`${p.name}(${p.trait})が検討中…`);
        let cands;
        if (Search.isMateScore(best) && best > 0) {
          cands = neutral.filter((r) => r.score === best);
        } else {
          cands = neutral.filter((r) => r.score >= best - p.margin && !(Search.isMateScore(r.score) && r.score < 0));
          if (cands.length < 3) cands = neutral.slice(0, 3);
        }
        cands = cands.slice(0, 12);
        if (cands.length === 1) pick = cands[0];
        else {
          const ranked = await Search.rankMoves(pos, Eval.makeEvaluator(p.weights, me), depth, {
            moves: cands.map((c) => c.move.enc), shouldAbort: abort,
          });
          if (!ranked) return null;
          pick = ranked[0];
          // 本命が他の軍師と同じなら、その性格にとって僅差の別案を出す
          if (used.has(pick.move.enc)) {
            const other = ranked.slice(1).find((r) => !used.has(r.move.enc) && pick.score - r.score <= p.margin * 0.6);
            if (other) { alt = pick; pick = other; }
          }
        }
      }
      used.add(pick.move.enc);
      picks.push({ personality: p, move: pick.move, pv: pick.pv, neutral: neutralScore.get(pick.move.enc), alt });
    }
    // 表示順は性格定義の順に戻す
    picks.sort((a, b) => personalities.indexOf(a.personality) - personalities.indexOf(b.personality));

    // 同じ手を推す性格はまとめる
    const cards = [];
    const byMove = new Map();
    for (const pk of picks) {
      let card = byMove.get(pk.move.enc);
      if (!card) {
        const f = moveFeatures(pos, pk.move);
        const san = pos.san(pk.move, legal);
        card = {
          move: pk.move, san, enc: pk.move.enc, features: f, tags: f.tags,
          personalities: [], score: pk.neutral.score, scoreText: formatScore(pk.neutral.score),
          pv: pk.pv, pvText: pvToSan(pos, pk.pv), comment: '', rank: neutral.findIndex((r) => r.move.enc === pk.move.enc) + 1,
          altOf: pk.alt ? pos.san(pk.alt.move, legal) : null,
        };
        byMove.set(pk.move.enc, card);
        cards.push(card);
      }
      card.personalities.push(pk.personality);
    }
    const bestSan = pos.san(neutral[0].move, legal);
    for (const c of cards) {
      c.comment = comment(c.personalities[0], c.features, c.san);
      if (c.altOf) c.note = `${c.altOf} も良いが、別案として。`;
      const ex = explain(pos, c.move, c.features, { san: c.san, pv: c.pv, pvText: c.pvText, score: c.score, scoreText: c.scoreText, best, bestSan, rank: c.rank });
      c.explain = ex.main;
      c.cautions = ex.cautions;
    }
    return { cards, neutral, bestScore: best, side: me };
  }

  function pvToSan(pos, pv) {
    const p = pos.clone();
    const out = [];
    for (const m of pv) {
      const legal = p.legalMoves();
      const real = legal.find((x) => x.enc === m.enc);
      if (!real) break;
      out.push(p.san(real, legal));
      p.make(real);
    }
    return out.join(' ');
  }

  return { advise, moveFeatures, primaryFeature, comment, explain, formatScore, pvToSan };
});
