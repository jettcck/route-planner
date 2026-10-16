package com.luyou.planner

import java.nio.ByteBuffer
import java.security.MessageDigest

/** Stable reminder IDs with much lower collision risk than String.hashCode(). */
internal object ReminderIdPolicy {
    private val reservedNotificationIds = setOf(7812, 7814)

    /** Avoid every currently stored reminder ID, including IDs from old builds. */
    fun availableId(title: String, atMillis: Long, occupied: Set<Int>): Int {
        var candidate = id(title, atMillis)
        while (candidate in occupied || candidate in reservedNotificationIds) {
            candidate = if (candidate == Int.MAX_VALUE) 1 else candidate + 1
        }
        return candidate
    }

    fun id(title: String, atMillis: Long): Int {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$title\u0000$atMillis".toByteArray(Charsets.UTF_8))
        val value = ByteBuffer.wrap(digest, 0, Int.SIZE_BYTES).int and Int.MAX_VALUE
        return if (value == 0) 7812 else value
    }
}
