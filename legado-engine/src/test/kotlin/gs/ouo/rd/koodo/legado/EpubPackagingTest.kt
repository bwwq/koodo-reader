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
    fun groupsLargeChapterSetsButKeepsEveryNavigationTarget() {
        val directory = Files.createTempDirectory("koodo-epub-test").toFile()
        val output = directory.resolve("grouped.epub")
        val chapters = (0 until 45).map { index ->
            "Chapter $index" to "<p>Body $index</p>"
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
