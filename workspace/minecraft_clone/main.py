# Simple Minecraft-like voxel world using Ursina
# This is a minimal example: a flat terrain of blocks you can walk on.
# Install dependencies: pip install ursina

from ursina import *

app = Ursina()

# Define a block class
class Voxel(Button):
    def __init__(self, position=(0,0,0), texture='white_cube'):
        super().__init__(
            parent=scene,
            position=position,
            model='cube',
            origin_y=0.5,
            texture=texture,
            color=color.white,
            highlight_color=color.lime,
        )
        self.texture = texture
        self.position = position
        self.model = 'cube'
        self.origin_y = 0.5
        self.highlight_color = color.lime
        self.color = color.white
        self.parent = scene
        self.collision = True
        self.scale = (1,1,1)
        self.visible = True
        self.enabled = True
        self.pressed = False
        self.hovered = False
        self.highlighted = False
        self.unlit = False
        self.shader = None
        self.texture = texture
        self.position = position
        self.model = 'cube'
        self.origin_y = 0.5
        self.highlight_color = color.lime
        self.color = color.white
        self.parent = scene
        self.collision = True
        self.scale = (1,1,1)
        self.visible = True
        self.enabled = True
        self.pressed = False
        self.hovered = False
        self.highlighted = False
        self.unlit = False
        self.shader = None
        # Set block to be solid
        self.collider = 'box'
        # Allow interaction
        self.on_click = self.input

    def input(self, key):
        if key == 'right mouse down':
            # Place a new block adjacent to this one
            Voxel(position=self.position + mouse.normal, texture='white_cube')
        if key == 'left mouse down':
            # Destroy this block
            destroy(self)

# Generate flat ground
for x in range(-10, 11):
    for z in range(-10, 11):
        Voxel(position=(x,0,z), texture='grass')

# Add a player controller
player = FirstPersonController()

# Sky and lighting
Sky()
AmbientLight(color=color.white)

app.run()
