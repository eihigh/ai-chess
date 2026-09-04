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
    for (const c of cards) {
      c.comment = comment(c.personalities[0], c.features, c.san);
      if (c.altOf) c.note = `${c.altOf} も良いが、別案として。`;
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

  return { advise, moveFeatures, primaryFeature, comment, formatScore, pvToSan };
});
