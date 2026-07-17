package gs.ouo.rd.koodo.legado

import io.legado.app.data.entities.Book
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.zip.ZipFile

class EpubPackagingTest {
    @Test
    fun embedsComicImagesAndRemovesRemoteScripts() {
        val directory = Files.createTempDirectory("koodo-comic-test").toFile()
        val output = directory.resolve("comic.epub")
        val image = ImageAsset("images/page-0.png", byteArrayOf(1, 2, 3, 4), "image/png")
        val book = Book(bookUrl = "https://books.example/comic", originName = "Comic source", name = "Comic", author = "Artist")
        try {
            writeEpub(book, listOf("Episode 1" to "<script>alert(1)</script><p><img src=\"images/page-0.png\"/></p>"), output, null, listOf(image))
            ZipFile(output).use { zip ->
                assertTrue(zip.getEntry("OEBPS/images/page-0.png") != null)
                assertTrue(zip.text("OEBPS/content.opf").contains("media-type=\"image/png\""))
                val page = zip.text("OEBPS/part-0.xhtml")
                assertTrue(page.contains("images/page-0.png"))
                assertFalse(page.contains("alert(1)"))
                assertFalse(page.contains("https://books.example"))
            }
        } finally {
            output.delete()
            directory.delete()
        }
    }

    @Test
    fun groupsLargeChapterSetsButKeepsEveryNavigationTarget() {
        val directory = Files.createTempDirectory("koodo-epub-test").toFile()
        val output = directory.resolve("grouped.epub")
        val chapters = (0 until 45).map { index ->
            "Chapter $index" to if (index == 0) {
                "　　&nbsp;&nbsp;First paragraph\n　　&nbsp;&nbsp;Second paragraph"
            } else {
                "<p>Body $index</p>"
            }
        }
        val book = Book(
            bookUrl = "https://books.example/large",
            originName = "Test source",
            name = "Large book",
            author = "Test author"
        )

        try {
            writeEpub(book, chapters, output, null)
            ZipFile(output).use { zip ->
                val names = zip.entries().asSequence().map { it.name }.toSet()
                assertTrue(names.contains("OEBPS/part-0.xhtml"))
                assertTrue(names.contains("OEBPS/part-1.xhtml"))
                assertTrue(names.contains("OEBPS/part-2.xhtml"))
                assertFalse(names.contains("OEBPS/part-3.xhtml"))
                assertFalse(names.any { it.startsWith("OEBPS/chapter-") })

                val opf = zip.text("OEBPS/content.opf")
                assertEquals(3, Regex("<itemref ").findAll(opf).count())
                val nav = zip.text("OEBPS/nav.xhtml")
                assertTrue(nav.contains("part-0.xhtml#chapter-0"))
                assertTrue(nav.contains("part-1.xhtml#chapter-20"))
                assertTrue(nav.contains("part-2.xhtml#chapter-44"))

                val first = zip.text("OEBPS/part-0.xhtml")
                assertTrue(first.contains("id=\"chapter-0\""))
                assertTrue(first.contains("id=\"chapter-19\""))
                assertFalse(first.contains("id=\"chapter-20\""))
                assertTrue(first.contains("<p>First paragraph</p>"))
                assertTrue(first.contains("<p>Second paragraph</p>"))
                assertFalse(first.contains("&nbsp;First paragraph"))
                assertTrue(first.contains("overflow-wrap:anywhere"))
                assertTrue(first.contains("text-indent:2em"))
                assertTrue(zip.text("OEBPS/part-2.xhtml").contains("Body 44"))
            }
        } finally {
            output.delete()
            directory.delete()
        }
    }

    private fun ZipFile.text(path: String): String =
        getInputStream(getEntry(path)).bufferedReader().use { it.readText() }
}
