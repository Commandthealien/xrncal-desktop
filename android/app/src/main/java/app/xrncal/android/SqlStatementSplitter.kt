package app.xrncal.android

/**
 * Splits a multi-statement SQL script into individually executable statements.
 *
 * `node:sqlite`'s `exec()` accepts a whole script; Android's `execSQL()` runs
 * exactly one statement and throws on a trailing second. Every migration in
 * `src/main/db/database.ts` is a multi-statement blob, so the script has to be
 * cut up before it reaches the driver.
 *
 * Splitting on `;` alone is wrong here. Migration 002 creates FTS triggers
 * whose bodies contain their own statement terminators:
 *
 *     CREATE TRIGGER trg_events_fts_update AFTER UPDATE ON events BEGIN
 *       DELETE FROM events_fts WHERE event_id = old.id;   <- not a boundary
 *       INSERT INTO events_fts(...) VALUES (...);         <- not a boundary
 *     END;                                                <- boundary
 *
 * so the splitter tracks trigger bodies, and skips terminators that appear
 * inside string literals or comments.
 */
object SqlStatementSplitter {

    fun split(script: String): List<String> {
        val statements = mutableListOf<String>()
        val current = StringBuilder()

        var i = 0
        var inSingleQuote = false
        var inDoubleQuote = false
        var inLineComment = false
        var inBlockComment = false
        // Depth of an open trigger body: a `;` only ends a statement at depth 0.
        var triggerDepth = 0
        // Set once CREATE [...] TRIGGER is seen, cleared by its BEGIN.
        var expectTriggerBody = false
        // CASE ... END shares the END keyword with a trigger body; without
        // tracking it, a CASE inside a trigger would close the body early.
        var caseDepth = 0

        fun keywordAt(index: Int): String? {
            if (!script[index].isLetter()) return null
            // Only match on a word boundary, so `ENDING` is not `END`.
            if (index > 0 && (script[index - 1].isLetterOrDigit() || script[index - 1] == '_')) return null
            var end = index
            while (end < script.length && (script[end].isLetterOrDigit() || script[end] == '_')) end++
            return script.substring(index, end).uppercase()
        }

        while (i < script.length) {
            val c = script[i]

            if (inLineComment) {
                current.append(c)
                if (c == '\n') inLineComment = false
                i++
                continue
            }

            if (inBlockComment) {
                current.append(c)
                if (c == '*' && i + 1 < script.length && script[i + 1] == '/') {
                    current.append('/')
                    i += 2
                    inBlockComment = false
                    continue
                }
                i++
                continue
            }

            if (inSingleQuote) {
                current.append(c)
                if (c == '\'') {
                    // '' inside a literal is an escaped quote, not the end.
                    if (i + 1 < script.length && script[i + 1] == '\'') {
                        current.append('\'')
                        i += 2
                        continue
                    }
                    inSingleQuote = false
                }
                i++
                continue
            }

            if (inDoubleQuote) {
                current.append(c)
                if (c == '"') inDoubleQuote = false
                i++
                continue
            }

            when {
                c == '\'' -> { inSingleQuote = true; current.append(c); i++ }
                c == '"' -> { inDoubleQuote = true; current.append(c); i++ }
                c == '-' && i + 1 < script.length && script[i + 1] == '-' -> {
                    inLineComment = true; current.append("--"); i += 2
                }
                c == '/' && i + 1 < script.length && script[i + 1] == '*' -> {
                    inBlockComment = true; current.append("/*"); i += 2
                }
                c == ';' -> {
                    if (triggerDepth > 0) {
                        // Inside a trigger body: keep the terminator, keep going.
                        current.append(c)
                        i++
                    } else {
                        val statement = current.toString().trim()
                        if (isExecutable(statement)) statements.add(statement)
                        current.setLength(0)
                        i++
                    }
                }
                else -> {
                    val keyword = keywordAt(i)
                    if (keyword != null) {
                        when (keyword) {
                            "TRIGGER" -> expectTriggerBody = true
                            "CASE" -> if (triggerDepth > 0) caseDepth++
                            "BEGIN" -> if (expectTriggerBody) {
                                triggerDepth++
                                expectTriggerBody = false
                            }
                            "END" -> if (triggerDepth > 0) {
                                if (caseDepth > 0) caseDepth-- else triggerDepth--
                            }
                        }
                        current.append(script, i, i + keyword.length)
                        i += keyword.length
                    } else {
                        current.append(c)
                        i++
                    }
                }
            }
        }

        val tail = current.toString().trim()
        if (isExecutable(tail)) statements.add(tail)
        return statements
    }

    /** A chunk that is only whitespace and comments has nothing to execute. */
    private fun isExecutable(statement: String): Boolean {
        if (statement.isEmpty()) return false
        val stripped = statement
            .replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")
            .replace(Regex("--[^\\n]*"), "")
            .trim()
        return stripped.isNotEmpty()
    }
}
