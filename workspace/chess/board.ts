// Chess board representation
// Simple string notation: 'P' white pawn, 'p' black pawn, '' empty square
// Empty squares are displayed as '.' in toString()

export class Board {
  // 8x8 board, rows indexed 0 (top) to 7 (bottom)
  board: string[][];

  constructor() {
    // Initialize empty board and set up initial position
    this.board = Array.from({ length: 8 }, () => Array(8).fill(''));
    this.reset();
  }

  /**
   * Reset the board to the standard chess starting position.
   */
  reset(): void {
    const backRankWhite = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    const backRankBlack = backRankWhite.map(p => p.toLowerCase());
    const pawnWhite = 'P';
    const pawnBlack = 'p';

    // Clear board
    this.board = Array.from({ length: 8 }, () => Array(8).fill(''));

    // Place black pieces (top of board)
    this.board[0] = backRankBlack;
    this.board[1] = Array(8).fill(pawnBlack);

    // Place white pieces (bottom of board)
    this.board[6] = Array(8).fill(pawnWhite);
    this.board[7] = backRankWhite;
  }

  /**
   * Return a multi‑line string representation of the board.
   * Empty squares are shown as '.' and pieces are separated by a space.
   */
  toString(): string {
    return this.board
      .map(row => row.map(cell => (cell === '' ? '.' : cell)).join(' '))
      .join('\n');
  }
}
