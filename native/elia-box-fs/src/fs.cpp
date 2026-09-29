#include "elia_box_fs.h"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#ifdef __APPLE__
#include <sys/clonefile.h>
#endif

namespace {

thread_local std::string g_error;

int fail(const std::string &msg) {
  g_error = msg + ": " + std::strerror(errno);
  return -1;
}

char *dup_string(const std::string &s) {
  char *out = static_cast<char *>(std::malloc(s.size() + 1));
  if (!out) return nullptr;
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}

// ---- SHA-256 (FIPS 180-4) -------------------------------------------------

struct Sha256 {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  unsigned char buf[64];
  size_t buflen = 0;
  uint64_t total = 0;

  static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

  void block(const unsigned char *p) {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = (uint32_t(p[i * 4]) << 24) | (uint32_t(p[i * 4 + 1]) << 16) |
             (uint32_t(p[i * 4 + 2]) << 8) | uint32_t(p[i * 4 + 3]);
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = hh + S1 + ch + k[i] + w[i];
      uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }

  void update(const unsigned char *data, size_t len) {
    total += len;
    while (len > 0) {
      size_t take = std::min(len, sizeof(buf) - buflen);
      std::memcpy(buf + buflen, data, take);
      buflen += take; data += take; len -= take;
      if (buflen == 64) { block(buf); buflen = 0; }
    }
  }

  std::string hex() {
    uint64_t bits = total * 8;
    unsigned char pad = 0x80;
    update(&pad, 1);
    unsigned char zero = 0;
    while (buflen != 56) update(&zero, 1);
    unsigned char len[8];
    for (int i = 0; i < 8; i++) len[i] = static_cast<unsigned char>(bits >> (56 - 8 * i));
    update(len, 8);
    static const char *digits = "0123456789abcdef";
    std::string out;
    for (int i = 0; i < 8; i++)
      for (int j = 3; j >= 0; j--) {
        unsigned char byte = static_cast<unsigned char>(h[i] >> (8 * j));
        out.push_back(digits[byte >> 4]);
        out.push_back(digits[byte & 15]);
      }
    return out;
  }
};

bool hash_file(const std::string &path, std::string &out) {
  int fd = ::open(path.c_str(), O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return false;
  Sha256 sha;
  unsigned char chunk[1 << 16];
  for (;;) {
    ssize_t n = ::read(fd, chunk, sizeof(chunk));
    if (n < 0) { if (errno == EINTR) continue; ::close(fd); return false; }
    if (n == 0) break;
    sha.update(chunk, static_cast<size_t>(n));
  }
  ::close(fd);
  out = sha.hex();
  return true;
}

// ---- tree walking -----------------------------------------------------------

std::vector<std::string> list_dir(const std::string &path) {
  std::vector<std::string> names;
  DIR *d = ::opendir(path.c_str());
  if (!d) return names;
  while (dirent *e = ::readdir(d)) {
    if (!std::strcmp(e->d_name, ".") || !std::strcmp(e->d_name, "..")) continue;
    names.emplace_back(e->d_name);
  }
  ::closedir(d);
  std::sort(names.begin(), names.end());
  return names;
}

std::set<std::string> split_lines(const char *s) {
  std::set<std::string> out;
  if (!s) return out;
  std::stringstream ss(s);
  std::string line;
  while (std::getline(ss, line))
    if (!line.empty()) out.insert(line);
  return out;
}

void walk(const std::string &root, const std::string &rel, const std::set<std::string> &excl,
          std::vector<std::string> &lines) {
  const std::string dir = rel.empty() ? root : root + "/" + rel;
  for (const auto &name : list_dir(dir)) {
    if (excl.count(name)) continue;
    const std::string r = rel.empty() ? name : rel + "/" + name;
    const std::string full = root + "/" + r;
    struct stat st;
    if (::lstat(full.c_str(), &st) != 0) continue;
    char mode[16];
    std::snprintf(mode, sizeof(mode), "%04o", static_cast<unsigned>(st.st_mode & 07777));
    std::string line;
    if (S_ISLNK(st.st_mode)) {
      char target[4096];
      ssize_t n = ::readlink(full.c_str(), target, sizeof(target) - 1);
      std::string t = n > 0 ? std::string(target, static_cast<size_t>(n)) : "";
      line = std::string("L\t") + mode + "\t0\t" + t + "\t" + r + "\n";
      lines.push_back(line);
    } else if (S_ISDIR(st.st_mode)) {
      lines.push_back(std::string("D\t") + mode + "\t0\t-\t" + r + "\n");
      walk(root, r, excl, lines);
    } else if (S_ISREG(st.st_mode)) {
      std::string h;
      if (!hash_file(full, h)) h = "unreadable";
      lines.push_back(std::string("F\t") + mode + "\t" + std::to_string(static_cast<long long>(st.st_size)) +
                      "\t" + h + "\t" + r + "\n");
    }
    // sockets, fifos and devices are not workspace content
  }
}

// ---- fork -------------------------------------------------------------------

bool copy_file(const std::string &src, const std::string &dst, mode_t mode) {
  int in = ::open(src.c_str(), O_RDONLY | O_NOFOLLOW);
  if (in < 0) return false;
  int out = ::open(dst.c_str(), O_WRONLY | O_CREAT | O_EXCL, mode & 07777);
  if (out < 0) { ::close(in); return false; }
  char chunk[1 << 16];
  bool ok = true;
  for (;;) {
    ssize_t n = ::read(in, chunk, sizeof(chunk));
    if (n < 0) { if (errno == EINTR) continue; ok = false; break; }
    if (n == 0) break;
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = ::write(out, chunk + off, static_cast<size_t>(n - off));
      if (w < 0) { if (errno == EINTR) continue; ok = false; break; }
      off += w;
    }
    if (!ok) break;
  }
  ::close(in);
  ::close(out);
  ::fchmodat(AT_FDCWD, dst.c_str(), mode & 07777, 0);
  return ok;
}

bool copy_tree(const std::string &src, const std::string &dst) {
  struct stat st;
  if (::lstat(src.c_str(), &st) != 0) return false;
  if (!S_ISDIR(st.st_mode)) return false;
  if (::mkdir(dst.c_str(), 0700) != 0) return false;
  for (const auto &name : list_dir(src)) {
    const std::string s = src + "/" + name, d = dst + "/" + name;
    struct stat e;
    if (::lstat(s.c_str(), &e) != 0) return false;
    if (S_ISLNK(e.st_mode)) {
      char target[4096];
      ssize_t n = ::readlink(s.c_str(), target, sizeof(target) - 1);
      if (n < 0) return false;
      target[n] = '\0';
      if (::symlink(target, d.c_str()) != 0) return false;
    } else if (S_ISDIR(e.st_mode)) {
      if (!copy_tree(s, d)) return false;
    } else if (S_ISREG(e.st_mode)) {
      if (!copy_file(s, d, e.st_mode)) return false;
    }
  }
  ::chmod(dst.c_str(), st.st_mode & 07777);
  return true;
}

bool remove_tree(const std::string &path) {
  struct stat st;
  if (::lstat(path.c_str(), &st) != 0) return errno == ENOENT;
  if (S_ISDIR(st.st_mode)) {
    ::chmod(path.c_str(), 0700);  // a read-only directory must be openable to be emptied
    for (const auto &name : list_dir(path))
      if (!remove_tree(path + "/" + name)) return false;
    return ::rmdir(path.c_str()) == 0;
  }
  return ::unlink(path.c_str()) == 0;
}

// ---- manifests --------------------------------------------------------------

std::map<std::string, std::string> parse_manifest(const char *m) {
  std::map<std::string, std::string> out;  // path -> "kind\tmode\tsize\thash"
  if (!m) return out;
  std::stringstream ss(m);
  std::string line;
  while (std::getline(ss, line)) {
    // the path is everything after the fourth tab, so paths may contain tabs
    size_t pos = 0;
    for (int i = 0; i < 4; i++) {
      pos = line.find('\t', pos);
      if (pos == std::string::npos) break;
      pos++;
    }
    if (pos == std::string::npos || pos > line.size()) continue;
    out[line.substr(pos)] = line.substr(0, pos - 1);
  }
  return out;
}

std::string json_escape(const std::string &s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
        else out.push_back(static_cast<char>(c));
    }
  }
  return out + "\"";
}

std::string json_array(const std::vector<std::string> &v) {
  std::string out = "[";
  for (size_t i = 0; i < v.size(); i++) {
    if (i) out += ",";
    out += json_escape(v[i]);
  }
  return out + "]";
}

}  // namespace

extern "C" {

int ebfs_fork(const char *src, const char *dst, int *used_clone) {
  if (!src || !dst) { g_error = "null path"; return -1; }
  if (used_clone) *used_clone = 0;
  struct stat st;
  if (::lstat(dst, &st) == 0) { errno = EEXIST; return fail(std::string("destination exists: ") + dst); }
#ifdef __APPLE__
  if (::clonefile(src, dst, CLONE_NOFOLLOW) == 0) {
    if (used_clone) *used_clone = 1;
    return 0;
  }
  // ENOTSUP (not APFS) and EXDEV (different volume) fall through to a byte copy;
  // anything else is a real failure and would fail the copy too.
  if (errno != ENOTSUP && errno != EXDEV) return fail(std::string("clonefile ") + src);
#endif
  if (!copy_tree(src, dst)) {
    int saved = errno;
    remove_tree(dst);
    errno = saved;
    return fail(std::string("copy ") + src);
  }
  return 0;
}

char *ebfs_snapshot(const char *root, const char *excludes) {
  if (!root) { g_error = "null root"; return nullptr; }
  struct stat st;
  if (::stat(root, &st) != 0 || !S_ISDIR(st.st_mode)) {
    errno = ENOTDIR;
    fail(std::string("snapshot root ") + root);
    return nullptr;
  }
  std::string base(root);
  while (base.size() > 1 && base.back() == '/') base.pop_back();
  std::vector<std::string> lines;
  walk(base, "", split_lines(excludes), lines);
  // depth-first over sorted names: deterministic, and diff works on maps anyway
  std::string out;
  for (const auto &l : lines) out += l;
  return dup_string(out);
}

char *ebfs_diff(const char *before, const char *after) {
  auto a = parse_manifest(before), b = parse_manifest(after);
  std::vector<std::string> added, modified, deleted;
  for (const auto &[path, meta] : b) {
    auto it = a.find(path);
    if (it == a.end()) added.push_back(path);
    else if (it->second != meta) modified.push_back(path);
  }
  for (const auto &[path, meta] : a)
    if (!b.count(path)) deleted.push_back(path);
  return dup_string("{\"added\":" + json_array(added) + ",\"modified\":" + json_array(modified) +
                    ",\"deleted\":" + json_array(deleted) + "}");
}

char *ebfs_sha256_hex(const unsigned char *data, size_t len) {
  Sha256 sha;
  if (data && len) sha.update(data, len);
  return dup_string(sha.hex());
}

int ebfs_remove_tree(const char *path) {
  if (!path || !*path || !std::strcmp(path, "/")) { g_error = "refusing to remove an empty path or /"; return -1; }
  return remove_tree(path) ? 0 : fail(std::string("remove ") + path);
}

const char *ebfs_last_error(void) { return g_error.c_str(); }
void ebfs_free(char *p) { std::free(p); }

}  // extern "C"
