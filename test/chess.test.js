'use strict';
// Chess rules.
//
// The core of this file is perft: walk the move tree to a fixed depth and count the leaves.
// The published counts for these six positions are the standard against which every move
// generator is checked, and they are unforgiving. A single misplaced en-passant capture, a
// castling right that survives a rook being taken, a pinned piece allowed to move: any one
// of those shows up as a wrong number. Spot-checking individual moves does not find them,
// which is why chess engines are tested this way and not that way.
//
// The positions below are the usual set, chosen between them to exercise castling both
// ways, en passant, promotion including under-promotion, pins, discovered check and
// positions where the king is already in check.

const test = require('node:test');
const assert = require('node:assert');
const chess = require('../src/chess');

/** Count leaf nodes at `depth`. The definition of perft, and nothing more. */
function perft(fen, depth) {
  if (depth === 0) return 1;
  const pos = chess.parseFen(fen);
  const moves = chess.legalMoves(pos);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) total += perft(chess.toFen(chess.makeMove(pos, m)), depth - 1);
  return total;
}

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const ENDGAME = '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1';
const PROMOTIONS = 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1';
const TANGLED = 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8';
const MIDDLEGAME = 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10';

test('perft from the starting position', () => {
  assert.strictEqual(perft(chess.START_FEN, 1), 20);
  assert.strictEqual(perft(chess.START_FEN, 2), 400);
  assert.strictEqual(perft(chess.START_FEN, 3), 8902);
  assert.strictEqual(perft(chess.START_FEN, 4), 197281);
});

test('perft through castling, en passant and pins', () => {
  assert.strictEqual(perft(KIWIPETE, 1), 48);
  assert.strictEqual(perft(KIWIPETE, 2), 2039);
  assert.strictEqual(perft(KIWIPETE, 3), 97862);
});

test('perft in an endgame full of discovered checks', () => {
  assert.strictEqual(perft(ENDGAME, 1), 14);
  assert.strictEqual(perft(ENDGAME, 2), 191);
  assert.strictEqual(perft(ENDGAME, 3), 2812);
  assert.strictEqual(perft(ENDGAME, 4), 43238);
});

test('perft with promotions and under-promotions', () => {
  assert.strictEqual(perft(PROMOTIONS, 1), 6);
  assert.strictEqual(perft(PROMOTIONS, 2), 264);
  assert.strictEqual(perft(PROMOTIONS, 3), 9467);
});

test('perft in a tangled position with a pawn on the seventh', () => {
  assert.strictEqual(perft(TANGLED, 1), 44);
  assert.strictEqual(perft(TANGLED, 2), 1486);
  assert.strictEqual(perft(TANGLED, 3), 62379);
});

test('perft in a quiet middlegame', () => {
  assert.strictEqual(perft(MIDDLEGAME, 1), 46);
  assert.strictEqual(perft(MIDDLEGAME, 2), 2079);
  assert.strictEqual(perft(MIDDLEGAME, 3), 89890);
});

// ----------------------------------------------------------------- the edges
test('FEN survives a round trip', () => {
  for (const fen of [chess.START_FEN, KIWIPETE, ENDGAME, PROMOTIONS, TANGLED, MIDDLEGAME]) {
    assert.strictEqual(chess.toFen(chess.parseFen(fen)), fen);
  }
});

test('malformed FEN is rejected rather than half-understood', () => {
  for (const bad of [
    '', 'not a fen',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',          // five fields
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1',               // seven ranks
    'rnbqkbnr/ppppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',     // nine on a rank
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1',      // no such side
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq j9 0 1',     // no such square
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - x 1',      // counter is not a number
  ]) {
    assert.throws(() => chess.parseFen(bad), /bad FEN|six fields/, `accepted: ${bad}`);
  }
});

test('an illegal move is refused, whatever it looks like', () => {
  const fen = chess.START_FEN;
  for (const bad of ['e2e5', 'e7e5', 'a1a3', 'e1g1', 'nonsense', '', 'e2e4q']) {
    assert.throws(() => chess.move(fen, bad), /illegal move/, `accepted: ${bad}`);
  }
  assert.doesNotThrow(() => chess.move(fen, 'e2e4'));
});

test('a move leaving your own king in check is not legal', () => {
  // The white king on e1, a black rook on e8, and a white knight on e2 that is pinned.
  const pinned = chess.parseFen('4r3/8/8/8/8/8/4N3/4K3 w - - 0 1');
  const knightMoves = chess.legalMoves(pinned).filter((m) => m.from === chess.parseSquare('e2'));
  assert.strictEqual(knightMoves.length, 0, 'the pinned knight has no legal move');
  assert.ok(chess.legalMoves(pinned).length > 0, 'the king can still step aside');
});

test('en passant captures the pawn beside the arriving one', () => {
  const after = chess.move('8/8/8/3pP3/8/8/8/4K2k w - d6 0 2', 'e5d6');
  const board = chess.parseFen(after.fen).board;
  assert.strictEqual(board[chess.parseSquare('d6')], 'P', 'the pawn arrives on d6');
  assert.strictEqual(board[chess.parseSquare('d5')], null, 'the captured pawn leaves d5');
  assert.strictEqual(board[chess.parseSquare('e5')], null);
});

test('the en passant square appears only after a double step', () => {
  const double = chess.move(chess.START_FEN, 'e2e4');
  assert.ok(double.fen.includes(' e3 '), 'e3 is the target after e2e4');
  const single = chess.move(chess.START_FEN, 'e2e3');
  assert.ok(single.fen.includes(' - '), 'a single step leaves no target');
});

test('castling moves the rook too, and only when it is allowed', () => {
  const ready = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  const short = chess.move(ready, 'e1g1');
  const shortBoard = chess.parseFen(short.fen).board;
  assert.strictEqual(shortBoard[chess.parseSquare('g1')], 'K');
  assert.strictEqual(shortBoard[chess.parseSquare('f1')], 'R');
  assert.strictEqual(shortBoard[chess.parseSquare('h1')], null);
  assert.strictEqual(short.san, 'O-O');

  const long = chess.move(ready, 'e1c1');
  const longBoard = chess.parseFen(long.fen).board;
  assert.strictEqual(longBoard[chess.parseSquare('c1')], 'K');
  assert.strictEqual(longBoard[chess.parseSquare('d1')], 'R');
  assert.strictEqual(long.san, 'O-O-O');

  // Out of check, through check, and into check are all refused.
  assert.throws(() => chess.move('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'.replace('8/8/8/8/8/8', '4r3/8/8/8/8/8'), 'e1g1'), /illegal/);
  assert.throws(() => chess.move('r3k2r/8/8/8/8/8/8/R3K1nR w KQkq - 0 1', 'e1g1'), /illegal/);
  // The rook may be attacked; that is allowed.
  assert.doesNotThrow(() => chess.move('r3k3/7q/8/8/8/8/8/R3K2R w KQq - 0 1', 'e1c1'));
});

test('the queen side needs the b-file empty but not safe', () => {
  // A black rook on b8 attacks b1. Castling long is still legal.
  assert.doesNotThrow(() => chess.move('1r2k3/8/8/8/8/8/8/R3K3 w Q - 0 1', 'e1c1'));
  // A knight standing on b1 blocks it.
  assert.throws(() => chess.move('4k3/8/8/8/8/8/8/RN2K3 w Q - 0 1', 'e1c1'), /illegal/);
});

test('castling rights die when the rook is captured where it stands', () => {
  // A black bishop takes the rook on h1. White must lose the short castling right.
  const after = chess.move('4k3/8/8/8/8/8/6b1/R3K2R b KQ - 0 1', 'g2h1');
  assert.ok(!after.fen.split(' ')[2].includes('K'), `rights were ${after.fen.split(' ')[2]}`);
  assert.ok(after.fen.split(' ')[2].includes('Q'), 'the a-file right survives');
});

test('castling rights die when the king moves, both sides at once', () => {
  const after = chess.move('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1e2');
  assert.strictEqual(after.fen.split(' ')[2], '-');
});

test('promotion produces the piece that was asked for', () => {
  for (const [promo, piece] of [['q', 'Q'], ['r', 'R'], ['b', 'B'], ['n', 'N']]) {
    const after = chess.move('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', `a7a8${promo}`);
    assert.strictEqual(chess.parseFen(after.fen).board[chess.parseSquare('a8')], piece);
  }
  assert.throws(() => chess.move('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8'), /illegal/);
});

test('mate, stalemate and check are told apart', () => {
  // Fool's mate.
  let fen = chess.START_FEN;
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) fen = chess.move(fen, m).fen;
  const mate = chess.status(chess.parseFen(fen));
  assert.deepStrictEqual(
    { over: mate.over, result: mate.result, reason: mate.reason },
    { over: true, result: '0-1', reason: 'checkmate' },
  );

  const stale = chess.status(chess.parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'));
  assert.strictEqual(stale.reason, 'stalemate');
  assert.strictEqual(stale.result, '1/2-1/2');

  const checked = chess.status(chess.parseFen('4k3/8/8/8/8/8/8/4K2R b K - 0 1'));
  assert.strictEqual(checked.over, false);
});

test('a dead position is a draw, and a live one is not', () => {
  const dead = [
    '4k3/8/8/8/8/8/8/4K3 w - - 0 1',           // bare kings
    '4k3/8/8/8/8/8/8/4KB2 w - - 0 1',          // one bishop
    '4k3/8/8/8/8/8/8/4KN2 w - - 0 1',          // one knight
    '2b1k3/8/8/8/8/8/8/4KB2 w - - 0 1',        // bishops on the same colour
  ];
  for (const fen of dead) {
    assert.ok(chess.insufficientMaterial(chess.parseFen(fen).board), `should be dead: ${fen}`);
  }
  const alive = [
    '4k3/8/8/8/8/8/P7/4K3 w - - 0 1',          // a pawn can promote
    '4k3/8/8/8/8/8/8/R3K3 w - - 0 1',          // a rook mates
    '4k3/8/8/8/8/8/8/3BKB2 w - - 0 1',         // two bishops mate
    '3bk3/8/8/8/8/8/8/4KB2 w - - 0 1',         // bishops on opposite colours
  ];
  for (const fen of alive) {
    assert.ok(!chess.insufficientMaterial(chess.parseFen(fen).board), `should be alive: ${fen}`);
  }
});

test('the fifty-move counter resets on a pawn move or a capture', () => {
  const quiet = chess.move('4k3/8/8/8/8/8/8/R3K3 w - - 40 60', 'a1a2');
  assert.strictEqual(chess.parseFen(quiet.fen).half, 41);
  const pawn = chess.move('4k3/8/8/8/8/8/P7/4K3 w - - 40 60', 'a2a3');
  assert.strictEqual(chess.parseFen(pawn.fen).half, 0);
  const capture = chess.move('4k3/8/8/8/8/r7/8/R3K3 w - - 40 60', 'a1a3');
  assert.strictEqual(chess.parseFen(capture.fen).half, 0);

  const fifty = chess.status(chess.parseFen('4k3/8/8/8/8/8/8/R3K3 w - - 100 80'));
  assert.strictEqual(fifty.reason, 'fifty-move');
});

test('a threefold repetition is a draw only once it is threefold', () => {
  let fen = chess.START_FEN;
  const history = [chess.repetitionKey(chess.parseFen(fen))];
  // Knights out and back, twice, returning to the start position each time.
  const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  for (let i = 0; i < 2; i += 1) {
    for (const m of cycle) {
      const r = chess.move(fen, m, history);
      fen = r.fen;
      history.push(r.key);
    }
  }
  const seen = history.filter((k) => k === history[0]).length;
  assert.strictEqual(seen, 3, 'the opening position has now occurred three times');
  assert.strictEqual(chess.status(chess.parseFen(fen), history).reason, 'threefold');

  // Two occurrences is not yet a draw.
  const shorter = history.slice(0, 5);
  assert.notStrictEqual(chess.status(chess.parseFen(chess.START_FEN), shorter).reason, 'threefold');
});

test('the repetition key ignores the move counters but not the rights', () => {
  const a = chess.parseFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const b = chess.parseFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 40 60');
  const c = chess.parseFen('4k3/8/8/8/8/8/8/R3K2R w K - 0 1');
  assert.strictEqual(chess.repetitionKey(a), chess.repetitionKey(b));
  assert.notStrictEqual(chess.repetitionKey(a), chess.repetitionKey(c));
});

test('algebraic notation disambiguates by file, then rank, then both', () => {
  // Rooks on a1 and e1, both able to reach c1 with nothing in the way: the file is enough.
  const twoFiles = chess.parseFen('7k/8/8/7K/8/8/8/R3R3 w - - 0 1');
  assert.strictEqual(chess.toSan(twoFiles, chess.findMove(twoFiles, 'a1c1')), 'Rac1');
  assert.strictEqual(chess.toSan(twoFiles, chess.findMove(twoFiles, 'e1c1')), 'Rec1');

  // Two rooks on the a-file, both able to reach a3: the file cannot separate them.
  const twoRanks = chess.parseFen('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1');
  assert.strictEqual(chess.toSan(twoRanks, chess.findMove(twoRanks, 'a1a3')), 'R1a3');
  assert.strictEqual(chess.toSan(twoRanks, chess.findMove(twoRanks, 'a5a3')), 'R5a3');

  // Queens on a1, a4 and d1, all bearing on d4. The a1 queen shares its file with one
  // rival and its rank with the other, so neither alone will do and the square is written
  // out in full. The other two need only a file or only a rank.
  // The black king sits on b8, off every line these queens command: on e8 it stood on the
  // a4-e8 diagonal and every one of these moves would have carried a check marker.
  const three = chess.parseFen('1k6/8/8/8/Q7/8/8/Q2Q3K w - - 0 1');
  assert.strictEqual(chess.toSan(three, chess.findMove(three, 'a1d4')), 'Qa1d4');
  assert.strictEqual(chess.toSan(three, chess.findMove(three, 'a4d4')), 'Q4d4');
  assert.strictEqual(chess.toSan(three, chess.findMove(three, 'd1d4')), 'Qdd4');
});

test('notation marks captures, checks and mate', () => {
  const capture = chess.parseFen('4k3/8/8/8/8/8/4p3/R3K3 w - - 0 1');
  assert.strictEqual(chess.toSan(capture, chess.findMove(capture, 'a1a8')), 'Ra8+');

  const pawnTake = chess.parseFen('4k3/8/8/8/8/3p4/4P3/4K3 w - - 0 1');
  assert.strictEqual(chess.toSan(pawnTake, chess.findMove(pawnTake, 'e2d3')), 'exd3');

  const promote = chess.parseFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  assert.strictEqual(chess.toSan(promote, chess.findMove(promote, 'a7a8n')), 'a8=N');

  const backRank = chess.parseFen('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
  assert.strictEqual(chess.toSan(backRank, chess.findMove(backRank, 'a1a8')), 'Ra8#');
});

test('move() reports the resulting status alongside the new position', () => {
  let fen = chess.START_FEN;
  for (const m of ['f2f3', 'e7e5', 'g2g4']) fen = chess.move(fen, m).fen;
  const mate = chess.move(fen, 'd8h4');
  assert.strictEqual(mate.san, 'Qh4#');
  assert.strictEqual(mate.status.over, true);
  assert.strictEqual(mate.status.result, '0-1');
});

test('legalUci gives the client every move and nothing else', () => {
  const list = chess.legalUci(chess.START_FEN);
  assert.strictEqual(list.length, 20);
  assert.ok(list.includes('e2e4'));
  assert.ok(list.includes('g1f3'));
  assert.ok(!list.includes('e2e5'));
  assert.strictEqual(new Set(list).size, list.length, 'no move is listed twice');
});
