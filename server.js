'use strict';
// Gol Düellosu - bağımlılıksız Node.js sunucusu (npm install gerekmez)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PLAY_MS = 15000;
const REVEAL_MS = 5500;
const MAX_PLAYERS = 6;
const ALPHA = 'ABCDEFGHJKLMNPRSTUVYZ';
const rooms = new Map();

const rid = () => crypto.randomBytes(8).toString('hex');
const rnd = (n) => Math.floor(Math.random() * n);

function newCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += ALPHA[rnd(ALPHA.length)];
  } while (rooms.has(c));
  return c;
}

function send(p, ev, data) {
  if (!p.res) return;
  try {
    p.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) { /* bağlantı kopmuş olabilir */ }
}

function pub(room) {
  return {
    room: room.code,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    total: room.total,
    shooterId: room.shooterId,
    keeperId: room.keeperId,
    ms: Math.max(0, room.deadline - Date.now()),
    dur: room.dur,
    locked: { shooter: !!room.picks.shot, keeper: !!room.picks.keeper },
    result: room.phase === 'reveal' ? room.result : null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, online: !!p.bot || !!p.res, bot: !!p.bot })),
  };
}

function broadcast(room) {
  const s = pub(room);
  room.players.forEach((p) => send(p, 'state', s));
}

function makeRoom() {
  const room = {
    code: newCode(),
    players: [],
    hostId: null,
    phase: 'lobby',
    round: 0,
    total: 0,
    shooterId: null,
    keeperId: null,
    picks: {},
    result: null,
    timer: null,
    deadline: 0,
    dur: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name, bot) {
  const p = {
    id: rid(),
    name: String(name || 'Oyuncu').trim().slice(0, 14) || 'Oyuncu',
    score: 0,
    res: null,
    drop: null,
    bot: !!bot,
  };
  room.players.push(p);
  if (!room.hostId && !bot) room.hostId = p.id;
  return p;
}

const BOT_NAMES = ['🤖 Mert', '🤖 Ece', '🤖 Kaan', '🤖 Defne', '🤖 Arda'];
const firstHuman = (room) => {
  const h = room.players.find((x) => !x.bot);
  return h ? h.id : null;
};

// Bot oyuncular 1,5-5 saniye içinde rastgele hamle yapar.
function botMoves(room) {
  const round = room.round;
  const act = (id, fn) => {
    if (!room.players.some((p) => p.id === id && p.bot)) return;
    setTimeout(() => {
      if (!rooms.has(room.code) || room.phase !== 'play' || room.round !== round) return;
      fn();
      if (room.picks.shot && room.picks.keeper) resolveRound(room);
      else broadcast(room);
    }, 1500 + rnd(3500));
  };
  act(room.shooterId, () => {
    if (room.picks.shot) return;
    const r = Math.random();
    const power = r < 0.15 ? 25 + Math.random() * 25 : r < 0.25 ? 90 + Math.random() * 10 : 58 + Math.random() * 28;
    room.picks.shot = { cell: rnd(6), power };
  });
  act(room.keeperId, () => {
    if (room.picks.keeper) return;
    room.picks.keeper = { cell: rnd(6) };
  });
}

function startRound(room) {
  const n = room.players.length;
  room.phase = 'play';
  room.picks = {};
  room.result = null;
  room.shooterId = room.players[room.round % n].id;
  room.keeperId = room.players[(room.round + 1) % n].id;
  room.dur = PLAY_MS;
  room.deadline = Date.now() + PLAY_MS;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveRound(room), PLAY_MS);
  broadcast(room);
  botMoves(room);
}

// Kurallar:
//  güç < 55  : yumuşak şut -> kaleci aynı sütundaysa kurtarır
//  55 - 88   : sert şut    -> kaleci sadece tam aynı kareyi seçtiyse kurtarır
//  güç > 88  : aut (üstten)
function resolveRound(room) {
  clearTimeout(room.timer);
  const sh = room.players.find((p) => p.id === room.shooterId);
  const kp = room.players.find((p) => p.id === room.keeperId);
  const shot = room.picks.shot || { cell: rnd(6), power: 30 + Math.random() * 50 };
  const kc = room.picks.keeper ? room.picks.keeper.cell : rnd(6);
  let outcome;
  if (shot.power > 88) outcome = 'miss';
  else if (shot.power < 55) outcome = shot.cell % 3 === kc % 3 ? 'save' : 'goal';
  else outcome = shot.cell === kc ? 'save' : 'goal';
  if (outcome === 'goal' && sh) sh.score++;
  if (outcome === 'save' && kp) kp.score++;
  room.result = {
    shooterId: room.shooterId,
    keeperId: room.keeperId,
    shotCell: shot.cell,
    power: Math.round(shot.power),
    keeperCell: kc,
    outcome,
  };
  room.phase = 'reveal';
  room.dur = REVEAL_MS;
  room.deadline = Date.now() + REVEAL_MS;
  room.timer = setTimeout(() => {
    room.round++;
    if (room.round >= room.total) {
      room.phase = 'over';
      room.dur = 0;
      room.deadline = Date.now();
      broadcast(room);
    } else {
      startRound(room);
    }
  }, REVEAL_MS);
  broadcast(room);
}

function dropPlayer(room, p) {
  if (room.phase === 'lobby') {
    room.players = room.players.filter((x) => x !== p);
    if (room.hostId === p.id) room.hostId = firstHuman(room);
  }
  if (room.players.filter((x) => !x.bot).every((x) => !x.res)) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  broadcast(room);
}

function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html bulunamadı'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && p === '/health') { res.writeHead(200); return res.end('ok'); }

  if (req.method === 'GET' && p === '/api/events') {
    const room = rooms.get(u.searchParams.get('room'));
    const pl = room && room.players.find((x) => x.id === u.searchParams.get('pid'));
    if (!pl) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (pl.res) { try { pl.res.end(); } catch (e) { /* yoksay */ } }
    pl.res = res;
    clearTimeout(pl.drop);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* yoksay */ } }, 20000);
    req.on('close', () => {
      clearInterval(hb);
      if (pl.res === res) {
        pl.res = null;
        pl.drop = setTimeout(() => dropPlayer(room, pl), 20000);
      }
    });
    broadcast(room);
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const b = await body(req);
    const act = p.slice(5);

    if (act === 'create') {
      const room = makeRoom();
      const pl = addPlayer(room, b.name);
      return json(res, { room: room.code, pid: pl.id });
    }

    const room = rooms.get(String(b.room || '').toUpperCase());
    if (!room) return json(res, { error: 'Oda bulunamadı' }, 404);

    if (act === 'join') {
      if (room.phase !== 'lobby') return json(res, { error: 'Oyun başlamış' }, 400);
      if (room.players.length >= MAX_PLAYERS) return json(res, { error: 'Oda dolu (en fazla 6 kişi)' }, 400);
      const pl = addPlayer(room, b.name);
      return json(res, { room: room.code, pid: pl.id });
    }

    const me = room.players.find((x) => x.id === b.pid);
    if (!me) return json(res, { error: 'Oyuncu yok' }, 403);

    if (act === 'start') {
      if (room.hostId !== me.id || room.phase !== 'lobby') return json(res, { error: 'Yetki yok' }, 403);
      if (room.players.length < 2) return json(res, { error: 'En az 2 kişi gerekli' }, 400);
      room.players.forEach((x) => (x.score = 0));
      room.round = 0;
      room.total = room.players.length * 2;
      startRound(room);
      return json(res, { ok: true });
    }

    if (act === 'pick') {
      if (room.phase !== 'play') return json(res, { ok: false });
      const cell = Number(b.cell);
      if (!(cell >= 0 && cell <= 5)) return json(res, { ok: false });
      if (me.id === room.shooterId && !room.picks.shot) {
        const power = Math.max(0, Math.min(100, Number(b.power) || 0));
        room.picks.shot = { cell, power };
      } else if (me.id === room.keeperId && !room.picks.keeper) {
        room.picks.keeper = { cell };
      } else {
        return json(res, { ok: false });
      }
      if (room.picks.shot && room.picks.keeper) resolveRound(room);
      else broadcast(room);
      return json(res, { ok: true });
    }

    if (act === 'addbot') {
      if (room.hostId !== me.id || room.phase !== 'lobby') return json(res, { error: 'Yetki yok' }, 403);
      if (room.players.length >= MAX_PLAYERS) return json(res, { error: 'Oda dolu (en fazla 6 kişi)' }, 400);
      const used = room.players.filter((x) => x.bot).length;
      addPlayer(room, BOT_NAMES[used % BOT_NAMES.length], true);
      broadcast(room);
      return json(res, { ok: true });
    }

    if (act === 'delbot') {
      if (room.hostId !== me.id || room.phase !== 'lobby') return json(res, { error: 'Yetki yok' }, 403);
      const idx = room.players.map((x) => x.bot).lastIndexOf(true);
      if (idx >= 0) room.players.splice(idx, 1);
      broadcast(room);
      return json(res, { ok: true });
    }

    if (act === 'signal') {
      const to = room.players.find((x) => x.id === b.to);
      if (to) send(to, 'signal', { from: me.id, data: b.data });
      return json(res, { ok: true });
    }

    if (act === 'again') {
      if (room.phase !== 'over') return json(res, { ok: false });
      room.phase = 'lobby';
      room.round = 0;
      room.picks = {};
      room.result = null;
      room.players = room.players.filter((x) => x.res || x.bot);
      room.players.forEach((x) => (x.score = 0));
      if (!room.players.find((x) => x.id === room.hostId)) room.hostId = firstHuman(room);
      broadcast(room);
      return json(res, { ok: true });
    }

    return json(res, { error: 'Bilinmeyen işlem' }, 400);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log('Gol Düellosu http://localhost:' + PORT));
