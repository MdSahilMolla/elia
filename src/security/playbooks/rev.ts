import type { Playbook } from './index.ts'

/**
 * Static and semi-static reverse engineering.
 *
 * The through-line: establish what the file really is (extensions lie, and one
 * of the cheapest wins in the category is a renamed or polyglot file), then
 * pick the decompiler that matches the *container*, then find the function that
 * decides pass/fail and reimplement it. Reading a disassembly linearly is the
 * failure mode — a stripped native binary has more functions than you have time
 * for, so the work is almost always about navigation, not about patience.
 */
export const revPlaybook: Playbook = {
  category: 'rev',
  summary:
    'Recover the logic, not the disassembly. Identify the true file type, pick the right decompiler for the container (native / Ghidra / jadx / Python bytecode / .NET), find the function that validates the input, and either reimplement its check in Python or patch the branch that fails it.',
  detect: [
    'A binary with no source shipped alongside it — `.exe`, ELF, `.dll`, `.so`, or a file with no extension at all.',
    'A mobile artifact: `.apk`, `.ipa`, `.dex`, or an `AndroidManifest.xml` reference.',
    'Python/other-language bytecode: `.pyc`, `.pyo`, `.class`, `.dex`.',
    'A "crackme" brief, a serial/licence check, or a program that prints "wrong, try again".',
    'A stripped ELF or PE, or a binary whose imports look trivial but whose behaviour does not.',
  ],
  steps: [
    {
      title: 'Establish what the file actually is — the extension is a claim, the bytes are evidence',
      note:
        'This is the single highest-yield minute in the category. A `.exe` can be an ELF, a `.png` can be a shell script, and a "broken" image is usually a polyglot with a second file after the first one\'s real end. Everything downstream is cheaper once you know what you are looking at.',
      commands: [
        'file app',
        'file -k app',
        'xxd -l 64 app',
        'strings -a -n 6 app | head -40',
        'unzip -l app',
        '7z l app',
      ],
      signals: [
        'A `.exe` whose first four bytes are `7f 45 4c 46` → it is an ELF. Reversing it needs ELF tooling; running it under wine would be a waste.',
        '`unzip -l` lists `AndroidManifest.xml`, `classes.dex`, `res/` → it is an APK, regardless of what it was named.',
        '`unzip -l` lists `[Content_Types].xml`, `word/` → an Office file. `META-INF/` plus `*.class` → a JAR.',
        'The magic is `d0 cf 11 e0` → an OLE2 container (legacy `.doc`/`.xls`, or an MSI). Modern `.docx`/`.xlsx` are plain zips.',
        '`file` says "data" for something with a media extension → the bytes are raw, encrypted, or a headerless fragment. `binwalk` and `xxd` before anything else.',
      ],
    },
    {
      title: 'Choose the decompiler that matches the container',
      note:
        'One binary, one right tool. Running jadx on a native ELF, or uncompyle6 on a 3.12 `.pyc`, produces confident nonsense that costs more time than the wrong tool ever would. Note the exact tool for the case at hand rather than trying the first one you remember.',
      commands: [
        '# native (ELF/PE/Mach-O) — radare2, no install required beyond the binary',
        'r2 -q -c "aaa; afl" ./app',
        'r2 -q -c "aaa; pdc @ main" ./app            # pdc = built-in pseudo-C; pdg if r2ghidra is installed',
        'objdump -d -M intel ./app > app.asm',
        '# Ghidra headless (Linux/macOS: analyzeHeadless; Windows: analyzeHeadless.bat)',
        'analyzeHeadless /tmp/ghidra_proj RevApp -import ./app -analysisTimeoutPerFile 600',
        'analyzeHeadless /tmp/ghidra_proj RevApp -process app -scriptPath /tmp/scripts -postScript DumpStrings.java',
        '# Android',
        'jadx -d out app.apk',
        'apktool d app.apk -o apk_out              # smali + decoded resources; reach for it when jadx fails',
        '# Python bytecode — read the version FIRST, then pick a decompiler for it',
        'xxd -l 4 app.pyc',
        'uncompyle6 app.pyc                        # CPython <= 3.8',
        'decompyle3 app.pyc                        # CPython 3.7-3.8',
        'pycdc app.pyc                             # builds from source; the broad-coverage option',
        'xdis.disasm app.pyc                       # prints bytecode + version when nothing else will',
        '# .NET',
        'monodis app.exe',
        'ilspycmd app.exe',
      ],
      signals: [
        '`r2 afl` lists hundreds of functions and none is `main` → stripped; navigate from the entry point and the imports (`r2 -q -c "aaa; afl~imp."`).',
        'Ghidra headless exits with a project-path error → the first argument is a writable *project directory* and the second is the project *name*; they are not the file you are importing.',
        'A `.pyc` decompiles to syntactically valid but semantically absurd code → the decompiler does not support that bytecode version. Check the magic bytes before trusting anything.',
        'jadx throws or produces empty classes for one class only → that class is likely obfuscated or native; `apktool d` gives you smali to read directly, and `lib/<abi>/*.so` inside the APK is a second native reversing job.',
      ],
    },
    {
      title: 'Find the real entry point and the function that decides pass/fail',
      note:
        'You are hunting one function: the one that takes your input, transforms it somehow, and compares it to something. Everything else in the binary is scenery. Cross-references beat reading: who calls `strcmp`? who opens `flag.txt`? who loads a 256-entry table?',
      commands: [
        'r2 -q -c "aaa; afl~main" ./app',
        'r2 -q -c "aaa; afl~check" ./app',
        'r2 -q -c "aaa; afl~valid" ./app',
        'r2 -q -c "aaa; s main; pdf" ./app',
        'r2 -q -c "aaa; axt @ sym.imp.strcmp" ./app',
        'r2 -q -c "aaa; axt @ sym.imp.fopen" ./app',
        'nm -C ./app | grep -iE " (main|check|verify|validate|do_check|process)($|_)"',
        'strings -a ./app | grep -iE "correct|wrong|congrat|flag|win|fail|try again"',
      ],
      signals: [
        'No `main` anywhere → the program starts at `entry0`/`_start`; in Ghidra follow the `__libc_start_main` argument to recover the real main.',
        'A function that opens `flag.txt` or `./flag` → the flag is read from disk, not embedded, and the flag file is usually shipped with the challenge or served by the remote endpoint.',
        'A function containing an inlined `strcmp`/byte-compare against a runtime-assembled string → string encryption; the comparison is real but the expected value is built on the stack.',
        'A function with a big loop and a 256-byte table lookup → a custom S-box; the table is the cipher.',
      ],
    },
    {
      title: 'Classify the check: string compare, checksum, cipher, or state machine',
      note:
        'Read the check and name its shape before attacking it. The four shapes below have completely different cheapest solutions, and misclassifying one costs hours.',
      commands: [
        'r2 -q -c "aaa; pdc @ main" ./app > main.c',
        'r2 -q -c "aaa; pdf @ main" ./app > main.asm',
        'r2 -q -c "aaa; afl" ./app | grep -iE "enc|dec|crypt|hash|sum|check|magic"',
      ],
      signals: [
        'A loop over input bytes with `^`/`+`/`*` and one compare at the end → a checksum. Brute-forcing each character against a small alphabet is usually faster and far more reliable than algebra.',
        'A 256-entry table plus XOR/rotate per byte → an S-box cipher. Dump the table (`r2 -q -c "aaa; px 256 @ <addr>"`) and reimplement it in Python, including the inverse if it is one-way per step.',
        'A `strcmp` against a string that is built byte-by-byte on the stack → string encryption. Recover it by assuming the plaintext prefix, or by breaking at the compare in a debugger and reading the argument.',
        'A `switch` on a state variable that jumps back into the same blocks → control-flow flattening. Do not read it block by block: decompile the whole caller, or recover the state transitions and rebuild the natural order.',
        'An `argv[1]`/`gets`/`read` into a buffer with a length check right after → the check is real; your job is to satisfy it, not bypass it.',
      ],
    },
    {
      title: 'Extract the flag, or reimplement the check and solve it',
      note:
        'The default finishing move is to reimplement the check in Python and run a candidate through it, because that proves you understood it and it generalises. Patching is the fallback for a check too tangled to reimplement — and for a *local* binary only, since you cannot patch a remote one. Either way the answer is usually a plain string, so treat "I know the algorithm" as unfinished until you have run it.',
      commands: [
        'strings -a -n 4 ./app | grep -iE "flag|ctf|congrat|correct|well done"',
        'rabin2 -zz ./app | grep -i flag',
        'r2 -q -c "aaa; iz~flag" ./app',
        'r2 -q -c "aaa; px 128 @ sym.flag" ./app',
        'write_file solve.py       # reimplement the check; run it, do not read it',
        'python3 solve.py',
      ],
      signals: [
        'A string table containing `flag{` split across separate entries, or individual printable characters with a fixed stride → reassemble rather than assume a contiguous string exists.',
        'A per-character XOR/ADD key in `.rodata` next to the comparison → recover the key by assuming a known plaintext prefix (`flag{`, `CTF{`), then verify the whole string round-trips.',
        'The check is `md5(input) == <hex>` or similar → the expected answer is the *input*, not the hash. Crack it or invert the constraint, then submit the input.',
      ],
    },
    {
      title: 'Patch the branch (local binaries only) when reimplementing is not worth it',
      note:
        'Patching is two operations: neutralise the failure branch, or force the success path. Do it on a copy so you keep the original for comparison, and re-run the original to confirm your patch is what changed the behaviour.',
      commands: [
        'cp ./app ./app.patched',
        'r2 -w -q -c "aa; s 0x401337; wx 90909090" ./app.patched     # NOP out the check',
        'r2 -w -q -c "aa; s 0x401337; wx eb01" ./app.patched       # jmp short +1 over the failure branch',
        'r2 -w -q -c "aa; s sym.imp.ptrace; wx 31c0c3" ./app.patched   # xor eax,eax; ret — defeat a ptrace anti-debug',
        'r2 -w -q -c "aa; wx 60 @ entry0" ./app.patched             # pushad: a crude breakpoint-free start',
        './app.patched',
      ],
      signals: [
        'The patched binary segfaults immediately → you wrote over a relocation, a jump table, or a needed instruction rather than over a branch. Disassemble before and after and diff.',
        'It runs but takes the failure path anyway → the decision is made in another function, or the branch is a conditional you overwrote in the wrong direction. Look for the `je`/`jne` that guards the failure message string.',
      ],
    },
    {
      title: 'Prove it against the original behaviour',
      note:
        'A flag is only correct when the *original* program, or the remote service, produces it from your input. An input that makes your reimplementation print the flag is a strong result; a flag that makes the real binary print it is a proof.',
      commands: [
        './app "yourinputhere"',
        'printf "yourinputhere" | ./app',
        'ncat HOST PORT   # then send the recovered input, once, as a line',
        'ncat HOST PORT   # interactive services often want a newline before they will say anything',
      ],
      signals: [
        'Local prints the flag but the remote hangs → the remote checks a different value, or wants the input in a different encoding/base (hex, base64, with a trailing newline).',
        'The remote accepts your input and returns nothing → some challenges want you to *read* the flag from a file the service serves, not to pass a string.',
      ],
    },
  ],
  gotchas: [
    '`AndroidManifest.xml` inside an APK is *binary AXML*, not text. `cat`ing it shows NUL bytes and no permissions. Use `aapt2 dump xmltree --file AndroidManifest.xml app.apk`, or `apktool d app.apk` and read the decoded copy. An exported activity with a `READ_FLAG`/custom permission is where the interesting code is.',
    'A `.pyc` must be decompiled with a decompiler that supports *its* bytecode version, not your interpreter\'s. Read the 4 magic bytes, compare against `python3 -c "import importlib.util; print(importlib.util.MAGIC_NUMBER.hex())"`, then pick: `uncompyle6`/`decompyle3` for CPython <= 3.8, `pycdc` for 3.9+. A mismatched decompiler emits code that parses and does nothing — worse than no output, because it looks like progress.',
    'Control-flow flattening replaces the natural control flow with a `switch` over a state variable, and reading the flattened graph one block at a time is close to hopeless. In Ghidra, decompile the whole function or the top-level caller and follow the state transitions instead; also check for an OLLVM-style bogus-dispatch table at the start of the function.',
    'Packed or obfuscated binaries: check `file` for "upx packed", and check the section permissions — an executable+writable `.text` is a strong packing signal. Try `upx -d app` first; if it is a custom packer, `binwalk -e app`, or read the unpacking stub at `entry0` and dump memory after it runs (`gdb`, break after the jump, `dump binary memory`).',
    'String encryption means `strings` finds nothing useful. Find the decryption routine (a small function with a loop and a table, called immediately before each use), then either reimplement it in Python or break in the debugger at the consuming function and read the string from the register that holds it.',
    'Anti-debug is usually one `ptrace(PTRACE_TRACEME)` whose return value is checked, sometimes plus a `/proc/self/status` `TracerPid` read. Patch the check to force a 0 return, NOP the `ptrace` call, or use a debugger that simply does not attach the way it expects. It is a speed bump, not a wall.',
    '`objdump -d` on a static binary produces tens of megabytes. Scope it with `nm`/`afl`/`afl~main` and read a function at a time, or use Ghidra. Reading a disassembly linearly is the most common way to burn an entire time budget.',
    'Ghidra headless has three positional parts: a writable project *directory*, a project *name*, and then `-import <file>`. Paths with spaces (`C:\\Program Files\\Ghidra`) and a non-existent project directory are the two failures you will actually hit; create the directory first.',
    'A Windows CTF `.exe` is usually a native PE with no unusual runtime dependency — read it statically, do not start reasoning about DLLs you have not seen in the import table.',
  ],
  successShape:
    'A single line of the form `flag{...}` (or the challenge\'s own prefix) that the *original* program or the remote service prints in response to your input. If the check validates a transform of the flag rather than the flag — `md5(input) == <hex>`, a serial-number check — then the expected answer is the input string itself, and that string is the flag. "I now understand the algorithm" is not a solve.',
}
