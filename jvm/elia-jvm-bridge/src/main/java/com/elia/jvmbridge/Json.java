package com.elia.jvmbridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader/writer. The JDK ships no JSON API and this bridge speaks
 * exactly one small protocol, so a ~200-line recursive-descent parser is a
 * better dependency story than pulling in Jackson.
 *
 * Parsed values are: {@code Map<String,Object>}, {@code List<Object>},
 * {@code String}, {@code Double}, {@code Boolean}, {@code null}.
 */
final class Json {

  private Json() {}

  // ---- reader ----

  static Object parse(String text) {
    Parser p = new Parser(text);
    p.skipWs();
    Object v = p.value();
    p.skipWs();
    if (!p.atEnd()) throw new IllegalArgumentException("trailing characters in JSON");
    return v;
  }

  private static final class Parser {
    private final String s;
    private int i = 0;

    Parser(String s) {
      this.s = s;
    }

    boolean atEnd() {
      return i >= s.length();
    }

    void skipWs() {
      while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    char next() {
      return s.charAt(i++);
    }

    char peek() {
      return s.charAt(i);
    }

    Object value() {
      skipWs();
      char c = peek();
      switch (c) {
        case '{':
          return object();
        case '[':
          return array();
        case '"':
          return string();
        case 't':
        case 'f':
          return bool();
        case 'n':
          expect("null");
          return null;
        default:
          return number();
      }
    }

    Map<String, Object> object() {
      Map<String, Object> map = new LinkedHashMap<>();
      next(); // {
      skipWs();
      if (peek() == '}') {
        next();
        return map;
      }
      while (true) {
        skipWs();
        String key = string();
        skipWs();
        if (next() != ':') throw new IllegalArgumentException("expected ':'");
        map.put(key, value());
        skipWs();
        char c = next();
        if (c == '}') return map;
        if (c != ',') throw new IllegalArgumentException("expected ',' or '}'");
      }
    }

    List<Object> array() {
      List<Object> list = new ArrayList<>();
      next(); // [
      skipWs();
      if (peek() == ']') {
        next();
        return list;
      }
      while (true) {
        list.add(value());
        skipWs();
        char c = next();
        if (c == ']') return list;
        if (c != ',') throw new IllegalArgumentException("expected ',' or ']'");
      }
    }

    String string() {
      if (next() != '"') throw new IllegalArgumentException("expected string");
      StringBuilder sb = new StringBuilder();
      while (true) {
        char c = next();
        if (c == '"') return sb.toString();
        if (c == '\\') {
          char e = next();
          switch (e) {
            case '"': sb.append('"'); break;
            case '\\': sb.append('\\'); break;
            case '/': sb.append('/'); break;
            case 'b': sb.append('\b'); break;
            case 'f': sb.append('\f'); break;
            case 'n': sb.append('\n'); break;
            case 'r': sb.append('\r'); break;
            case 't': sb.append('\t'); break;
            case 'u':
              sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
              i += 4;
              break;
            default:
              throw new IllegalArgumentException("bad escape \\" + e);
          }
        } else {
          sb.append(c);
        }
      }
    }

    Boolean bool() {
      if (peek() == 't') {
        expect("true");
        return Boolean.TRUE;
      }
      expect("false");
      return Boolean.FALSE;
    }

    Double number() {
      int start = i;
      while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
      return Double.parseDouble(s.substring(start, i));
    }

    void expect(String lit) {
      if (!s.startsWith(lit, i)) throw new IllegalArgumentException("expected " + lit);
      i += lit.length();
    }
  }

  // ---- writer ----

  static String write(Object value) {
    StringBuilder sb = new StringBuilder();
    writeValue(sb, value);
    return sb.toString();
  }

  private static void writeValue(StringBuilder sb, Object v) {
    if (v == null) {
      sb.append("null");
    } else if (v instanceof String) {
      writeString(sb, (String) v);
    } else if (v instanceof Boolean || v instanceof Integer || v instanceof Long) {
      sb.append(v);
    } else if (v instanceof Double) {
      double d = (Double) v;
      if (d == Math.rint(d) && !Double.isInfinite(d)) sb.append((long) d);
      else sb.append(d);
    } else if (v instanceof Map) {
      sb.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
        if (!first) sb.append(',');
        first = false;
        writeString(sb, String.valueOf(e.getKey()));
        sb.append(':');
        writeValue(sb, e.getValue());
      }
      sb.append('}');
    } else if (v instanceof Iterable) {
      sb.append('[');
      boolean first = true;
      for (Object o : (Iterable<?>) v) {
        if (!first) sb.append(',');
        first = false;
        writeValue(sb, o);
      }
      sb.append(']');
    } else {
      writeString(sb, v.toString());
    }
  }

  private static void writeString(StringBuilder sb, String str) {
    sb.append('"');
    for (int k = 0; k < str.length(); k++) {
      char c = str.charAt(k);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    sb.append('"');
  }
}
