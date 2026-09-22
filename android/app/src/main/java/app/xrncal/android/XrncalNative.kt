package app.xrncal.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import io.requery.android.database.sqlite.SQLiteDatabase
import io.requery.android.database.sqlite.SQLiteProgram
import io.requery.android.database.sqlite.SQLiteStatement
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The synchronous host surface behind `window.XrncalNative`.
 *
 * Every method here is reachable from JS and returns a JSON envelope
 * (`{"ok":true,"value":…}` / `{"ok":false,"error":…}`). The envelope is not
 * decoration: an exception thrown out of an `@JavascriptInterface` method is
 * swallowed by the WebView and arrives in JS as a bare `null`, which would
 * turn a UNIQUE-constraint failure into a silent no-op.
 *
 * Methods run on a binder thread, not the UI thread, and block the calling JS
 * thread until they return. That is exactly what makes the port possible -
 * `ISqliteDatabase` and every repo written against it are synchronous - but it
 * also means nothing here may touch the UI directly or take a long lock.
 *
 * See src/android/native/bridge.ts for the TypeScript side of this contract.
 */
class XrncalNative(private val activity: Activity) {

    private val context: Context get() = activity.applicationContext

    @Volatile
    private var db: SQLiteDatabase? = null

    /** Compiled-statement cache for writes, keyed by SQL text. */
    private val statementCache = object : LinkedHashMap<String, SQLiteStatement>(16, 0.75f, true) {
        override fun removeEldestEntry(
            eldest: MutableMap.MutableEntry<String, SQLiteStatement>?
        ): Boolean = size > MAX_CACHED_STATEMENTS
    }

    companion object {
        private const val MAX_CACHED_STATEMENTS = 128
        private const val KEY_ALIAS = "xrncal_token_key"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val GCM_IV_BYTES = 12
        private const val GCM_TAG_BITS = 128
    }

    // ---------------------------------------------------------------- envelope

    private inline fun <T> envelope(block: () -> T): String = try {
        val value = block()
        JSONObject().put("ok", true).apply {
            when (value) {
                is Unit, null -> put("value", JSONObject.NULL)
                is JSONArray -> put("value", value)
                is JSONObject -> put("value", value)
                else -> put("value", value)
            }
        }.toString()
    } catch (t: Throwable) {
        JSONObject()
            .put("ok", false)
            .put("error", "${t.javaClass.simpleName}: ${t.message ?: "no message"}")
            .toString()
    }

    private fun requireDb(): SQLiteDatabase =
        db ?: throw IllegalStateException("Database is not open")

    // ------------------------------------------------------------------ SQLite

    /**
     * Opens (or creates) the database.
     *
     * The bundled SQLite from requery is used rather than Android's own. The
     * schema's migration 002 creates an FTS5 virtual table, and FTS5 is not
     * reliably compiled into the platform SQLite across the API levels this
     * app supports (minSdk 23) - on a device without it, the very first launch
     * would fail during migration.
     */
    @JavascriptInterface
    fun dbOpen(path: String): String = envelope {
        synchronized(this) {
            db?.close()
            statementCache.clear()

            val opened = if (path == ":memory:") {
                SQLiteDatabase.create(null)
            } else {
                File(path).parentFile?.mkdirs()
                SQLiteDatabase.openOrCreateDatabase(File(path), null)
            }

            try {
                // WAL is turned on with the PRAGMA rather than with
                // enableWriteAheadLogging(), and the difference is critical.
                //
                // enableWriteAheadLogging() switches SQLiteDatabase to a
                // multi-connection pool. Reads and writes are then served by
                // *different* connections, so a read issued inside an explicit
                // SAVEPOINT cannot see that transaction's own uncommitted rows.
                // EventsRepo.createEvent inserts and then reads the row back,
                // and ImportIcs wraps the whole thing in a transaction - the
                // read-back returned nothing and the import reported "0
                // imported, N errors" while the rows had in fact landed.
                //
                // Setting the PRAGMA directly gives the same on-disk WAL
                // journal while leaving the framework's WAL flag off, so the
                // pool stays at a single connection and a transaction sees its
                // own writes. Routed through execOne because a journal_mode
                // PRAGMA returns a row and execSQL rejects those.
                if (path != ":memory:") execOne(opened, "PRAGMA journal_mode = WAL")
                // This one returns nothing, so execSQL is fine.
                opened.execSQL("PRAGMA foreign_keys = ON;")
            } catch (t: Throwable) {
                // An opened handle that never reaches `db` can never be closed
                // by dbClose, and SQLite's CloseGuard reports it as a leak.
                opened.close()
                throw t
            }

            db = opened
        }
    }

    /** Runs a whole SQL script, splitting it into statements first. */
    @JavascriptInterface
    fun dbExec(sql: String): String = envelope {
        val database = requireDb()
        for (statement in SqlStatementSplitter.split(sql)) {
            execOne(database, statement)
        }
    }

    /**
     * `node:sqlite`'s exec() runs anything; Android's execSQL throws on a
     * statement that returns rows. The driver's `exec()` is mostly DDL, but
     * PRAGMA and SELECT both reach it (a PRAGMA assignment still yields a
     * row), so those are routed through rawQuery instead. Android cursors are
     * lazy, so the statement only actually runs when the cursor is stepped -
     * hence the moveToFirst().
     */
    private fun execOne(database: SQLiteDatabase, statement: String) {
        val head = statement.trimStart().takeWhile { !it.isWhitespace() }.uppercase()
        if (head == "PRAGMA" || head == "SELECT" || head == "WITH" || head == "EXPLAIN") {
            database.rawQuery(statement, emptyArray()).use { it.moveToFirst() }
        } else {
            database.execSQL(statement)
        }
    }

    @JavascriptInterface
    fun dbQuery(sql: String, paramsJson: String): String = envelope {
        val database = requireDb()
        val args = parseParams(paramsJson)
        database.rawQuery(sql, args).use { cursor -> cursorToJson(cursor) }
    }

    @JavascriptInterface
    fun dbRun(sql: String, paramsJson: String): String = envelope {
        val database = requireDb()
        val args = parseParams(paramsJson)
        val statement = synchronized(statementCache) {
            statementCache.getOrPut(sql) { database.compileStatement(sql) }
        }

        synchronized(statement) {
            statement.clearBindings()
            bindAll(statement, args)

            val isInsert = sql.trimStart().take(6).equals("INSERT", ignoreCase = true)
            val result = JSONObject()
            if (isInsert) {
                val rowId = statement.executeInsert()
                // executeInsert returns -1 when a conflict clause swallowed the
                // row, which is the same thing as "zero rows changed".
                result.put("changes", if (rowId == -1L) 0 else 1)
                result.put("lastInsertRowid", if (rowId == -1L) 0 else rowId)
            } else {
                result.put("changes", statement.executeUpdateDelete())
                result.put("lastInsertRowid", 0)
            }
            result
        }
    }

    @JavascriptInterface
    fun dbClose(): String = envelope {
        synchronized(this) {
            for (statement in statementCache.values) statement.close()
            statementCache.clear()
            db?.close()
            db = null
        }
    }

    private fun parseParams(paramsJson: String): Array<Any?> {
        val array = JSONArray(paramsJson)
        return Array(array.length()) { index ->
            if (array.isNull(index)) null else array.get(index)
        }
    }

    private fun bindAll(statement: SQLiteProgram, args: Array<Any?>) {
        args.forEachIndexed { index, value ->
            // SQLite bind indices are 1-based.
            val position = index + 1
            when (value) {
                null -> statement.bindNull(position)
                is Int -> statement.bindLong(position, value.toLong())
                is Long -> statement.bindLong(position, value)
                is Boolean -> statement.bindLong(position, if (value) 1L else 0L)
                is Double -> {
                    // JSON has one number type, so an integral value arrives as
                    // a Double. Binding 1.0 where the column holds 1 would make
                    // `dirty = ?` never match.
                    if (value == Math.floor(value) && !value.isInfinite()) {
                        statement.bindLong(position, value.toLong())
                    } else {
                        statement.bindDouble(position, value)
                    }
                }
                else -> statement.bindString(position, value.toString())
            }
        }
    }

    private fun cursorToJson(cursor: Cursor): JSONArray {
        val rows = JSONArray()
        val columnCount = cursor.columnCount
        while (cursor.moveToNext()) {
            val row = JSONObject()
            for (column in 0 until columnCount) {
                val name = cursor.getColumnName(column)
                when (cursor.getType(column)) {
                    Cursor.FIELD_TYPE_NULL -> row.put(name, JSONObject.NULL)
                    Cursor.FIELD_TYPE_INTEGER -> row.put(name, cursor.getLong(column))
                    Cursor.FIELD_TYPE_FLOAT -> row.put(name, cursor.getDouble(column))
                    Cursor.FIELD_TYPE_BLOB ->
                        row.put(name, Base64.encodeToString(cursor.getBlob(column), Base64.NO_WRAP))
                    else -> row.put(name, cursor.getString(column))
                }
            }
            rows.put(row)
        }
        return rows
    }

    // -------------------------------------------------------------- filesystem

    @JavascriptInterface
    fun fsExists(path: String): Boolean = File(path).exists()

    @JavascriptInterface
    fun fsMkdirs(path: String): String = envelope {
        val dir = File(path)
        if (!dir.exists() && !dir.mkdirs()) {
            throw IllegalStateException("Could not create directory $path")
        }
    }

    @JavascriptInterface
    fun fsReadBase64(path: String): String = envelope {
        Base64.encodeToString(File(path).readBytes(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun fsWriteBase64(path: String, base64: String): String = envelope {
        val file = File(path)
        file.parentFile?.mkdirs()
        file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
    }

    @JavascriptInterface
    fun fsUnlink(path: String): String = envelope {
        val file = File(path)
        if (file.exists() && !file.delete()) {
            throw IllegalStateException("Could not delete $path")
        }
    }

    @JavascriptInterface
    fun fsSize(path: String): String = envelope { File(path).length() }

    @JavascriptInterface
    fun dirData(): String = envelope { context.filesDir.absolutePath }

    @JavascriptInterface
    fun dirCache(): String = envelope { context.cacheDir.absolutePath }

    // ----------------------------------------------------------------- secrets

    /**
     * Keystore-backed AES-GCM, standing in for Electron's safeStorage.
     *
     * The key never leaves the Keystore, so the ciphertext in the `settings`
     * table is useless if the database file is extracted from a backup or a
     * rooted device. There is no software fallback: like the desktop build on
     * a Linux box with no keyring, this fails closed rather than writing
     * tokens somewhere readable.
     */
    @JavascriptInterface
    fun secureAvailable(): Boolean = try {
        secretKey()
        true
    } catch (t: Throwable) {
        false
    }

    @JavascriptInterface
    fun secureEncrypt(plaintext: String): String = envelope {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        // The IV is generated per message and is not secret; prefixing it keeps
        // the stored value self-contained.
        Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun secureDecrypt(ciphertextBase64: String): String = envelope {
        val raw = Base64.decode(ciphertextBase64, Base64.DEFAULT)
        require(raw.size > GCM_IV_BYTES) { "Ciphertext is too short to contain an IV" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKey(),
            GCMParameterSpec(GCM_TAG_BITS, raw, 0, GCM_IV_BYTES)
        )
        String(
            cipher.doFinal(raw, GCM_IV_BYTES, raw.size - GCM_IV_BYTES),
            Charsets.UTF_8
        )
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Requiring device unlock would break background token refresh
                // during sync, which is exactly when the app is not in front of
                // the user.
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }

    // -------------------------------------------------------------- host + IPC

    @JavascriptInterface
    fun appVersion(): String = envelope {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
    }

    /**
     * Hands a file to the system share sheet. Stands in for
     * `shell.showItemInFolder`, which has no Android equivalent - an
     * app-private file the user cannot browse to is not useful on its own.
     */
    @JavascriptInterface
    fun shareFile(path: String, mimeType: String, title: String): String = envelope {
        val file = File(path)
        require(file.exists()) { "No file at $path" }

        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        // Called from a binder thread; starting an activity has to happen on
        // the UI thread.
        activity.runOnUiThread {
            activity.startActivity(Intent.createChooser(intent, title))
        }
    }
}
