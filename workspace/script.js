// Simple Snake Game
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const gridSize = 20; // size of each cell
const canvasSize = canvas.width; // assume square

let snake = [{x: 9, y: 9}]; // starting position (center)
let direction = {x: 0, y: 0};
let food = {x: 0, y: 0};
let gameInterval;
let speed = 150; // ms per move

function randomFood() {
    food.x = Math.floor(Math.random() * (canvasSize / gridSize));
    food.y = Math.floor(Math.random() * (canvasSize / gridSize));
    // Ensure food not on snake
    if (snake.some(seg => seg.x === food.x && seg.y === food.y)) {
        randomFood();
    }
}

function drawCell(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * gridSize, y * gridSize, gridSize, gridSize);
}

function draw() {
    ctx.clearRect(0, 0, canvasSize, canvasSize);
    // Draw food
    drawCell(food.x, food.y, 'red');
    // Draw snake
    snake.forEach((seg, idx) => {
        drawCell(seg.x, seg.y, idx === 0 ? 'green' : 'lime');
    });
}

function update() {
    // Move head
    const newHead = {x: snake[0].x + direction.x, y: snake[0].y + direction.y};
    // Wall collision
    if (newHead.x < 0 || newHead.x >= canvasSize / gridSize || newHead.y < 0 || newHead.y >= canvasSize / gridSize) {
        endGame();
        return;
    }
    // Self collision
    if (snake.some(seg => seg.x === newHead.x && seg.y === newHead.y)) {
        endGame();
        return;
    }
    snake.unshift(newHead);
    // Food check
    if (newHead.x === food.x && newHead.y === food.y) {
        randomFood();
    } else {
        snake.pop();
    }
    draw();
}

function endGame() {
    clearInterval(gameInterval);
    alert('Game Over! Your score: ' + (snake.length - 1));
    // Reset
    snake = [{x: 9, y: 9}];
    direction = {x: 0, y: 0};
    randomFood();
    gameInterval = setInterval(update, speed);
}

function handleKey(e) {
    switch (e.key) {
        case 'ArrowUp':
            if (direction.y === 1) break;
            direction = {x: 0, y: -1};
            break;
        case 'ArrowDown':
            if (direction.y === -1) break;
            direction = {x: 0, y: 1};
            break;
        case 'ArrowLeft':
            if (direction.x === 1) break;
            direction = {x: -1, y: 0};
            break;
        case 'ArrowRight':
            if (direction.x === -1) break;
            direction = {x: 1, y: 0};
            break;
    }
}

window.addEventListener('keydown', handleKey);
randomFood();
draw();
gameInterval = setInterval(update, speed);
