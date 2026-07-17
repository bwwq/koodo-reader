package gs.ouo.rd.koodo.legado

import io.legado.app.adapters.ReaderAdapterHelper
import io.legado.app.adapters.ReaderAdapterInterface
import io.legado.app.help.http.StrResponse
import io.legado.app.help.http.CookieStore
import io.legado.app.model.DebugLog
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.ContextFactory
import org.mozilla.javascript.EvaluatorException
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.WrapFactory
import java.io.File
import java.net.URLEncoder
import java.net.URLDecoder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private val sandboxInstalled = AtomicBoolean(false)
private val scriptDeadlineMillis = ThreadLocal<Long>()
private val rhinoDeadlineKey = Any()
private val sourceMessageSink = ThreadLocal<((String) -> Unit)?>()

val legadoJsCompatibilityScript = """
(function () {
  if (!String.prototype.includes) String.prototype.includes = function (value, start) { return this.indexOf(value, start || 0) !== -1; };
  if (!String.prototype.startsWith) String.prototype.startsWith = function (value, start) { return this.indexOf(value, start || 0) === (start || 0); };
  if (!String.prototype.endsWith) String.prototype.endsWith = function (value, length) { var end = length === undefined ? this.length : length; return this.substring(end - value.length, end) === value; };
  if (!String.prototype.padStart) String.prototype.padStart = function (length, fill) { var value = String(this); var pad = fill === undefined ? ' ' : String(fill); while (value.length < length) value = pad + value; return value.slice(value.length - length); };
  if (!Array.prototype.includes) Array.prototype.includes = function (value, start) { return this.indexOf(value, start || 0) !== -1; };
  if (!Array.prototype.find) Array.prototype.find = function (callback, self) { for (var i = 0; i < this.length; i++) if (callback.call(self, this[i], i, this)) return this[i]; };
  if (!Array.prototype.findIndex) Array.prototype.findIndex = function (callback, self) { for (var i = 0; i < this.length; i++) if (callback.call(self, this[i], i, this)) return i; return -1; };
  if (!Object.values) Object.values = function (value) { return Object.keys(value).map(function (key) { return value[key]; }); };
  if (!Object.entries) Object.entries = function (value) { return Object.keys(value).map(function (key) { return [key, value[key]]; }); };
  if (!Object.assign) Object.assign = function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] || {}; Object.keys(source).forEach(function (key) { target[key] = source[key]; }); } return target; };
  var defineObjectMethod = function (name, value) { if (!Object.prototype[name]) Object.defineProperty(Object.prototype, name, { value: value, configurable: true, writable: true }); };
  defineObjectMethod('includes', function (value, start) { return String(this).indexOf(value, start || 0) !== -1; });
  defineObjectMethod('startsWith', function (value, start) { return String(this).indexOf(value, start || 0) === (start || 0); });
  defineObjectMethod('endsWith', function (value, length) { var text = String(this); var end = length === undefined ? text.length : length; return text.substring(end - value.length, end) === value; });
  defineObjectMethod('padStart', function (length, fill) { var text = String(this); var pad = fill === undefined ? ' ' : String(fill); while (text.length < length) text = pad + text; return text.slice(text.length - length); });
})();
""".trimIndent()

internal fun <T> withRhinoDeadline(timeoutMillis: Long, block: () -> T): T {
    scriptDeadlineMillis.set(timeoutMillis)
    return try { block() } finally { scriptDeadlineMillis.remove() }
}

private fun resetRhinoDeadlineAfterBrowser() {
    Context.getCurrentContext()?.putThreadLocal(rhinoDeadlineKey, System.nanoTime() + TimeUnit.SECONDS.toNanos(30))
}

internal fun setSourceMessageSink(sink: ((String) -> Unit)?) {
    if (sink == null) sourceMessageSink.remove() else sourceMessageSink.set(sink)
}

private val allowedScriptClasses = listOf(
    "io.legado.app.data.entities.",
    "io.legado.app.model.analyzeRule.",
    "io.legado.app.help.CacheManager",
    "io.legado.app.help.JsExtensions",
    "io.legado.app.help.http.CookieStore",
    "io.legado.app.help.http.StrResponse",
    "org.jsoup.",
    "java.lang.String",
    "java.lang.Boolean",
    "java.lang.Byte",
    "java.lang.Short",
    "java.lang.Integer",
    "java.lang.Long",
    "java.lang.Float",
    "java.lang.Double",
    "java.math.BigDecimal",
    "java.math.BigInteger",
    "java.util.ArrayList",
    "java.util.HashMap",
    "java.util.LinkedHashMap",
    "java.util.LinkedHashSet",
    "org.mozilla.javascript.ConsString"
)

fun installSandbox() {
    if (!sandboxInstalled.compareAndSet(false, true)) return
    val shutter = ClassShutter { name ->
        allowedScriptClasses.any { allowed ->
            if (allowed.endsWith('.')) name.startsWith(allowed) else name == allowed
        }
    }
    try {
        // The bundled ScriptEngine installs its own global factory. Load it
        // first, then harden every context produced by that factory.
        Class.forName("com.script.javascript.RhinoScriptEngine")
        ContextFactory.getGlobal().addListener(SandboxContextListener(shutter))
        ReaderAdapterHelper.setAdapter(IsolatedAdapter(File(dataDir, "runtime")))
    } catch (error: Throwable) {
        sandboxInstalled.set(false)
        throw error
    }
}

private class DeadlineContextFactory : ContextFactory() {
    override fun observeInstructionCount(context: Context, instructionCount: Int) {
        val deadline = context.getThreadLocal(rhinoDeadlineKey) as? Long ?: return
        if (System.nanoTime() > deadline) throw EvaluatorException("JavaScript execution timed out")
    }
}

private class SandboxContextListener(private val shutter: ClassShutter) : ContextFactory.Listener {
    override fun contextCreated(context: Context) = configureRhinoContext(context, shutter)

    override fun contextReleased(context: Context) = Unit
}

private val deadlineContextFactory = DeadlineContextFactory()
private val contextFactoryField = Context::class.java.getDeclaredField("factory").apply { isAccessible = true }
private val classShutterField = Context::class.java.getDeclaredField("classShutter").apply { isAccessible = true }

private class SafeWrapFactory : WrapFactory() {
    init {
        isJavaPrimitiveWrap = false
    }

    override fun wrap(cx: Context, scope: Scriptable, obj: Any?, staticType: Class<*>?): Any? {
        // Rhino represents template-literal concatenations as ConsString. Treat
        // every CharSequence as a JavaScript string so String.prototype APIs
        // remain available when the value crosses a function boundary.
        if (obj is CharSequence) return obj.toString()
        return super.wrap(cx, scope, obj, staticType)
    }
}

private val safeWrapFactory = SafeWrapFactory()

private fun configureRhinoContext(context: Context, shutter: ClassShutter) {
    // Legado sources commonly use ES6 syntax such as template literals,
    // destructuring and object-property shorthand. Rhino otherwise inherits
    // the engine's legacy default and rejects valid source rules while parsing.
    context.languageVersion = Context.VERSION_ES6
    context.optimizationLevel = -1
    context.instructionObserverThreshold = 10_000
    context.wrapFactory = safeWrapFactory
    classShutterField.set(context, shutter)
    contextFactoryField.set(context, deadlineContextFactory)
    context.putThreadLocal(
        rhinoDeadlineKey,
        System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(scriptDeadlineMillis.get() ?: 30_000L)
    )
}

private class IsolatedAdapter(private val root: File) : ReaderAdapterInterface {
    private val gson = Gson()
    private val webviewUrl = (System.getenv("LEGADO_WEBVIEW_URL") ?: "http://legado-webview:9223").trimEnd('/')
    private val webviewToken = System.getenv("LEGADO_WEBVIEW_TOKEN") ?: ""
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val webviewClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(35, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .build()

    private fun browserNamespace(namespace: String): String = namespace.substringBefore("::source:")

    override fun reportMessage(message: String) {
        sourceMessageSink.get()?.invoke(message.take(4_000))
    }

    init { root.mkdirs() }

    private fun resolve(parts: List<String>): String {
        val candidate = parts.fold(root) { current, part -> File(current, part) }.canonicalFile
        val base = root.canonicalFile
        if (candidate != base && !candidate.path.startsWith(base.path + File.separator)) {
            throw SecurityException("path escapes isolated runtime directory")
        }
        candidate.mkdirs()
        return candidate.path
    }

    override fun getWorkDir(subPath: String): String = resolve(listOf(subPath))
    override fun getWorkDir(vararg subDirFiles: String): String = resolve(subDirFiles.toList())
    override fun getCacheDir(): String = resolve(listOf("cache"))

    override suspend fun getStrResponseByRemoteWebview(
        url: String?, html: String?, encode: String?, tag: String?,
        headerMap: Map<String, String>?, sourceRegex: String?, javaScript: String?,
        proxy: String?, post: Boolean, body: String?, userNameSpace: String,
        debugLog: DebugLog?
    ): StrResponse {
        val payload = mapOf(
            "url" to url,
            "html" to html,
            "encode" to encode,
            "source" to (tag ?: url ?: "default"),
            "headers" to (headerMap ?: emptyMap<String, String>()),
            "sourceRegex" to sourceRegex,
            "javaScript" to javaScript,
            "post" to post,
            "body" to body,
            "namespace" to browserNamespace(userNameSpace)
        )
        val result = request("POST", "/render", payload)
        syncCookies(userNameSpace, result["cookies"])
        return StrResponse(result["url"]?.toString() ?: url.orEmpty(), result["body"]?.toString())
    }

    override suspend fun startBrowserSession(
        url: String,
        title: String,
        source: String,
        userNameSpace: String,
        await: Boolean,
        html: String?,
        javaScript: String?
    ): StrResponse {
        val inlineHtml = html ?: decodeDataHtml(url)
        val created = request("POST", "/sessions", mapOf(
            "url" to (if (inlineHtml != null && url.startsWith("data:text/html", true)) null else url),
            "html" to inlineHtml,
            "javaScript" to javaScript,
            "title" to title,
            "source" to source,
            "namespace" to browserNamespace(userNameSpace)
        ))
        val id = created["id"]?.toString() ?: throw IllegalStateException("browser session was not created")
        if (!await) return StrResponse(url, "")
        val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(30)
        while (System.nanoTime() < deadline) {
            if (Thread.currentThread().isInterrupted) throw InterruptedException("browser session cancelled")
            val state = request("GET", "/sessions/${URLEncoder.encode(id, "UTF-8")}", null)
            when (state["state"]?.toString()) {
                "finished" -> {
                    syncCookies(userNameSpace, state["cookies"])
                    resetRhinoDeadlineAfterBrowser()
                    return StrResponse(state["url"]?.toString() ?: url, state["body"]?.toString())
                }
                "failed", "cancelled" -> throw IllegalStateException(state["error"]?.toString()?.ifBlank { "browser session cancelled" } ?: "browser session cancelled")
            }
            Thread.sleep(750)
        }
        throw IllegalStateException("browser session timed out")
    }

    private fun decodeDataHtml(url: String): String? {
        if (!url.startsWith("data:text/html", true)) return null
        val metadata = url.substringBefore(',')
        val payload = url.substringAfter(',', "")
        return if (metadata.contains(";base64", true)) {
            String(java.util.Base64.getDecoder().decode(payload), Charsets.UTF_8)
        } else URLDecoder.decode(payload, "UTF-8")
    }

    private fun request(method: String, path: String, value: Any?): Map<String, Any?> {
        val builder = Request.Builder().url(webviewUrl + path).header("X-Engine-Token", webviewToken)
        if (method == "POST") builder.post(gson.toJson(value).toRequestBody(jsonType)) else builder.get()
        val response = webviewClient.newCall(builder.build()).execute()
        response.use {
            val body = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                val problem = runCatching { gson.fromJson(body, Map::class.java)["error"]?.toString() }.getOrNull()
                throw IllegalStateException(problem ?: "WebView HTTP ${it.code}")
            }
            val type = object : TypeToken<Map<String, Any?>>() {}.type
            return gson.fromJson(body, type)
        }
    }

    private fun syncCookies(namespace: String, raw: Any?) {
        val values = raw as? List<*> ?: return
        val store = CookieStore(namespace)
        values.forEach { item ->
            val cookie = item as? Map<*, *> ?: return@forEach
            val domain = cookie["domain"]?.toString()?.trimStart('.') ?: return@forEach
            val name = cookie["name"]?.toString() ?: return@forEach
            val value = cookie["value"]?.toString() ?: ""
            store.replaceCookie("https://$domain", "$name=$value")
        }
    }
}
