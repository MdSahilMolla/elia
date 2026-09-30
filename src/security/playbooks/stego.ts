import type { Playbook } from './index.ts'

/**
 * Data hidden in an ordinary-looking file.
 *
 * The through-line: the highest-yield check in the whole category is two
 * seconds long — is there data after the real end of this file? — and most
 * people skip it. Everything after that is the standard hiding places in the
 * order they are actually found in practice: appended data, metadata, embedded
 * files, LSB, then audio/spectrogram.
 */
export const stegoPlaybook: Playbook = {
  category: 'stego',
  summary:
    'Find the payload hiding inside a plausible-looking file. Triage the real type, check immediately for data appended past the real EOF, then work the standard hiding places in order: metadata, embedded files, LSB/channel tricks, and audio spectrograms.',
  detect: [
    'An image or audio file that is larger — or noisier, or flatter — than its pixel/sample count justifies.',
    'A file whose `file` magic disagrees with its extension: a `.png` that is JPEG, a `.jpg` that is a zip, a `.txt` that is an image.',
    'A filename or brief containing steg, lsb, hidden, invisible, or a phrase like "nothing to see here".',
    'A "corrupted"/"broken" second copy supplied alongside a good one — the diff between them is often the payload.',
    'A small image with an implausible byte size, or a palette with hundreds of unused entries.',
  ],
  steps: [
    {
      title: 'Triage: the extension is a claim, the bytes are evidence',
      note:
        'Two commands before anything else. `file` tells you what it really is, and the size against the format\'s own accounting tells you whether there is room for a hidden payload at all. A 4x4 PNG that is 300 KB has something appended; a 4x4 PNG that is 300 bytes does not, and the answer is in the pixels instead.',
      commands: [
        'ls -l photo.png',
        'file -k photo.png',
        'xxd -l 64 photo.png',
        'identify photo.png                        # ImageMagick: dimensions, depth, alpha, colour count',
        'ffprobe -hide_banner photo.wav            # duration, channels, sample rate',
        'strings -a -n 6 photo.png | head -40',
      ],
      signals: [
        '`file` reports a different format than the extension → a renamed file or a polyglot. Work from the real type; a JPEG LSB tool on a PNG is a dead end.',
        '`file` says "data" for a media extension → the bytes are raw, encrypted, or a headerless fragment. Go to binwalk/xxd before any stego tool.',
        'File size far exceeds what the reported dimensions allow → appended data or an embedded file, not LSB. Jump to step 2.',
        'A 2-colour or small-palette image with a large file size → the payload is in the palette order or the pixel indices, not the bit depth.',
        'Two supplied copies that differ in size → diff them first; the delta is the payload.',
      ],
    },
    {
      title: 'Check for data after the real EOF first — the single highest-yield check',
      note:
        'Appending a second file after the image\'s terminator is the most common stego trick in the category, and it takes seconds to rule in or out. A ZIP is *located by its central directory at the end of the file*, so an archive appended to a PNG opens directly from the PNG with `7z x` — no carving needed. Find the terminator (PNG: last `IEND` chunk; JPEG: the final `FFD9`; GIF: the `;` trailer), read everything after it, and `file` the result. The recipe below is portable and beats guessing a `dd` offset, which you cannot compute by hand.\n\n```python\n# tail_extract.py — usage: python3 tail_extract.py photo.png IEND [tail.bin]\nimport sys\ndata = open(sys.argv[1], "rb").read()\nmarker = sys.argv[2].encode()\nend = data.rfind(marker) + len(marker)\nprint(f"real end at {end:#x}; {len(data) - end} trailing bytes")\nif len(data) > end:\n    open(sys.argv[3] if len(sys.argv) > 3 else "tail.bin", "wb").write(data[end:])\n```\n\nFor JPEG the marker is two raw bytes, so pass a hex form: search for `\\xff\\xd9` and add 2.',
      commands: [
        'xxd photo.png | tail -20',
        'xxd photo.jpg | tail -20',
        'tail -c 512 photo.png | xxd',
        'binwalk photo.png',
        'binwalk -D photo.png                        # carve every embedded signature, offsets in names',
        'binwalk -e photo.png                        # extract automatically',
        '7z l photo.png                             # a ZIP appended to a PNG lists here directly',
        'write_file tail_extract.py                  # then: python3 tail_extract.py photo.png IEND',
        'file tail.bin',
        '7z x photo.png                             # a good-enough first attempt at the whole thing',
      ],
      signals: [
        'Anything readable after the last `IEND`/`FFD9`/trailer → that is your payload. `file` it before doing anything clever.',
        'The trailing bytes start with `PK\\x03\\x04`, `GIF8`, `\\x89PNG`, `Rar!`, or `\\x7fELF` → carve at that offset, or just open the original with the right tool.',
        'The trailing bytes are high-entropy gibberish of the same size as the image → the image and the trailing block are one XOR/encrypted pair; XOR them and check the magic.',
        'The trailer appears more than once, or `tail` shows only a few stray bytes → benign padding, not a payload. Move on to metadata.',
      ],
    },
    {
      title: 'Read the metadata',
      note:
        'Free, and it is the answer often enough to do before anything heavier. Comments, descriptions, XMP, and leftover thumbnails are all common hiding places, and a thumbnail in particular is a whole second image the main view never showed.',
      commands: [
        'exiftool photo.jpg',
        'exiftool -G1 -s -a photo.jpg',
        'exiftool -b -Comment photo.jpg > comment.txt ; file comment.txt',
        'exiftool -b -ThumbnailImage photo.jpg > thumb.jpg ; file thumb.jpg',
        'strings -a -n 6 photo.png | grep -iE "flag|ctf|key|password|secret"',
        'python3 -c "import zlib,struct; print(\'zlib ok\')"   # import probe only',
      ],
      signals: [
        'A `Comment`, `Description`, `XPComment` or `XMP` field holding base64, hex, or the flag itself → decoded base64/hex is the next step.',
        'A thumbnail present in a file that "should not have" one → the thumbnail is a different image; open it and run the whole playbook on it.',
        'A GPS field, artist field, or software string that is oddly specific → usually a hint for the password of a password-protected stego tool, not the flag itself.',
        'Nothing in the metadata but a `Comment` that is a phrase → treat it as the stego password, not as a clue to decode.',
      ],
    },
    {
      title: 'Carve embedded files with binwalk and foremost',
      note:
        'Different verbs, different results: `binwalk` finds and locates embedded signatures, `-D` carves them out with offsets in the filenames, `-e` extracts using built-in extractors, and `foremost` carves by file signature independently of binwalk. Running both is cheap and they do find different things.',
      commands: [
        'binwalk photo.png',
        'binwalk -D photo.png',
        'binwalk -e photo.png',
        'foremost -i photo.png -o carved/',
        'foremost -i mystery.bin -o carved/ -t all',
        '7z l photo.jpg',
        'file carved/*',
      ],
      signals: [
        'binwalk prints a second PNG/ZIP/JAR/GIF/ELF at a byte offset → extract at that offset, or read the carved output it produced.',
        'An offset that is not page-aligned and is followed by more structure → real embedded file, not a coincidental magic match.',
        'binwalk reports a large entropy block with no signature → encrypted or compressed payload; that is a crypto/pwn question, not a stego one.',
        '`foremost` recovers files binwalk missed (it uses full file signatures, not just leading magic) → run both before concluding there is nothing inside.',
      ],
    },
    {
      title: 'LSB and the per-format stego tools',
      note:
        'Each tool covers a different format and a different hiding scheme, and using the wrong one is the most common wasted call. `zsteg` is PNG/BMP bit-plane analysis and reports what it finds; `steghide` is JPEG/BMP/WAV/AUDIO/AVI with a passphrase; `outguess` is JPEG with a passphrase; `openstego` is PNG LSB. Most of these want a password, and the password is nearly always derivable from the challenge text rather than brute-forced.',
      commands: [
        'zsteg photo.png',
        'zsteg -a photo.png                          # all bit orders and channels',
        'zsteg --channel=a photo.png                 # the alpha plane is a classic and is NOT in the default pass',
        'steghide info photo.jpg -p ""',
        'steghide extract -sf photo.jpg -p "" -xf out.txt -f',
        'steghide extract -sf photo.jpg -p "challengeword" -xf out.txt -f',
        'outguess -r photo.jpg out.txt -k ""',
        'openstego extract -sf photo.png -xd out.png',
        'file out.txt',
      ],
      signals: [
        'zsteg reporting "bits: 1" and a `b1,lsb,xy` or `b1,rgb,xy` entry whose extracted data is *another PNG or ZIP header* → a nested file, not a flag. `file` the output and recurse.',
        'zsteg returning nothing on a PNG but data existing → try the alpha plane (`--channel=a`), a specific colour channel, or a different bit order; the default pass is not exhaustive for every generator.',
        'steghide reporting "Could not find any data embedded" → either wrong password or the file is not its format. It does **not** handle PNG at all.',
        'A tool that succeeds and writes a file whose `file` output is "data" → the extracted blob is another layer; decode/zip/carve it.',
      ],
    },
    {
      title: 'Structure: channels, palette, and a diff against a clean copy',
      note:
        'When the LSB tools come up empty the payload is in the *structure*: one colour channel, the palette order, the alpha plane, or a difference between two supplied images. Splitting channels and comparing are cheap and are the right move when the challenge gives you a "normal" copy to diff against.',
      commands: [
        'identify -verbose photo.png                  # depth, colours, alpha, palette entries',
        'magick photo.png -channel R -separate r.png  # also G, B, A',
        'magick photo.png -alpha extract alpha.png',
        'magick photo.png -colors 2 -depth 1 pal.png   # a 2-colour image is usually a bitmap of something',
        'compare -metric AE original.png photo.png diff.png',
        'write_file channels.py                        # count unique colours / dump the palette order',
      ],
      signals: [
        'A palette with hundreds of mostly-unused entries → the mapping from index to colour is the message; dump the index array, not the rendered image.',
        'One channel visually blank or visibly different from the others → that is where the data is; `zsteg` it on its own.',
        'A large number of exactly two unique colours → a 1-bit-per-pixel bitmap; view it directly and it may be a QR code or text.',
        '`compare -metric AE` reporting a small non-zero pixel count between two copies → the differing pixels are the payload.',
      ],
    },
    {
      title: 'Audio: spectrogram, then the raw samples',
      note:
        'Audio stego is either visual (a spectrogram carrying text or a picture) or sample-level (data encoded in the low bits or in the LSB of the sample values). Render the spectrogram first — it is fast and the answer is often legible — and go to the raw samples only when the spectrogram is clean.',
      commands: [
        'sox sound.wav -n spectrogram -y spec.png',
        'ffmpeg -i sound.wav -lavfi showspectrumpic=s=1920x1080 spec.png',
        'ffmpeg -i sound.wav -ac 1 -ar 44100 raw.s16 -f s16le',
        'xxd sound.wav | head -40                       # RIFF chunk list: LIST/INFO often holds the flag',
        'sox sound.wav out.wav trim 0 0:30               # isolate a region that looks wrong',
        'ffprobe -hide_banner sound.wav',
      ],
      signals: [
        'Text or a picture in the spectrogram → read it; the answer is often written at a specific frequency band.',
        'A suspiciously blank or flat rectangle in the middle of an otherwise detailed spectrogram → something was replaced; isolate it with `sox ... trim` and decode it separately.',
        'A `LIST`/`INFO` chunk in the RIFF header containing a comment or a long string → metadata, not signal processing.',
        'Morse, DTMF, or a spoken-number track → `ffmpeg -ac 1` to mono and listen or decode; this is really a misc problem wearing an audio file.',
      ],
    },
    {
      title: 'Verify the payload is the flag and not one more layer',
      note:
        '"I found hidden data" is a finding; "solved" is a flag. The extracted blob is very often not the answer — it is another image, a password-protected archive, or a base64 string. So the last step of every stego solve is the same: `file` the payload, and if it is not the flag form, recurse with the tool that fits whatever `file` just said. This is also where you report the exact command, because in stego the evidence for the solve is the command that recovered it.',
      commands: [
        'file out.txt',
        'xxd out.txt | head -4',
        'strings -a out.txt | head -10',
        'cat out.txt',
        'base64 -d out.txt > next ; file next',
        '7z l out.txt',
        'zsteg out.png                            # a nested image is its own stego challenge',
        'write_file tail_extract.py ; python3 tail_extract.py out.png IEND',
      ],
      signals: [
        'The payload contains `flag{`, `CTF{`, or the challenge\'s own prefix → solved. Note which tool produced it.',
        '`file` says PNG/ZIP/GIF/ELF → recurse with the appropriate playbook; you have found a container, not the flag.',
        'The payload is base64/hex/rot13 → the crypto or misc playbook decodes it; do not report the encoded form.',
        'The payload is high-entropy with no structure and no `file` match → it is encrypted, not stego. The answer needs a key from the challenge text, and guessing is a dead end.',
        'The payload decodes to a password and nothing else → that password usually unlocks a second artifact; go back to step 2 with it.',
      ],
    },
  ],
  gotchas: [
    'The least significant bit of the **alpha** channel is a standard hiding place and the default `zsteg` pass does not always reach it. Use `zsteg --channel=a`, or split the plane with `magick photo.png -alpha extract alpha.png` and analyse that on its own.',
    'Colour-channel ordering and palette-vs-pixel confusion are the two things that make a correct extraction look wrong. BGR instead of RGB, the palette index instead of the colour value, or a 1-bit image read as 8-bit all produce plausible garbage. `zsteg` tries many orders — if it finds nothing, extract the raw channel bytes yourself rather than trying more flags.',
    'A polyglot is valid in two formats at once (GIF+ZIP, JPEG+ZIP, PNG+anything after `IEND`). `file` only ever reports the first format it recognises, so `file` disagreeing with itself across two commands, or binwalk finding a second signature, is the tell. Tail-check and binwalk together find what `file` misses.',
    '`steghide`, `outguess`, and `openstego` are password-protected. The password in a CTF is almost always derivable — the empty password, the challenge name, the author, the year, something in the metadata, or a supplied wordlist. Brute-forcing without a candidate list is not a plan; if you must loop, use `wordlists/rockyou.txt` and expect it to be the intended move only when the challenge says so.',
    '`zsteg` is PNG/BMP only. JPEG compresses with DCT and quantises, so LSB data in a JPEG does not survive unless the quality is very high — a JPEG LSB challenge is almost always a different trick (appended data, a comment segment, or a password tool).',
    'Run `exiftool` read-only. It rewrites files when told to, and the flags that control that (`-overwrite_original`, `-o`) are one typo away from destroying the only copy of the artifact.',
    '`foremost` and `binwalk` find different things: binwalk keys on leading magic and signature-ish patterns, foremost on full file signatures. Running only one of them produces a false "nothing embedded here".',
    'A `.wav` is a RIFF *container*: `LIST`, `ID3 `, and `INFO` chunks sit in the header and often hold the answer, so `xxd sound.wav | head` is worth its two seconds before any DSP.',
  ],
  successShape:
    'A recovered string in flag form — `flag{...}`, `STEG{...}` — surfaced either as text from a stego tool, in a hex dump, in an EXIF field, or legible in a spectrogram. The payload is frequently one more layer: a base64 string, a second image, or a password-protected archive. "I found hidden data" and "solved" are different claims, and only the second one is worth reporting.',
}
