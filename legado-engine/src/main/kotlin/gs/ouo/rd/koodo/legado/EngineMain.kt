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
import java.net.URI
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.Semaphore
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

private val gson: Gson = GsonBuilder().disableHtmlEscaping().create()
internal val dataDir = File(System.getenv("LEGADO_DATA") ?: "/data")
private val jobsDir = File(dataDir, "jobs")
private val engineToken = System.getenv("LEGADO_ENGINE_TOKEN") ?: ""
private val executor = Executors.newFixedThreadPool(2)
private val imageExecutor = Executors.newFixedThreadPool(4)
private val jobs = ConcurrentHashMap<String, EngineJob>()
private val futures = ConcurrentHashMap<String, Future<*>>()
private val actionJobs = ConcurrentHashMap<String, EngineActionJob>()
private const val maxRequestBytes = 5 * 1024 * 1024
private const val maxEpubBytes = 512L * 1024L * 1024L
private const val maxChapters = 20_000
private const val maxCoverBytes = 10 * 1024 * 1024
private const val maxImageBytes = 20 * 1024 * 1024
private const val maxBookImages = 20_000
internal const val epubChaptersPerDocument = 20

internal data class CoverAsset(val bytes: ByteArray, val mediaType: String, val extension: String)
internal data class ImageAsset(val path: String, val bytes: ByteArray, val mediaType: String)

private class EngineJob(val id: String) {
    @Volatile var status = "queued"
    @Volatile var stage = "queued"
    @Volatile var current = 0
    @Volatile var total = 0
    @Volatile var error = ""
    @Volatile var message = ""
    @Volatile var file = ""
    @Volatile var latestChapter = ""
    @Volatile var latestChapterUrl = ""
    @Volatile var chapterCount = 0
    val createdAt = Instant.now().epochSecond

    fun response(): Map<String, Any> = mapOf(
        "id" to id,
        "status" to status,
        "stage" to stage,
        "current" to current,
        "total" to total,
        "latest_chapter" to latestChapter,
        "latest_chapter_url" to latestChapterUrl,
        "chapter_count" to chapterCount,
        "error" to error,
        "message" to message,
        "ready" to (status == "ready")
    )
}

private class EngineActionJob(val id: String) {
    @Volatile var status = "queued"
    @Volatile var message = ""
    @Volatile var error = ""
    val createdAt = Instant.now().epochSecond

    fun response(): Map<String, Any> = mapOf(
        "id" to id,
        "status" to status,
        "message" to message,
        "error" to error,
        "created_at" to createdAt
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
    "(?i)(?:getClass\\s*\\(|forName\\s*\\(|" +
        "ProcessBuilder\\b|Runtime\\s*\\.|ClassLoader\\b|loadClass\\s*\\(|" +
        "java\\.io\\b|java\\.nio\\b|javax\\.script\\b|" +
        "readFile\\s*\\(|readTxtFile\\s*\\(|getFile\\s*\\(|deleteFile\\s*\\(|" +
        "unzipFile\\s*\\(|getTxtInFolder\\s*\\(|downloadFile\\s*\\()"
)

private val embeddedJavaScript = Regex("(?s)<js>(.*?)</js>")

private fun normalizeEmbeddedRuleScripts(value: com.google.gson.JsonElement) {
    when {
        value.isJsonObject -> value.asJsonObject.entrySet().toList().forEach { (childKey, child) ->
            if (childKey == "jsLib") return@forEach
            if (child.isJsonPrimitive && child.asJsonPrimitive.isString) {
                val raw = child.asString
                if (raw.contains("<js>")) {
                    value.asJsonObject.addProperty(childKey, embeddedJavaScript.replace(raw) { match ->
                        "<js>${legadoCompatibleJavaScript(match.groupValues[1])}</js>"
                    })
                }
            } else normalizeEmbeddedRuleScripts(child)
        }
        value.isJsonArray -> value.asJsonArray.forEach(::normalizeEmbeddedRuleScripts)
    }
}

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
            normalizeEmbeddedRuleScripts(root)
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

private data class CheckRequest(
    val source: JsonObject,
    val book: JsonObject,
    val namespace: String = "default"
)

private fun isolatedNamespace(account: String, source: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(source.toByteArray(StandardCharsets.UTF_8))
        .take(12).joinToString("") { "%02x".format(it) }
    return "$account::source:$digest"
}

private data class ActionRequest(
    val source: JsonObject,
    val action: String,
    val values: Map<String, Any?> = emptyMap(),
    val namespace: String = "default"
)

internal fun nativeActionValuesScript(values: Map<String, Any?>): String {
    val valuesJson = gson.toJson(values)
    return "var result = JSON.parse(${gson.toJson(valuesJson)});"
}

private data class StateRequest(
    val source: JsonObject,
    val namespace: String = "default"
)

private fun handleState(exchange: HttpExchange) {
    if (exchange.requestMethod != "DELETE") return exchange.problem(405, "method not allowed")
    val request = gson.fromJson(exchange.readBody(), StateRequest::class.java)
    val source = validateSource(gson.toJson(request.source))
    val namespace = isolatedNamespace(request.namespace, source.bookSourceUrl)
    source.setUserNameSpace(namespace)
    io.legado.app.help.http.CookieStore(namespace).clear()
    source.removeLoginInfo()
    source.removeLoginHeader()
    source.setVariable(null)
    exchange.json(200, mapOf("ok" to true))
}

private fun handleActions(exchange: HttpExchange) {
    val parts = exchange.requestURI.path.removePrefix("/internal/actions").trim('/').split('/').filter { it.isNotEmpty() }
    if (parts.isEmpty()) {
        if (exchange.requestMethod != "POST") return exchange.problem(405, "method not allowed")
        val request = gson.fromJson(exchange.readBody(), ActionRequest::class.java)
        if (request.action.isBlank() || request.action.length > 32_000) return exchange.problem(422, "invalid source action")
        val source = validateSource(gson.toJson(request.source)).apply {
            setUserNameSpace(isolatedNamespace(request.namespace, bookSourceUrl))
        }
        val id = UUID.randomUUID().toString()
        val job = EngineActionJob(id)
        actionJobs[id] = job
        executor.submit {
            try {
                job.status = "running"
                source.putLoginInfo(gson.toJson(request.values))
                val loginScript = source.getLoginJs().orEmpty()
                setSourceMessageSink { message -> job.message = message }
                try {
                    source.evalJS("${nativeActionValuesScript(request.values)}\n$loginScript\n${request.action}")
                } finally {
                    source.removeLoginInfo()
                    setSourceMessageSink(null)
                }
                job.message = "操作已完成"
                job.status = "ready"
            } catch (error: Throwable) {
                job.error = error.message ?: error.javaClass.simpleName
                job.status = "failed"
            }
        }
        return exchange.json(202, job.response())
    }
    if (exchange.requestMethod != "GET") return exchange.problem(405, "method not allowed")
    val job = actionJobs[parts[0]] ?: return exchange.problem(404, "action not found")
    exchange.json(200, job.response())
}

private fun handleSearch(exchange: HttpExchange) {
    if (exchange.requestMethod != "POST") return exchange.problem(405, "method not allowed")
    val request = gson.fromJson(exchange.readBody(), SearchRequest::class.java)
    if (request.keyword.trim().isEmpty()) return exchange.problem(422, "keyword is required")
    val source = validateSource(gson.toJson(request.source))
    val namespace = isolatedNamespace(request.namespace, source.bookSourceUrl)
    val result = runBlocking {
        withTimeout(120_000) {
            WebBook(source, debugLog = false, userNameSpace = namespace)
                .searchBook(request.keyword.trim(), request.page.coerceAtLeast(1))
        }
    }
    exchange.json(200, mapOf("items" to result))
}

private fun handleCheck(exchange: HttpExchange) {
    if (exchange.requestMethod != "POST") return exchange.problem(405, "method not allowed")
    val request = gson.fromJson(exchange.readBody(), CheckRequest::class.java)
    val source = validateSource(gson.toJson(request.source))
    val namespace = isolatedNamespace(request.namespace, source.bookSourceUrl)
    val search = gson.fromJson(request.book, SearchBook::class.java)
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
    val chapters = runBlocking { withTimeout(120_000) { webBook.getChapterList(book) } }
    if (chapters.isEmpty()) throw IllegalStateException("chapter list is empty")
    if (chapters.size > maxChapters) throw IllegalStateException("too many chapters")
    val latest = chapters.last()
    exchange.json(200, mapOf(
        "chapter_count" to chapters.size,
        "latest_chapter" to latest.title,
        "latest_chapter_url" to latest.url
    ))
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

private fun buildBook(job: EngineJob, source: BookSource, search: SearchBook, accountNamespace: String) {
    setSourceMessageSink { message -> job.message = message }
    try {
        val namespace = isolatedNamespace(accountNamespace, source.bookSourceUrl)
        job.status = "running"
        job.stage = "book_info"
        search.setUserNameSpace(namespace)
        val webBook = WebBook(source, debugLog = false, userNameSpace = namespace)
        val book = runBlocking {
            withTimeout(30 * 60_000L) {
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
        if (book.type == 1 || book.type == 3 || book.type == 4 || book.type == 32) {
            throw IllegalStateException("audio and video sources are not supported for offline import")
        }
        job.total = chapters.size
        job.chapterCount = chapters.size
        job.latestChapter = chapters.last().title
        job.latestChapterUrl = chapters.last().url
        val contents = ArrayList<Pair<String, String>>(chapters.size)
        chapters.forEachIndexed { index, chapter ->
            if (Thread.currentThread().isInterrupted) throw InterruptedException("cancelled")
            var failure: Throwable? = null
            var content = ""
            repeat(3) { attempt ->
                if (content.isNotEmpty()) return@repeat
                try {
                    content = runBlocking {
                        withTimeout(30 * 60_000L) {
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
        job.stage = "images"
        val localized = localizeImages(contents, chapters.map { it.url }, source, namespace, job)
        job.stage = "packaging"
        val safeName = book.name.ifBlank { "book" }.replace(Regex("[\\\\/:*?\"<>|]"), "-")
        val output = File(jobsDir, "${job.id}--${safeName.take(80)}.epub")
        val cover = downloadCover(book.customCoverUrl ?: book.coverUrl)
        writeEpub(book, localized.first, output, cover, localized.second)
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
    } finally {
        setSourceMessageSink(null)
    }
}

private fun localizeImages(
    chapters: List<Pair<String, String>>,
    chapterUrls: List<String>,
    source: BookSource,
    namespace: String,
    job: EngineJob
): Pair<List<Pair<String, String>>, List<ImageAsset>> {
    data class Pending(val chapter: Int, val element: org.jsoup.nodes.Element, val url: String)
    val documents = chapters.map { Jsoup.parseBodyFragment(it.second) }
    val pending = ArrayList<Pending>()
    documents.forEachIndexed { chapterIndex, document ->
        document.select("script,iframe,object,embed").remove()
        document.select("img").forEach { image ->
            val candidate = listOf("src", "data-src", "data-original", "data-lazy-src", "data-url")
                .asSequence().map { image.attr(it).trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
            val raw = if (candidate.startsWith("http", true)) candidate.substringBefore(",{") else candidate
            if (raw.isBlank()) {
                image.remove()
                return@forEach
            }
            val resolved = when {
                raw.startsWith("data:image/", true) -> raw
                raw.startsWith("http://", true) || raw.startsWith("https://", true) -> raw
                else -> runCatching { URI(chapterUrls.getOrNull(chapterIndex).orEmpty()).resolve(raw).toString() }.getOrDefault("")
            }
            if (resolved.isBlank() || (!resolved.startsWith("data:image/", true) && !resolved.startsWith("http", true))) {
                image.remove()
            } else pending.add(Pending(chapterIndex, image, resolved))
        }
    }
    if (pending.size > maxBookImages) throw IllegalStateException("book contains more than 20,000 images")
    val urls = pending.map { it.url }.distinct()
    job.current = 0
    job.total = urls.size
    val configuredConcurrency = source.concurrentRate?.substringBefore('/')?.toIntOrNull()
    val concurrency = if (source.concurrentRate.isNullOrBlank()) 4 else (configuredConcurrency ?: 1).coerceIn(1, 4)
    val semaphore = Semaphore(concurrency)
    val imageFutures = urls.mapIndexed { index, imageUrl ->
        imageUrl to imageExecutor.submit<ImageAsset> {
            semaphore.acquire()
            try {
                val chapter = pending.firstOrNull { it.url == imageUrl }?.chapter
                downloadImage(imageUrl, chapter?.let { chapterUrls.getOrNull(it) }, source, namespace, index)
            } finally {
                semaphore.release()
            }
        }
    }.toMap()
    val cached = HashMap<String, ImageAsset>()
    var imageBytes = 0L
    try {
        urls.forEachIndexed { index, imageUrl ->
            val asset = imageFutures.getValue(imageUrl).get()
            imageBytes += asset.bytes.size
            if (imageBytes > maxEpubBytes) throw IllegalStateException("embedded images exceed 512 MiB")
            cached[imageUrl] = asset
            job.current = index + 1
        }
    } catch (error: Throwable) {
        imageFutures.values.forEach { it.cancel(true) }
        throw (error.cause ?: error)
    }
    val assets = urls.map { cached.getValue(it) }
    pending.forEach { item ->
        if (Thread.currentThread().isInterrupted) throw InterruptedException("cancelled")
        item.element.attr("src", cached.getValue(item.url).path)
        listOf("data-src", "data-original", "data-lazy-src", "data-url", "srcset", "onload", "onclick").forEach { attr -> item.element.removeAttr(attr) }
    }
    val content = chapters.mapIndexed { index, pair -> pair.first to documents[index].body().html() }
    return content to assets
}

internal fun decodeEmbeddedImageData(rawUrl: String, base64: Boolean): ByteArray {
    val payload = rawUrl.substringAfter(',').substringBefore(',')
    return if (base64) java.util.Base64.getDecoder().decode(payload)
    else java.net.URLDecoder.decode(payload, "UTF-8").toByteArray(StandardCharsets.UTF_8)
}

private fun downloadImage(rawUrl: String, referer: String?, source: BookSource, namespace: String, index: Int): ImageAsset {
    if (rawUrl.startsWith("data:image/", true)) {
        val header = rawUrl.substringBefore(',')
        if (rawUrl.length - header.length > maxImageBytes * 2) throw IllegalStateException("image exceeds 20 MiB")
        val mediaType = header.substringAfter("data:").substringBefore(';').lowercase()
        var bytes = decodeEmbeddedImageData(rawUrl, header.contains(";base64", true))
        if (mediaType == "image/svg+xml") bytes = sanitizeSvg(bytes)
        if (bytes.size > maxImageBytes) throw IllegalStateException("image exceeds 20 MiB")
        val ext = imageExtension(mediaType) ?: throw IllegalStateException("unsupported embedded image type")
        return ImageAsset("images/page-$index.$ext", bytes, mediaType)
    }
    val headers = synchronized(source) {
        runCatching { source.getHeaderMap(true) }.getOrElse { hashMapOf() }
    }
    val request = Request.Builder().url(rawUrl).get().apply {
        headers.forEach { (name, value) -> if (!name.equals("Host", true)) header(name, value) }
        if (!referer.isNullOrBlank()) header("Referer", referer)
        val cookie = io.legado.app.help.http.CookieStore(namespace).getCookie(rawUrl)
        if (cookie.isNotBlank()) header("Cookie", cookie)
    }.build()
    val response = okHttpClient.newCall(request).execute()
    response.use {
        if (!it.isSuccessful) throw IllegalStateException("image download failed: HTTP ${it.code}")
        val body = it.body ?: throw IllegalStateException("empty image response")
        if (body.contentLength() > maxImageBytes) throw IllegalStateException("image exceeds 20 MiB")
        val sink = ByteArrayOutputStream()
        body.byteStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (sink.size() + count > maxImageBytes) throw IllegalStateException("image exceeds 20 MiB")
                sink.write(buffer, 0, count)
            }
        }
        val bytes = sink.toByteArray()
        val declaredType = body.contentType()?.toString()?.substringBefore(';')?.lowercase().orEmpty()
        val mediaType = detectImageType(declaredType, bytes)
            ?: throw IllegalStateException("unsupported image type: $declaredType")
        val ext = imageExtension(mediaType) ?: throw IllegalStateException("unsupported image type: $mediaType")
        return ImageAsset("images/page-$index.$ext", bytes, mediaType)
    }
}

private fun imageExtension(mediaType: String): String? = when (mediaType.lowercase()) {
    "image/jpeg", "image/jpg" -> "jpg"
    "image/png" -> "png"
    "image/gif" -> "gif"
    "image/webp" -> "webp"
    "image/svg+xml" -> "svg"
    else -> null
}

internal fun sanitizeSvg(bytes: ByteArray): ByteArray {
    val text = String(bytes, StandardCharsets.UTF_8)
        .replace(Regex("(?is)<script\\b[^>]*>.*?</script>"), "")
        .replace(Regex("(?i)\\s+on[a-z]+\\s*=\\s*(?:\"[^\"]*\"|'[^']*')"), "")
        .replace(Regex("(?i)\\s+(?:href|xlink:href)\\s*=\\s*(?:\"https?://[^\"]*\"|'https?://[^']*')"), "")
    return text.toByteArray(StandardCharsets.UTF_8)
}

private fun detectImageType(declaredType: String, bytes: ByteArray): String? {
    if (imageExtension(declaredType) != null) return declaredType
    if (bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte()) return "image/jpeg"
    if (bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))) return "image/png"
    if (bytes.size >= 6 && String(bytes, 0, 6, StandardCharsets.US_ASCII).startsWith("GIF8")) return "image/gif"
    if (bytes.size >= 12 && String(bytes, 0, 4, StandardCharsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, StandardCharsets.US_ASCII) == "WEBP") return "image/webp"
    return null
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

internal fun writeEpub(book: Book, chapters: List<Pair<String, String>>, output: File, cover: CoverAsset?, images: List<ImageAsset> = emptyList()) {
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

            // Koodo builds its document list from spine items. Thousands of
            // one-chapter documents make that initialization quadratic, so
            // retain chapter-level anchors while bounding the spine size.
            val documents = chapters.chunked(epubChaptersPerDocument)
            val chapterItems = documents.indices.joinToString("\n") {
                "<item id=\"p$it\" href=\"part-$it.xhtml\" media-type=\"application/xhtml+xml\"/>"
            }
            val spine = documents.indices.joinToString("\n") { "<itemref idref=\"p$it\"/>" }
            val identifier = UUID.nameUUIDFromBytes(book.bookUrl.toByteArray()).toString()
            val coverManifest = cover?.let {
                "<item id=\"cover-image\" href=\"cover.${it.extension}\" media-type=\"${it.mediaType}\" properties=\"cover-image\"/>"
            } ?: ""
            val imageManifest = images.mapIndexed { index, image ->
                "<item id=\"image-$index\" href=\"${xml(image.path)}\" media-type=\"${xml(image.mediaType)}\"/>"
            }.joinToString("\n")
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
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>$coverManifest$imageManifest$chapterItems</manifest>
  <spine>$spine</spine>
</package>""")
            cover?.let { asset ->
                zip.putNextEntry(ZipEntry("OEBPS/cover.${asset.extension}"))
                zip.write(asset.bytes)
                zip.closeEntry()
            }
            images.forEach { asset ->
                zip.putNextEntry(ZipEntry("OEBPS/${asset.path}"))
                zip.write(asset.bytes)
                zip.closeEntry()
            }
            val navItems = chapters.mapIndexed { index, pair ->
                val documentIndex = index / epubChaptersPerDocument
                "<li><a href=\"part-$documentIndex.xhtml#chapter-$index\">${xml(pair.first)}</a></li>"
            }.joinToString("\n")
            zip.text("OEBPS/nav.xhtml", xhtml(book.name, "<nav epub:type=\"toc\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><ol>$navItems</ol></nav>"))
            documents.forEachIndexed { documentIndex, documentChapters ->
                val firstChapterIndex = documentIndex * epubChaptersPerDocument
                val body = documentChapters.mapIndexed { offset, pair ->
                    val chapterIndex = firstChapterIndex + offset
                    val content = normalizeChapterContent(pair.second)
                    "<section id=\"chapter-$chapterIndex\"><h1>${xml(pair.first)}</h1>$content</section>"
                }.joinToString("\n")
                val title = documentChapters.firstOrNull()?.first ?: book.name
                zip.text("OEBPS/part-$documentIndex.xhtml", xhtml(title, body))
            }
        }
    }
}

private fun ZipOutputStream.text(path: String, value: String) {
    putNextEntry(ZipEntry(path))
    write(value.toByteArray(StandardCharsets.UTF_8))
    closeEntry()
}

internal fun normalizeChapterContent(raw: String): String {
    val clean = Jsoup.clean(
        raw,
        "",
        Safelist.relaxed()
            .removeTags("script", "style", "iframe", "object", "embed")
            .removeProtocols("img", "src", "http", "https")
            .preserveRelativeLinks(true),
        org.jsoup.nodes.Document.OutputSettings().prettyPrint(false)
    )
    if (clean.isBlank()) return "<p></p>"

    val document = Jsoup.parseBodyFragment(clean)
    val body = document.body()
    body.select("img[src]").forEach { image ->
        val source = image.attr("src").trim()
        if (!source.startsWith("images/") && !source.startsWith("data:image/")) {
            image.removeAttr("src")
        }
    }
    val onlyLineBreaks = body.children().all { it.tagName().equals("br", true) }
    if (onlyLineBreaks) {
        val text = org.jsoup.parser.Parser.unescapeEntities(
            clean.replace(Regex("(?i)<br\\s*/?>"), "\n"),
            false
        )
        val paragraphs = text
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .lineSequence()
            .map { it.replace(Regex("^[\\s\\u00A0\\u3000]+|[\\s\\u00A0\\u3000]+$"), "") }
            .filter { it.isNotEmpty() }
            .map { "<p>${xml(it)}</p>" }
            .toList()
        return if (paragraphs.isEmpty()) "<p></p>" else paragraphs.joinToString("\n")
    }
    return body.html().ifBlank { "<p></p>" }
}

private fun xhtml(title: String, body: String) = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xml(title)}</title><meta charset="utf-8"/><style type="text/css">
html,body{margin:0;padding:0;max-width:100%;}
body,h1,p,li,blockquote,td,th{overflow-wrap:anywhere;word-wrap:break-word;}
section{max-width:100%;}
section+section{break-before:page;page-break-before:always;}
p{margin:0 0 .8em;text-indent:2em;white-space:normal;}
p:has(>img){text-indent:0;text-align:center;}
img,svg,video,canvas{max-width:100%;height:auto;}
table{max-width:100%;table-layout:fixed;}
pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;}
</style></head><body>$body</body></html>"""

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
    server.createContext("/health") { exchange -> exchange.json(200, mapOf("status" to "ok", "version" to "0.6.0")) }
    server.createContext("/internal/search") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleSearch(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "search failed")
        }
    }
    server.createContext("/internal/check") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleCheck(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "check failed")
        }
    }
    server.createContext("/internal/imports") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleImports(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "request failed")
        }
    }
    server.createContext("/internal/actions") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleActions(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "action failed")
        }
    }
    server.createContext("/internal/state") { exchange ->
        try {
            if (!exchange.authorized()) exchange.problem(401, "unauthorized") else handleState(exchange)
        } catch (error: Throwable) {
            exchange.problem(422, error.message ?: "state cleanup failed")
        }
    }
    server.start()
    println("Koodo Legado engine 0.6.0 listening on :$port")
}
