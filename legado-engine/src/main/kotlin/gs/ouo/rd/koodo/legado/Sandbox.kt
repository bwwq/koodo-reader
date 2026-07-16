package gs.ouo.rd.koodo.legado

import io.legado.app.adapters.ReaderAdapterHelper
import io.legado.app.adapters.ReaderAdapterInterface
import io.legado.app.help.http.StrResponse
import io.legado.app.model.DebugLog
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.ContextFactory
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

private val sandboxInstalled = AtomicBoolean(false)

private val allowedScriptClasses = listOf(
    "io.legado.app.data.entities.",
    "io.legado.app.model.analyzeRule.",
    "io.legado.app.help.JsExtensions",
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
    "java.util.LinkedHashSet"
)

fun installSandbox() {
    if (!sandboxInstalled.compareAndSet(false, true)) return
    ContextFactory.initGlobal(object : ContextFactory() {
        override fun makeContext(): Context {
            return super.makeContext().apply {
                classShutter = ClassShutter { name ->
                    allowedScriptClasses.any { allowed ->
                        if (allowed.endsWith('.')) name.startsWith(allowed) else name == allowed
                    }
                }
                optimizationLevel = -1
            }
        }
    })
    ReaderAdapterHelper.setAdapter(IsolatedAdapter(File(dataDir, "runtime")))
}

private class IsolatedAdapter(private val root: File) : ReaderAdapterInterface {
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
    ): StrResponse = throw UnsupportedOperationException("WebView-dependent sources are not supported")
}
