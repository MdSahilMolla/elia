import { test, expect } from 'bun:test';
import { Game } from './game';

test('make move e2 e4', () => {
  const game = new Game();
  const moved = game.makeMove('e2', 'e4');
  expect(moved).toBe(true);
  const boardStr = game.currentBoardString();
  const rows = boardStr.split('\n');
  // Rank 4 corresponds to row index 4 (0‑based, top row is rank 8)
  const row4 = rows[4]!.split(' ');
  expect(row4[4]).toBe('P');
  // Rank 2 corresponds to row index 6
  const row2 = rows[6]!.split(' ');
  expect(row2[4]).toBe('.');
});
