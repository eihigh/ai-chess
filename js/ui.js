/* ui.js — 盤面・進言カード・対局進行 */
(function () {
  'use strict';
  const { Position, WHITE, BLACK, PAWN, KING, F_CAPTURE, F_PROMO, sqName, fileOf, rankOf } = Chess;
  const GLYPH = ['', '♟', '♞', '♝', '♜', '♛', '♚'];
  const PIECE_JA = ['', 'ポーン', 'ナイト', 'ビショップ', 'ルーク', 'クイーン', 'キング'];
  const LEVELS = [
    { name: '入門', depth: 2, timeMs: 400, random: 60 },
    { name: '初級', depth: 3, timeMs: 800, random: 25 },
    { name: '中級', depth: 4, timeMs: 1500, random: 8 },
    { name: '上級', depth: 6, timeMs: 3000, random: 0 },
    { name: '達人', depth: 9, timeMs: 7000, random: 0 },
  ];

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'), arrows: $('arrows'), status: $('status'), cards: $('cards'),
    adviceStatus: $('advice-status'), movelist: $('movelist'), evalFill: $('eval-fill'), evalText: $('eval-text'),
    opponentLine: $('opponent-line'), undo: $('undo'), flip: $('flip'), resign: $('resign'), newGame: $('new-game'),
    colorSelect: $('color-select'), levelSelect: $('level-select'), oppSelect: $('opp-select'),
    adviceDepth: $('advice-depth'), promo: $('promo-dialog'), roster: $('roster'), showExplain: $('show-explain'),
  };

  const state = {
    pos: new Position(), playerColor: WHITE, flipped: false, sans: [],
    busy: false, over: false, token: 0, selected: null, legal: [], lastMove: null,
    advice: null, oppPersonality: null, level: LEVELS[2], adviceDepth: 3, hotEnc: null,
  };

  // ---------- 設定 ----------
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('gunshi-chess-settings') || '{}');
      if (s.color) el.colorSelect.value = s.color;
      if (s.level) el.levelSelect.value = s.level;
      if (s.opp) el.oppSelect.value = s.opp;
      if (s.adviceDepth) el.adviceDepth.value = s.adviceDepth;
      if (typeof s.explain === 'boolean') el.showExplain.checked = s.explain;
    } catch (e) { /* ignore */ }
  }
  function saveSettings() {
    try {
      localStorage.setItem('gunshi-chess-settings', JSON.stringify({
        color: el.colorSelect.value, level: el.levelSelect.value, opp: el.oppSelect.value, adviceDepth: el.adviceDepth.value,
        explain: el.showExplain.checked,
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------- 盤描画 ----------
  function buildBoard() {
    el.board.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'square';
      d.addEventListener('click', () => onSquareClick(+d.dataset.sq));
      el.board.appendChild(d);
    }
  }

  function displayToSq(i) {
    let r = 7 - Math.floor(i / 8), f = i % 8;
    if (state.flipped) { r = 7 - r; f = 7 - f; }
    return (r << 4) | f;
  }

  function render() {
    const pos = state.pos;
    const check = !state.over && pos.inCheck();
    const kingSq = pos.kingSq[pos.side === WHITE ? 0 : 1];
    const targets = new Map(state.legal.map((m) => [m.to, m]));
    const squares = el.board.children;
    for (let i = 0; i < 64; i++) {
      const sq = displayToSq(i);
      const d = squares[i];
      d.dataset.sq = sq;
      const light = (fileOf(sq) + rankOf(sq)) % 2 === 1;
      let cls = 'square ' + (light ? 'light' : 'dark');
      if (state.lastMove && (sq === state.lastMove.from || sq === state.lastMove.to)) cls += ' last';
      if (state.selected === sq) cls += ' selected';
      if (targets.has(sq)) cls += ' target' + (targets.get(sq).flags & F_CAPTURE ? ' capture' : '');
      if (check && sq === kingSq) cls += ' check';
      d.className = cls;
      const p = pos.board[sq];
      let html = '';
      if (p) html += `<span class="piece ${p > 0 ? 'w' : 'b'}">${GLYPH[Math.abs(p)]}</span>`;
      const bottomRow = i >= 56, leftCol = i % 8 === 0;
      if (bottomRow) html += `<span class="coord file">${'abcdefgh'[fileOf(sq)]}</span>`;
      if (leftCol) html += `<span class="coord rank">${rankOf(sq) + 1}</span>`;
      d.innerHTML = html;
    }
    renderArrows();
    renderMoveList();
    el.undo.disabled = state.busy || state.pos.history.length === 0;
    el.resign.disabled = state.over || state.busy;
  }

  function sqCenter(sq) {
    let x = fileOf(sq), y = 7 - rankOf(sq);
    if (state.flipped) { x = 7 - x; y = 7 - y; }
    return [x + 0.5, y + 0.5];
  }

  function renderArrows() {
    const svg = el.arrows;
    svg.innerHTML = '';
    if (!state.advice || state.over) return;
    for (const card of state.advice.cards) {
      const [x1, y1] = sqCenter(card.move.from);
      const [x2, y2] = sqCenter(card.move.to);
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;
      const head = 0.38, w = 0.14;
      const bx = x2 - ux * head, by = y2 - uy * head;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'arrow' + (state.hotEnc === card.enc ? ' hot' : ''));
      const color = card.personalities[0].color;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', bx); line.setAttribute('y2', by);
      line.setAttribute('stroke', color); line.setAttribute('stroke-width', w); line.setAttribute('stroke-linecap', 'round');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      const px = -uy, py = ux;
      poly.setAttribute('points', `${x2},${y2} ${bx + px * 0.22},${by + py * 0.22} ${bx - px * 0.22},${by - py * 0.22}`);
      poly.setAttribute('fill', color);
      g.appendChild(line); g.appendChild(poly);
      svg.appendChild(g);
    }
  }

  function renderMoveList() {
    el.movelist.innerHTML = '';
    for (let i = 0; i < state.sans.length; i += 2) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${state.sans[i]}</span><span>${state.sans[i + 1] || ''}</span>`;
      el.movelist.appendChild(li);
    }
    el.movelist.scrollTop = el.movelist.scrollHeight;
  }

  function setStatus(text, cls) {
    el.status.textContent = text;
    el.status.className = 'status' + (cls ? ' ' + cls : '');
  }

  function setEval(scoreForSide, side) {
    const white = side === WHITE ? scoreForSide : -scoreForSide;
    let pct;
    if (Search.isMateScore(white)) pct = white > 0 ? 100 : 0;
    else pct = 100 / (1 + Math.exp(-white / 350));
    el.evalFill.style.width = pct + '%';
    el.evalText.textContent = Search.isMateScore(white)
      ? (white > 0 ? '白詰み' : '黒詰み')
      : (white >= 0 ? '+' : '') + (white / 100).toFixed(1);
  }

  // ---------- 進言カード ----------
  function renderCards() {
    el.cards.innerHTML = '';
    if (!state.advice) return;
    for (const card of state.advice.cards) {
      const lead = card.personalities[0];
      const others = card.personalities.slice(1);
      const div = document.createElement('div');
      div.className = 'card' + (state.over || state.busy ? ' disabled' : '');
      const scoreCls = Search.isMateScore(card.score) ? (card.score > 0 ? 'good' : 'bad') : card.score > 50 ? 'good' : card.score < -50 ? 'bad' : '';
      div.innerHTML = `
        <div class="card-head">
          <span class="mark" style="background:${lead.color}">${lead.mark}</span>
          <span class="name">${lead.name}</span>
          <span class="trait" style="color:${lead.color}">${lead.trait}</span>
          ${others.length ? `<span class="also">${others.map((p) => p.name).join('・')} も賛成</span>` : ''}
        </div>
        <div class="card-move"><span class="san">${card.san}</span><span class="score ${scoreCls}">形勢 ${card.scoreText}</span></div>
        <div class="card-comment">「${card.comment}」</div>
        ${card.note ? `<div class="card-note">※ ${card.note}</div>` : ''}
        ${el.showExplain.checked ? `<div class="card-explain"><span class="label">解説</span>${card.explain}${card.cautions ? `<span class="caution">${card.cautions}</span>` : ''}</div>` : ''}
        <div class="chips">${card.tags.map((t) => `<span class="chip${t === '取られる駒あり' ? ' warn' : ''}">${t}</span>`).join('')}</div>
        <div class="pv">読み筋: ${card.pvText}</div>`;
      div.addEventListener('mouseenter', () => { state.hotEnc = card.enc; renderArrows(); });
      div.addEventListener('mouseleave', () => { state.hotEnc = null; renderArrows(); });
      div.addEventListener('click', () => { if (!state.busy && !state.over) playerMove(card.move); });
      el.cards.appendChild(div);
    }
  }

  function setAdviceStatus(text, spinning) {
    el.adviceStatus.innerHTML = (spinning ? '<span class="spinner"></span>' : '') + text;
  }

  async function startAdvice() {
    const token = ++state.token;
    state.advice = null;
    renderCards(); renderArrows();
    if (state.over || state.pos.side !== state.playerColor) { setAdviceStatus(''); return; }
    setAdviceStatus('軍師たちが検討中…', true);
    const t0 = performance.now();
    const res = await Advisor.advise(state.pos, {
      depth: state.adviceDepth,
      shouldAbort: () => token !== state.token,
      onProgress: (msg) => { if (token === state.token) setAdviceStatus(msg, true); },
    });
    if (token !== state.token || !res) return;
    state.advice = res;
    setEval(res.bestScore, res.side);
    setAdviceStatus(`検討完了（${((performance.now() - t0) / 1000).toFixed(1)}秒）。${res.cards.length} 案あります。`);
    renderCards(); renderArrows();
  }

  // ---------- 対局進行 ----------
  function applyMove(m) {
    const legal = state.pos.legalMoves();
    const san = state.pos.san(m, legal);
    state.pos.make(m);
    state.sans.push(san);
    state.lastMove = m;
    state.selected = null; state.legal = [];
    return san;
  }

  function checkGameOver() {
    const st = state.pos.status();
    if (!st.over) return false;
    state.over = true;
    state.token++;
    state.advice = null;
    let msg;
    const playerWon = (st.result === '1-0' && state.playerColor === WHITE) || (st.result === '0-1' && state.playerColor === BLACK);
    if (st.reason === 'checkmate') msg = playerWon ? 'チェックメイト！ あなたの勝ちです。' : 'チェックメイト……あなたの負けです。';
    else if (st.reason === 'stalemate') msg = 'ステイルメイト。引き分けです。';
    else if (st.reason === 'repetition') msg = '同一局面 3 回。引き分けです。';
    else if (st.reason === 'fifty') msg = '50 手ルール。引き分けです。';
    else msg = '駒不足で詰ませられません。引き分けです。';
    setStatus(msg + ' [' + st.result + ']', 'over');
    setAdviceStatus('対局終了。「新しい対局」でもう一局どうぞ。');
    renderCards();
    return true;
  }

  function playerStatus() {
    const check = state.pos.inCheck();
    setStatus((check ? 'チェック！ ' : '') + `あなたの番です（${state.playerColor === WHITE ? '白' : '黒'}）`);
  }

  async function playerMove(m) {
    if (state.busy || state.over) return;
    state.token++;
    applyMove(m);
    state.advice = null;
    renderCards(); render();
    if (checkGameOver()) return;
    await opponentMove();
  }

  async function opponentMove() {
    state.busy = true;
    render(); renderCards();
    const p = state.oppPersonality;
    setStatus(`${p.name}（相手）が考え中…`, 'thinking');
    setAdviceStatus('');
    const oppColor = -state.playerColor;
    const weights = Object.assign({}, p.weights, { random: (p.weights.random || 0) + state.level.random });
    const evalFn = Eval.makeEvaluator(weights, oppColor);
    const before = state.pos.clone();
    const res = await Search.think(state.pos, evalFn, { maxDepth: state.level.depth, timeMs: state.level.timeMs });
    state.busy = false;
    if (!res || state.over) return;
    const legal = before.legalMoves();
    const f = Advisor.moveFeatures(before, res.move);
    const san = before.san(res.move, legal);
    const line = Advisor.comment(p, f, san);
    applyMove(res.move);
    el.opponentLine.innerHTML = `<span class="mark small" style="background:${p.color}">${p.mark}</span><strong>${p.name}</strong>（相手）「${line}」<span class="depth">深さ ${res.depth}</span>`;
    render();
    if (checkGameOver()) return;
    playerStatus();
    startAdvice();
  }

  function onSquareClick(sq) {
    if (state.busy || state.over || state.pos.side !== state.playerColor) return;
    const p = state.pos.board[sq];
    const own = p && (p > 0 ? WHITE : BLACK) === state.playerColor;
    if (state.selected !== null) {
      const cands = state.legal.filter((m) => m.to === sq);
      if (cands.length) {
        if (cands[0].flags & F_PROMO) {
          choosePromotion(state.playerColor).then((pt) => {
            const m = cands.find((c) => c.promo === pt);
            if (m) playerMove(m);
          });
          return;
        }
        playerMove(cands[0]);
        return;
      }
    }
    if (own && state.selected !== sq) {
      state.selected = sq;
      state.legal = state.pos.legalMoves().filter((m) => m.from === sq);
    } else {
      state.selected = null; state.legal = [];
    }
    render();
  }

  function choosePromotion(color) {
    return new Promise((resolve) => {
      const box = el.promo.querySelector('.promo-choices');
      box.innerHTML = '';
      for (const pt of [5, 2, 4, 3]) {
        const b = document.createElement('button');
        b.innerHTML = `<span class="piece ${color === WHITE ? 'w' : 'b'}">${GLYPH[pt]}</span>`;
        b.title = PIECE_JA[pt];
        b.addEventListener('click', () => { el.promo.hidden = true; resolve(pt); });
        box.appendChild(b);
      }
      el.promo.hidden = false;
    });
  }

  function undo() {
    if (state.busy || state.pos.history.length === 0) return;
    state.token++;
    const wasOver = state.over;
    state.over = false;
    state.pos.unmake(); state.sans.pop();
    if (state.pos.side !== state.playerColor && state.pos.history.length) { state.pos.unmake(); state.sans.pop(); }
    state.lastMove = state.pos.history.length ? state.pos.history[state.pos.history.length - 1].m : null;
    state.selected = null; state.legal = [];
    el.opponentLine.textContent = wasOver ? '' : el.opponentLine.textContent;
    render();
    if (state.pos.side === state.playerColor) { playerStatus(); startAdvice(); }
    else opponentMove();
  }

  function resign() {
    if (state.over || state.busy) return;
    state.over = true; state.token++; state.advice = null;
    setStatus('投了しました。相手の勝ちです。', 'over');
    setAdviceStatus('対局終了。「新しい対局」でもう一局どうぞ。');
    renderCards(); render();
  }

  function newGame() {
    saveSettings();
    state.token++;
    state.pos = new Position();
    state.sans = []; state.lastMove = null; state.selected = null; state.legal = [];
    state.over = false; state.busy = false; state.advice = null;
    const c = el.colorSelect.value;
    state.playerColor = c === 'w' ? WHITE : c === 'b' ? BLACK : (Math.random() < 0.5 ? WHITE : BLACK);
    state.flipped = state.playerColor === BLACK;
    state.level = LEVELS[+el.levelSelect.value] || LEVELS[2];
    state.adviceDepth = +el.adviceDepth.value || 3;
    const oppId = el.oppSelect.value;
    state.oppPersonality = oppId === 'random'
      ? Eval.PERSONALITIES[Math.floor(Math.random() * Eval.PERSONALITIES.length)]
      : Eval.personalityById(oppId);
    el.opponentLine.innerHTML = `<span class="mark small" style="background:${state.oppPersonality.color}">${state.oppPersonality.mark}</span>相手は <strong>${state.oppPersonality.name}</strong>（${state.oppPersonality.trait}・${state.level.name}）`;
    setEval(0, WHITE);
    render(); renderCards();
    if (state.pos.side === state.playerColor) { playerStatus(); startAdvice(); }
    else opponentMove();
  }

  // ---------- 初期化 ----------
  function init() {
    for (const p of Eval.PERSONALITIES) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = `${p.name}（${p.trait}）`;
      el.oppSelect.appendChild(o);
      const li = document.createElement('li');
      li.innerHTML = `<span class="mark small" style="background:${p.color}">${p.mark}</span><strong>${p.name}</strong>（${p.trait}）<span class="desc">${p.desc}</span>`;
      el.roster.appendChild(li);
    }
    loadSettings();
    buildBoard();
    el.newGame.addEventListener('click', newGame);
    el.undo.addEventListener('click', undo);
    el.resign.addEventListener('click', resign);
    el.flip.addEventListener('click', () => { state.flipped = !state.flipped; render(); });
    el.adviceDepth.addEventListener('change', () => { state.adviceDepth = +el.adviceDepth.value; saveSettings(); if (!state.busy && !state.over) startAdvice(); });
    el.levelSelect.addEventListener('change', () => { state.level = LEVELS[+el.levelSelect.value]; saveSettings(); });
    el.oppSelect.addEventListener('change', saveSettings);
    el.showExplain.addEventListener('change', () => { saveSettings(); renderCards(); });
    el.colorSelect.addEventListener('change', saveSettings);
    newGame();
  }

  // テスト用に公開
  window.GunshiChess = { state, playerMove, newGame, undo, LEVELS };
  init();
})();
