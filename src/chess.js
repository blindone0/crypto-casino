'use strict';
// Chess rules.
//
// This is the authority. The board in the browser is a picture of a game that lives here,
// because the moment a stake is attached to a result, a rules check that runs on the
// player's machine is worth exactly nothing. Every move a client sends is generated here
// from scratch and rejected unless it appears in the legal list.
//
// Representation: a 64-square array indexed 0..63 from a8 across to h1, so index = rank * 8
// + file with rank 0 being the eighth rank. Pieces are single letters, uppercase for White
// and lowercase for Black, and an empty square is null. Positions serialise to FEN, which
// is what gets stored, and moves are coordinate pairs ("e2e4", "e7e8q") rather than SAN,
// because coordinates cannot be ambiguous and do not need the position to be parsed twice.
//
// Everything here is pure: no state is kept between calls, and applying a move returns a
// new position rather than editing the one it was given.

const FILES = 'abcdefgh';
const WHITE = 'w';
const BLACK = 'b';

const isUpper = (c) => c >= 'A' && c <= 'Z';
const colourOf = (piece) => (piece === null ? null : (isUpper(piece) ? WHITE : BLACK));
const other = (colour) => (colour === WHITE ? BLACK : WHITE);

const fileOf = (sq) => sq % 8;
const rankOf = (sq) => Math.floor(sq / 8); // 0 is the eighth rank
const onBoard = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8;
const sqOf = (file, rank) => rank * 8 + file;

/** "e4" to an index, and back. Used at the edges, never inside move generation. */
function parseSquare(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const file = FILES.indexOf(name[0]);
  const rank = 8 - Number(name[1]);
  if (file < 0 || !Number.isInteger(rank) || rank < 0 || rank > 7) return -1;
  return sqOf(file, rank);
}
const squareName = (sq) => `${FILES[fileOf(sq)]}${8 - rankOf(sq)}`;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ------------------------------------------------------------------- FEN
/** Parse a FEN into a position. Throws on anything malformed. */
function parseFen(fen) {
  const parts = String(fen).trim().split(/\s+/);
  if (parts.length !== 6) throw new Error('bad FEN: expected six fields');
  const [placement, turn, castling, ep, half, full] = parts;

  const board = new Array(64).fill(null);
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error('bad FEN: expected eight ranks');
  for (let rank = 0; rank < 8; rank += 1) {
    let file = 0;
    for (const ch of rows[rank]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else if ('prnbqkPRNBQK'.includes(ch)) {
        if (file > 7) throw new Error('bad FEN: rank overflows');
        board[sqOf(file, rank)] = ch;
        file += 1;
      } else {
        throw new Error(`bad FEN: unknown piece "${ch}"`);
      }
    }
    if (file !== 8) throw new Error('bad FEN: rank is not eight squares');
  }

  if (turn !== WHITE && turn !== BLACK) throw new Error('bad FEN: side to move');
  if (!/^(-|K?Q?k?q?)$/.test(castling)) throw new Error('bad FEN: castling rights');
  const epSquare = ep === '-' ? -1 : parseSquare(ep);
  if (ep !== '-' && epSquare < 0) throw new Error('bad FEN: en passant square');
  if (!/^\d+$/.test(half) || !/^\d+$/.test(full)) throw new Error('bad FEN: move counters');

  return {
    board,
    turn,
    castling: castling === '-' ? '' : castling,
    ep: epSquare,
    half: Number(half),
    full: Number(full),
  };
}

function toFen(pos) {
  const rows = [];
  for (let rank = 0; rank < 8; rank += 1) {
    let row = '';
    let gap = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = pos.board[sqOf(file, rank)];
      if (piece === null) { gap += 1; continue; }
      if (gap) { row += String(gap); gap = 0; }
      row += piece;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return [
    rows.join('/'),
    pos.turn,
    pos.castling || '-',
    pos.ep < 0 ? '-' : squareName(pos.ep),
    pos.half,
    pos.full,
  ].join(' ');
}

const startPosition = () => parseFen(START_FEN);

/**
 * The part of a position that decides repetition: everything except the move counters.
 * Two positions with the same pieces, side to move, castling rights and en passant target
 * are the same position for the purpose of a threefold draw, however they were reached.
 */
function repetitionKey(pos) {
  return toFen(pos).split(' ').slice(0, 4).join(' ');
}

// ------------------------------------------------------- attacks and moves
const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const BISHOP_RAYS = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const ROOK_RAYS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

/**
 * Is `sq` attacked by `byColour`?
 *
 * Deliberately not written as "generate their moves and look": that would recurse, because
 * castling legality asks this question while moves are being generated.
 */
function isAttacked(board, sq, byColour) {
  const file = fileOf(sq);
  const rank = rankOf(sq);
  const wantsUpper = byColour === WHITE;
  const is = (piece, letter) => piece !== null
    && piece.toLowerCase() === letter && isUpper(piece) === wantsUpper;

  // Pawns. White pawns live below their targets on this board, so they attack upward,
  // which is toward a smaller rank index.
  const pawnRank = byColour === WHITE ? rank + 1 : rank - 1;
  for (const df of [-1, 1]) {
    if (!onBoard(file + df, pawnRank)) continue;
    if (is(board[sqOf(file + df, pawnRank)], 'p')) return true;
  }

  for (const [df, dr] of KNIGHT_STEPS) {
    if (!onBoard(file + df, rank + dr)) continue;
    if (is(board[sqOf(file + df, rank + dr)], 'n')) return true;
  }

  for (const [df, dr] of KING_STEPS) {
    if (!onBoard(file + df, rank + dr)) continue;
    if (is(board[sqOf(file + df, rank + dr)], 'k')) return true;
  }

  for (const [rays, letter] of [[BISHOP_RAYS, 'b'], [ROOK_RAYS, 'r']]) {
    for (const [df, dr] of rays) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const piece = board[sqOf(f, r)];
        if (piece !== null) {
          if (is(piece, letter) || is(piece, 'q')) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
  }
  return false;
}

function findKing(board, colour) {
  const king = colour === WHITE ? 'K' : 'k';
  for (let sq = 0; sq < 64; sq += 1) if (board[sq] === king) return sq;
  return -1;
}

/** Is the side to move, or the named side, currently in check? */
function inCheck(pos, colour = pos.turn) {
  const king = findKing(pos.board, colour);
  return king >= 0 && isAttacked(pos.board, king, other(colour));
}

const PROMOTIONS = ['q', 'r', 'b', 'n'];

/** Pseudo-legal moves: correct in every way except that they may leave the king in check. */
function pseudoMoves(pos) {
  const { board, turn } = pos;
  const moves = [];
  const forward = turn === WHITE ? -1 : 1; // toward a smaller rank index for White
  const homeRank = turn === WHITE ? 6 : 1;
  const lastRank = turn === WHITE ? 0 : 7;

  const push = (from, to, extra = {}) => moves.push({ from, to, promo: null, ...extra });

  for (let from = 0; from < 64; from += 1) {
    const piece = board[from];
    if (piece === null || colourOf(piece) !== turn) continue;
    const file = fileOf(from);
    const rank = rankOf(from);
    const kind = piece.toLowerCase();

    if (kind === 'p') {
      const oneRank = rank + forward;
      if (onBoard(file, oneRank) && board[sqOf(file, oneRank)] === null) {
        const to = sqOf(file, oneRank);
        if (oneRank === lastRank) for (const p of PROMOTIONS) push(from, to, { promo: p });
        else push(from, to);
        // The double step is only available from the home rank and only through an
        // empty square, which is why it is nested inside the single-step test.
        const twoRank = rank + forward * 2;
        if (rank === homeRank && board[sqOf(file, twoRank)] === null) {
          push(from, sqOf(file, twoRank), { double: true });
        }
      }
      for (const df of [-1, 1]) {
        if (!onBoard(file + df, oneRank)) continue;
        const to = sqOf(file + df, oneRank);
        const target = board[to];
        if (target !== null && colourOf(target) !== turn) {
          if (oneRank === lastRank) for (const p of PROMOTIONS) push(from, to, { promo: p });
          else push(from, to);
        } else if (target === null && to === pos.ep) {
          push(from, to, { enPassant: true });
        }
      }
      continue;
    }

    if (kind === 'n' || kind === 'k') {
      for (const [df, dr] of (kind === 'n' ? KNIGHT_STEPS : KING_STEPS)) {
        if (!onBoard(file + df, rank + dr)) continue;
        const to = sqOf(file + df, rank + dr);
        if (board[to] !== null && colourOf(board[to]) === turn) continue;
        push(from, to);
      }
      continue;
    }

    const rays = kind === 'b' ? BISHOP_RAYS : kind === 'r' ? ROOK_RAYS : [...BISHOP_RAYS, ...ROOK_RAYS];
    for (const [df, dr] of rays) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const to = sqOf(f, r);
        const target = board[to];
        if (target !== null) {
          if (colourOf(target) !== turn) push(from, to);
          break;
        }
        push(from, to);
        f += df;
        r += dr;
      }
    }
  }

  addCastling(pos, moves);
  return moves;
}

/**
 * Castling.
 *
 * Three separate conditions get confused with each other constantly: the squares between
 * king and rook must be empty, the king may not start in check, and the king may not pass
 * through or land on an attacked square. The rook is allowed to be attacked, and on the
 * queen's side the b-file square must be empty but need not be safe.
 */
function addCastling(pos, moves) {
  const { board, turn, castling } = pos;
  const rank = turn === WHITE ? 7 : 0;
  const king = sqOf(4, rank);
  const kingPiece = turn === WHITE ? 'K' : 'k';
  if (board[king] !== kingPiece) return;
  const them = other(turn);
  if (isAttacked(board, king, them)) return;

  const rights = turn === WHITE ? ['K', 'Q'] : ['k', 'q'];
  const rookPiece = turn === WHITE ? 'R' : 'r';

  // [right, rook file, files that must be empty, files the king crosses]
  const sides = [
    [rights[0], 7, [5, 6], [5, 6]],
    [rights[1], 0, [1, 2, 3], [3, 2]],
  ];
  for (const [right, rookFile, empties, path] of sides) {
    if (!castling.includes(right)) continue;
    if (board[sqOf(rookFile, rank)] !== rookPiece) continue;
    if (empties.some((f) => board[sqOf(f, rank)] !== null)) continue;
    if (path.some((f) => isAttacked(board, sqOf(f, rank), them))) continue;
    moves.push({ from: king, to: sqOf(path[1], rank), promo: null, castle: right });
  }
}

/** Legal moves: pseudo-legal, minus everything that leaves your own king attacked. */
function legalMoves(pos) {
  return pseudoMoves(pos).filter((move) => {
    const next = makeMove(pos, move);
    return !isAttacked(next.board, findKing(next.board, pos.turn), other(pos.turn));
  });
}

/**
 * Apply a move without checking that it is legal.
 * Internal: callers outside this file go through move(), which validates first.
 */
function makeMove(pos, m) {
  const board = pos.board.slice();
  const piece = board[m.from];
  const kind = piece.toLowerCase();
  const captured = m.enPassant ? 'p' : board[m.to];

  board[m.to] = m.promo ? (pos.turn === WHITE ? m.promo.toUpperCase() : m.promo) : piece;
  board[m.from] = null;

  if (m.enPassant) {
    // The captured pawn is beside the arriving pawn, not under it.
    board[sqOf(fileOf(m.to), rankOf(m.from))] = null;
  }

  if (m.castle) {
    const rank = rankOf(m.from);
    const kingside = m.castle === 'K' || m.castle === 'k';
    const rookFrom = sqOf(kingside ? 7 : 0, rank);
    const rookTo = sqOf(kingside ? 5 : 3, rank);
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }

  // Castling rights die when the king or a rook leaves its square, and also when a rook
  // is captured where it stands: forgetting the second case is the classic bug here.
  let castling = pos.castling;
  const drop = (letters) => { for (const l of letters) castling = castling.replace(l, ''); };
  if (kind === 'k') drop(pos.turn === WHITE ? 'KQ' : 'kq');
  if (m.from === 63 || m.to === 63) drop('K');
  if (m.from === 56 || m.to === 56) drop('Q');
  if (m.from === 7 || m.to === 7) drop('k');
  if (m.from === 0 || m.to === 0) drop('q');

  return {
    board,
    turn: other(pos.turn),
    castling,
    ep: m.double ? sqOf(fileOf(m.from), (rankOf(m.from) + rankOf(m.to)) / 2) : -1,
    half: (kind === 'p' || captured) ? 0 : pos.half + 1,
    full: pos.turn === BLACK ? pos.full + 1 : pos.full,
  };
}

// ------------------------------------------------------------------ notation
const uci = (m) => `${squareName(m.from)}${squareName(m.to)}${m.promo || ''}`;

/** Find the legal move matching a coordinate string, or null. */
function findMove(pos, text) {
  const want = String(text || '').trim().toLowerCase();
  return legalMoves(pos).find((m) => uci(m) === want) || null;
}

/**
 * Standard algebraic notation, for the move list.
 * Disambiguation follows the usual rule: file if that is enough, else rank, else both.
 */
function toSan(pos, move) {
  const piece = pos.board[move.from];
  const kind = piece.toLowerCase();
  const capture = move.enPassant || pos.board[move.to] !== null;
  const after = makeMove(pos, move);
  const opponent = other(pos.turn);
  const check = isAttacked(after.board, findKing(after.board, opponent), pos.turn);
  const mated = check && legalMoves(after).length === 0;
  const suffix = mated ? '#' : (check ? '+' : '');

  if (move.castle) return (move.castle.toLowerCase() === 'k' ? 'O-O' : 'O-O-O') + suffix;

  if (kind === 'p') {
    const body = capture ? `${FILES[fileOf(move.from)]}x${squareName(move.to)}` : squareName(move.to);
    return body + (move.promo ? `=${move.promo.toUpperCase()}` : '') + suffix;
  }

  const rivals = legalMoves(pos).filter((m) => m.to === move.to && m.from !== move.from
    && pos.board[m.from] === piece);
  let where = '';
  if (rivals.length) {
    const sameFile = rivals.some((m) => fileOf(m.from) === fileOf(move.from));
    const sameRank = rivals.some((m) => rankOf(m.from) === rankOf(move.from));
    if (!sameFile) where = FILES[fileOf(move.from)];
    else if (!sameRank) where = String(8 - rankOf(move.from));
    else where = squareName(move.from);
  }
  return `${kind.toUpperCase()}${where}${capture ? 'x' : ''}${squareName(move.to)}${suffix}`;
}

// -------------------------------------------------------------------- state
/**
 * Material too thin for anyone to force mate.
 * King against king, king and a single minor against king, and the two-bishop case where
 * both bishops stand on the same colour. Two knights are excluded on purpose: mate is not
 * forcible, but it is possible, so it is not a dead position by rule.
 */
function insufficientMaterial(board) {
  const minors = [];
  for (let sq = 0; sq < 64; sq += 1) {
    const piece = board[sq];
    if (piece === null) continue;
    const kind = piece.toLowerCase();
    if (kind === 'k') continue;
    if (kind === 'p' || kind === 'r' || kind === 'q') return false;
    minors.push({ kind, colour: colourOf(piece), dark: (fileOf(sq) + rankOf(sq)) % 2 === 1 });
  }
  if (minors.length <= 1) return true;
  if (minors.length === 2 && minors.every((m) => m.kind === 'b')
    && minors[0].colour !== minors[1].colour && minors[0].dark === minors[1].dark) return true;
  return false;
}

/**
 * How the game stands.
 *
 * `history` is the list of repetition keys for every position that has occurred, this one
 * included; pass it to get threefold detection, leave it out to skip that test.
 */
function status(pos, history = null) {
  const moves = legalMoves(pos);
  if (moves.length === 0) {
    return inCheck(pos)
      ? { over: true, result: pos.turn === WHITE ? '0-1' : '1-0', reason: 'checkmate' }
      : { over: true, result: '1/2-1/2', reason: 'stalemate' };
  }
  if (pos.half >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move' };
  if (insufficientMaterial(pos.board)) {
    return { over: true, result: '1/2-1/2', reason: 'insufficient-material' };
  }
  if (history) {
    const key = repetitionKey(pos);
    let seen = 0;
    for (const k of history) if (k === key) seen += 1;
    if (seen >= 3) return { over: true, result: '1/2-1/2', reason: 'threefold' };
  }
  return { over: false, result: null, reason: inCheck(pos) ? 'check' : null };
}

/**
 * Play a coordinate move against a FEN.
 * Returns the new FEN, the move in SAN, and the resulting status, or throws if the move is
 * not legal in that position. This is the only entry point the server needs.
 */
function move(fen, text, history = null) {
  const pos = parseFen(fen);
  const found = findMove(pos, text);
  if (!found) throw new Error(`illegal move: ${text}`);
  const san = toSan(pos, found);
  const next = makeMove(pos, found);
  const nextHistory = history ? [...history, repetitionKey(next)] : null;
  return {
    fen: toFen(next),
    san,
    uci: uci(found),
    key: repetitionKey(next),
    status: status(next, nextHistory),
  };
}

/** Every legal move in a position, as coordinate strings. For the client's board. */
const legalUci = (fen) => legalMoves(parseFen(fen)).map(uci);

module.exports = {
  START_FEN,
  startPosition,
  parseFen,
  toFen,
  parseSquare,
  squareName,
  legalMoves,
  legalUci,
  findMove,
  makeMove,
  move,
  toSan,
  uci,
  inCheck,
  isAttacked,
  status,
  insufficientMaterial,
  repetitionKey,
};
