#!/usr/bin/env python3
"""elia-box escape suite.

Every attack is a small program run *inside* the box that tries to break a promise
elia-box makes: read what it should not, write where it should not, reach the network,
signal or outlive its host, or overrun its budget. The suite passes only if every
attack fails.

A suite that only ever sees attacks fail proves nothing (they might be broken), so
each attack that is safe to repeat also runs once *outside* the box as a control and
must succeed there. A control that does not succeed marks the test invalid, not the
sandbox secure.

    python3 run.py [--backend seatbelt|docker|auto] [--bin PATH] [--only NAME] [--json FILE]

Exit status: 0 all contained, 1 an attack escaped or a control was invalid, 2 setup failed.
"""
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]

TOKEN = "ESCAPE-CANARY-" + os.urandom(6).hex()


class Ctx:
    """Everything an attack may need, prepared once per run."""

    def __init__(self, backend, exe):
        self.backend = backend
        self.exe = exe
        raw = Path(tempfile.mkdtemp(prefix="eb-escape-"))
        self.root = raw.resolve()
        self.ws = self.root / "ws"
        self.ws.mkdir()
        self.outside = self.root / "outside"
        self.outside.mkdir()
        self.secret = self.outside / "secret.txt"
        self.secret.write_text(TOKEN)
        self.home_canary = None
        home = Path.home()
        # A canary in the REAL home directory: the place credentials live.
        self.home_canary = home / f".elia-box-canary-{os.getpid()}"
        self.home_canary.write_text(TOKEN)
        # A loopback service on the host the box must not be able to reach.
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(8)
        self.port = self.listener.getsockname()[1]
        self.hits = []
        threading.Thread(target=self._serve, daemon=True).start()
        self.keychain = None
        self._kc_list = None
        if sys.platform == "darwin":
            self._make_keychain()
        self.victim = subprocess.Popen(["/bin/sleep", "300"])  # a host process the box must not signal
        # python inside the box: docker has its own; seatbelt needs one it can read.
        self.py = "python3" if backend == "docker" else sys.executable
        os.environ["ELIA_ESCAPE_CANARY"] = TOKEN  # host env var the box must not inherit

    def _make_keychain(self):
        """A throwaway keychain, unlocked, holding a canary secret. The box cannot read the
        file, so only the Security daemon could hand the secret over."""
        sec = "/usr/bin/security"
        listed = subprocess.run([sec, "list-keychains", "-d", "user"], capture_output=True, text=True)
        self._kc_list = [l.strip().strip('"') for l in listed.stdout.splitlines() if l.strip()]
        kc = self.outside / "canary.keychain-db"
        ok = subprocess.run([sec, "create-keychain", "-p", "pw", str(kc)], capture_output=True).returncode == 0
        if ok:
            subprocess.run([sec, "add-generic-password", "-a", "eb", "-s", "ebcanary", "-w", TOKEN, str(kc)], capture_output=True)
            subprocess.run([sec, "unlock-keychain", "-p", "pw", str(kc)], capture_output=True)
            self.keychain = kc

    def _serve(self):
        while True:
            try:
                c, _ = self.listener.accept()
            except OSError:
                return
            self.hits.append(time.time())
            try:
                c.sendall(TOKEN.encode())
            finally:
                c.close()

    def cleanup(self):
        if self.keychain is not None:
            subprocess.run(["/usr/bin/security", "delete-keychain", str(self.keychain)], capture_output=True)
            if self._kc_list:
                subprocess.run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", *self._kc_list], capture_output=True)
        self.victim.kill()
        self.listener.close()
        try:
            self.home_canary.unlink()
        except FileNotFoundError:
            pass
        shutil.rmtree(self.root, ignore_errors=True)


def policy(ctx, **over):
    p = {"workspace": str(ctx.ws), "backend": ctx.backend, "limits": {"wallMs": 20000}}
    if ctx.backend != "docker":
        p["readPaths"] = [str(Path(sys.executable).resolve().parents[1])] if Path(sys.executable).resolve().parents[1] != Path("/") else []
        p["readPaths"] += [d for d in ["/opt/homebrew/bin"] if os.path.isdir(d)]
    for k, v in over.items():
        if k == "limits":
            p["limits"].update(v)
        else:
            p[k] = v
    return p


def in_box(ctx, argv, **over):
    pol = policy(ctx, **over)
    r = subprocess.run([ctx.exe, "run", "--policy", "-", "--", *argv], input=json.dumps(pol),
                       capture_output=True, text=True, timeout=120)
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"error": {"kind": "internal", "message": (r.stderr or r.stdout)[:300]}}
    return out


def sh(script):
    return ["/bin/sh", "-c", script]


class Attack:
    def __init__(self, name, why, build, escaped, control=None, policy_over=None, backends=None):
        self.name, self.why, self.build, self.escaped, self.control = name, why, build, escaped, control
        self.policy_over = policy_over or {}
        # Attacks aimed at macOS services mean nothing inside a Linux container that
        # does not even contain the tool; running them there would be a fake pass.
        self.backends = backends


def out_has(token):
    return lambda ctx, res: token in res.get("stdout", "")


def reached_listener(ctx, res):
    return TOKEN in res.get("stdout", "") or bool(ctx.hits)


def victim_dead(ctx, res):
    return ctx.victim.poll() is not None


def attacks(ctx):
    py = ctx.py
    A = []

    A.append(Attack("read-outside-file", "an ordinary file outside the workspace",
                    lambda: sh(f"cat {ctx.secret}"), out_has(TOKEN),
                    control=lambda: sh(f"cat {ctx.secret}")))
    A.append(Attack("read-real-home", "a credential-like file in the real home directory",
                    lambda: sh(f"cat {ctx.home_canary}"), out_has(TOKEN),
                    control=lambda: sh(f"cat {ctx.home_canary}")))
    A.append(Attack("read-via-symlink", "a symlink planted in the workspace pointing at a secret",
                    lambda: sh(f"ln -s {ctx.secret} link && cat link"), out_has(TOKEN),
                    control=lambda: sh(f"ln -sf {ctx.secret} link2 && cat link2")))
    A.append(Attack("read-via-traversal", "../ traversal out of the workspace",
                    lambda: sh(f"cat ../outside/secret.txt"), out_has(TOKEN),
                    control=lambda: sh(f"cat ../outside/secret.txt")))
    A.append(Attack("list-home", "listing the real home directory",
                    lambda: sh(f"ls {Path.home()}"), lambda c, r: ".elia-box-canary" in r.get("stdout", ""),
                    control=lambda: sh(f"ls -A {Path.home()}")))
    planted = ctx.outside / "planted"
    A.append(Attack("write-outside-file", "creating a file outside the workspace",
                    lambda: sh(f"echo x > {planted}"), lambda c, r: planted.exists(),
                    control=lambda: sh(f"echo x > {planted}")))
    A.append(Attack("write-via-symlink", "writing through a workspace symlink to an outside directory",
                    lambda: sh(f"ln -s {ctx.outside} out && echo x > out/via-link"),
                    lambda c, r: (ctx.outside / "via-link").exists(),
                    control=lambda: sh(f"ln -sf {ctx.outside} out2 && echo x > out2/via-link")))
    A.append(Attack("write-real-home", "dropping a file into the real home directory",
                    lambda: sh(f"echo x > {Path.home()}/.elia-box-planted-{os.getpid()}"),
                    lambda c, r: (Path.home() / f".elia-box-planted-{os.getpid()}").exists(),
                    control=lambda: sh(f"echo x > {Path.home()}/.elia-box-planted-{os.getpid()}")))
    A.append(Attack("env-inheritance", "a host environment variable carrying a secret",
                    lambda: sh("env; echo ---; printenv ELIA_ESCAPE_CANARY"), out_has(TOKEN),
                    control=lambda: sh("printenv ELIA_ESCAPE_CANARY")))
    A.append(Attack("net-loopback-service", "a service on the host's loopback interface",
                    lambda: [py, "-c", f"import socket;s=socket.create_connection(('127.0.0.1',{ctx.port}),3);print(s.recv(99).decode())"],
                    reached_listener,
                    control=lambda: [py, "-c", f"import socket;s=socket.create_connection(('127.0.0.1',{ctx.port}),3);print(s.recv(99).decode())"]))
    A.append(Attack("net-external-ip", "a direct TCP connection to the internet",
                    lambda: [py, "-c", "import socket;s=socket.create_connection(('1.1.1.1',443),4);print('CONNECTED-EXTERNAL')"],
                    out_has("CONNECTED-EXTERNAL"),
                    control=lambda: [py, "-c", "import socket;s=socket.create_connection(('1.1.1.1',443),4);print('CONNECTED-EXTERNAL')"]))
    A.append(Attack("net-dns", "resolving a name (a covert channel even when TCP is blocked)",
                    lambda: [py, "-c", "import socket;print('RESOLVED',socket.gethostbyname('example.com'))"],
                    out_has("RESOLVED"),
                    control=lambda: [py, "-c", "import socket;print('RESOLVED',socket.gethostbyname('example.com'))"]))
    docker_sock = Path.home() / ".docker" / "run" / "docker.sock"
    if docker_sock.exists():
        A.append(Attack("docker-socket", "the host's docker socket (root-equivalent on the host)",
                        lambda: [py, "-c", f"import socket;s=socket.socket(socket.AF_UNIX);s.connect('{docker_sock}');print('CONNECTED-DOCKER')"],
                        out_has("CONNECTED-DOCKER"),
                        control=lambda: [py, "-c", f"import socket;s=socket.socket(socket.AF_UNIX);s.connect('{docker_sock}');print('CONNECTED-DOCKER')"]))
    A.append(Attack("signal-host-process", "killing a process that belongs to the host",
                    lambda: sh(f"kill -9 {ctx.victim.pid}"), victim_dead))
    pw = ctx.outside / "pwned-by-osascript"
    if sys.platform == "darwin":
        A.append(Attack("osascript-launch", "asking macOS to run a command outside the sandbox (Apple Events)",
                        lambda: ["/usr/bin/osascript", "-e", f'do shell script "touch {pw}"'],
                        lambda c, r: pw.exists(),
                        control=lambda: ["/usr/bin/osascript", "-e", f'do shell script "touch {pw}"'], backends=("seatbelt",)))
        if ctx.keychain is not None:
            kc_cmd = ["/usr/bin/security", "find-generic-password", "-s", "ebcanary", "-w", str(ctx.keychain)]
            A.append(Attack("keychain-access", "extracting a secret through the Security daemon (the file itself is unreadable)",
                            lambda: kc_cmd, out_has(TOKEN), control=lambda: kc_cmd, backends=("seatbelt",)))
        A.append(Attack("launchctl-submit", "registering a job with launchd to run outside the sandbox",
                        lambda: sh(f"/bin/launchctl submit -l eb.escape.{os.getpid()} -- /usr/bin/touch {ctx.outside}/launchd-ran; sleep 2"),
                        lambda c, r: (ctx.outside / "launchd-ran").exists(), backends=("seatbelt",)))
    marker = f"3{int(time.time()) % 1000:03d}.{os.getpid() % 100:02d}"
    A.append(Attack("outlive-session", "daemonizing (setsid + double fork) to keep running after the run ends",
                    lambda: [py, "-c",
                             "import os,sys\n"
                             "if os.fork()==0:\n"
                             "    os.setsid()\n"
                             "    if os.fork()==0:\n"
                             f"        os.execvp('sleep',['sleep','{marker}'])\n"
                             "    os._exit(0)\n"
                             "os.wait()\n"],
                    lambda c, r: _alive(marker),
                    ))
    A.append(Attack("fork-bomb", "spawning far more processes than the budget",
                    lambda: [py, "-c",
                             "import subprocess,sys\nprocs=[]\n"
                             "for i in range(400):\n"
                             "    try: procs.append(subprocess.Popen(['sleep','25']))\n"
                             "    except OSError: break\n"
                             "print('SPAWNED',len(procs))\n"],
                    lambda c, r: _spawned(r) >= 300,
                    policy_over={"limits": {"pids": 60}}))
    A.append(Attack("memory-bomb", "allocating several times the memory budget",
                    lambda: [py, "-c", "b=bytearray(1500*1024*1024)\nfor i in range(0,len(b),4096): b[i]=1\nprint('ALLOCATED')"],
                    out_has("ALLOCATED"), policy_over={"limits": {"memoryMb": 256}}))
    A.append(Attack("cpu-spin", "spinning forever past the wall clock",
                    lambda: [py, "-c", "while True: pass"],
                    lambda c, r: r.get("receipt", {}).get("exit", {}).get("timedOut") is not True,
                    policy_over={"limits": {"wallMs": 1500}}))
    A.append(Attack("disk-fill", "writing far more than the file-size budget",
                    lambda: sh("head -c 60000000 /dev/zero > big; ls -l big | awk '{print $5}'"),
                    lambda c, r: (c.ws / "big").exists() and (c.ws / "big").stat().st_size > 12 * 1024 * 1024,
                    policy_over={"limits": {"fileSizeMb": 10}}))
    A.append(Attack("output-flood", "printing far more than the output budget",
                    lambda: sh("head -c 30000000 /dev/zero | tr '\\0' A"),
                    lambda c, r: len(r.get("stdout", "")) > 2 * 1024 * 1024,
                    policy_over={"limits": {"outputBytes": 1024 * 1024}}))
    return A


def _alive(marker):
    time.sleep(0.4)
    r = subprocess.run(["/usr/bin/pgrep", "-f", f"sleep {marker}"], capture_output=True, text=True)
    alive = bool(r.stdout.strip())
    if alive:
        subprocess.run(["/usr/bin/pkill", "-f", f"sleep {marker}"])
    return alive


def _spawned(res):
    for line in res.get("stdout", "").splitlines():
        if line.startswith("SPAWNED"):
            return int(line.split()[1])
    return 0


def run_control(ctx, atk):
    """Runs the attack bare on the host from inside the workspace; returns whether it 'escaped'."""
    argv = atk.control()
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=30, cwd=ctx.ws)
    except subprocess.TimeoutExpired:
        return False
    res = {"stdout": r.stdout, "stderr": r.stderr}
    return bool(atk.escaped(ctx, res))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="auto")
    ap.add_argument("--bin", default=os.environ.get("ELIA_BOX_BIN") or str(REPO / "bin" / "elia-box"))
    ap.add_argument("--only")
    ap.add_argument("--json")
    a = ap.parse_args()
    if not os.path.exists(a.bin):
        print(f"elia-box binary not found at {a.bin}", file=sys.stderr)
        return 2
    probe = json.loads(subprocess.run([a.bin, "probe"], capture_output=True, text=True).stdout)
    backend = a.backend
    if backend == "auto":
        backend = "seatbelt" if probe["seatbelt"]["available"] else "docker"
    if not probe.get(backend, {}).get("available"):
        print(f"backend {backend} is not available: {probe.get(backend)}", file=sys.stderr)
        return 2
    if backend == "docker" and not probe["docker"]["imagePresent"]:
        print("docker image missing; run `elia-box image build`", file=sys.stderr)
        return 2

    ctx = Ctx(backend, a.bin)
    results, bad = [], 0
    try:
        for atk in attacks(ctx):
            if a.only and a.only != atk.name:
                continue
            if atk.backends and backend not in atk.backends:
                print(f"[n/a ] {atk.name:24s} {atk.why} (macOS-only)")
                continue
            for f in (ctx.outside / "planted", ctx.outside / "via-link", ctx.outside / "pwned-by-osascript",
                      ctx.outside / "launchd-ran", Path.home() / f".elia-box-planted-{os.getpid()}"):
                if f.exists():
                    f.unlink()
            for f in list(ctx.ws.iterdir()):
                f.unlink() if f.is_file() or f.is_symlink() else shutil.rmtree(f)
            # control first: the attack must be able to succeed somewhere
            control = None
            if atk.control:
                control = run_control(ctx, atk)
                for f in (ctx.outside / "planted", ctx.outside / "via-link", ctx.outside / "pwned-by-osascript",
                          Path.home() / f".elia-box-planted-{os.getpid()}"):
                    if f.exists():
                        f.unlink()
                for f in list(ctx.ws.iterdir()):
                    f.unlink() if f.is_file() or f.is_symlink() else shutil.rmtree(f)
                ctx.hits.clear()
            res = in_box(ctx, atk.build(), **atk.policy_over)
            if "error" in res:
                status, detail = "SETUP-ERROR", res["error"]["message"]
                bad += 1
            else:
                escaped = bool(atk.escaped(ctx, res))
                if control is False:
                    status, detail = "INVALID-CONTROL", "the attack does not succeed even outside the box, so this test proves nothing"
                    bad += 1
                elif escaped:
                    status, detail = "ESCAPED", (res.get("stdout", "")[:120] + res.get("stderr", "")[:120]).strip()
                    bad += 1
                else:
                    status, detail = "contained", ""
            results.append({"attack": atk.name, "why": atk.why, "status": status, "control": control, "detail": detail})
            mark = {"contained": "ok  ", "ESCAPED": "FAIL", "INVALID-CONTROL": "????", "SETUP-ERROR": "ERR "}[status]
            ctl = "" if control is None else (" control:succeeded" if control else " control:did-not-succeed")
            print(f"[{mark}] {atk.name:24s} {atk.why}{ctl}" + (f"\n         -> {status}: {detail}" if detail else ""))
    finally:
        ctx.cleanup()
    print(f"\nbackend={backend}  attacks={len(results)}  problems={bad}")
    if a.json:
        Path(a.json).write_text(json.dumps({"backend": backend, "results": results}, indent=2))
    return 1 if bad else 0


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
