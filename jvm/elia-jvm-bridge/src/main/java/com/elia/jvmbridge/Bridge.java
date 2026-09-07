package com.elia.jvmbridge;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.StringWriter;
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
      String response;
      try {
        @SuppressWarnings("unchecked")
        Map<String, Object> req = (Map<String, Object>) Json.parse(line);
        response = Json.write(handle(req));
      } catch (Throwable t) {
        response = Json.write(error(0, -32603, String.valueOf(t)));
      }
      out.write(response);
      out.write('\n');
      out.flush();
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> handle(Map<String, Object> req) {
    long id = ((Number) req.getOrDefault("id", 0.0)).longValue();
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
  private static final Pattern TYPE =
      Pattern.compile("\\b(?:public\\s+|final\\s+|abstract\\s+|sealed\\s+)*(?:class|interface|enum|record)\\s+(\\w+)");

  static String typeName(String source, String path) {
    Matcher t = TYPE.matcher(source);
    String simple = t.find() ? t.group(1) : basenameNoExt(path);
    Matcher p = PACKAGE.matcher(source);
    return p.find() ? p.group(1) + "." + simple : simple;
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

  /** Type-checks without writing any .class files to disk. */
  private static final class DiscardingFileManager
      extends ForwardingJavaFileManager<StandardJavaFileManager> {

    DiscardingFileManager(StandardJavaFileManager delegate) {
      super(delegate);
    }

    @Override
    public JavaFileObject getJavaFileForOutput(
        Location location, String className, JavaFileObject.Kind kind, javax.tools.FileObject sibling) {
      return new SimpleJavaFileObject(
          URI.create("mem:///" + className.replace('.', '/') + kind.extension), kind) {
        @Override
        public OutputStream openOutputStream() {
          return OutputStream.nullOutputStream();
        }
      };
    }
  }

  private Bridge() {}
}
