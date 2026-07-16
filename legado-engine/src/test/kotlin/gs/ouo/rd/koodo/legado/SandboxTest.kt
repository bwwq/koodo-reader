package gs.ouo.rd.koodo.legado

import io.legado.app.adapters.ReaderAdapterHelper
import org.junit.Assert.assertFalse
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
            val shutter = context.classShutter
            assertFalse(shutter.visibleToScripts("java.lang.Runtime"))
            assertFalse(shutter.visibleToScripts("java.io.File"))
            assertTrue(shutter.visibleToScripts("io.legado.app.data.entities.Book"))
        } finally {
            Context.exit()
        }
        assertThrows(SecurityException::class.java) {
            ReaderAdapterHelper.getAdapter().getWorkDir("..", "..", "etc")
        }
    }
}
