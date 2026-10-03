#!/usr/bin/env python3
"""Tic-Tac-Toe CLI Game"""

BOARD_SIZE = 9
WIN_COMBOS = [(0,1,2),(3,4,5),(6,7,8),(0,3,6),(1,4,7),(2,5,8),(0,4,8),(2,4,6)]

def print_board(board):
    print(f"\n {board[0]} | {board[1]} | {board[2]} ")
    print("-----------")
    print(f" {board[3]} | {board[4]} | {board[5]} ")
    print("-----------")
    print(f" {board[6]} | {board[7]} | {board[8]} \n")

def check_winner(board):
    for a,b,c in WIN_COMBOS:
        if board[a] == board[b] == board[c] != ' ':
            return board[a]
    if ' ' not in board:
        return 'draw'
    return None

def get_move(board, player):
    while True:
        try:
            pos = int(input(f"{player}'s turn. Choose position (1-9): ")) - 1
            if 0 <= pos <= BOARD_SIZE - 1 and board[pos] == ' ':
                return pos
            print("Invalid move. Try again.")
        except (ValueError, EOFError):
            return None

def play_game():
    board = [' '] * BOARD_SIZE
    print("Tic-Tac-Toe")
    print("Positions: 1-9 (left-to-right, top-to-bottom)")
    print_board(board)

    for turn in range(BOARD_SIZE):
        player = 'X' if turn % 2 == 0 else 'O'
        pos = get_move(board, player)
        if pos is None:
            print("\nGame ended prematurely.")
            return
        board[pos] = player
        print_board(board)
        result = check_winner(board)
        if result:
            if result == 'draw':
                print("It's a draw!")
            else:
                print(f"{result} wins!")
            return

if __name__ == "__main__":
    while True:
        play_game()
        try:
            again = input("Play again? (y/n): ").lower()
            if again != 'y':
                print("Goodbye!")
                break
        except (ValueError, EOFError):
            print("Goodbye!")
            break
