package com.luyou.planner;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

public class WeatherMonitorPolicyTest {
    private static final WeatherMonitorPolicy POLICY = WeatherMonitorPolicy.INSTANCE;

    @Test
    public void rateLimitsAndTimeoutsRemainRetryable() {
        assertFalse(POLICY.isPermanentHttpFailure(408));
        assertFalse(POLICY.isPermanentHttpFailure(429));
        assertFalse(POLICY.isPermanentHttpFailure(503));
        assertFalse(POLICY.isPermanentHttpFailure(200));
        assertTrue(POLICY.isPermanentHttpFailure(400));
        assertTrue(POLICY.isPermanentHttpFailure(404));
    }

    @Test
    public void expiryUsesTheLastDayAndAllowsAllDestinationTimezones() {
        // Final date 2026-10-06 UTC midnight is 1791244800000.
        long finalDay = 1791244800000L;
        long grace = 2 * 24 * 60 * 60 * 1000L;
        assertFalse(POLICY.isExpired(Arrays.asList("2026-10-06", "2026-10-01"), finalDay + grace - 1));
        assertTrue(POLICY.isExpired(Arrays.asList("2026-10-06", "2026-10-01"), finalDay + grace));
        assertFalse(POLICY.isExpired(Arrays.asList("2026-10-06", "2026-10-20"), finalDay + grace));
    }

    @Test
    public void malformedDatesCannotExpireAnUnknownConfiguration() {
        assertFalse(POLICY.isExpired(Collections.emptyList(), Long.MAX_VALUE));
        assertFalse(POLICY.isExpired(Arrays.asList("not-a-date", "2026-02-30"), Long.MAX_VALUE));
    }

    @Test
    public void datesUseStrictCalendarValidation() {
        assertTrue(POLICY.isCalendarDate("2024-02-29"));
        assertTrue(POLICY.isCalendarDate("2026-10-06"));
        for (String date : new String[]{"2023-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "0000-01-01", "2026-1-01"}) {
            assertFalse(date, POLICY.isCalendarDate(date));
        }
    }

    @Test
    public void scheduleRejectsNarrowingOrMalformedDateSets() {
        assertEquals(Arrays.asList("2026-10-06", "2026-10-07"),
            POLICY.validateScheduleDates(Arrays.asList("2026-10-06", "2026-10-07"), 31));
        assertThrows(IllegalArgumentException.class,
            () -> POLICY.validateScheduleDates(Collections.emptyList(), 31));
        assertThrows(IllegalArgumentException.class,
            () -> POLICY.validateScheduleDates(Arrays.asList("2026-10-06", "bad"), 31));
        assertThrows(IllegalArgumentException.class,
            () -> POLICY.validateScheduleDates(Arrays.asList("2026-10-06", "2026-10-06"), 31));
        assertThrows(IllegalArgumentException.class,
            () -> POLICY.validateScheduleDates(Collections.nCopies(32, "2026-10-06"), 31));
    }

    private static void assertThrows(Class<? extends Throwable> type, Runnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) return;
            throw new AssertionError("Expected " + type.getName() + " but got " + error, error);
        }
        throw new AssertionError("Expected " + type.getName());
    }
}
