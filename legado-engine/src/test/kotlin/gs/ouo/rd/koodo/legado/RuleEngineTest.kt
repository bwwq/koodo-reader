package gs.ouo.rd.koodo.legado

import com.sun.net.httpserver.HttpServer
import io.legado.app.data.entities.BookSource
import io.legado.app.data.entities.rule.SearchRule
import io.legado.app.model.webBook.WebBook
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress

class RuleEngineTest {
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
                header = "{\"X-Source-Test\":\"engine-test\"}",
                searchUrl = "$base/search?key={{key}}&page={{page}}",
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
