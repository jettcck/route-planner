package com.luyou.planner

/** Serializes permission decisions across the reminder and weather plugins. */
internal class NotificationPermissionGate {
    enum class Action { REQUEST, WAIT, SETTINGS }

    private var inFlight = false

    @Synchronized
    fun begin(requestedBefore: Boolean): Action {
        if (inFlight) return Action.WAIT
        if (requestedBefore) return Action.SETTINGS
        inFlight = true
        return Action.REQUEST
    }

    @Synchronized
    fun finish() {
        inFlight = false
    }
}
