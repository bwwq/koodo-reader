package gs.ouo.rd.koodo.legado

import io.legado.app.adapters.ReaderAdapterHelper
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mozilla.javascript.Context

class SandboxTest {
    @Test
    fun blocksJvmAndPathTraversalButKeepsLegadoObjectsVisible() {
        installSandbox()
        val context = Context.enter()
        try {
            val scope = context.initStandardObjects()
            assertTrue(runCatching {
                context.evaluateString(scope, "Packages.java.lang.Runtime.getRuntime()", "blocked", 1, null)
            }.isFailure)
            assertTrue(runCatching {
                context.evaluateString(scope, "Packages.java.io.File", "blocked", 1, null)
            }.isFailure)
            assertTrue(runCatching {
                context.evaluateString(scope, "Packages.io.legado.app.data.entities.Book", "allowed", 1, null)
            }.isSuccess)
        } finally {
            Context.exit()
        }
        assertThrows(SecurityException::class.java) {
            ReaderAdapterHelper.getAdapter().getWorkDir("..", "..", "etc")
        }
    }
}
