package com.elia.jvmbridge;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.StringWriter;
import java.io.Writer;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

/**
 * elia-jvm-bridge — a resident JVM service for Elia.
 *
 * Speaks the same newline-delimited JSON-RPC as {@code eliad}, over stdin/stdout.
 * {@code eliad} spawns and supervises it and forwards {@code jvm.*} requests.
 *
 * Today it does one thing: {@code jvm.check} type-checks a proposed .java edit
 * with the JDK's in-process compiler ({@code javax.tools}) and returns
 * diagnostics — so Elia catches a broken Java edit in a few hundred milliseconds
 * warm, instead of after a cold Gradle build.
 */
public final class Bridge {

  private static final String VERSION = "0.1.0";

  public static void main(String[] args) throws Exception {
    var in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    var out = new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isBlank()) continue;
      out.write(respond(line));
      out.write('\n');
      out.flush();
    }
  }

  /**
   * One request line in, one response line out, never throwing. Every error
   * carries the request's id: {@code eliad} matches responses by id and skips
   * the rest, so an error sent as id 0 (as it used to be) was never seen, and
   * the caller waited out its full timeout instead of failing fast.
   */
  @SuppressWarnings("unchecked")
  static String respond(String line) {
    Map<String, Object> req;
    try {
      Object parsed = Json.parse(line);
      if (!(parsed instanceof Map)) throw new IllegalArgumentException("request must be a JSON object");
      req = (Map<String, Object>) parsed;
    } catch (RuntimeException e) {
      return Json.write(error(leadingId(line), -32700, "parse error: " + e.getMessage()));
    }
    long id = requestId(req);
    try {
      return Json.write(handle(req, id));
    } catch (Throwable t) {
      return Json.write(error(id, -32603, String.valueOf(t)));
    }
  }

  private static long requestId(Map<String, Object> req) {
    return req.get("id") instanceof Number n ? n.longValue() : 0;
  }

  private static final Pattern LEADING_ID = Pattern.compile("^\\s*\\{\\s*\"id\"\\s*:\\s*(\\d{1,18})");

  /** The id from the start of a line that did not parse, e.g. {@code {"id":42,…}. */
  static long leadingId(String line) {
    Matcher m = LEADING_ID.matcher(line);
    return m.find() ? Long.parseLong(m.group(1)) : 0;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> handle(Map<String, Object> req, long id) {
    String method = String.valueOf(req.get("method"));
    Map<String, Object> params = (Map<String, Object>) req.getOrDefault("params", Map.of());

    Object result;
    switch (method) {
      case "jvm.info":
        result = Map.of(
            "version", VERSION,
            "protocol", 1,
            "java_version", System.getProperty("java.version"),
            "java_home", System.getProperty("java.home"));
        break;
      case "jvm.check":
        result = check(params);
        break;
      default:
        return error(id, -32601, "unknown method: " + method);
    }
    var ok = new LinkedHashMap<String, Object>();
    ok.put("id", id);
    ok.put("result", result);
    return ok;
  }

  private static Map<String, Object> error(long id, int code, String message) {
    var e = new LinkedHashMap<String, Object>();
    e.put("id", id);
    e.put("error", Map.of("code", code, "message", message));
    return e;
  }

  // ---- jvm.check ----

  @SuppressWarnings("unchecked")
  private static Map<String, Object> check(Map<String, Object> params) {
    String source = String.valueOf(params.getOrDefault("source", ""));
    String path = String.valueOf(params.getOrDefault("path", "Anon.java"));
    List<String> classpath =
        params.get("classpath") instanceof List ? (List<String>) params.get("classpath") : List.of();

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      return Map.of("ok", true, "errors", List.of(
          Map.of("line", 0, "column", 0, "message", "no system Java compiler (JRE, not JDK?)", "severity", "warning")));
    }

    var diagnostics = new DiagnosticCollector<JavaFileObject>();
    StandardJavaFileManager standard = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8);
    var fileManager = new DiscardingFileManager(standard);

    var options = new ArrayList<String>(List.of("-proc:none", "-implicit:none", "-nowarn"));
    if (!classpath.isEmpty()) {
      options.add("-cp");
      options.add(String.join(File.pathSeparator, classpath));
    }

    var unit = new MemorySource(typeName(source, path), source);
    JavaCompiler.CompilationTask task =
        compiler.getTask(new StringWriter(), fileManager, diagnostics, options, null, List.of(unit));
    task.call();

    boolean ok = true;
    var errors = new ArrayList<Map<String, Object>>();
    for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
      boolean isError = d.getKind() == Diagnostic.Kind.ERROR;
      if (isError) ok = false;
      else if (d.getKind() != Diagnostic.Kind.WARNING && d.getKind() != Diagnostic.Kind.MANDATORY_WARNING) {
        continue;
      }
      errors.add(Map.of(
          "line", Math.max(0, d.getLineNumber()),
          "column", Math.max(0, d.getColumnNumber()),
          "message", d.getMessage(null),
          "severity", isError ? "error" : "warning"));
    }
    return Map.of("ok", ok, "errors", errors);
  }

  private static final Pattern PACKAGE = Pattern.compile("(?m)^\\s*package\\s+([\\w.]+)\\s*;");
  private static final Pattern TYPE = Pattern.compile(
      "\\b((?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\\s+)*)"
          + "(?:class|interface|enum|record|@interface)\\s+(\\w+)");

  /**
   * The class name to give the in-memory unit. javac requires a public
   * top-level type to live in a file of its own name, so that type wins; then
   * the file's own name if the unit declares it; then the first top-level type.
   * It used to take the first type-like match anywhere, so {@code class Helper {}}
   * followed by {@code public class Main {}} named the unit {@code Helper} and
   * javac reported a false "should be declared in a file named Main.java".
   * Nested types and anything inside comments or literals are ignored.
   */
  static String typeName(String source, String path) {
    String code = blankCommentsAndLiterals(source);
    String base = basenameNoExt(path);
    String first = null;
    String publicType = null;
    boolean declaresBase = false;
    int depth = 0;
    int scanned = 0;
    Matcher t = TYPE.matcher(code);
    while (t.find()) {
      for (; scanned < t.start(); scanned++) {
        char c = code.charAt(scanned);
        if (c == '{') depth++;
        else if (c == '}') depth = Math.max(0, depth - 1);
      }
      if (depth != 0) continue;
      String name = t.group(2);
      if (first == null) first = name;
      if (publicType == null && t.group(1).matches("(?s).*\\bpublic\\b.*")) publicType = name;
      if (name.equals(base)) declaresBase = true;
    }
    String simple = publicType != null ? publicType : declaresBase ? base : first != null ? first : base;
    Matcher p = PACKAGE.matcher(code);
    return p.find() ? p.group(1) + "." + simple : simple;
  }

  /** {@code source} with comments and string/char literals (text blocks too) blanked to spaces. */
  static String blankCommentsAndLiterals(String source) {
    StringBuilder out = new StringBuilder(source);
    int n = source.length();
    int i = 0;
    while (i < n) {
      char c = source.charAt(i);
      int end;
      if (source.startsWith("//", i)) {
        end = source.indexOf('\n', i);
        if (end < 0) end = n;
      } else if (source.startsWith("/*", i)) {
        end = source.indexOf("*/", i + 2);
        end = end < 0 ? n : end + 2;
      } else if (source.startsWith("\"\"\"", i)) {
        end = source.indexOf("\"\"\"", i + 3);
        end = end < 0 ? n : end + 3;
      } else if (c == '"' || c == '\'') {
        end = i + 1;
        while (end < n && source.charAt(end) != c && source.charAt(end) != '\n') {
          end += source.charAt(end) == '\\' ? 2 : 1;
        }
        end = Math.min(n, end + 1);
      } else {
        i++;
        continue;
      }
      for (int k = i; k < end; k++) {
        if (source.charAt(k) != '\n') out.setCharAt(k, ' ');
      }
      i = end;
    }
    return out.toString();
  }

  private static String basenameNoExt(String path) {
    String base = path.replaceAll("^.*[/\\\\]", "");
    int dot = base.lastIndexOf('.');
    String name = dot > 0 ? base.substring(0, dot) : base;
    return name.matches("[A-Za-z_$][\\w$]*") ? name : "Anon";
  }

  /** An in-memory .java source. */
  private static final class MemorySource extends SimpleJavaFileObject {
    private final String code;

    MemorySource(String className, String code) {
      super(URI.create("string:///" + className.replace('.', '/') + Kind.SOURCE.extension), Kind.SOURCE);
      this.code = code;
    }

    @Override
    public CharSequence getCharContent(boolean ignoreEncodingErrors) {
      return code;
    }
  }

  /**
   * Type-checks without writing anything to disk: class files and any other
   * output (resources an annotation processor or plugin would emit) all go to
   * a sink. Only {@code getJavaFileForOutput} used to be covered, so resource
   * output still reached the real file manager; {@code -proc:none} kept that
   * dormant, but the check should not depend on the option list.
   */
  private static final class DiscardingFileManager
      extends ForwardingJavaFileManager<StandardJavaFileManager> {

    DiscardingFileManager(StandardJavaFileManager delegate) {
      super(delegate);
    }

    @Override
    public JavaFileObject getJavaFileForOutput(
        Location location, String className, JavaFileObject.Kind kind, FileObject sibling) {
      return new Sink(URI.create("mem:///" + className.replace('.', '/') + kind.extension), kind);
    }

    @Override
    public FileObject getFileForOutput(
        Location location, String packageName, String relativeName, FileObject sibling) {
      String dir = packageName.isEmpty() ? "" : packageName.replace('.', '/') + "/";
      return new Sink(URI.create("mem:///" + dir + relativeName), JavaFileObject.Kind.OTHER);
    }
  }

  /** An output file whose contents are thrown away. */
  private static final class Sink extends SimpleJavaFileObject {
    Sink(URI uri, Kind kind) {
      super(uri, kind);
    }

    @Override
    public OutputStream openOutputStream() {
      return OutputStream.nullOutputStream();
    }

    @Override
    public Writer openWriter() {
      return Writer.nullWriter();
    }
  }

  private Bridge() {}
}
