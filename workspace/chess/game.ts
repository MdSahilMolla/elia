// Game logic for a simple chess engine
// This file defines a Game class that wraps a Board and tracks player turns.
// Moves are supplied in simple algebraic notation (e.g., "e2" -> "e4").
// No move validation is performed beyond ensuring the coordinates are on the board.

import { Board } from "./board";

export class Game {
  private board: Board;
  private turn: "w" | "b";

  constructor() {
    this.board = new Board();
    this.turn = "w"; // White moves first
  }

  /**
   * Convert a square in algebraic notation (e.g., "e2") to board indices.
   * Returns a tuple [row, col] where row and col are zero‑based.
   * If the input is malformed, returns null.
   */
  private static algebraicToIndices(square: string): [number, number] | null {
    if (!/^[a-h][1-8]$/.test(square)) {
      return null;
    }
    const file = square[0];
    const rankChar = square[1];
    if (file === undefined || rankChar === undefined) {
      return null;
    }
    const rank = parseInt(rankChar, 10);
    const col = file.charCodeAt(0) - 'a'.charCodeAt(0);
    // Row 0 is the top of the board (rank 8), row 7 is the bottom (rank 1)
    const row = 8 - rank;
    return [row, col];
  }

  /**
   * Attempt to move a piece from one square to another.
   * Returns true if the move was applied, false if the coordinates are out of bounds.
   */
  makeMove(from: string, to: string): boolean {
    const fromIdx = Game.algebraicToIndices(from);
    const toIdx = Game.algebraicToIndices(to);
    if (!fromIdx || !toIdx) {
      return false; // out of bounds or malformed input
    }
    const [fromRow, fromCol] = fromIdx;
    const [toRow, toCol] = toIdx;
    // Perform the move (no validation of piece colour or legality)
    const fromBoardRow = this.board.board[fromRow];
    const toBoardRow = this.board.board[toRow];
    const piece = fromBoardRow?.[fromCol];
    if (!fromBoardRow || !toBoardRow || piece === undefined) {
      return false;
    }
    toBoardRow[toCol] = piece;
    fromBoardRow[fromCol] = "";
    // Switch turn
    this.turn = this.turn === "w" ? "b" : "w";
    return true;
  }

  /**
   * Return a string representation of the current board.
   */
  currentBoardString(): string {
    return this.board.toString();
  }

  /**
   * Get the player whose turn it is.
   */
  getCurrentTurn(): "w" | "b" {
    return this.turn;
  }
}
