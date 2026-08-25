import random

def main():
    """Simple number guessing game.

    The computer picks a random integer between 1 and 100.
    The player tries to guess it, receiving feedback after each guess.
    The game ends when the player guesses correctly or types 'quit'.
    """
    number = random.randint(1, 100)
    attempts = 0
    print("Welcome to the Number Guessing Game!")
    print("I have selected a number between 1 and 100.")
    print("Type your guess and press Enter. Type 'quit' to exit.")
    while True:
        guess = input("Your guess: ").strip()
        if guess.lower() == "quit":
            print(f"Thanks for playing! The number was {number}.")
            break
        if not guess.isdigit():
            print("Please enter a valid number.")
            continue
        guess_int = int(guess)
        attempts += 1
        if guess_int < number:
            print("Too low! Try again.")
        elif guess_int > number:
            print("Too high! Try again.")
        else:
            print(f"Congratulations! You guessed the number in {attempts} attempts.")
            break

if __name__ == "__main__":
    main()
