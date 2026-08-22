import sys
from PIL import Image

# Character ramp from dark to light (adjust string density for contrast)
ASCII_CHARS = [" ", ".", ":", "-", "=", "+", "*", "#", "%", "@"]


def scale_image(image, new_width=160):
    (original_width, original_height) = image.size
    # Adjust aspect ratio (terminal characters are roughly twice as tall as they are wide)
    aspect_ratio = (original_height / original_width) * 0.55
    new_height = int(new_width * aspect_ratio)
    return image.resize((new_width, new_height))


def convert_to_grayscale(image):
    return image.convert("L")


def pixels_to_ascii(image):
    pixels = image.getdata()
    characters = "".join(
        [ASCII_CHARS[pixel // 26] for pixel in pixels]
    )  # 256 / 10 = ~25.6
    return characters


def image_to_ascii(image_path, output_width=160):
    try:
        image = Image.open(image_path)
    except Exception as e:
        print(f"Error opening image: {e}")
        return

    image = scale_image(image, new_width=output_width)
    image = convert_to_grayscale(image)

    ascii_str = pixels_to_ascii(image)
    pixel_count = len(ascii_str)

    # Format character array into lines matching output width
    ascii_img = "\n".join(
        [
            ascii_str[index : index + output_width]
            for index in range(0, pixel_count, output_width)
        ]
    )

    return ascii_img


if __name__ == "__main__":
    # Replace 'zeus.jpg' with your image path
    path = "zeus.jpg"
    ascii_art = image_to_ascii(path, output_width=180)

    # Print to console
    print(ascii_art)

    # Save output to text file
    with open("zeus_ascii.txt", "w") as f:
        f.write(ascii_art)