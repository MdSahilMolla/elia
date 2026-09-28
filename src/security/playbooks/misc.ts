import type { Playbook } from './index.ts'

/**
 * The residual category: forensics, encoding puzzles, network captures, and
 * anything that does not fit the other four.
 *
 * Two things make misc tractable. First, `file` on every artifact before
 * anything else — a meaningful fraction of misc challenges turn out to be a
 * mislabelled image or a renamed script, and that takes ten seconds to learn.
 * Second, the honest caveat that runs through this whole playbook: "misc" is
 * what a challenge gets called when it does not obviously belong to pwn, rev,
 * crypto or stego, which means a real share of them *do* belong and were just
 * mis-detected. Re-classifying beats grinding.
 */
export const miscPlaybook: Playbook = {
  category: 'misc',
  summary:
    'The residual bucket: forensics, encoding chains, network captures, file-format oddities, and pure guessing puzzles. Triage every artifact with `file` first, try the cheap and obvious in a fixed order, then work the format family the artifact actually belongs to — and re-check whether it was simply one of the other four mislabelled.',
  detect: [
    'A bag of unrelated files with no common theme: an image, a log, a pcap, a script, a spreadsheet.',
    'A network service (host:port) to talk to, or a packet capture to read.',
    'An encoding puzzle: base64/hex/rot13/morse/brainfuck, a partially human-readable string, or a "decode this" brief.',
    'A file whose format is unusual or disputed: a PDF with no visible text, an audio file that must be *looked at*, a video whose frames matter.',
    'A challenge with no category tag at all, or one whose tag is the only thing separating it from a specific category.',
  ],
  steps: [
    {
      title: 'List and `file` everything before touching a single artifact',
      note:
        'Ten seconds, and it changes what every later command should be. `file` is the cheapest information in the whole category: it catches a `.txt` that is a PNG, a `.jpg` that is a zip, and a 4 MB "empty" file that is not. Then check the sizes — one artifact being dramatically larger or smaller than its siblings is usually the one that matters.',
      commands: [
        'ls -laR .',
        'file *',
        'file -k *                    # force magic detection past the extension',
        'wc -c *                     # relative sizes are themselves a signal',
        'xxd -l 32 mystery_file',
      ],
      signals: [
        'A `.txt` that `file` calls PNG/JPEG image data → it is an image. Switch to the stego playbook.',
        'A `.jpg` that `file` calls a Zip archive → it is an archive, or a polyglot. `unzip -l` it.',
        'A file whose `file` output is "data" with an innocuous extension → raw/encrypted bytes. `strings`, `xxd`, and `binwalk` before anything clever.',
        'One file orders of magnitude larger than the rest → appended data or an embedded payload. Compare against what its format should weigh.',
        'A file with no read permission or an odd mode/ownership → the container is hiding something structurally, not cryptographically.',
      ],
    },
    {
      title: 'The cheap and obvious, in this exact order',
      note:
        'Run these in sequence and stop as soon as one lands. It is a bad idea to skip ahead to a clever idea while a plaintext flag is sitting in a hex dump two commands away. Keep each intermediate output as its own file and re-run `file` on it — that is how a three-layer chain gets found.',
      commands: [
        'strings -a -n 6 file | head -60',
        'strings -a -n 6 file | grep -iE "flag|ctf|key|pass|secret|base64"',
        'xxd file | head -20',
        'xxd file | tail -20',
        'base64 -d file > out ; file out',
        'xxd -r -p file > out ; file out          # hex decode',
        'tr "A-Za-z" "N-Za-z" < file > out ; file out   # rot13',
        'wc -c file',
      ],
      signals: [
        'A long run of `[A-Za-z0-9+/=]` → base64; a run of `[0-9a-f]` with even length → hex; `A-Z2-7=` padding → base32; `0`/`1` with spaces in fixed groups → binary.',
        'Text that is entirely printable but not English → rot-N, a Caesar shift, or a substitution. Count character frequencies before assuming which.',
        '`base64 -d` succeeds but the output is not text → it is another layer, or you are on the wrong file. `file` the output and go again.',
        'The hex dump shows a recognisable header (`%PDF`, `PK\\x03\\x04`, `\\x89PNG`, `\\x7fELF`) at a non-zero offset → the payload is at that offset; extract it.',
        'A `-`/`_` alphabet with digits ≥ 32 → base64url, which `base64 -d` rejects until you translate the alphabet.',
      ],
    },
    {
      title: 'Barcodes, QR codes, and anything that has to be *looked at*',
      note:
        'A QR code is an encoding puzzle that is invisible to `strings`. Decode it before assuming the challenge is about the image. If a code is present but will not scan, it is usually low-contrast, inverted, partially covered, or too small — clean and re-invert it, and try a higher-resolution decode pass.',
      commands: [
        'zbarimg file.png',
        'zbarimg -q --raw -Sbinary file.png > out.bin ; file out.bin',
        'zbarimg -q --raw -Sqrcode file.png > decoded.txt',
        'magick file.png -colorspace Gray -threshold 50% -negate clean.png ; zbarimg clean.png',
        'magick file.png -resize 400% -sharpen 0x1 big.png ; zbarimg big.png',
      ],
      signals: [
        'A decoded blob that is itself an image, a zip, or a URL → recurse: it is another artifact, not the answer.',
        'A decoded string that looks like base64 or a key → hand it to the crypto playbook.',
        'A code that scans only after thresholding/inverting → it was a contrast or polarity problem, not a dead end.',
        'No code detected in a large image → look at it. A rendered QR at low DPI, a Data Matrix, or a rotated code will not be found by `zbarimg` at the default settings.',
      ],
    },
    {
      title: 'Network artifacts: pcap, or a service to talk to',
      note:
        'Two different jobs. A pcap is already solved data — reconstruct the conversation rather than sniffing for live traffic. A live service is the opposite: you have to be the client, and the first job is to find out what it expects. Either way, read the request headers before the payload; a `Cookie`, an `Authorization` header, or a `flag.txt` GET is frequently the entire puzzle.',
      commands: [
        'file capture.pcap',
        'tshark -r capture.pcap -q -z conv,tcp',
        'tshark -r capture.pcap -Y "http.request" -T fields -e http.host -e http.request.uri -e http.cookie',
        'tshark -r capture.pcap --export-objects http,outdir',
        'tshark -r capture.pcap -Y "dns" -T fields -e dns.qry.name',
        'strings -a capture.pcap | grep -iE "GET |POST |Host:|Authorization|flag|Content-Type"',
        'ncat HOST PORT',
        'printf "GET / HTTP/1.1\\r\\n\\r\\n" | ncat HOST PORT',
        'socat - TCP:HOST:PORT',
      ],
      signals: [
        'An HTTP request with a `Cookie`/`Authorization` value → base64-decode it (or split on `:`) and the flag is right there.',
        '`--export-objects http,outdir` writing several files → each is a downloaded artifact; `file` and the stego playbook apply to them.',
        'A DNS query to a suspicious name, or a TXT record → the answer may be in the query itself; read it character by character if it is not readable.',
        'A service that says nothing until you send a newline → send one, then look again. Many write a prompt only after a first read.',
        'A service that wants raw bytes rather than a line → `printf "\\x00\\x00" | ncat HOST PORT`, and remember `ncat --send-only` if it is one-directional.',
        'A TLS session with a certificate name or a self-signed subject that is a message → the flag may be in the certificate, not the traffic.',
      ],
    },
    {
      title: 'Work the file-format family the artifact belongs to',
      note:
        'Each format has one tool that solves the standard version of its own problem, and reaching for it is nearly always faster than the generic approach. The recurring theme is that the interesting content is in a part the normal viewer ignores: a PDF stream object, an embedded object in a document, a single video frame, a trailing archive chunk.',
      commands: [
        '# PDF',
        'pdftotext file.pdf -',
        'pdfimages -list file.pdf',
        'qpdf --qdf --object-streams=disable file.pdf out.pdf     # then read out.pdf as text',
        'pdftk file.pdf dump_data',
        'strings -a file.pdf | grep -iE "flag|/JavaScript|stream"',
        '# Office documents',
        'soffice --headless --convert-to txt file.docx --outdir out/',
        'soffice --headless --convert-to txt:"Text (encoded)" file.xls --outdir out/',
        'unzip -l file.docx                         # media, embeddings, and customXml are all worth reading',
        '# Audio / video',
        'ffmpeg -i file.mov -vf fps=1 frame%03d.png',
        'ffmpeg -i file.m4a -ac 1 -ar 44100 out.wav',
        'sox file.wav out.wav trim 0 0:30',
        'ffmpeg -i file.mp4 -vf "select=eq(n\\,120)" -vframes 1 still.png',
        '# Archives',
        '7z l file.7z',
        'unzip -l file.zip',
        'bsdtar -tf file.tar.gz',
        '7z x file.zip -p<password>',
        'zsteg file.png                             # a stego "archive" is usually an image, not a zip',
      ],
      signals: [
        'A PDF that `pdftotext` returns nothing for, but that is several hundred KB → the text is in a compressed stream; `qpdf --qdf --object-streams=disable` and read the result.',
        'A PDF with `/JavaScript`, an OpenAction, or form fields → `pdftk dump_data` or the qdf output; the flag is frequently a form field value or a JS string literal.',
        '`unzip -l` on a document showing `word/media/*` or `xl/embeddings/*` → an embedded object that is its own puzzle.',
        'A video where one frame is a distinct colour or a still image → extract that frame and treat it as an image; a subtitle track (`.srt`, `.vtt`) is often a separate file inside the container.',
        'A zip that fails to extract → check the method (`7z l` shows it) and try the challenge-supplied wordlist; a non-standard method number means the header is part of the puzzle.',
      ],
    },
    {
      title: 'When a wordlist is the intended tool, build a targeted one first',
      note:
        'Before reaching for a 14-million-line list, mine the challenge text: title, author, year, theme, and anything a human chose. A targeted list of a few hundred entries finishes in seconds and a full rockyou run can take minutes. This applies to hashes, archive passwords, stego passwords, and anything else where the secret is human-chosen.',
      commands: [
        'write_file words.txt            # targeted: title, author, year, theme, leetspeak variants, numbers',
        'john --wordlist=words.txt hashes.txt      # CTF-scoped: the hash in the challenge, nothing else',
        'john --wordlist=words.txt --rules file.zip',
        'hashcat -m 0 hashes.txt words.txt         # -m 0 = MD5, 100 = SHA1, 1400 = SHA2-256',
        '7z x file.zip -p$(head -1 words.txt)     # quick manual check of the top candidate',
        'grep -iE "password|key|secret" words.txt',
      ],
      signals: [
        'A mask hint in the brief (`?l?l?l?d?d?d?d`) → it is a hashcat mask, not a dictionary problem: `hashcat -m <mode> hashes.txt -a 3 "?"...`.',
        'The archive/cipher password is a phrase from the challenge text → it is in your own notes, not in rockyou.',
        'Nothing in the full wordlist works → the secret is not a dictionary word. Re-read the brief: it is probably a derived value (a hash, a key, a transform of something you already have).',
        'The service is a login form and you need a valid credential → that is an authorised-engagement brute force; check the challenge brief states the target is in scope, and never point a cracker at anything else.',
      ],
    },
    {
      title: 'Disk images and memory dumps, when that is what you were given',
      note:
        'A `.raw`/`.dd`/`.E01`/`.pcap`-sized blob or a `memory.dmp` is forensics, not guesswork, and the workflow is a fixed one: identify the filesystem, list it, extract, then treat each extracted file as its own misc/stego/rev challenge. Do not try to read it with `strings` and hope.',
      commands: [
        'file image.dd',
        'fdisk -l image.dd',
        '7z l image.dd                            # works surprisingly often and needs no tooling',
        'mount -o loop,ro image.dd /mnt/evidence   # read-only, always',
        'find /mnt/evidence -type f -name "*.txt"',
        'python3 -m volatility3 -f memory.dmp windows.info',
        'foremost -i image.dd -o carved/ -t all',
        'scalpel image.dd -o carved2/',
      ],
      signals: [
        '`file` says "disk image" or "DOS/MBR" → mount read-only and browse; the flag is almost always a plain file in the tree.',
        'An unallocated region with no visible file → carve it with foremost/scalpel; deleted files are not in the directory tree.',
        'A memory dump → the interesting artifacts are the process list, the command line, environment variables, and open file handles before anything else.',
        'A filesystem that will not mount cleanly → `testdisk` / `photorec` for the partition layout, and re-check whether it is an EWF (`ewfinfo`) that needs converting first.',
      ],
    },
    {
      title: 'Re-classify before you run out of budget',
      note:
        'Say this out loud in your own reasoning: a large share of "misc" challenges are pwn, rev, crypto or stego that was mislabelled, had a lying extension, or is really a different category once you read it. Re-run detection with the concrete artifact names you now have — that is a much better input than the original brief, and it is a cheap way to stop grinding the wrong procedure.',
      commands: [
        'file *',
        'ctf_playbook  { "hints": ["chall.elf", "ret2win"] }',
        'ctf_playbook  { "hints": ["app.apk", "jadx"] }',
        'ctf_playbook  { "hints": ["photo.png", "LSB"] }',
        'ctf_playbook  { "hints": ["cipher.txt", "RSA"] }',
      ],
      signals: [
        '`file` says ELF / PE / Mach-O → pwn or rev, and you have been guessing at a binary you could have disassembled in one command.',
        'The artifact is an image whose size does not match its dimensions → stego, and the tail-check is two seconds.',
        'The numbers have structure (a modulus, repeated 16-byte blocks) → crypto, and the right attack is already written down.',
        'Nothing classifies even after re-running `file` → it really is misc, and you are back in this playbook with better information.',
      ],
    },
  ],
  gotchas: [
    'A `.txt` that is really an image, and a `.png` that is really a script or a zip, are both routine in this category. `file` on the *first* artifact you open is not optional, and `file -k` when the magic is ambiguous. An hour of encoding transforms on a JPEG is an hour that a single `file` would have saved.',
    'Chained encodings are the norm, not the exception: base64 → hex → rot13 is three layers, and the layer boundary is usually not marked. Re-run `file` and check the character class after *every* decode, and keep the intermediates as separate files instead of piping blindly — otherwise you cannot tell which step produced readable text.',
    'The answer sometimes needs a wordlist you do not have. `hashcat` and `john` are high-capability cracking tools and belong to an authorised engagement: against a challenge file that is entirely appropriate, but check the target really is the challenge artifact and never point one at a system or third-party password file.',
    '`misc` includes forensics. A disk image or a memory dump is not a `strings` problem — it is filesystem/browser/process analysis, and the right first move is `file`, then mount read-only or run a volatility target. Treating a 2 GB image with `strings` wastes the whole budget.',
    'A network service can need raw bytes rather than a line, can need a newline *before* it will print its banner, and can need two round trips (banner, then payload). If a single `ncat HOST PORT` looks dead, try sending a bare newline and a bare `GET /` before concluding the port is wrong.',
    'Beware the obvious. A flag sitting in plaintext in a `strings` dump that you skimmed past three times is a real failure mode in this category — re-read the plain text output before automating anything, because human eyes are faster than your pipeline for the first pass.',
    '`soffice --headless` writes a lock file and can hang waiting on a profile on a server with no home directory. Pass `-env:UserInstallation=file:///tmp/lo` and always convert a *copy*, since LibreOffice rewrites formats aggressively on save.',
    'Not every "unreadable" file is a puzzle. Before building a decoder, check whether the artifact is a known format with a viewer you have not used yet (a `.pcap` in Wireshark, a `.mp4` in a player, a `.docx` in an office suite) — the tool you are missing is more often the answer than the cipher is.',
  ],
  successShape:
    'A flag-form string — `flag{...}`, or the challenge\'s own prefix — recovered from an extracted file, a decoded chain, a packet capture, a carved block, or the output of a service. If the challenge wanted a *derived* value (a hash, a serial, a password that unlocks a file), that derived value is what you report, and you should say which artifact produced it. Naming the artifact and the exact command is part of the answer in a misc solve, because the reasoning is what is being checked.',
}
