/**
 * What security/CTF tooling is worth having on a machine, and what each one is
 * actually for.
 *
 * This is data, not behaviour: detection lives in `src/tools/ctfToolchain.ts`,
 * which reads this catalog and reports what is present without installing
 * anything. Keeping the list here means the report, the install plan and any
 * future `capabilityContract` wording all describe the same tools.
 *
 * A tool appears exactly once, under the category it is most load-bearing for.
 * Several of these (radare2, gdb, objdump, strings, file, xxd, zsteg, binwalk,
 * openssl, curl) are used across categories; a second entry under a second
 * category would break the uniqueness invariant `toolNamesFor` depends on, so
 * the cross-category use is named in `purpose` instead.
 *
 * `install` hints are best-effort and deliberately sparse: only commands we are
 * confident are correct are filled in, because a wrong install command is worse
 * than no hint. An entry with no hint for this platform is reported as
 * "no install hint" rather than guessed at.
 */

export type ToolCategory = 'pwn' | 'rev' | 'crypto' | 'stego' | 'misc'

export interface CatalogEntry {
  /** Display name, e.g. `nmap`. Unique across the catalog. */
  name: string
  category: ToolCategory
  /** One line: why you reach for it. Also the source of a missing tool's blocking impact. */
  purpose: string
  /** Accepted binary names; the first is canonical. Empty means "not a CLI, detect by `probe`". */
  binaries: string[]
  /** Alternative way to detect a library-shaped dependency, e.g. `python3 -c "import pwn"`. */
  probe?: string
  /** Per-OS install hints. Commands where we know one, a note where the answer is a download. */
  install?: Partial<Record<'linux' | 'macos' | 'windows', string>>
  /** Boundary note for tools that need one. */
  scopeNote?: string
}

export const TOOL_CATEGORIES: ToolCategory[] = ['pwn', 'rev', 'crypto', 'stego', 'misc']

export const CATEGORY_DESCRIPTIONS: Record<ToolCategory, string> = {
  pwn: 'Binary exploitation: read the mitigations, find the bug, build the chain.',
  rev: 'Reverse engineering: recover what a stripped or compiled artifact was doing.',
  crypto: 'Cryptanalysis: solve the maths instead of guessing the plaintext.',
  stego: 'Steganography: find what was hidden inside an image, audio file or archive.',
  misc: 'Forensics and general-purpose: the capture, document, media and encoding tools everything else leans on.',
}

/** The two password-cracking entries are the same boundary, so it is written once. */
const CRACK_SCOPE_NOTE = 'Only run this against a CTF challenge\'s own artifacts — the hashes and files the challenge ships with, or a target inside a recorded, authorized engagement. Never against third-party accounts, a hash you scraped from somewhere else, or a machine you were not engaged to test.'

/** `binutils` ships the three of them, so the same hint serves objdump/readelf/nm/strings. */
const BINUTILS = {
  linux: 'sudo apt install binutils',
  macos: 'brew install binutils',
} as const

const PIP = (packageName: string): Partial<Record<'linux' | 'macos' | 'windows', string>> => ({
  linux: `pip install ${packageName}`,
  macos: `pip install ${packageName}`,
  windows: `pip install ${packageName}`,
})

/** Probes are interpreter invocations: an import that fails is the missing signal. */
const PYTHON_PROBE = (importLine: string): string => `python3 -c "${importLine}"`

export const SECURITY_TOOL_CATALOG: CatalogEntry[] = [
  // ---------------------------------------------------------------- pwn ----
  {
    name: 'pwntools',
    category: 'pwn',
    purpose: 'Script the whole exploit: ROP chains, automatic address packing, and remote connections in a few lines instead of by hand.',
    binaries: [],
    probe: PYTHON_PROBE('import pwn'),
    install: PIP('pwntools'),
  },
  {
    name: 'gdb',
    category: 'pwn',
    purpose: 'Step to the crash, inspect registers and memory, and drive a debug session on a live process.',
    binaries: ['gdb'],
    install: { linux: 'sudo apt install gdb', macos: 'brew install gdb' },
  },
  {
    name: 'pwndbg',
    category: 'pwn',
    purpose: 'A GDB plugin that turns a crash dump into a usable exploit workspace: heap views, vmmap and mitigations on load.',
    binaries: ['pwndbg'],
    install: {
      linux: 'git clone --depth 1 https://github.com/pwndbg/pwndbg.git && cd pwndbg && ./install.sh — the launcher is written to ~/.local/bin, so add that to PATH',
      macos: 'git clone --depth 1 https://github.com/pwndbg/pwndbg.git && cd pwndbg && ./install.sh — the launcher is written to ~/.local/bin, so add that to PATH',
    },
  },
  {
    name: 'checksec',
    category: 'pwn',
    purpose: 'One line of which mitigations a binary was built with: NX, PIE, RELRO, canary.',
    binaries: ['checksec'],
    install: {
      linux: 'mkdir -p ~/.local/bin && wget -O ~/.local/bin/checksec https://raw.githubusercontent.com/pwntools/checksec/master/checksec && chmod +x ~/.local/bin/checksec — ~/.local/bin must be on PATH',
      macos: 'mkdir -p ~/.local/bin && wget -O ~/.local/bin/checksec https://raw.githubusercontent.com/pwntools/checksec/master/checksec && chmod +x ~/.local/bin/checksec — ~/.local/bin must be on PATH',
    },
  },
  {
    name: 'radare2',
    category: 'pwn',
    purpose: 'Disassembly, patching and scriptable analysis for a quick read of a binary you have not seen before; also the fastest reverse engineering tool here.',
    binaries: ['r2', 'radare2'],
    install: { linux: 'sudo apt install radare2', macos: 'brew install radare2' },
  },
  {
    name: 'objdump',
    category: 'pwn',
    purpose: 'Disassemble sections, dump headers and scan for gadget bytes without a full debugger.',
    binaries: ['objdump'],
    install: { ...BINUTILS },
  },
  {
    name: 'readelf',
    category: 'pwn',
    purpose: 'Read ELF headers, sections, symbols and relocations directly, including the GNU_STACK flags that decide NX.',
    binaries: ['readelf'],
    install: { ...BINUTILS },
  },
  {
    name: 'nm',
    category: 'pwn',
    purpose: 'List defined symbols, so you can spot the interesting functions and their addresses.',
    binaries: ['nm'],
    install: { ...BINUTILS },
  },
  {
    name: 'strings',
    category: 'pwn',
    purpose: 'Pull printable strings out of a binary or an image: flags, hints and library names.',
    binaries: ['strings'],
    install: { ...BINUTILS },
  },
  {
    name: 'file',
    category: 'pwn',
    purpose: 'Identify what a blob actually is before picking a tool for it — extensions lie in CTFs.',
    binaries: ['file'],
    install: { linux: 'sudo apt install file', macos: 'brew install file' },
  },
  {
    name: 'xxd',
    category: 'pwn',
    purpose: 'Hex dump and hex-edit a file, which is the fastest way to see and patch raw bytes.',
    binaries: ['xxd'],
    install: { linux: 'sudo apt install xxd', macos: 'brew install xxd' },
  },
  {
    name: 'patchelf',
    category: 'pwn',
    purpose: "Rewrite an ELF's interpreter, RPATH or needed libraries so a binary runs in the environment you need it in.",
    binaries: ['patchelf'],
    install: { linux: 'sudo apt install patchelf', macos: 'brew install patchelf' },
  },
  {
    name: 'ropper',
    category: 'pwn',
    purpose: 'Enumerate ROP gadgets and assemble chains from what is actually there, instead of hand-picking bytes.',
    binaries: ['ropper', 'ROPgadget'],
    install: PIP('ropper'),
  },
  {
    name: 'one_gadget',
    category: 'pwn',
    purpose: 'List the `execve("/bin/sh", ...)` gadgets this glibc build really has, with their register constraints.',
    binaries: ['one_gadget'],
    install: { linux: 'gem install one_gadget', macos: 'gem install one_gadget' },
  },
  {
    name: 'strace',
    category: 'pwn',
    purpose: 'Trace every syscall, which is usually how you find the flag path or the read that overflows.',
    binaries: ['strace'],
    install: { linux: 'sudo apt install strace' },
  },
  {
    name: 'ltrace',
    category: 'pwn',
    purpose: 'Trace library calls, which is where a `system()` or `execve()` wrapper shows up.',
    binaries: ['ltrace'],
    install: { linux: 'sudo apt install ltrace' },
  },
  {
    name: 'socat',
    category: 'pwn',
    purpose: 'Stand up a listener or bridge a TCP connection, for serving a shell or talking to a remote service.',
    binaries: ['socat'],
    install: { linux: 'sudo apt install socat', macos: 'brew install socat', windows: 'choco install socat' },
  },
  {
    name: 'ncat',
    category: 'pwn',
    purpose: 'Netcat with TLS and scripting, for a `ncat -e` listener or a scripted protocol exchange.',
    binaries: ['ncat'],
    install: {
      linux: 'sudo apt install nmap — ncat ships inside the nmap package',
      macos: 'brew install nmap — ncat ships inside the nmap package',
      windows: 'choco install nmap — ncat ships inside the nmap package',
    },
  },
  {
    name: 'dd',
    category: 'pwn',
    purpose: 'Copy an exact byte range out of a file: slice a header, or pull a trailing payload at a known offset.',
    binaries: ['dd'],
    install: { linux: 'sudo apt install coreutils — dd ships inside the coreutils package' },
  },

  // ---------------------------------------------------------------- rev ----
  {
    name: 'ghidra',
    category: 'rev',
    purpose: 'Full decompilation to C-like pseudocode in batch mode — the highest-signal answer for a stripped binary, and the same tool pwn challenges reach for.',
    binaries: ['analyzeHeadless', 'analyzeHeadless.bat'],
    install: {
      linux: 'Download the official Ghidra release ZIP from github.com/NationalSecurityAgency/ghidra/releases and unzip it (Ghidra is not in apt), then add <ghidra>/support to PATH so analyzeHeadless resolves — it also needs a JDK 17+ on PATH',
      macos: 'Download the official Ghidra release ZIP from github.com/NationalSecurityAgency/ghidra/releases and unzip it (Ghidra is not in Homebrew either), then add <ghidra>/support to PATH so analyzeHeadless resolves — it also needs a JDK 17+ on PATH',
      windows: 'Download the official Ghidra release ZIP from github.com/NationalSecurityAgency/ghidra/releases and unzip it (Ghidra is not in winget), then add <ghidra>\\support to PATH so analyzeHeadless.bat resolves — it also needs a JDK 17+ on PATH',
    },
  },
  {
    name: 'upx',
    category: 'rev',
    purpose: 'Detect and unpack a UPX-packed executable so the real code becomes visible.',
    binaries: ['upx'],
    install: { linux: 'sudo apt install upx-ucl', macos: 'brew install upx', windows: 'choco install upx' },
  },
  {
    name: 'retdec',
    category: 'rev',
    purpose: 'Unpack a native binary into readable C-like output and recover the structure of a stripped one.',
    binaries: ['retdec-decompiler', 'retdec-decompiler.exe'],
    install: {
      linux: 'Build from the release tarball at github.com/avst/retdec/releases (cmake + a C++ toolchain), then put retdec-decompiler on PATH — there is no apt or brew package',
      macos: 'Build from the release tarball at github.com/avst/retdec/releases (cmake + a C++ toolchain), then put retdec-decompiler on PATH — there is no apt or brew package',
    },
  },
  {
    name: 'decompyle3',
    category: 'rev',
    purpose: 'Recover Python source from .pyc bytecode; the `uncompyle6` name covers the older bytecode versions it refuses.',
    binaries: ['decompyle3', 'uncompyle6'],
    install: PIP('decompyle3  (for older bytecode: pip install uncompyle6)'),
  },
  {
    name: 'jadx',
    category: 'rev',
    purpose: 'Decompile an APK or a bare dex to readable Java and search it for the logic you need.',
    binaries: ['jadx'],
    install: { linux: 'sudo apt install jadx', macos: 'brew install jadx', windows: 'choco install jadx' },
  },
  {
    name: 'apktool',
    category: 'rev',
    purpose: 'Disassemble an APK back to smali and resources when the decompiled Java is not enough.',
    binaries: ['apktool'],
    install: { linux: 'sudo apt install apktool', macos: 'brew install apktool', windows: 'choco install apktool' },
  },
  {
    name: 'aapt2',
    category: 'rev',
    purpose: "Read an APK's manifest, resources and file table without decompiling anything.",
    binaries: ['aapt2', 'aapt'],
    install: {
      linux: 'Install the Android SDK build-tools and add the build-tools directory to PATH (e.g. export PATH="$ANDROID_HOME/build-tools/34.0.0:$PATH") so aapt2 resolves',
      macos: 'Install the Android SDK build-tools and add the build-tools directory to PATH (e.g. export PATH="$ANDROID_HOME/build-tools/34.0.0:$PATH") so aapt2 resolves',
      windows: 'choco install aapt — or add %ANDROID_HOME%\\build-tools\\<version> to PATH so aapt2 resolves',
    },
  },
  {
    name: 'baksmali',
    category: 'rev',
    purpose: 'Disassemble classes.dex back to smali when you need to read the exact bytecode rather than the decompiled guess.',
    binaries: ['baksmali', 'baksmali.jar'],
    install: {
      linux: 'Download the jar from github.com/JesusFreke/smali/releases and run java -jar smali/baksmali.jar, or use the copy in the Android SDK build-tools on PATH',
      macos: 'Download the jar from github.com/JesusFreke/smali/releases and run java -jar smali/baksmali.jar, or use the copy in the Android SDK build-tools on PATH',
    },
  },
  {
    name: 'androguard',
    category: 'rev',
    purpose: 'Parse an APK programmatically — manifest, certificates and the code graph — when you want to script the analysis rather than read it.',
    binaries: [],
    probe: PYTHON_PROBE('import androguard'),
    install: PIP('androguard'),
  },
  {
    name: 'otool',
    category: 'rev',
    purpose: 'The macOS native answer to objdump and nm: Mach-O headers, linked libraries and disassembly.',
    binaries: ['otool'],
    install: { macos: 'xcode-select --install — otool ships with the Xcode command line tools and has no standalone install' },
  },

  // ------------------------------------------------------------- crypto ----
  {
    name: 'python3',
    category: 'crypto',
    purpose: 'The interpreter most CTF crypto is written in, and the host for the probe-only libraries below.',
    binaries: ['python3', 'python', 'python.exe'],
    install: { linux: 'sudo apt install python3 python3-pip', macos: 'brew install python', windows: 'winget install Python.Python.3' },
  },
  {
    name: 'sympy',
    category: 'crypto',
    purpose: 'Symbolic solving: factor polynomials, solve congruences, and invert functions in a few calls.',
    binaries: [],
    probe: PYTHON_PROBE('import sympy'),
    install: PIP('sympy'),
  },
  {
    name: 'pycryptodome',
    category: 'crypto',
    purpose: 'Practical cipher implementations (AES, RSA, DES) and the standard padding modes, ready to use against a real ciphertext.',
    binaries: [],
    probe: PYTHON_PROBE('from Crypto.Cipher import AES'),
    install: PIP('pycryptodome'),
  },
  {
    name: 'z3-solver',
    category: 'crypto',
    purpose: 'Constraint solving: model the cipher as equations over bytes and let the solver find the key.',
    binaries: [],
    probe: PYTHON_PROBE('import z3'),
    install: PIP('z3-solver'),
  },
  {
    name: 'xortools',
    category: 'crypto',
    purpose: 'Break a repeating-key XOR, and inspect the entropy of something that looks like a keystream.',
    binaries: [],
    probe: PYTHON_PROBE('import xortools'),
    install: PIP('xortools'),
  },
  {
    name: 'SageMath',
    category: 'crypto',
    purpose: 'A full algebra system with discrete log, elliptic curves and lattices in one place.',
    binaries: ['sage'],
    install: {
      linux: 'sudo apt install sagemath',
      macos: 'brew install sagemath — it is keg-only, so add $(brew --prefix)/opt/sagemath/bin to PATH for `sage` to resolve',
    },
  },
  {
    name: 'openssl',
    category: 'crypto',
    purpose: 'Hash a file, generate a keypair and encrypt or decrypt from the command line; also the TLS client for the misc category.',
    binaries: ['openssl'],
    install: { linux: 'sudo apt install openssl', macos: 'brew install openssl', windows: 'choco install openssl.light' },
  },
  {
    name: 'pari-gp',
    category: 'crypto',
    purpose: 'Fast discrete log, modular inverse and factoring over big integers, when a Python loop is too slow.',
    binaries: ['gp'],
    install: { linux: 'sudo apt install pari-gp', macos: 'brew install pari-gp' },
  },
  {
    name: 'R',
    category: 'crypto',
    purpose: 'A statistical scratchpad, which is what a challenge needs when the answer is a graph or a distribution.',
    binaries: ['Rscript', 'Rscript.exe'],
    install: { linux: 'sudo apt install r-base', macos: 'brew install r', windows: 'winget install RProject.R' },
  },
  {
    name: 'hashcat',
    category: 'crypto',
    purpose: 'GPU hash cracking, for when you already have the hash and only lack the password.',
    binaries: ['hashcat'],
    install: { linux: 'sudo apt install hashcat', macos: 'brew install hashcat', windows: 'choco install hashcat' },
    scopeNote: CRACK_SCOPE_NOTE,
  },
  {
    name: 'john',
    category: 'crypto',
    purpose: 'CPU hash cracking with a large wordlist and mangling rules, for when the hash is the weak link.',
    binaries: ['john'],
    install: { linux: 'sudo apt install john', macos: 'brew install john', windows: 'choco install john' },
    scopeNote: CRACK_SCOPE_NOTE,
  },

  // -------------------------------------------------------------- stego ----
  {
    name: 'binwalk',
    category: 'stego',
    purpose: 'Carve embedded files out of an image or a firmware dump and fingerprint the formats inside.',
    binaries: ['binwalk'],
    install: { linux: 'sudo apt install binwalk', macos: 'brew install binwalk', windows: 'pip install binwalk' },
  },
  {
    name: 'exiftool',
    category: 'stego',
    purpose: 'Read and write image metadata — the fastest way to see an appended blob or a stashed comment.',
    binaries: ['exiftool'],
    install: { linux: 'sudo apt install libimage-exiftool-perl', macos: 'brew install exiftool', windows: 'choco install exiftool' },
  },
  {
    name: 'steghide',
    category: 'stego',
    purpose: 'Hide data in and extract data from JPEG, BMP and WAV files with a passphrase.',
    binaries: ['steghide'],
    install: { linux: 'sudo apt install steghide', macos: 'brew install steghide' },
  },
  {
    name: 'stegseek',
    category: 'stego',
    purpose: 'Extract steghide data without the passphrase, by attacking the seed space instead of the key.',
    binaries: ['stegseek'],
    install: {
      linux: 'Build from source: git clone https://github.com/stegegree420/stegseek && cd stegseek && make — put the resulting stegseek on PATH',
      macos: 'Build from source: git clone https://github.com/stegegree420/stegseek && cd stegseek && make — put the resulting stegseek on PATH',
    },
  },
  {
    name: 'outguess',
    category: 'stego',
    purpose: 'Extract from a modified JPEG when steghide reports nothing — a different classic scheme, not a fallback for the same one.',
    binaries: ['outguess'],
    install: { linux: 'sudo apt install outguess', macos: 'brew install outguess' },
  },
  {
    name: 'pngcheck',
    category: 'stego',
    purpose: 'Validate PNG chunk structure — length fields and CRC — which is where a hidden chunk shows up.',
    binaries: ['pngcheck'],
    install: { linux: 'sudo apt install pngcheck', macos: 'brew install pngcheck' },
  },
  {
    name: 'identify',
    category: 'stego',
    purpose: 'ImageMagick geometry and format probing; its convert pipeline can also rebuild or strip a file.',
    binaries: ['identify', 'magick', 'magick.exe'],
    install: { linux: 'sudo apt install imagemagick', macos: 'brew install imagemagick', windows: 'choco install imagemagick' },
  },
  {
    name: 'zsteg',
    category: 'stego',
    purpose: 'Enumerate every LSB bit plane of a PNG or BMP and print what each one decodes to.',
    binaries: ['zsteg'],
    install: { linux: 'gem install zsteg (needs a ruby interpreter first)', macos: 'gem install zsteg (macOS ships ruby)' },
  },
  {
    name: 'openstego',
    category: 'stego',
    purpose: 'LSB steganography for PNG and BMP with a password, for the formats steghide does not cover.',
    binaries: [],
    probe: 'java -jar openstego.jar --help',
    install: {
      linux: 'Download the release jar from github.com/syvaidya/openstego/releases and run java -jar openstego.jar (needs a JDK on PATH) — the probe only finds it when the jar is reachable from the working directory',
      macos: 'Download the release jar from github.com/syvaidya/openstego/releases and run java -jar openstego.jar (needs a JDK on PATH) — the probe only finds it when the jar is reachable from the working directory',
      windows: 'Download the release jar from github.com/syvaidya/openstego/releases and run java -jar openstego.jar (needs a JDK on PATH) — the probe only finds it when the jar is reachable from the working directory',
    },
  },
  {
    name: 'stegoveritas',
    category: 'stego',
    purpose: 'Run a whole battery of stego checks — trailing data, LSB planes, colour channels — over one file at once.',
    binaries: [],
    probe: PYTHON_PROBE('import stegoveritas'),
    install: PIP('stegoveritas'),
  },
  {
    name: 'foremost',
    category: 'stego',
    purpose: 'Carve a raw byte stream or an image back into its original files by signature.',
    binaries: ['foremost'],
    install: { linux: 'sudo apt install foremost', macos: 'brew install foremost', windows: 'choco install foremost' },
  },

  // --------------------------------------------------------------- misc ----
  {
    name: 'qpdf',
    category: 'misc',
    purpose: 'Linearize and decompress a PDF, so a hidden object or a nested stream becomes readable.',
    binaries: ['qpdf'],
    install: { linux: 'sudo apt install qpdf', macos: 'brew install qpdf', windows: 'choco install qpdf' },
  },
  {
    name: 'pdftotext',
    category: 'misc',
    purpose: 'Extract the text layer of a PDF in one command, which beats reading it in a viewer.',
    binaries: ['pdftotext'],
    install: { linux: 'sudo apt install poppler-utils', macos: 'brew install poppler', windows: 'choco install poppler' },
  },
  {
    name: 'pdftoppm',
    category: 'misc',
    purpose: 'Render PDF pages to an image for when the text layer is empty and the answer is in the picture.',
    binaries: ['pdftoppm'],
    install: { linux: 'sudo apt install poppler-utils', macos: 'brew install poppler', windows: 'choco install poppler' },
  },
  {
    name: 'tshark',
    category: 'misc',
    purpose: 'Filter and reassemble a packet capture, including a USB or TCP stream that is carrying the flag.',
    binaries: ['tshark'],
    install: { linux: 'sudo apt install tshark', macos: 'brew install wireshark — tshark ships with it', windows: 'choco install wireshark — tshark ships with it' },
  },
  {
    name: 'ffmpeg',
    category: 'misc',
    purpose: 'Probe, transcode and extract audio from a challenge video, which is usually the first thing to run on one.',
    binaries: ['ffmpeg'],
    install: { linux: 'sudo apt install ffmpeg', macos: 'brew install ffmpeg', windows: 'choco install ffmpeg' },
  },
  {
    name: 'sox',
    category: 'misc',
    purpose: 'Inspect and process audio — strip, resample, split — which undoes most simple spectrogram tricks.',
    binaries: ['sox'],
    install: { linux: 'sudo apt install sox', macos: 'brew install sox' },
  },
  {
    name: 'curl',
    category: 'misc',
    purpose: 'Fetch a challenge URL or post to it, and keep the raw response body for the next step.',
    binaries: ['curl'],
    install: { linux: 'sudo apt install curl' },
  },
  {
    // The one scanner the prompts, the mode docs, and the engagement tests all
    // name first — and it was missing from this catalog entirely, which meant
    // the missing-binary path in securityScan could never install it and a
    // `nmap` run could only ever report "not installed". `ncat` below is a
    // different binary from the same package, so both hints are `nmap`.
    name: 'nmap',
    category: 'misc',
    purpose: 'Port and service scan an in-scope target; the first move against anything with a network surface, and the usual source of the version string that names the next CVE.',
    binaries: ['nmap'],
    install: { linux: 'sudo apt install nmap', macos: 'brew install nmap', windows: 'choco install nmap' },
  },
  {
    name: '7z',
    category: 'misc',
    purpose: 'Open the archive a challenge hid something in, including the ones wearing a misleading extension.',
    binaries: ['7z', '7z.exe'],
    install: { linux: 'sudo apt install p7zip-full', macos: 'brew install p7zip', windows: 'choco install 7zip' },
  },
  {
    name: 'cyberchef',
    category: 'misc',
    purpose: 'The browser data-Operations toolbox, available headless for batch encode, decode and extract pipelines.',
    binaries: ['cyberchef', 'cyberchef.cmd'],
    probe: 'cyberchef --version',
    install: { linux: 'npm install -g cyberchef', macos: 'npm install -g cyberchef', windows: 'npm install -g cyberchef' },
  },
  {
    name: 'oletools',
    category: 'misc',
    purpose: 'Pull VBA macros, embedded objects and metadata out of an Office document.',
    binaries: [],
    probe: PYTHON_PROBE('import oletools'),
    install: PIP('oletools'),
  },
]

export function entriesForCategory(category: ToolCategory): CatalogEntry[] {
  return SECURITY_TOOL_CATALOG.filter((entry) => entry.category === category)
}

/** The executable a probe actually depends on — what has to be on PATH for the probe to mean anything. */
export function probeExecutable(probe: string | undefined): string | undefined {
  if (!probe) return undefined
  return probe.trim().split(/\s+/)[0]
}

/**
 * The binary name to look for on `platform`.
 *
 * Windows resolves the `.bat`/`.cmd`/`.exe` spelling when the entry lists one —
 * Ghidra's headless entry is `analyzeHeadless` everywhere except Windows, where
 * only `analyzeHeadless.bat` exists. A probe-only entry has no binary of its
 * own, so it reports the interpreter the probe shells out to.
 */
export function binaryForPlatform(entry: CatalogEntry, platform: NodeJS.Platform = process.platform): string | undefined {
  if (entry.binaries.length === 0) return probeExecutable(entry.probe)
  if (platform === 'win32') {
    const windowsName = entry.binaries.find((name) => /\.(?:bat|cmd|exe)$/i.test(name))
    if (windowsName) return windowsName
  }
  return entry.binaries[0]
}

/** Every name to look up on PATH for this platform, in catalog order. */
export function toolNamesFor(platform: NodeJS.Platform = process.platform): { name: string; binary: string; scopeNote?: string }[] {
  const names: { name: string; binary: string; scopeNote?: string }[] = []
  for (const entry of SECURITY_TOOL_CATALOG) {
    const binary = binaryForPlatform(entry, platform)
    if (!binary) continue
    names.push({ name: entry.name, binary, ...(entry.scopeNote ? { scopeNote: entry.scopeNote } : {}) })
  }
  return names
}
