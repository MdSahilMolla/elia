// Command-line interface for the simple chess engine
// Reads commands from stdin and interacts with the Game class.

import * as readline from "readline";
import { Game } from "./game";

// Initialize the game instance
const game = new Game();

// Set up readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("Simple Chess CLI. Type a move like 'e2 e4' or 'board' to display the board.");
rl.prompt();

rl.on("line", (line) => {
  const input = line.trim();
  if (input.length === 0) {
    rl.prompt();
    return;
  }

  if (input.toLowerCase() === "board") {
    console.log(game.currentBoardString());
    rl.prompt();
    return;
  }

  const parts = input.split(/\s+/);
  if (parts.length !== 2) {
    console.log("Invalid command. Use 'board' or a move like 'e2 e4'.");
    rl.prompt();
    return;
  }

  const [from, to] = parts as [string, string];
  const success = game.makeMove(from, to);
  if (!success) {
    console.log(`Invalid move: ${input}`);
  } else {
    console.log(game.currentBoardString());
    console.log(`Turn: ${game.getCurrentTurn() === "w" ? "White" : "Black"}`);
  }
  rl.prompt();
});

rl.on("close", () => {
  console.log("Exiting Chess CLI.");
  process.exit(0);
});
