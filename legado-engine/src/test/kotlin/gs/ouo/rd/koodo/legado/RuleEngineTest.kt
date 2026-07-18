package gs.ouo.rd.koodo.legado

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.sun.net.httpserver.HttpServer
import io.legado.app.data.entities.BookSource
import io.legado.app.data.entities.rule.SearchRule
import io.legado.app.model.analyzeRule.AnalyzeRule
import io.legado.app.model.analyzeRule.AnalyzeUrl
import io.legado.app.model.analyzeRule.RuleData
import io.legado.app.model.webBook.WebBook
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.util.Base64

class RuleEngineTest {
    @Test
    fun exposesLoginFormValuesAsNativeJavaScriptObject() {
        installSandbox()
        val source = BookSource(
            bookSourceUrl = "https://books.example",
            bookSourceName = "Login source"
        )
        val values = Gson().fromJson<Map<String, Any?>>(
            """{"email":"reader@example.com","remember":true}""",
            object : TypeToken<Map<String, Any?>>() {}.type
        )

        assertEquals(
            "reader@example.com:true:object",
            source.evalJS(
                nativeActionValuesScript(values) +
                    "\nresult.email + ':' + result.remember + ':' + typeof result"
            ).toString()
        )
    }

    @Test
    fun redactsSourceRequestsAndPacesChapterImports() {
        val request = """https://books.example/login,{"headers":{"cookie":"token=secret"},"body":"{\"password\":\"secret\"}"}"""
        assertEquals("书源请求处理中", sanitizeSourceMessage(request, listOf("secret")))
        assertEquals("account=[redacted]", sanitizeSourceMessage("account=reader@example.com", listOf("reader@example.com")))
        assertEquals(550L, chapterPacingIntervalMillis(null, 50L))
        assertEquals(5_250L, chapterPacingIntervalMillis("5000", 250L))
        assertEquals(550L, chapterPacingIntervalMillis("2/1000", 50L))
        assertTrue(isSourceRateLimitMessage("今日访问次数已达上限，请稍后再试"))
        assertFalse(isSourceRateLimitMessage("正在获取章节"))
    }

    @Test
    fun acceptsWebViewSourcesWithGuardedEnvironmentProbes() {
        val source = validateSource(
            """{"bookSourceUrl":"https://books.example","bookSourceName":"WebView source","searchUrl":"<js>try { Packages.example.Client } catch(e) {}; 'https://books.example,{\"webView\":true}'</js>"}"""
        )
        assertEquals("WebView source", source.bookSourceName)
    }

    @Test
    fun parsesModernSearchOnlySourceJson() {
        val source = validateSource(
            """
            {
              "bookSourceUrl": "https://books.example",
              "bookSourceName": "Search-only source",
              "searchUrl": "https://books.example/search?q={{key}}",
              "ruleSearch": {
                "bookList": ".book",
                "name": "h2@text",
                "bookUrl": "a@href"
              }
            }
            """.trimIndent()
        )

        assertEquals("https://books.example/search?q={{key}}", source.searchUrl)
        assertEquals(".book", source.ruleSearch?.bookList)
        assertEquals("h2@text", source.ruleSearch?.name)
    }

    @Test
    fun retainsAndLoadsSourceJavaScriptLibrary() {
        installSandbox()
        val source = validateSource(
            """
            {
              "bookSourceUrl": "https://books.example",
              "bookSourceName": "Library source",
              "jsLib": "function sourceBase() { var saved = JSON.parse(source.getVariable()); return saved.url || 'https://library.example'; }",
              "searchUrl": "<js>sourceBase() + '/search?q=' + key</js>",
              "ruleSearch": {"bookList": "$.items"}
            }
            """.trimIndent()
        )

        assertEquals("https://library.example", source.evalJS("sourceBase()"))
        assertEquals("value-1", source.evalJS("java.log(`value-${'$'}{1}`)"))
        assertEquals(true, source.evalJS("function check(value) { return value.includes('ue-'); } check(`value-${'$'}{1}`)"))
        assertEquals(
            "book-7:author-9:summary",
            source.evalJS(
                """
                const name = 'book-7';
                const author = 'author-9';
                const abstract = 'summary';
                const payload = { name, author, abstract, };
                const { name: parsedName, author: parsedAuthor } = payload;
                `${'$'}{parsedName}:${'$'}{parsedAuthor}:${'$'}{payload["abstract"]}`
                """.trimIndent()
            ).toString()
        )
        assertEquals("", source.evalJS("cookie.getCookie('https://books.example')"))
        assertEquals(true, source.evalJS("typeof cache.get == 'function' && typeof cache.put == 'function'"))
    }

    @Test
    fun convertsCommonModernSourceSyntaxForPinnedRhino() {
        val converted = legadoCompatibleJavaScript(
            """
            const result = { source: 'source-1', book_id: 'book-2' };
            const { source:sources, book_id } = result;
            let catalog = {
                sources,
                book_id,
            };
            const options = JSON.stringify({ headers, default: 8 });
            const action = (data, book) => { return data && book; };
            try { action(result, catalog); } catch {}
            const searchUrl = '/search?key={{key}}&page={{page}}';
            """.trimIndent()
        )
        assertFalse(converted.contains("{ source:sources, book_id }"))
        assertFalse(converted.contains("const "))
        assertFalse(converted.contains("let "))
        assertTrue(converted.contains("var sources = __legado_destructure_0[\"source\"]"))
        assertTrue(converted.contains("var book_id = __legado_destructure_0[\"book_id\"]"))
        assertTrue(converted.contains("catalog[\"sources\"] = sources"))
        assertTrue(converted.contains("catalog[\"book_id\"] = book_id"))
        assertTrue(converted.contains("{ \"headers\": headers, \"default\": 8 }"))
        assertTrue(converted.contains("function(data, book) {"))
        assertTrue(converted.contains("catch (__legado_error) {"))
        assertTrue(converted.contains("{{key}}&page={{page}}"))
    }

    @Test
    fun decodesEmbeddedImagesWithoutLegadoOptions() {
        val payload = "<svg>chapter review</svg>"
        val encoded = Base64.getEncoder().encodeToString(payload.toByteArray())
        val url = "data:image/svg+xml;base64,$encoded,{'type':'qtbzs'}"
        assertEquals(payload, String(decodeEmbeddedImageData(url, true)))
    }

    @Test
    fun sanitizesEmbeddedSvgScriptsAndHandlers() {
        val svg = "<svg onclick=\"alert(1)\"><script>alert(2)</script><path/></svg>"
        val clean = String(sanitizeSvg(svg.toByteArray()))
        assertFalse(clean.contains("script", ignoreCase = true))
        assertFalse(clean.contains("onclick", ignoreCase = true))
    }

    @Test
    fun decodesMultilineDataUrlsReturnedBySourceJavaScript() {
        val payload = "{\"ok\":true}"
        val encoded = Base64.getMimeEncoder(8, "\n".toByteArray()).encodeToString(payload.toByteArray())
        val source = BookSource(
            bookSourceUrl = "https://books.example",
            bookSourceName = "Data URL source",
            searchUrl = "<js>const dataUrl = `data:;base64,$encoded,{\"type\":\"json\"}`; dataUrl;</js>"
        )
        val analyzeUrl = AnalyzeUrl(
            mUrl = source.searchUrl!!,
            key = "book",
            page = 1,
            baseUrl = source.bookSourceUrl,
            source = source
        )

        val response = runBlocking { analyzeUrl.getStrResponseAwait() }
        assertEquals("json", analyzeUrl.type)
        assertTrue(response.body()?.isNotBlank() == true)

        val direct = AnalyzeUrl(
            mUrl = "data:;base64,$encoded,{\"type\":\"json\"}",
            baseUrl = source.bookSourceUrl,
            source = source
        )
        val directResponse = runBlocking { direct.getStrResponseAwait() }
        assertEquals("json", direct.type)
        assertTrue(directResponse.body()?.isNotBlank() == true)
        assertEquals(payload, String(runBlocking { direct.getByteArrayAwait() }))
    }

    @Test
    fun keepsStringMethodsWhenTemplateValuesEnterSearchRules() {
        installSandbox()
        val source = BookSource(
            bookSourceUrl = "https://books.example",
            bookSourceName = "Template search source",
            jsLib = "function request(url) { return url.includes('/search?'); }"
        )
        val rule = AnalyzeRule(RuleData(), source)

        assertEquals(
            true,
            rule.evalJS("var url = `/search?title=${'$'}{result}`; request(url);", "Koodo")
        )
    }

    @Test
    fun searchesCssRulesWithKeywordPageAndHeaders() {
        installSandbox()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/search") { exchange ->
            assertTrue(exchange.requestURI.rawQuery.contains("key=Koodo"))
            assertTrue(exchange.requestURI.rawQuery.contains("page=2"))
            assertEquals("engine-test", exchange.requestHeaders.getFirst("X-Source-Test"))
            val body = """
                <html><body><div class="book">
                  <h2>Koodo Test Book</h2><span class="author">Test Author</span>
                  <a href="/book/1">details</a><p class="latest">Chapter 9</p>
                </div></body></html>
            """.trimIndent().toByteArray()
            exchange.responseHeaders.set("Content-Type", "text/html; charset=utf-8")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val base = "http://127.0.0.1:${server.address.port}"
            val source = BookSource(
                bookSourceUrl = base,
                bookSourceName = "Fixed test source",
                jsLib = "const searchBase = '$base';",
                header = "{\"X-Source-Test\":\"engine-test\"}",
                searchUrl = "<js>searchBase + '/search?key={{key}}&page={{page}}'</js>",
                ruleSearch = SearchRule(
                    bookList = ".book",
                    name = "h2@text",
                    author = ".author@text",
                    bookUrl = "a@href",
                    lastChapter = ".latest@text"
                )
            )
            val books = runBlocking { WebBook(source, debugLog = false).searchBook("Koodo", 2) }
            assertEquals(1, books.size)
            assertEquals("Koodo Test Book", books[0].name)
            assertEquals("Test Author", books[0].author)
            assertEquals("Chapter 9", books[0].latestChapterTitle)
            assertEquals("$base/book/1", books[0].bookUrl)
        } finally {
            server.stop(0)
        }
    }
}
