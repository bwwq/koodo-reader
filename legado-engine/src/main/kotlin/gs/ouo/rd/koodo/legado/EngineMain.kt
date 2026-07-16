package gs.ouo.rd.koodo.legado

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import io.legado.app.data.entities.Book
import io.legado.app.data.entities.BookSource
import io.legado.app.data.entities.SearchBook
import io.legado.app.help.http.okHttpClient
import io.legado.app.model.webBook.WebBook
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import org.jsoup.Jsoup
import org.jsoup.safety.Safelist
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

private val gson: Gson = GsonBuilder().disableHtmlEscaping().create()
internal val dataDir = File(System.getenv("LEGADO_DATA") ?: "/data")
private val jobsDir = File(dataDir, "jobs")
private val engineToken = System.getenv("LEGADO_ENGINE_TOKEN") ?: ""
private val executor = Executors.newFixedThreadPool(2)
private val jobs = ConcurrentHashMap<String, EngineJob>()
private val futures = ConcurrentHashMap<String, Future<*>>()
private const val maxRequestBytes = 5 * 1024 * 1024
private const val maxEpubBytes = 512L * 1024L * 1024L
private const val maxChapters = 20_000
private const val maxCoverBytes = 10 * 1024 * 1024

private data class CoverAsset(val bytes: ByteArray, val mediaType: String, val extension: String)

private class EngineJob(val id: String) {
    @Volatile var status = "queued"
    @Volatile var stage = "queued"
    @Volatile var current = 0
    @Volatile var total = 0
    @Volatile var error = ""
    @Volatile var file = ""
    val createdAt = Instant.now().epochSecond

    fun response(): Map<String, Any> = mapOf(
        "id" to id,
        "status" to status,
        "stage" to stage,
        "current" to current,
        "total" to total,
        "error" to error,
        "ready" to (status == "ready")
    )
}

private fun HttpExchange.authorized(): Boolean {
    if (engineToken.isEmpty()) return remoteAddress.address.isLoopbackAddress
    return requestHeaders.getFirst("X-Engine-Token") == engineToken
}

private fun HttpExchange.readBody(): String {
    val sink = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0
    requestBody.use { input ->
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > maxRequestBytes) throw IllegalArgumentException("request body too large")
            sink.write(buffer, 0, count)
        }
    }
    val output = sink.toByteArray()
    if (output.size > maxRequestBytes) throw IllegalArgumentException("request body too large")
    return output.toString(StandardCharsets.UTF_8)
}

private fun HttpExchange.json(status: Int, value: Any) {
    val bytes = gson.toJson(value).toByteArray(StandardCharsets.UTF_8)
    responseHeaders.set("Content-Type", "application/json; charset=utf-8")
    sendResponseHeaders(status, bytes.size.toLong())
    responseBody.use { it.write(bytes) }
}

private fun HttpExchange.problem(status: Int, message: String) =
    json(status, mapOf("error" to message))

private val dangerousScript = Regex(
    "(?i)(?:Packages\\b|java\\.lang\\b|getClass\\s*\\(|forName\\s*\\(|" +
        "ProcessBuilder\\b|Runtime\\s*\\.|ClassLoader\\b|loadClass\\s*\\(|" +
        "java\\.io\\b|java\\.nio\\b|javax\\.script\\b|" +
        "readFile\\s*\\(|readTxtFile\\s*\\(|getFile\\s*\\(|deleteFile\\s*\\(|" +
        "unzipFile\\s*\\(|getTxtInFolder\\s*\\(|downloadFile\\s*\\()"
)

internal fun validateSource(raw: String): BookSource {
    if (dangerousScript.containsMatchIn(raw)) {
        throw IllegalArgumentException("source contains forbidden JVM access")
    }
    // reader-legado's migration path uses ruleToc as the discriminator between
    // legacy and modern JSON. Search-only modern sources legitimately omit it,
    // so add an empty rule object before delegating to the upstream parser.
    val sourceJson = runCatching { gson.fromJson(raw, JsonObject::class.java) }
        .getOrNull()
        ?.also { root ->
            val modern = listOf("searchUrl", "ruleSearch", "ruleBookInfo", "ruleContent")
                .any(root::has)
            if (modern && (!root.has("ruleToc") || root.get("ruleToc").isJsonNull)) {
                root.add("ruleToc", JsonObject())
            }
        }
        ?.let { gson.toJson(it) }
        ?: raw
    val source = BookSource.fromJson(sourceJson).getOrElse {
        throw IllegalArgumentException("invalid Legado source: ${it.message}")
    }
    if (source.bookSourceUrl.isBlank() || source.bookSourceName.isBlank()) {
        throw IllegalArgumentException("source name and URL are required")
    }
    if (Regex("(?i)\\\"webView\\\"\\s*:\\s*(?:true|\\\"?(?!false\\b)[^,}]+)").containsMatchIn(raw)) {
        throw IllegalArgumentException("WebView-dependent sources are not supported")
    }
    return source
}

private data class SearchRequest(
    val source: JsonObject,
    val keyword: String,
    val page: Int = 1,
    val namespace: String = "default"
)

private data class ImportRequest(
    val id: String = UUID.randomUUID().toString(),
    val source: JsonObject,
    val book: JsonObject,
    val namespace: String = "default"
)

private fun handleSearch(exchange: HttpExchange) {
    if (exchange.requestMethod != "POST") return exchange.problem(405, "method not allowed")
    val request = gson.fromJson(exchange.readBody(), SearchRequest::class.java)
    if (request.keyword.trim().isEmpty()) return exchange.problem(422, "keyword is required")
    val source = validateSource(gson.toJson(request.source))
    val result = runBlocking {
        withTimeout(20_000) {
            WebBook(source, debugLog = false, userNameSpace = request.namespace)
                .searchBook(request.keyword.trim(), request.page.coerceAtLeast(1))
        }
    }
    exchange.json(200, mapOf("items" to result))
}

private fun handleImports(exchange: HttpExchange) {
    val parts = exchange.requestURI.path.removePrefix("/internal/imports").trim('/').split('/')
        .filter { it.isNotEmpty() }
    if (parts.isEmpty()) {
        if (exchange.requestMethod != "POST") return exchange.problem(405, "method not allowed")
        val request = gson.fromJson(exchange.readBody(), ImportRequest::class.java)
        if (!request.id.matches(Regex("[A-Za-z0-9_-]{8,80}"))) {
            return exchange.problem(422, "invalid job id")
        }
        if (jobs.containsKey(request.id)) return exchange.problem(409, "job already exists")
        val source = validateSource(gson.toJson(request.source))
        val searchBook = gson.fromJson(request.book, SearchBook::class.java)
        val job = EngineJob(request.id)
        jobs[job.id] = job
        futures[job.id] = executor.submit { buildBook(job, source, searchBook, request.namespace) }
        return exchange.json(202, job.response())
    }

    val id = parts[0]
    val job = jobs[id] ?: return exchange.problem(404, "job not found")
    if (parts.size == 2 && parts[1] == "file") {
        if (exchange.requestMethod != "GET") return exchange.problem(405, "method not allowed")
        if (job.status != "ready") return exchange.problem(409, "job is not ready")
        val file = File(job.file)
        if (!file.isFile) return exchange.problem(404, "file not found")
        exchange.responseHeaders.set("Content-Type", "application/epub+zip")
        exchange.responseHeaders.set(
            "Content-Disposition",
            "attachment; filename=\"${file.name.replace(Regex("[^A-Za-z0-9._-]"), "_")}\""
        )
        exchange.sendResponseHeaders(200, file.length())
        file.inputStream().use { input -> exchange.responseBody.use { input.copyTo(it) } }
        return
    }
    when (exchange.requestMethod) {
        "GET" -> exchange.json(200, job.response())
        "DELETE" -> {
            futures.remove(id)?.cancel(true)
            job.status = "cancelled"
            job.stage = "cancelled"
            if (job.file.isNotEmpty()) File(job.file).delete()
            exchange.json(200, job.response())
        }
        else -> exchange.problem(405, "method not allowed")
    }
}

private fun buildBook(job: EngineJob, source: BookSource, search: SearchBook, namespace: String) {
    try {
        job.status = "running"
        job.stage = "book_info"
        search.setUserNameSpace(namespace)
        val webBook = WebBook(source, debugLog = false, userNameSpace = namespace)
        val book = runBlocking {
            withTimeout(30_000) {
                val candidate = search.toBook()
                if (candidate.tocUrl.isBlank() || candidate.intro.isNullOrBlank()) {
                    webBook.getBookInfo(candidate)
                } else candidate
            }
        }
        job.stage = "chapters"
        val chapters = runBlocking { withTimeout(120_000) { webBook.getChapterList(book) } }
        if (chapters.isEmpty()) throw IllegalStateException("chapter list is empty")
        if (chapters.size > maxChapters) throw IllegalStateException("too many chapters")
        job.total = chapters.size
        val contents = ArrayList<Pair<String, String>>(chapters.size)
        chapters.forEachIndexed { index, chapter ->
            if (Thread.currentThread().isInterrupted) throw InterruptedException("cancelled")
            var failure: Throwable? = null
            var content = ""
            repeat(3) { attempt ->
                if (content.isNotEmpty()) return@repeat
                try {
                    content = runBlocking {
                        withTimeout(30_000) {
                            webBook.getBookContent(book, chapter, chapters.getOrNull(index + 1)?.url)
                        }
                    }
                } catch (error: Throwable) {
                    failure = error
                    if (attempt < 2) Thread.sleep((attempt + 1) * 500L)
                }
            }
            if (content.isBlank()) {
                throw IllegalStateException("chapter ${index + 1} failed: ${failure?.message}")
            }
            contents.add(chapter.title.ifBlank { "Chapter ${index + 1}" } to content)
            job.current = index + 1
        }
        job.stage = "packaging"
        val safeName = book.name.ifBlank { "book" }.replace(Regex("[\\\\/:*?\"<>|]"), "-")
        val output = File(jobsDir, "${job.id}--${safeName.take(80)}.epub")
        val cover = downloadCover(book.customCoverUrl ?: book.coverUrl)
        writeEpub(book, contents, output, cover)
        if (output.length() > maxEpubBytes) {
            output.delete()
            throw IllegalStateException("generated EPUB exceeds 512 MiB")
        }
        job.file = output.absolutePath
        job.stage = "ready"
        job.status = "ready"
    } catch (error: Throwable) {
        if (job.status != "cancelled") {
            job.status = "failed"
            job.stage = "failed"
            job.error = error.message ?: error.javaClass.simpleName
        }
    }
}

private fun downloadCover(rawUrl: String?): CoverAsset? {
    if (rawUrl.isNullOrBlank()) return null
    return runCatching {
        val response = okHttpClient.newCall(Request.Builder().url(rawUrl).get().build()).execute()
        response.use {
            if (!it.isSuccessful) return null
            val mediaType = it.body?.contentType()?.toString()?.substringBefore(';') ?: return null
            val extension = when (mediaType.lowercase()) {
                "image/jpeg" -> "jpg"
                "image/png" -> "png"
                "image/gif" -> "gif"
                "image/webp" -> "webp"
                else -> return null
            }
            val body = it.body ?: return null
            if (body.contentLength() > maxCoverBytes) return null
            val sink = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            body.byteStream().use { input ->
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (sink.size() + count > maxCoverBytes) return null
                    sink.write(buffer, 0, count)
                }
            }
            CoverAsset(sink.toByteArray(), mediaType, extension)
        }
    }.getOrNull()
}

private fun writeEpub(book: Book, chapters: List<Pair<String, String>>, output: File, cover: CoverAsset?) {
    output.parentFile.mkdirs()
    Files.newOutputStream(output.toPath()).use { raw ->
        ZipOutputStream(BufferedOutputStream(raw)).use { zip ->
            val mime = "application/epub+zip".toByteArray(StandardCharsets.US_ASCII)
            val crc = CRC32().apply { update(mime) }
            zip.putNextEntry(ZipEntry("mimetype").apply {
                method = ZipEntry.STORED
                size = mime.size.toLong()
                compressedSize = mime.size.toLong()
                this.crc = crc.value
            })
            zip.write(mime)
            zip.closeEntry()
            zip.text("META-INF/container.xml", """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""")

            val chapterItems = chapters.indices.joinToString("\n") {
                "<item id=\"c$it\" href=\"chapter-$it.xhtml\" media-type=\"application/xhtml+xml\"/>"
            }
            val spine = chapters.indices.joinToString("\n") { "<itemref idref=\"c$it\"/>" }
            val identifier = UUID.nameUUIDFromBytes(book.bookUrl.toByteArray()).toString()
            val coverManifest = cover?.let {
                "<item id=\"cover-image\" href=\"cover.${it.extension}\" media-type=\"${it.mediaType}\" properties=\"cover-image\"/>"
            } ?: ""
            zip.text("OEBPS/content.opf", """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">$identifier</dc:identifier>
    <dc:title>${xml(book.name)}</dc:title>
    <dc:creator>${xml(book.author)}</dc:creator>
    <dc:description>${xml(book.intro ?: "")}</dc:description>
    <dc:source>${xml(book.originName)}</dc:source>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${Instant.now().toString().substringBefore('.')}Z</meta>
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>$coverManifest$chapterItems</manifest>
  <spine>$spine</spine>
</package>""")
            cover?.let { asset ->
                zip.putNextEntry(ZipEntry("OEBPS/cover.${asset.extension}"))
                zip.write(asset.bytes)
                zip.closeEntry()
            }
            val navItems = chapters.mapIndexed { index, pair ->
                "<li><a href=\"chapter-$index.xhtml\">${xml(pair.first)}</a></li>"
            }.joinToString("\n")
            zip.text("OEBPS/nav.xhtml", xhtml(book.name, "<nav epub:type=\"toc\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><ol>$navItems</ol></nav>"))
            chapters.forEachIndexed { index, pair ->
                val clean = Jsoup.clean(
                    pair.second,
                    "",
                    Safelist.relaxed().removeTags("script", "style", "iframe", "object", "embed"),
                    org.jsoup.nodes.Document.OutputSettings().prettyPrint(false)
                )
                val body = if (clean.isBlank()) "<p></p>" else clean
                zip.text("OEBPS/chapter-$index.xhtml", xhtml(pair.first, "<h1>${xml(pair.first)}</h1>$body"))
            }
        }
    }
}

private fun ZipOutputStream.text(path: String, value: String) {
    putNextEntry(ZipEntry(path))
    write(value.toByteArray(StandardCharsets.UTF_8))
    closeEntry()
}

private fun xhtml(title: String, body: String) = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xml(title)}</title><meta charset="utf-8"/></head><body>$body</body></html>"""

private fun xml(value: String): String = value
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;")

fun main() {
    installSandbox()
    jobsDir.mkdirs()
    jobsDir.listFiles { file -> file.isFile && file.extension.equals("epub", true) }
        ?.forEach { file ->
            val id = file.name.substringBefore("--")
            if (id.matches(Regex("[A-Za-z0-9_-]{8,80}"))) {
                jobs[id] = EngineJob(id).apply {
                    status = "ready"
                    stage = "ready"
                    this.file = file.absolutePath
                }
            }
        }
    val port = (System.getenv("LEGADO_PORT") ?: "9080").toInt()
    val server = HttpServer.create(InetSocketAddress("0.0.0.0", port), 0)
    server.executor = Executors.newCachedThreadPool()
    server.createContext("/health") { exchange -> exchange.json(200, mapOf("status" to "ok", "version" to "0.4.0")) }
    server.createContext("/internal/search") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleSearch(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "search failed")
        }
    }
    server.createContext("/internal/imports") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleImports(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "request failed")
        }
    }
    server.start()
    println("Koodo Legado engine 0.4.0 listening on :$port")
}
