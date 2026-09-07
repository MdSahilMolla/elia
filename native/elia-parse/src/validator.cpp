// elia-parse — structural edit check. See ../include/elia_parse.h.
//
// One linear pass. A small state machine over the byte stream that understands
// each language family's comment, string, and char syntax well enough to answer
// one question: would this text fail to tokenize? Unbalanced (), [], {};
// unterminated "..." / '...' / `...` / ''' / """; unterminated /* ... */.

#include "elia_parse.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr const char *kVersion = "0.1.0";

enum class Lang { Generic, JsTs, Python, Rust, Go };

Lang to_lang(int v) {
  switch (v) {
    case ELIA_PARSE_JS_TS: return Lang::JsTs;
    case ELIA_PARSE_PYTHON: return Lang::Python;
    case ELIA_PARSE_RUST: return Lang::Rust;
    case ELIA_PARSE_GO: return Lang::Go;
    default: return Lang::Generic;
  }
}

struct Pos {
  unsigned line = 1;
  unsigned col = 1;
};

struct Open {
  char ch;
  Pos pos;
};

struct Error {
  Pos pos;
  std::string message;
};

char closer_for(char open) {
  switch (open) {
    case '(': return ')';
    case '[': return ']';
    case '{': return '}';
    default: return '\0';
  }
}

class Scanner {
 public:
  Scanner(const char *s, size_t n, Lang lang) : s_(s), n_(n), lang_(lang) {}

  std::vector<Error> run() {
    scan_code(/*in_template_interp=*/false);
    // Anything still open at EOF is unbalanced.
    for (auto it = stack_.rbegin(); it != stack_.rend(); ++it) {
      errors_.push_back({it->pos, std::string("unclosed '") + it->ch + "'"});
    }
    return std::move(errors_);
  }

 private:
  const char *s_;
  size_t n_;
  size_t i_ = 0;
  Pos pos_;
  Lang lang_;
  std::vector<Open> stack_;
  std::vector<Error> errors_;

  char cur() const { return i_ < n_ ? s_[i_] : '\0'; }
  char at(size_t k) const { return (i_ + k) < n_ ? s_[i_ + k] : '\0'; }
  bool eof() const { return i_ >= n_; }

  void adv() {
    if (i_ >= n_) return;
    if (s_[i_] == '\n') {
      pos_.line++;
      pos_.col = 1;
    } else {
      pos_.col++;
    }
    i_++;
  }

  void adv(int count) {
    for (int k = 0; k < count && !eof(); ++k) adv();
  }

  bool starts_with(const char *lit) const {
    size_t m = std::strlen(lit);
    if (i_ + m > n_) return false;
    return std::memcmp(s_ + i_, lit, m) == 0;
  }

  // Returns when it consumes the interpolation-closing `}` (in_template_interp),
  // or at EOF.
  void scan_code(bool in_template_interp) {
    while (!eof()) {
      char c = cur();

      // --- comments ---
      if ((lang_ != Lang::Python) && c == '/' && at(1) == '/') {
        scan_line_comment();
        continue;
      }
      if (lang_ == Lang::Python && c == '#') {
        scan_line_comment();
        continue;
      }
      if ((lang_ != Lang::Python) && c == '/' && at(1) == '*') {
        scan_block_comment(/*nestable=*/lang_ == Lang::Rust);
        continue;
      }

      // --- strings / chars ---
      if (c == '"') {
        if (lang_ == Lang::Python && at(1) == '"' && at(2) == '"') {
          scan_triple('"');
        } else {
          scan_quoted('"', /*multiline=*/false);
        }
        continue;
      }
      if (c == '\'') {
        if (lang_ == Lang::Python && at(1) == '\'' && at(2) == '\'') {
          scan_triple('\'');
        } else if (lang_ == Lang::Rust) {
          scan_rust_quote_or_lifetime();
        } else if (lang_ == Lang::Python || lang_ == Lang::JsTs) {
          scan_quoted('\'', /*multiline=*/false);  // Python/JS: ' delimits strings
        } else {
          scan_quoted('\'', /*multiline=*/false);  // C-family char literal
        }
        continue;
      }
      if (c == '`') {
        if (lang_ == Lang::JsTs) {
          scan_template();
          continue;
        }
        if (lang_ == Lang::Go) {
          scan_quoted('`', /*multiline=*/true);
          continue;
        }
        adv();
        continue;
      }
      if (lang_ == Lang::Rust && (c == 'r') && (at(1) == '"' || at(1) == '#')) {
        if (scan_rust_raw_string()) continue;
        // not actually a raw string (e.g. an identifier starting with r) — fall through
      }

      // --- brackets ---
      if (c == '(' || c == '[' || c == '{') {
        stack_.push_back({c, pos_});
        adv();
        continue;
      }
      if (c == ')' || c == ']' || c == '}') {
        if (c == '}' && in_template_interp &&
            (stack_.empty() || stack_.back().ch != '{')) {
          adv();  // closes ${ ... }
          return;
        }
        if (stack_.empty()) {
          errors_.push_back({pos_, std::string("unexpected '") + c + "'"});
          adv();
          continue;
        }
        char want = closer_for(stack_.back().ch);
        if (want != c) {
          errors_.push_back(
              {pos_, std::string("'") + c + "' does not match '" + stack_.back().ch + "'"});
          // Pop anyway to keep going; the unclosed report covers the rest.
        }
        stack_.pop_back();
        adv();
        continue;
      }

      adv();
    }
  }

  void scan_line_comment() {
    while (!eof() && cur() != '\n') adv();
  }

  void scan_block_comment(bool nestable) {
    Pos start = pos_;
    adv(2);  // consume /*
    int depth = 1;
    while (!eof()) {
      if (starts_with("*/")) {
        adv(2);
        if (--depth == 0) return;
        continue;
      }
      if (nestable && starts_with("/*")) {
        adv(2);
        depth++;
        continue;
      }
      adv();
    }
    errors_.push_back({start, "unterminated block comment"});
  }

  void scan_quoted(char delim, bool multiline) {
    Pos start = pos_;
    adv();  // opening delim
    while (!eof()) {
      char c = cur();
      if (c == '\\') {
        adv(2);
        continue;
      }
      if (c == delim) {
        adv();
        return;
      }
      if (c == '\n' && !multiline) {
        errors_.push_back({start, std::string("unterminated string ") + delim});
        return;  // resync at the newline
      }
      adv();
    }
    errors_.push_back({start, std::string("unterminated string ") + delim});
  }

  void scan_triple(char q) {
    Pos start = pos_;
    adv(3);
    while (!eof()) {
      if (cur() == '\\') {
        adv(2);
        continue;
      }
      if (cur() == q && at(1) == q && at(2) == q) {
        adv(3);
        return;
      }
      adv();
    }
    errors_.push_back({start, "unterminated triple-quoted string"});
  }

  void scan_template() {
    Pos start = pos_;
    adv();  // opening backtick
    while (!eof()) {
      char c = cur();
      if (c == '\\') {
        adv(2);
        continue;
      }
      if (c == '`') {
        adv();
        return;
      }
      if (c == '$' && at(1) == '{') {
        adv(2);
        scan_code(/*in_template_interp=*/true);
        continue;
      }
      adv();
    }
    errors_.push_back({start, "unterminated template literal"});
  }

  // Rust: distinguish a char literal 'x' / '\n' from a lifetime 'a or a label.
  void scan_rust_quote_or_lifetime() {
    if (at(1) == '\\') {
      scan_quoted('\'', /*multiline=*/false);
      return;
    }
    // 'x'  -> char literal (char at +1, closing quote at +2)
    if (at(1) != '\0' && at(2) == '\'') {
      adv(3);
      return;
    }
    // Otherwise a lifetime/label: consume the apostrophe, let the ident scan.
    adv();
  }

  // Rust raw string:  r"..."  or  r#"..."#  (matching hash count). Returns false
  // if what follows `r` is not a raw string opener.
  bool scan_rust_raw_string() {
    size_t save_i = i_;
    Pos save_pos = pos_;
    adv();  // r
    int hashes = 0;
    while (cur() == '#') {
      hashes++;
      adv();
    }
    if (cur() != '"') {
      i_ = save_i;
      pos_ = save_pos;
      return false;
    }
    Pos start = save_pos;
    adv();  // opening quote
    std::string terminator = "\"";
    terminator.append(hashes, '#');
    while (!eof()) {
      if (starts_with(terminator.c_str())) {
        adv(static_cast<int>(terminator.size()));
        return true;
      }
      adv();
    }
    errors_.push_back({start, "unterminated raw string"});
    return true;
  }
};

void json_escape(const std::string &in, std::string &out) {
  for (char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
}

char *dup_cstr(const std::string &s) {
  char *out = static_cast<char *>(std::malloc(s.size() + 1));
  if (!out) return nullptr;
  std::memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}

}  // namespace

extern "C" {

char *elia_parse_check_json(const char *source, size_t len, int lang) {
  std::vector<Error> errors;
  if (source != nullptr && len > 0) {
    Scanner scanner(source, len, to_lang(lang));
    errors = scanner.run();
  }

  std::string json = "{\"ok\":";
  json += errors.empty() ? "true" : "false";
  json += ",\"errors\":[";
  for (size_t k = 0; k < errors.size(); ++k) {
    if (k) json += ',';
    json += "{\"line\":";
    json += std::to_string(errors[k].pos.line);
    json += ",\"column\":";
    json += std::to_string(errors[k].pos.col);
    json += ",\"message\":\"";
    json_escape(errors[k].message, json);
    json += "\"}";
  }
  json += "]}";
  return dup_cstr(json);
}

void elia_parse_free_string(char *s) { std::free(s); }

const char *elia_parse_version(void) { return kVersion; }

}  // extern "C"
