import type { Playbook } from './index.ts'

/**
 * Applied cryptography where the *implementation* is the bug, not the maths.
 *
 * The through-line: turn the artifact into numbers, name the scheme from its
 * structure rather than from the challenge's prose, then look for the one
 * elementary property that was violated. Almost nothing here needs a lattice or
 * a solver — the overwhelming majority of CTF crypto is a small exponent, a
 * reused nonce, ECB, or a PRNG seeded with something guessable. Save `z3` and
 * SageMath for the case where the scheme genuinely is underdetermined.
 */
export const cryptoPlaybook: Playbook = {
  category: 'crypto',
  summary:
    'Break the implementation, not the primitive. Convert the artifact to numbers, identify the scheme from its structure, find the one violated property (small e, shared modulus, reused nonce, ECB, guessable seed, missing MAC), and implement the single attack that property enables. SageMath/z3 are for the minority of cases that need them.',
  detect: [
    'Numbers that look cryptographic: a long decimal or hex modulus, an exponent, a set of small primes, or a ciphertext of exactly n bytes.',
    'A `flag.enc`, `cipher.txt`, `message.bin`, `secret.pem`/`.key`/`.pub`, `.gpg` or similar encrypted/keyed artifact.',
    'A narrative about encryption: "we encrypted your message", "Bob sent Alice", "recover the plaintext".',
    'A hex string of a fixed length (16/32/48/64 chars) with no other structure — an MD5, SHA-1, SHA-256, an AES key, or an IV.',
    'Source code containing `pow(`, `Crypto`, `Fernet`, `hashlib`, `random`, or a hand-rolled XOR/Caesar/S-box.',
  ],
  steps: [
    {
      title: 'Turn the artifact into numbers before theorising',
      note:
        'Almost every wasted hour in this category starts as theorising over a file nobody has read. Look at the bytes, get the sizes and the character set, and write down what the numbers *are* before deciding what they might mean.',
      commands: [
        'file challenge',
        'xxd challenge | head -20',
        'xxd challenge | tail -5',
        'strings -a challenge',
        'wc -c challenge',
        'cat challenge              # frequently it is one long number, or a short Python snippet',
      ],
      signals: [
        'A single long decimal or hex value → an RSA `c` or `n`. Two values (`n`, `e`) or three (`c`, `e`, `n`) → textbook RSA, unpadded.',
        'A hex blob whose length is a multiple of 16 → AES. Multiples of 8 only → DES/3DES/Blowfish. A 12/16-byte file → an IV or nonce.',
        'Two long values that are the same length and share a long common prefix → plaintext blocks under ECB, or a reused keystream.',
        'A file that is mostly printable ASCII but nonsense words → it is encoded or enciphered with a classical cipher, not a modern block cipher.',
        'A readable Python/shell source file → the scheme is stated explicitly; read it before guessing. Many "crypto" challenges ship the encryption script.',
      ],
    },
    {
      title: 'Name the scheme from its structure, and find the violated property',
      note:
        'Use this table. Each row is a structural signal with the exact attack it licenses — read the row that matches your data, not a generic reference on RSA.\n\n- **textbook RSA, small e** (e = 3, and m³ < N): the ciphertext is a perfect cube. `sympy.integer_nthroot(c, 3)` returns m directly. If m³ >= N, use root or low-exponent lattice methods instead.\n- **shared modulus**: two ciphertexts with the same `n` and coprime exponents e1, e2 → `m = c1 * pow(c2, -1, n) mod n`, no factoring needed. Confirm `gcd(e1, e2) == 1` first.\n- **small private exponent**: d < N^0.25/3 → Wiener. The continued-fraction expansion of e/n contains d.\n- **close or weak primes**: p and q close → Fermat (incremental `isqrt` from `isqrt(n)`). Small factors → Pollard p-1 (`sympy.ntheory.factor_.pollard_pm1`) or ECM via `sage factor(n)`.\n- **partial key disclosure**: some high or low bits of `p` or `m` given → Coppersmith `small_roots`, which recovers a root smaller than N^β when β > 1/e.\n- **AES-ECB**: identical plaintext blocks produce identical ciphertext blocks → look for repeated 16-byte chunks in a long ciphertext, and reordering them reorders the plaintext.\n- **CBC with a reused IV and no MAC**: XOR of two ciphertexts = XOR of the first plaintext blocks. Strip the first block and look for a known header (`flag{`, PNG magic, `PK\\x03\\x04`).\n- **CTR/GCM with a reused nonce**: XOR the two ciphertexts to recover the keystream at that offset, then decrypt the other message with it. GCM nonce reuse additionally leaks the authentication subkey (`H`), which forges tags.\n- **weak keystream**: RC4 with a short or known key, an LCG, `random.seed(1337)`, or MT19937 → recover the state and regenerate. `random` with any other seed is *not* brute-forceable; look for the seed in the source instead.\n- **hash abuse**: a 32-char hex is an MD5, 40 a SHA-1, 64 a SHA-256; length extension applies to `H(secret || msg)` when the secret length is unknown; a padding oracle exists when valid and invalid padding get distinguishable behaviour (error text, status code, or timing).',
      commands: [
        'openssl rsa -in priv.pem -text -noout          # when a key file is supplied',
        'python3 -c "import sympy, z3; print(\'ok\')"   # import probe only',
        'hashid <hash>                                 # identify a hash before touching a cracker',
        'RsaCtfTool --public $e --cipher $c --private  # third-party; uses factordb, so it needs network',
      ],
      signals: [
        'e = 3 and integer_nthroot(c, 3) returns a small integer that decodes to text → solved, it was the whole challenge.',
        'Two ciphertexts with identical `n` and different `e` → shared modulus; you never needed to factor anything.',
        'A long ciphertext with a repeated 16-byte block at a suspicious offset → ECB, or a keystream that repeats every 16 bytes.',
        'A block-cipher ciphertext that is an exact multiple of the plaintext length and unaligned → a stream cipher or CTR, and you need the keystream, not the key.',
        'The decryption function\'s error paths differ between "bad padding" and "bad MAC" → padding oracle, ~128 queries per byte.',
      ],
    },
    {
      title: 'Implement the attack in a real file — pure Python is usually enough',
      note:
        'Write the solver with `write_file` and run it; `python3 -c` one-liners with nested quotes and `\\n` escapes do not survive the shell layer, and a multi-step attack needs loops anyway. Reach for SageMath only when the technique genuinely needs it — Coppersmith/`small_roots`, lattice work, or a discrete log. An elementary flaw (small e, shared modulus, reused nonce, ECB, a custom XOR) is *faster* in pure Python and always available.\n\nSmall-exponent skeleton:\n\n```python\nfrom sympy import integer_nthroot, gcd, isprime\nimport gmpy2\n\nc, e, n = <ints>\nif e == 3:\n    root, exact = integer_nthroot(c, e)\n    assert exact, \'m^e >= N, this attack does not apply\'\n    print(int(root))\n```\n\nFermat for close primes:\n\n```python\nimport math\nn = <int>\na = math.isqrt(n)\nfor k in range(1, 10**7):\n    b2 = a * a + k\n    b = math.isqrt(b2)\n    if b * b == b2:\n        p, q = a + k + b, a + k - b\n        print(hex(p), hex(q))\n        break\n```\n\nWiener with Sage:\n\n```python\nfrom sage.all import QQ, ContinuedFraction\nK = ContinuedFraction(QQ(e) / QQ(n))\nfor conv in K.convergents():\n    d = conv.numerator()\n    if (e * d - 1) % n == 0 and d < n:\n        print(\'d =\', d)\n        break\n```',
      commands: [
        'write_file solve.py',
        'python3 solve.py',
        'python3 -m pip install sympy            # only if the import probe failed',
        'sage solve.sage                          # for Coppersmith / lattice / discrete log only',
        'sage -c "print(factor(123456789012345678901234567890))"',
      ],
      signals: [
        '`integer_nthroot` says the root is not exact → the message was padded, or e is not small enough. Check for PKCS#1 v1.5 padding before assuming the attack failed.',
        'The recovered integer is a byte string that is not text → it is the padded plaintext, or another layer. Convert with `long_to_bytes` and `file` the result.',
        '`factor(n)` returns immediately → trivial factors; anything else means you are on the wrong attack, go back to step 2.',
      ],
    },
    {
      title: 'Symmetric and custom ciphers: the key, the mode, or the key schedule is wrong',
      note:
        'For hand-rolled ciphers the question is never "what cipher is this" but "what is it doing wrong". The highest-yield moves, in order: read the source if you were given it; find the mode from the code (a mode of operation that repeats a block is the bug); and check the key schedule, where `key` is often only partially used or the IV is left as zeros.',
      commands: [
        'strings -a challenge | grep -iE "key|iv|nonce|sbox|box|perm|round"',
        'xxd -l 256 challenge',
        'python3 -c "from Crypto.Cipher import AES; print(\'pycryptodome ok\')"',
        'openssl enc -aes-128-ecb -d -in challenge -out out.bin -K <hexkey> -nopad',
        'openssl enc -des-ecb -d -in challenge -out out.bin -K <hexkey> -nopad -provider legacy -provider default',
      ],
      signals: [
        'A 256-byte block of high-entropy data in the artifact, plus a permutation table in the source → an S-box; extract the 256 bytes and invert it.',
        'The code XORs with `key[i % len(key)]` → repeating-key XOR. Break it with a Hamming-distance key length guess, or assume `flag{` and derive the key directly.',
        'The code builds a permutation from an LCG whose modulus and multiplier are in the source → the keystream is fully determined; seed it yourself.',
        'The cipher is a `PyCrypto`/`pycryptodome` `DES`/`Blowfish`/`RC4` call under OpenSSL 3.x and `openssl` errors with "unsupported" → add `-provider legacy -provider default`.',
      ],
    },
    {
      title: 'Hashes, padding oracles, and the tooling that fits each',
      note:
        'Hash challenges are the one place a cracker is the right first move, and they are scoped to the challenge artifact: `hashcat -m 0/100/1400` and `john --format=raw-md5` are for the hash in front of you, not for anything else on the machine. Padding and length-extension attacks are query-driven rather than brute-force-driven, and both need a *decision oracle* — confirm the oracle exists before you write any code.',
      commands: [
        'hashid <hash>',
        'john --wordlist=wordlists/rockyou.txt hashes.txt      # low-entropy password, the classic case',
        'john --format=raw-md5 hashes.txt',
        'hashcat -m 1400 hashes.txt wordlists/rockyou.txt      # -m 0 = MD5, 100 = SHA1, 1400 = SHA2-256',
        'openssl dgst -md5 -binary file | xxd -p              # confirm what you are hashing',
      ],
      signals: [
        'The server answers faster/slower, or with different text, for the last byte → padding oracle. Confirm the difference is about padding and not about the input by sending a same-padding, different-content request.',
        'The challenge gives `H(secret || data)` with an unknown-length secret and a forgeable endpoint → length extension: `hashpumpy`, which reuses the given digest and length and extends the message without knowing `secret`.',
        'A hash whose input is a *known format* (a date, a licence key, a small number) → a targeted wordlist beats rockyou by orders of magnitude. Build it from the challenge text.',
        'The hash is a 32-hex string that the program then *uses as a key* rather than to verify → it is not a cracking target, it is a key you should feed into a cipher.',
      ],
    },
    {
      title: 'When the scheme is underdetermined, stop guessing and write a z3 model',
      note:
        'Some checks are not invertible: a byte-at-a-time transform with branches, a checksum over a constrained alphabet, a VM. Assert the transformation as constraints and let the solver find the input. This is the legitimate use of `z3` in this category — `BitVec` byte arrays model a memory image directly, and the model stays small because the challenge input is short.',
      commands: [
        'write_file solve_z3.py',
        'python3 solve_z3.py',
        'sage solve_z3.sage            # if you need modular arithmetic on big integers rather than bytes',
      ],
      signals: [
        'Brute force over a printable-ASCII input of length <= 6-8 is feasible → try the dumb thing first; it finishes in seconds and removes all doubt about the model.',
        'The solver returns `sat` with a short, printable result → that is the input. If the result is not printable, a constraint is missing or the model is wrong.',
        'The solver returns `unknown` → the theory is too hard for the default tactic. Split the problem, or bound the input length explicitly with `Length(inp) == n`.',
        'z3 hangs → the model is unconstrained in a way that makes the search huge. Add the missing invariant (each byte in range, the checksum compared at a fixed offset).',
      ],
    },
    {
      title: 'Unwrap the layers — most "crypto" challenges are two or three deep',
      note:
        'Keep intermediate outputs instead of piping blindly, and re-run `file` on each one. A decoded blob that is not text is almost always another layer or a compressed archive, and that fact is what tells you to keep going. This is also where a recovered *password* turns back into the real flag, rather than being the answer itself.',
      commands: [
        'base64 -d layer1 > layer2 ; file layer2',
        'xxd -r -p layer2 > layer3 ; file layer3',
        'tr "A-Z" "N-ZA-M" < layer2 > layer3 ; file layer3',
        'openssl enc -aes-256-cbc -d -in layer3 -out layer4 -K <hex> -iv <hexiv> -nosalt -md md5',
        'file layer4',
      ],
      signals: [
        '`file layerN` reports a zip, gzip, PNG, or ELF → a nested artifact; recurse with the stego or misc playbook on it.',
        'The output is text that still is not the flag → one more transform. Read it: an English-looking but wrong string is often a further substitution or a transposition.',
        'The output is the flag but with a wrong prefix/case → compare against the challenge title for the exact expected format before you submit.',
      ],
    },
  ],
  gotchas: [
    'Encoding is not encryption. Base64, hex, URL-encoding and rot13 have no key: if you found a key, the real cipher is elsewhere. Conversely, if `openssl` "fails" on something, check for base64 first — a lot of "ciphertexts" are one decode away from a block-aligned blob.',
    '`openssl enc` version quirks bite constantly. OpenSSL 3.x defaults to `-salt` plus PBKDF2, so old-style output needs `-md md5 -nosalt` to reproduce the original `EVP_BytesToKey` derivation. RC4/DES/Blowfish need `-provider legacy -provider default`. AES-GCM through `openssl enc` is awkward — use `pycryptodome`.',
    'The flag is very often behind several layers: base64 of an AES blob whose plaintext is itself another base64 of a ROT13. Check the character class of every intermediate (`file` is enough) instead of assuming you are one step from the end.',
    'Do not confuse a hash with a key. A 32-hex string might be an MD5 to crack, or an AES-128 key to use. Read how the program consumes it before sending it to a cracker.',
    '`RsaCtfTool` and anything else that hits factordb needs network access, which a challenge container will not have. The offline equivalents are `sage factor(n)`, a Fermat loop for close primes, and `sympy.ntheory.factor_.pollard_pm1` for small factors. Never assume a large `n` means "unsolvable" — most of them are one bad parameter away from trivial.',
    'An underdetermined scheme (a checksum you cannot invert, a byte-wise branchy transform, a small VM) is a `z3` problem, not an algebra problem. Reaching for closed-form maths here is the classic time sink; so is brute-forcing 8+ printable characters.',
    'Padding oracle attacks are only worth writing once you have *proven* the oracle exists: identical-length requests that differ only in the last byte must produce observably different behaviour (different text, status, or measurable time). Without that, it is a guess and you will waste the budget.',
    'A "small e" attack needs the raw unpadded integer. If the challenge used PKCS#1 v1.5, unpad first (`i2osp(m, k)` then strip the `00 02 <random> 00` prefix) or your recovered m is a padded message, not the plaintext.',
  ],
  successShape:
    'Plaintext containing the flag form — `flag{...}`, `crypto{...}`, or the challenge\'s own prefix — or, for a hash-cracking or padding-oracle challenge, the *input* string that satisfies the check (that input is the flag). A recovered password that does not itself look like a flag usually wraps one: re-read the check for the final layer instead of submitting it.',
}
