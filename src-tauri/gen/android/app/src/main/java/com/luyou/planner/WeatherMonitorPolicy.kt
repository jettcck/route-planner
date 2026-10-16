package com.luyou.planner

import java.util.GregorianCalendar
import java.util.TimeZone

/** Rules used by foreground registration, reboot recovery, and background workers. */
internal object WeatherMonitorPolicy {
    fun isPermanentHttpFailure(code: Int): Boolean = code in 400..499 && code != 408 && code != 429

    fun isCalendarDate(value: String): Boolean = calendarMillis(value) != null

    /** Validate a new monitor request without silently narrowing its scope. */
    fun validateScheduleDates(values: List<String>, maxDates: Int): List<String> {
        require(maxDates > 0) { "maxDates must be positive" }
        require(values.isNotEmpty() && values.size <= maxDates) {
            "dates are required and must contain at most $maxDates entries"
        }
        require(values.all(::isCalendarDate)) { "dates contain an invalid calendar date" }
        require(values.distinct().size == values.size) { "dates must not contain duplicates" }
        return values.toList()
    }

    /** Keep a two-day grace window so trips in another timezone are never stopped early. */
    fun isExpired(dates: List<String>, nowMillis: Long): Boolean {
        val finalDay = dates.mapNotNull(::calendarMillis).maxOrNull() ?: return false
        return nowMillis >= finalDay + 2 * 24 * 60 * 60 * 1000L
    }

    private fun calendarMillis(value: String): Long? {
        if (!value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) return null
        val parts = value.split('-').map(String::toInt)
        if (parts[0] !in 1..9999) return null
        return runCatching {
            GregorianCalendar(TimeZone.getTimeZone("UTC")).apply {
                clear()
                isLenient = false
                set(parts[0], parts[1] - 1, parts[2])
            }.timeInMillis
        }.getOrNull()
    }
}
