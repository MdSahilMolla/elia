// Simple Snake Game
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const gridSize = 20; // size of each cell in pixels
const canvasSize = canvas.width; // assume square canvas
const cellCount = canvasSize / gridSize;

let snake = [{x: 5, y: 5}]; // initial snake segments
let direction = {x: 1, y: 0}; // moving right initially
let food = randomFood();
let speed = 200; // ms per frame
let gameInterval;

function randomFood() {
  let position;
  do {
    position = {
      x: Math.floor(Math.random() * cellCount),
      y: Math.floor(Math.random() * cellCount)
    };
  } while (snake.some(seg => seg.x === position.x && seg.y === position.y));
  return position;
}

function drawCell(x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * gridSize, y * gridSize, gridSize, gridSize);
}

function update() {
  // Move snake head
  const newHead = {x: snake[0].x + direction.x, y: snake[0].y + direction.y};
  // Wall collision (wrap around)
  newHead.x = (newHead.x + cellCount) % cellCount;
  newHead.y = (newHead.y + cellCount) % cellCount;

  // Self collision
  if (snake.some(seg => seg.x === newHead.x && seg.y === newHead.y)) {
    clearInterval(gameInterval);
    alert('Game Over!');
    return;
  }

  snake.unshift(newHead);

  // Food consumption
  if (newHead.x === food.x && newHead.y === food.y) {
    food = randomFood();
    // increase speed slightly
    speed = Math.max(50, speed - 5);
    clearInterval(gameInterval);
    gameInterval = setInterval(update, speed);
  } else {
    snake.pop(); // remove tail
  }
}

function draw() {
  // Clear board
  ctx.clearRect(0, 0, canvasSize, canvasSize);

  // Draw food
  drawCell(food.x, food.y, 'red');

  // Draw snake
  snake.forEach((seg, idx) => {
    const color = idx === 0 ? 'darkgreen' : 'lightgreen';
    drawCell(seg.x, seg.y, color);
  });
}

function loop() {
  update();
  draw();
}

// Keyboard handling
window.addEventListener('keydown', e => {
  switch (e.key) {
    case 'ArrowUp':
    if (direction.y !== 1) direction = {x: 0, y: -1};
      break;
    case 'ArrowDown':
    if (direction.y !== -1) direction = {x: 0, y: 1};
      break;
    case 'ArrowLeft':
    if (direction.x !== 1) direction = {x: -1, y: 0};
      break;
    case 'ArrowRight':
    if (direction.x !== -1) direction = {x: 1, y: 0};
      break;
  }
});

// Start game
gameInterval = setInterval(update, speed);
requestAnimationFrame(function render(){
  draw();
  requestAnimationFrame(render);
});
